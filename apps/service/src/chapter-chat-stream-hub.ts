import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { ChatKitStreamEvent } from "./chapter-chat-stream-types.js";
import { isAbortLikeError } from "./jobs.js";
import type { ServiceContext } from "./service-context.js";
import { describeError, logError, logInfo } from "./service-logging.js";

type StoredEvent = { readonly seq: number; readonly event: ChatKitStreamEvent };

type StreamSession = {
  readonly key: string;
  readonly events: StoredEvent[];
  readonly subscribers: Set<WebSocket>;
  readonly abortController: AbortController;
  active: boolean;
  seq: number;
  updatedAt: number;
};

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.subscribe"), sessionKey: z.string().min(1), afterSeq: z.number().int().min(0).default(0) }),
  z.object({
    type: z.literal("session.send"),
    requestId: z.string().min(1),
    sessionKey: z.string().min(1),
    bookId: z.string().min(1),
    chapterNumber: z.number().int().min(1),
    profileId: z.string().optional(),
    messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) })).min(1),
  }),
  z.object({ type: z.literal("session.cancel"), sessionKey: z.string().min(1) }),
]);

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function waitForRecoveryDelay(signal: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, parseInt(process.env.INKOS_CHAT_RECOVERY_DELAY_MS ?? "30000", 10) || 0);
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("章节对话已取消");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function attachChapterChatStreamHub(server: Server, context: ServiceContext): void {
  const websocketServer = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, StreamSession>();

  const getSession = (key: string): StreamSession => {
    const existing = sessions.get(key);
    if (existing) return existing;
    const created: StreamSession = {
      key,
      events: [],
      subscribers: new Set(),
      abortController: new AbortController(),
      active: false,
      seq: 0,
      updatedAt: Date.now(),
    };
    sessions.set(key, created);
    return created;
  };

  const publish = (session: StreamSession, event: ChatKitStreamEvent): void => {
    const stored = { seq: ++session.seq, event };
    session.events.push(stored);
    if (session.events.length > 2000) session.events.splice(0, session.events.length - 2000);
    session.updatedAt = Date.now();
    for (const socket of session.subscribers) {
      sendJson(socket, { type: "session.stream", sessionKey: session.key, ...stored });
    }
  };

  const subscribe = (socket: WebSocket, session: StreamSession, afterSeq: number): void => {
    session.subscribers.add(socket);
    for (const stored of session.events) {
      if (stored.seq > afterSeq) sendJson(socket, { type: "session.stream", sessionKey: session.key, ...stored });
    }
    if (!session.active && session.seq > 0) {
      sendJson(socket, { type: "session.done", sessionKey: session.key, lastSeq: session.seq });
    }
  };

  const runSession = async (
    session: StreamSession,
    input: Extract<z.infer<typeof clientMessageSchema>, { type: "session.send" }>,
  ): Promise<void> => {
    try {
      let result: Awaited<ReturnType<typeof context.llmService.runChapterAssistant>> | undefined;
      let messages = [...input.messages];
      let accumulatedContent = "";
      let toolStarted = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await context.llmService.runChapterAssistant({
            bookId: input.bookId,
            chapterNumber: input.chapterNumber,
            messages,
            useStream: true,
            includeReasoning: true,
            profileId: input.profileId,
            abortSignal: session.abortController.signal,
            onTextDelta: (content) => {
              accumulatedContent += content;
              publish(session, { type: "message_chunk", data: { content } });
            },
            onReasoningDelta: (content) => publish(session, { type: "thought_chunk", data: { content } }),
            onToolStart: (data) => {
              toolStarted = true;
              publish(session, { type: "tool_call", data });
            },
            onToolEnd: (data) => publish(session, { type: "tool_call_update", data }),
          });
          break;
        } catch (error) {
          if (isAbortLikeError(error) || attempt === 3 || !accumulatedContent.trim() || toolStarted) throw error;
          publish(session, { type: "recovery", data: { message: "遇到错误，重试中..." } });
          await waitForRecoveryDelay(session.abortController.signal);
          messages = [
            ...input.messages,
            { role: "assistant" as const, content: accumulatedContent },
            { role: "user" as const, content: "continue" },
          ];
        }
      }
      if (!result) throw new Error("章节对话恢复失败");
      publish(session, {
        type: "final",
        ok: true,
        content: accumulatedContent.trim() || result.reply,
        reasoning: result.reasoning,
        model: result.model,
        profileId: result.profileId ?? input.profileId,
        toolCalls: result.toolTrace.length,
      });
      publish(session, { type: "done" });
      logInfo("chapter.chat_ws.done", { sessionKey: session.key, bookId: input.bookId, chapter: input.chapterNumber });
    } catch (error) {
      if (!isAbortLikeError(error)) {
        const message = describeError(error);
        publish(session, { type: "error", ok: false, error: message });
        logError("chapter.chat_ws.error", { sessionKey: session.key, error: message });
      }
    } finally {
      session.active = false;
      session.updatedAt = Date.now();
      for (const socket of session.subscribers) {
        sendJson(socket, { type: "session.done", sessionKey: session.key, lastSeq: session.seq });
      }
    }
  };

  websocketServer.on("connection", (socket) => {
    const subscriptions = new Set<StreamSession>();
    socket.on("message", (raw) => {
      try {
        const input = clientMessageSchema.parse(JSON.parse(raw.toString()));
        const session = getSession(input.sessionKey);
        if (input.type === "session.subscribe") {
          subscriptions.add(session);
          subscribe(socket, session, input.afterSeq);
          return;
        }
        if (input.type === "session.cancel") {
          if (!session.abortController.signal.aborted) session.abortController.abort("用户取消章节对话");
          return;
        }
        subscriptions.add(session);
        subscribe(socket, session, 0);
        if (session.active || session.seq > 0) {
          sendJson(socket, { type: "session.error", sessionKey: session.key, error: "章节对话会话已存在" });
          return;
        }
        session.active = true;
        sendJson(socket, { type: "session.accepted", sessionKey: session.key, requestId: input.requestId });
        void runSession(session, input);
      } catch (error) {
        sendJson(socket, { type: "session.error", error: describeError(error) });
      }
    });
    socket.on("close", () => {
      for (const session of subscriptions) session.subscribers.delete(socket);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/api/chapter-chat/ws") return;
    websocketServer.handleUpgrade(request, socket, head, (ws) => websocketServer.emit("connection", ws, request));
  });

  setInterval(() => {
    const cutoff = Date.now() - 3600_000;
    for (const [key, session] of sessions) {
      if (!session.active && session.updatedAt < cutoff) sessions.delete(key);
    }
  }, 600_000).unref();
}
