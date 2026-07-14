export type ChatKitStreamEvent =
  | { readonly type: "message_chunk"; readonly data: { readonly content: string } }
  | { readonly type: "thought_chunk"; readonly data: { readonly content: string } }
  | { readonly type: "tool_call" | "tool_call_update"; readonly data: any }
  | { readonly type: "recovery"; readonly data: { readonly message: string } }
  | { readonly type: "final"; readonly ok: true; readonly content: string; readonly reasoning?: string; readonly [key: string]: unknown }
  | { readonly type: "error"; readonly ok: false; readonly error: string }
  | { readonly type: "done" };
