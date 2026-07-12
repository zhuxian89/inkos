import type { ChatKitItem, ProfileStreamEvent } from "./types";

export type ProfileStreamState = {
  readonly items: ChatKitItem[];
  readonly assistantTextId: string | null;
  readonly thoughtId: string | null;
  readonly content: string;
  readonly reasoning: string;
};

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyProfileStreamState(): ProfileStreamState {
  return {
    items: [],
    assistantTextId: null,
    thoughtId: null,
    content: "",
    reasoning: "",
  };
}

/** 将 SSE 事件折叠进 ChatKit 时间线（含旧 delta / reasoning_delta 兼容） */
export function applyProfileStreamEvent(
  state: ProfileStreamState,
  event: ProfileStreamEvent,
): ProfileStreamState {
  const normalized: ProfileStreamEvent =
    event.type === "delta" && typeof event.delta === "string"
      ? { type: "message_chunk", data: { content: event.delta } }
      : event.type === "reasoning_delta" && typeof event.delta === "string"
        ? { type: "thought_chunk", data: { content: event.delta } }
        : event;

  if (normalized.type === "thought_chunk") {
    const chunk = normalized.data.content;
    const reasoning = state.reasoning + chunk;
    if (state.thoughtId) {
      return {
        ...state,
        reasoning,
        items: state.items.map((item) =>
          item.kind === "thought" && item.id === state.thoughtId
            ? { ...item, content: reasoning }
            : item,
        ),
      };
    }
    const thoughtId = nextId("thought");
    return {
      ...state,
      reasoning,
      thoughtId,
      items: [...state.items, { kind: "thought", id: thoughtId, content: reasoning }],
    };
  }

  if (normalized.type === "message_chunk") {
    const chunk = normalized.data.content;
    const content = state.content + chunk;
    if (state.assistantTextId) {
      return {
        ...state,
        content,
        items: state.items.map((item) =>
          item.kind === "assistant_text" && item.id === state.assistantTextId
            ? { ...item, content, streaming: true }
            : item,
        ),
      };
    }
    const assistantTextId = nextId("asst");
    return {
      ...state,
      content,
      assistantTextId,
      items: [...state.items, { kind: "assistant_text", id: assistantTextId, content, streaming: true }],
    };
  }

  if (normalized.type === "tool_call") {
    const toolItem: ChatKitItem = {
      kind: "tool",
      id: normalized.data.id,
      name: normalized.data.name,
      status: "running",
      argsPreview: normalized.data.arguments,
    };
    return {
      ...state,
      assistantTextId: null,
      items: [...state.items.filter((i) => !(i.kind === "tool" && i.id === toolItem.id)), toolItem],
    };
  }

  if (normalized.type === "tool_call_update") {
    return {
      ...state,
      items: state.items.map((item) =>
        item.kind === "tool" && item.id === normalized.data.id
          ? {
              ...item,
              status: normalized.data.status,
              resultPreview: normalized.data.resultPreview,
              error: normalized.data.error,
            }
          : item,
      ),
    };
  }

  if (normalized.type === "final") {
    const content = normalized.content || state.content;
    const reasoning = normalized.reasoning ?? state.reasoning;
    // Drop intermediate assistant_text; keep tools in order; one thought + one final reply.
    const items: ChatKitItem[] = [];
    let thoughtPlaced = false;
    for (const item of state.items) {
      if (item.kind === "assistant_text" || item.kind === "status") continue;
      if (item.kind === "thought") {
        if (!thoughtPlaced && reasoning.trim()) {
          items.push({ kind: "thought", id: item.id, content: reasoning });
          thoughtPlaced = true;
        }
        continue;
      }
      if (item.kind === "tool") {
        items.push(item);
      }
    }
    if (reasoning.trim() && !thoughtPlaced) {
      items.unshift({ kind: "thought", id: nextId("thought"), content: reasoning });
    }
    if (content.trim()) {
      items.push({
        kind: "assistant_text",
        id: nextId("asst"),
        content,
        streaming: false,
      });
    }
    return {
      items,
      assistantTextId: null,
      thoughtId: null,
      content,
      reasoning,
    };
  }

  return state;
}
