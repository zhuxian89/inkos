import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { attachChapterChatStreamHub } from "../chapter-chat-stream-hub.js";
import type { ServiceContext } from "../service-context.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  delete process.env.INKOS_CHAT_RECOVERY_DELAY_MS;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function waitForMessage(socket: WebSocket, predicate: (value: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const listener = (raw: Buffer) => {
      const value = JSON.parse(raw.toString());
      if (!predicate(value)) return;
      socket.off("message", listener);
      resolve(value);
    };
    socket.on("message", listener);
  });
}

describe("chapter chat stream hub", () => {
  it("keeps running after disconnect and replays only missing events", async () => {
    let releaseSecondChunk!: () => void;
    const secondChunk = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
    const context = {
      llmService: {
        runChapterAssistant: async (input: any) => {
          input.onTextDelta?.("first");
          await secondChunk;
          input.onTextDelta?.("second");
          return { reply: "firstsecond", model: "test", toolTrace: [] };
        },
      },
    } as unknown as ServiceContext;
    const server = createServer();
    servers.push(server);
    attachChapterChatStreamHub(server, context);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const url = `ws://127.0.0.1:${address.port}/api/chapter-chat/ws`;
    const sessionKey = "book:1:test";

    const first = new WebSocket(url);
    await new Promise<void>((resolve) => first.once("open", resolve));
    first.send(JSON.stringify({
      type: "session.send",
      requestId: "request-1",
      sessionKey,
      bookId: "book",
      chapterNumber: 1,
      messages: [{ role: "user", content: "hello" }],
    }));
    const firstChunk = await waitForMessage(first, (value) => value.type === "session.stream" && value.event?.type === "message_chunk");
    expect(firstChunk.seq).toBe(1);
    first.close();
    await new Promise<void>((resolve) => first.once("close", resolve));

    releaseSecondChunk();
    const second = new WebSocket(url);
    await new Promise<void>((resolve) => second.once("open", resolve));
    const replayedPromise = waitForMessage(second, (value) => value.type === "session.stream" && value.event?.type === "message_chunk");
    const finalPromise = waitForMessage(second, (value) => value.type === "session.stream" && value.event?.type === "final");
    second.send(JSON.stringify({ type: "session.subscribe", sessionKey, afterSeq: 1 }));
    const replayed = await replayedPromise;
    expect(replayed.seq).toBe(2);
    expect(replayed.event.data.content).toBe("second");
    const final = await finalPromise;
    expect(final.event.content).toBe("firstsecond");
    second.close();
  });

  it("continues after a partial provider failure when no tool ran", async () => {
    process.env.INKOS_CHAT_RECOVERY_DELAY_MS = "0";
    let attempts = 0;
    const context = {
      llmService: {
        runChapterAssistant: async (input: any) => {
          attempts += 1;
          input.onTextDelta?.(attempts === 1 ? "partial" : "continued");
          if (attempts === 1) throw new Error("temporary stream failure");
          expect(input.messages.at(-1)?.content).toBe("continue");
          return { reply: "continued", model: "test", toolTrace: [] };
        },
      },
    } as unknown as ServiceContext;
    const server = createServer();
    servers.push(server);
    attachChapterChatStreamHub(server, context);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/chapter-chat/ws`);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const recoveryPromise = waitForMessage(socket, (value) => value.event?.type === "recovery");
    const finalPromise = waitForMessage(socket, (value) => value.event?.type === "final");
    socket.send(JSON.stringify({
      type: "session.send",
      requestId: "request-recovery",
      sessionKey: "book:1:recovery",
      bookId: "book",
      chapterNumber: 1,
      messages: [{ role: "user", content: "hello" }],
    }));
    expect((await recoveryPromise).event.data.message).toContain("重试中");
    expect((await finalPromise).event.content).toBe("partialcontinued");
    expect(attempts).toBe(2);
    socket.close();
  });
});
