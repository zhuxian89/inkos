import type { ChatKitItem, ChatKitToolCall, ChatKitToolStatus, ProfileStreamEvent } from "./types";

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

function isToolStatus(value: unknown): value is ChatKitToolStatus {
  return (
    value === "running"
    || value === "in_progress"
    || value === "complete"
    || value === "success"
    || value === "failed"
    || value === "error"
    || value === "cancelled"
  );
}

function normalizeToolCall(data: unknown): ChatKitToolCall {
  const raw = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const legacyName = typeof raw.name === "string" ? raw.name : "tool";
  const callId = typeof raw.callId === "string"
    ? raw.callId
    : typeof raw.id === "string"
      ? raw.id
      : nextId("tool");
  const status = isToolStatus(raw.status) ? raw.status : "running";
  const kind = typeof raw.kind === "string" ? raw.kind : "other";
  const meta = raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
    ? raw.meta as Record<string, unknown>
    : {
        tool: legacyName,
        ...(typeof raw.arguments === "string" ? { arguments: raw.arguments } : {}),
      };

  return {
    callId,
    title: typeof raw.title === "string" ? raw.title : legacyName,
    status,
    kind,
    ...(Array.isArray(raw.content) ? { content: raw.content as ChatKitToolCall["content"] } : {}),
    ...(Array.isArray(raw.locations) ? { locations: raw.locations as ChatKitToolCall["locations"] } : {}),
    meta,
    ...(typeof raw.result === "string" ? { result: raw.result } : {}),
    ...(typeof raw.resultPreview === "string" ? { result: raw.resultPreview } : {}),
    ...(typeof raw.error === "string" ? { result: raw.error } : {}),
    ...(typeof raw.rawType === "string" ? { rawType: raw.rawType } : {}),
  };
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
    const toolCall = normalizeToolCall(normalized.data);
    const toolItem: ChatKitItem = {
      kind: "tool",
      id: toolCall.callId,
      toolCall,
    };
    return {
      ...state,
      // New LLM turn after tools: do not concatenate into previous buffers.
      assistantTextId: null,
      thoughtId: null,
      content: "",
      reasoning: "",
      items: [...state.items.filter((i) => !(i.kind === "tool" && i.id === toolItem.id)), toolItem],
    };
  }

  if (normalized.type === "tool_call_update") {
    const toolCall = normalizeToolCall(normalized.data);
    return {
      ...state,
      items: state.items.map((item) =>
        item.kind === "tool" && item.id === toolCall.callId
          ? {
              ...item,
              toolCall: {
                ...item.toolCall,
                ...toolCall,
                meta: {
                  ...(item.toolCall.meta ?? {}),
                  ...(toolCall.meta ?? {}),
                },
              },
            }
          : item,
      ),
    };
  }

  if (normalized.type === "final") {
    const content = normalized.content || state.content;
    const items: ChatKitItem[] = [];
    const thoughtContents: string[] = [];
    for (const item of state.items) {
      if (item.kind === "assistant_text" || item.kind === "status") continue;
      if (item.kind === "thought") {
        if (item.content.trim()) {
          items.push(item);
          thoughtContents.push(item.content.trim());
        }
        continue;
      }
      if (item.kind === "tool") {
        items.push(item);
      }
    }
    const finalReasoning = (normalized.reasoning ?? "").trim();
    if (finalReasoning && !thoughtContents.includes(finalReasoning)) {
      items.unshift({ kind: "thought", id: nextId("thought"), content: finalReasoning });
      thoughtContents.unshift(finalReasoning);
    }
    const reasoning = thoughtContents.join("\n\n") || state.reasoning;
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
