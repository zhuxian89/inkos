import {
  applyProfileStreamEvent,
  createEmptyProfileStreamState,
} from "./apply-profile-stream-event";
import { messagesToChatKitItems } from "./messages-to-items";
import type { ChatKitItem, ChatKitStreamEvent } from "./types";

type ChatKitHistoryMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
  readonly id?: string;
  readonly items?: ReadonlyArray<ChatKitItem>;
};

export type ChatKitStreamResult = {
  readonly content: string;
  readonly reasoning?: string;
  readonly items: ReadonlyArray<ChatKitItem>;
  readonly finalEvent?: Extract<ChatKitStreamEvent, { readonly type: "final" }>;
};

export class ChatKitStreamError extends Error {
  constructor(
    message: string,
    readonly partial: ChatKitStreamResult,
  ) {
    super(message);
    this.name = "ChatKitStreamError";
  }
}

export function parseChatKitSseEventBlock(block: string): ChatKitStreamEvent | null {
  const lines = block.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as ChatKitStreamEvent;
  } catch {
    return null;
  }
}

export async function consumeChatKitStream(
  response: Response,
  baseMessages: ReadonlyArray<ChatKitHistoryMessage>,
  options?: { readonly signal?: AbortSignal; readonly onFrame?: (items: ChatKitItem[]) => void },
): Promise<ChatKitStreamResult> {
  if (!response.body) {
    throw new Error("流式响应不可用");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let turnState = createEmptyProfileStreamState();
  let finalEvent: Extract<ChatKitStreamEvent, { readonly type: "final" }> | undefined;
  const historyItems = messagesToChatKitItems(baseMessages);

  const currentResult = (): ChatKitStreamResult => ({
    content: turnState.content,
    reasoning: turnState.reasoning || undefined,
    items: turnState.items,
    ...(finalEvent ? { finalEvent } : {}),
  });

  const renderFrame = (): void => {
    options?.onFrame?.([...historyItems, ...turnState.items]);
  };

  const throwIfAborted = (): void => {
    if (options?.signal?.aborted) {
      const error = new Error("对话已取消");
      error.name = "AbortError";
      throw error;
    }
  };

  renderFrame();

  try {
    while (true) {
      throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex >= 0) {
        throwIfAborted();
        const block = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        const raw = parseChatKitSseEventBlock(block);
        if (!raw) {
          delimiterIndex = buffer.indexOf("\n\n");
          continue;
        }

        if (raw.type === "error") {
          throw new Error(raw.error ?? "对话失败");
        }

        if (
          raw.type === "message_chunk"
          || raw.type === "thought_chunk"
          || raw.type === "tool_call"
          || raw.type === "tool_call_update"
          || raw.type === "final"
        ) {
          if (raw.type === "final") {
            finalEvent = raw;
          }
          turnState = applyProfileStreamEvent(turnState, raw);
          renderFrame();
        }

        delimiterIndex = buffer.indexOf("\n\n");
      }

      if (done) break;
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ChatKitStreamError(
      error instanceof Error ? error.message : String(error),
      currentResult(),
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return currentResult();
}
