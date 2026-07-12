export type ChatKitToolStatus = "running" | "in_progress" | "complete" | "success" | "failed" | "error" | "cancelled";

export type ChatKitToolLocation = {
  readonly path: string;
  readonly line?: number;
};

export type ChatKitToolContentItem =
  | {
      readonly type: "text";
      readonly text?: string;
      readonly path?: string;
      readonly changeKind?: string;
    }
  | {
      readonly type: "diff";
      readonly path?: string;
      readonly oldText?: string;
      readonly newText?: string;
      readonly changeKind?: string;
    };

export type ChatKitToolCall = {
  readonly callId: string;
  readonly title?: string;
  readonly status: ChatKitToolStatus;
  readonly kind: string;
  readonly content?: ReadonlyArray<ChatKitToolContentItem>;
  readonly locations?: ReadonlyArray<ChatKitToolLocation>;
  readonly meta?: Record<string, unknown>;
  readonly result?: string;
  readonly rawType?: string;
};

export type ChatKitItem =
  | { readonly kind: "user"; readonly id: string; readonly content: string }
  | { readonly kind: "assistant_text"; readonly id: string; readonly content: string; readonly streaming?: boolean }
  | { readonly kind: "thought"; readonly id: string; readonly content: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly toolCall: ChatKitToolCall;
    }
  | { readonly kind: "status"; readonly id: string; readonly text: string };

export type ProfileStreamEvent =
  | { readonly type: "start"; readonly ok: true; readonly profileId: string; readonly model: string }
  | { readonly type: "message_chunk"; readonly data: { readonly content: string } }
  | { readonly type: "thought_chunk"; readonly data: { readonly content: string } }
  | {
      readonly type: "tool_call";
      readonly data: ChatKitToolCall;
    }
  | {
      readonly type: "tool_call_update";
      readonly data: ChatKitToolCall;
    }
  | {
      readonly type: "final";
      readonly ok: true;
      readonly content: string;
      readonly reasoning?: string;
      readonly toolCalls: number;
    }
  | { readonly type: "error"; readonly ok: false; readonly error: string }
  | { readonly type: "done" }
  /** @deprecated 兼容旧 SSE，bridge 可映射为 message_chunk */
  | { readonly type: "delta"; readonly delta?: string }
  /** @deprecated 兼容旧 SSE，bridge 可映射为 thought_chunk */
  | { readonly type: "reasoning_delta"; readonly delta?: string };
