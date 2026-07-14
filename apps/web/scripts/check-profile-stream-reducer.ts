/**
 * Lightweight regression checks for applyProfileStreamEvent (web has no vitest).
 * Run: npx tsx apps/web/scripts/check-profile-stream-reducer.ts
 */
import {
  applyProfileStreamEvent,
  createEmptyProfileStreamState,
} from "../app/ui/chat-kit/apply-profile-stream-event";
import { ChatKitStreamError, consumeChatKitStream } from "../app/ui/chat-kit/consume-chat-kit-stream";
import { messagesToChatKitItems } from "../app/ui/chat-kit/messages-to-items";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

let state = createEmptyProfileStreamState();
state = applyProfileStreamEvent(state, { type: "message_chunk", data: { content: "A" } });
state = applyProfileStreamEvent(state, {
  type: "tool_call",
  data: {
    callId: "t1",
    kind: "read",
    title: "list_books",
    status: "running",
    meta: { tool: "list_books", args: {} },
  },
});
state = applyProfileStreamEvent(state, {
  type: "tool_call_update",
  data: {
    callId: "t1",
    kind: "read",
    title: "list_books",
    status: "complete",
    meta: { tool: "list_books", args: {} },
    result: JSON.stringify({ ok: true, books: [] }, null, 2),
  },
});
assert(state.content === "", "tool_call must reset content buffer");
assert(state.assistantTextId === null, "tool_call must clear assistantTextId");
assert(state.reasoning === "", "tool_call must reset reasoning buffer");
assert(state.thoughtId === null, "tool_call must clear thoughtId");
const firstTool = state.items.find((i) => i.kind === "tool" && i.id === "t1");
assert(firstTool?.kind === "tool" && firstTool.toolCall.status === "complete", "list_books ok result must render as complete");

state = applyProfileStreamEvent(state, { type: "message_chunk", data: { content: "B" } });
assert(state.content === "B", "next turn content must start fresh, got: " + state.content);

state = applyProfileStreamEvent(state, { type: "thought_chunk", data: { content: "think1" } });
state = applyProfileStreamEvent(state, {
  type: "tool_call",
  data: {
    callId: "t2",
    kind: "read",
    title: "list_llm_profiles",
    status: "running",
    meta: { tool: "list_llm_profiles", args: {} },
  },
});
state = applyProfileStreamEvent(state, { type: "thought_chunk", data: { content: "think2" } });
const thoughts = state.items.filter((i) => i.kind === "thought");
assert(thoughts.length === 2, "expected two thought blocks across tool turns");
assert(thoughts[1]?.content === "think2", "second thought must not concat prior reasoning");

state = applyProfileStreamEvent(state, {
  type: "final",
  ok: true,
  content: "B",
  reasoning: "think2",
  toolCalls: 2,
});
assert(
  state.items.filter((i) => i.kind === "assistant_text").length === 1,
  "final must keep a single assistant_text",
);
assert(
  state.items.filter((i) => i.kind === "thought").length >= 1,
  "final must keep thought blocks",
);
assert(
  state.items.filter((i) => i.kind === "tool").length === 2,
  "final must keep tool blocks in the live turn",
);

const historyItems = messagesToChatKitItems([
  { role: "user", content: "read files" },
  {
    role: "assistant",
    content: state.content,
    reasoning: state.reasoning,
    items: state.items,
  },
]);
assert(
  historyItems.filter((i) => i.kind === "tool").length === 2,
  "persisted assistant items must replay tool blocks after live state is cleared",
);
assert(
  historyItems.every((i) => i.kind !== "assistant_text" || !i.streaming),
  "persisted assistant items must not replay streaming state",
);

async function checkPartialStreamError(): Promise<void> {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"message_chunk","data":{"content":"partial"}}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"error","ok":false,"error":"upstream failed"}\n\n'));
      controller.close();
    },
  }));
  try {
    await consumeChatKitStream(response, []);
    throw new Error("expected stream error");
  } catch (error) {
    if (!(error instanceof ChatKitStreamError)) {
      throw new Error("stream errors must preserve partial output");
    }
    assert(error.partial.content === "partial", "partial content must survive stream errors");
    assert(error.partial.items.some((item) => item.kind === "assistant_text" && item.content === "partial"), "partial timeline must survive stream errors");
  }
}

void checkPartialStreamError().then(() => {
  console.log("check-profile-stream-reducer: ok");
});
