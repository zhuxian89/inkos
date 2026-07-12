"use client";

import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";
import { ChatKitPanel, messagesToChatKitItems } from "./chat-kit";

export interface ChatPanelMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
  readonly id?: string;
}

export function ChatPanel(props: Readonly<{
  readonly messages: ReadonlyArray<ChatPanelMessage>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly sending?: boolean;
  readonly placeholder?: string;
  readonly emptyText?: string;
  readonly topBar?: ReactNode;
  readonly footerLeft?: ReactNode;
  readonly footerRight?: ReactNode;
  readonly minHeight?: number;
  readonly maxHeight?: number | string;
  readonly inputMinRows?: number;
  readonly inputMaxRows?: number;
  readonly sendText?: string;
  readonly containerStyle?: CSSProperties;
}>) {
  const items = useMemo(() => messagesToChatKitItems(props.messages), [props.messages]);

  return (
    <ChatKitPanel
      items={items}
      value={props.value}
      onChange={props.onChange}
      onSend={props.onSend}
      sending={props.sending}
      placeholder={props.placeholder}
      emptyText={props.emptyText}
      topBar={props.topBar}
      footerLeft={props.footerLeft}
      footerRight={props.footerRight}
      minHeight={props.minHeight}
      maxHeight={props.maxHeight}
      inputMinRows={props.inputMinRows}
      inputMaxRows={props.inputMaxRows}
      sendText={props.sendText}
      containerStyle={props.containerStyle}
    />
  );
}
