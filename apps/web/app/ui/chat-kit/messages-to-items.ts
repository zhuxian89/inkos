import type { ChatKitItem } from "./types";

function historyItemId(messageIndex: number, itemIndex: number, originalId: string): string {
  return `hist-${messageIndex}-${itemIndex}-${originalId}`;
}

function normalizeHistoryItem(
  item: ChatKitItem,
  messageIndex: number,
  itemIndex: number,
): ChatKitItem | null {
  if (item.kind === "status") return null;
  if (item.kind === "assistant_text") {
    return {
      ...item,
      id: historyItemId(messageIndex, itemIndex, item.id),
      streaming: false,
    };
  }
  return {
    ...item,
    id: historyItemId(messageIndex, itemIndex, item.id),
  };
}

export function messagesToChatKitItems(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly reasoning?: string;
    readonly items?: ReadonlyArray<ChatKitItem>;
  }>,
): ChatKitItem[] {
  const items: ChatKitItem[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      items.push({ kind: "user", id: `hist-user-${index}`, content: message.content });
      return;
    }
    if (message.items?.length) {
      message.items.forEach((item, itemIndex) => {
        const normalized = normalizeHistoryItem(item, index, itemIndex);
        if (normalized) items.push(normalized);
      });
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
