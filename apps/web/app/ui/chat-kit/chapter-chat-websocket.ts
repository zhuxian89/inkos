import { applyProfileStreamEvent, createEmptyProfileStreamState } from "./apply-profile-stream-event";
import { ChatKitStreamError, type ChatKitStreamResult } from "./consume-chat-kit-stream";
import { messagesToChatKitItems } from "./messages-to-items";
import type { ChatKitItem, ChatKitStreamEvent } from "./types";

type HistoryMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
  readonly items?: ReadonlyArray<ChatKitItem>;
};

export class ChapterChatSocketUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChapterChatSocketUnavailableError";
  }
}

export async function consumeChapterChatWebSocket(input: Readonly<{
  bookId: string;
  chapterNumber: number;
  messages: ReadonlyArray<HistoryMessage>;
  profileId?: string;
  signal?: AbortSignal;
  onFrame?: (items: ChatKitItem[]) => void;
}>): Promise<ChatKitStreamResult> {
  const configResponse = await fetch("/api/inkos/chapter-chat-ws-config", { cache: "no-store" });
  if (!configResponse.ok) throw new ChapterChatSocketUnavailableError("无法获取章节对话 WebSocket 地址");
  const config = await configResponse.json() as { url?: string };
  if (!config.url) throw new ChapterChatSocketUnavailableError("章节对话 WebSocket 地址为空");

  const requestId = `chapter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionKey = `${input.bookId}:${input.chapterNumber}:${requestId}`;
  const historyItems = messagesToChatKitItems(input.messages);
  let state = createEmptyProfileStreamState();
  let finalEvent: Extract<ChatKitStreamEvent, { type: "final" }> | undefined;
  let lastSeq = 0;
  let accepted = false;
  let settled = false;
  let reconnects = 0;
  let socket: WebSocket | null = null;

  const result = (): ChatKitStreamResult => ({
    content: state.content,
    reasoning: state.reasoning || undefined,
    items: state.items,
    ...(finalEvent ? { finalEvent } : {}),
  });
  const render = (): void => input.onFrame?.([...historyItems, ...state.items]);

  return await new Promise<ChatKitStreamResult>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket?.close();
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result());
    };
    const abort = (): void => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "session.cancel", sessionKey }));
      }
      const error = new Error("对话已取消");
      error.name = "AbortError";
      finish(error);
    };
    const connect = (): void => {
      if (settled || input.signal?.aborted) return abort();
      socket = new WebSocket(config.url!);
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: "session.subscribe", sessionKey, afterSeq: lastSeq }));
        if (!accepted) {
          socket?.send(JSON.stringify({
            type: "session.send",
            requestId,
            sessionKey,
            bookId: input.bookId,
            chapterNumber: input.chapterNumber,
            profileId: input.profileId,
            messages: input.messages.map(({ role, content }) => ({ role, content })),
          }));
        }
      };
      socket.onmessage = (message) => {
        const payload = JSON.parse(String(message.data)) as {
          type: string;
          seq?: number;
          event?: ChatKitStreamEvent;
          error?: string;
        };
        if (payload.type === "session.accepted") {
          accepted = true;
          return;
        }
        if (payload.type === "session.error") {
          finish(accepted
            ? new ChatKitStreamError(payload.error ?? "章节对话失败", result())
            : new ChapterChatSocketUnavailableError(payload.error ?? "章节对话 WebSocket 不可用"));
          return;
        }
        if (payload.type === "session.stream" && payload.event && typeof payload.seq === "number") {
          if (payload.seq <= lastSeq) return;
          lastSeq = payload.seq;
          if (payload.event.type === "error") {
            finish(new ChatKitStreamError(payload.event.error, result()));
            return;
          }
          if (payload.event.type === "final") finalEvent = payload.event;
          if (["message_chunk", "thought_chunk", "tool_call", "tool_call_update", "recovery", "final"].includes(payload.event.type)) {
            state = applyProfileStreamEvent(state, payload.event);
            render();
          }
          return;
        }
        if (payload.type === "session.done") {
          if (finalEvent) finish();
          else finish(new ChatKitStreamError("章节对话未返回完整结果", result()));
        }
      };
      socket.onerror = () => {
        if (!accepted) finish(new ChapterChatSocketUnavailableError("章节对话 WebSocket 连接失败"));
      };
      socket.onclose = () => {
        if (settled) return;
        if (!accepted) {
          finish(new ChapterChatSocketUnavailableError("章节对话 WebSocket 握手失败"));
          return;
        }
        if (++reconnects > 20) {
          finish(new ChatKitStreamError("章节对话 WebSocket 重连失败", result()));
          return;
        }
        window.setTimeout(connect, Math.min(2000, 200 * reconnects));
      };
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    render();
    connect();
  });
}
