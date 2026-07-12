/**
 * Lightweight regression checks for applyProfileStreamEvent (web has no vitest).
 * Run: npx tsx apps/web/scripts/check-profile-stream-reducer.ts
 */
import {
  applyProfileStreamEvent,
  createEmptyProfileStreamState,
} from "../app/ui/chat-kit/apply-profile-stream-event";

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

console.log("check-profile-stream-reducer: ok");
