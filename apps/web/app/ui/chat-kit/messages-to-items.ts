import type { ChatKitItem } from "./types";

export function messagesToChatKitItems(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly reasoning?: string;
  }>,
): ChatKitItem[] {
  const items: ChatKitItem[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      items.push({ kind: "user", id: `hist-user-${index}`, content: message.content });
      return;
    }
    if (message.reasoning?.trim()) {
      items.push({ kind: "thought", id: `hist-thought-${index}`, content: message.reasoning });
    }
    if (message.content?.trim()) {
      items.push({
        kind: "assistant_text",
        id: `hist-asst-${index}`,
        content: message.content,
        streaming: false,
      });
    }
  });
  return items;
}
