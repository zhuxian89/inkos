export type ChatKitToolStatus = "running" | "complete" | "error";

export type ChatKitItem =
  | { readonly kind: "user"; readonly id: string; readonly content: string }
  | { readonly kind: "assistant_text"; readonly id: string; readonly content: string; readonly streaming?: boolean }
  | { readonly kind: "thought"; readonly id: string; readonly content: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly status: ChatKitToolStatus;
      readonly argsPreview?: string;
      readonly resultPreview?: string;
      readonly error?: string;
    }
  | { readonly kind: "status"; readonly id: string; readonly text: string };

export type ProfileStreamEvent =
  | { readonly type: "start"; readonly ok: true; readonly profileId: string; readonly model: string }
  | { readonly type: "message_chunk"; readonly data: { readonly content: string } }
  | { readonly type: "thought_chunk"; readonly data: { readonly content: string } }
  | {
      readonly type: "tool_call";
      readonly data: {
        readonly id: string;
        readonly name: string;
        readonly arguments?: string;
        readonly status: "running";
      };
    }
  | {
      readonly type: "tool_call_update";
      readonly data: {
        readonly id: string;
        readonly status: "complete" | "error";
        readonly resultPreview?: string;
        readonly error?: string;
      };
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
