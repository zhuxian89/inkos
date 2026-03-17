"use client";

import { Button, Input, Space, Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";

export interface ChatPanelMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
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
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [props.messages, props.sending]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        width: "100%",
        ...props.containerStyle,
      }}
    >
      {props.topBar}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          height: props.maxHeight ?? 460,
          maxHeight: props.maxHeight ?? 460,
          display: "flex",
          flexDirection: "column",
          border: "1px solid #f0f0f0",
          borderRadius: 16,
          background: "#fafafa",
          overflow: "hidden",
        }}
      >
        <div
          ref={bodyRef}
          style={{
            flex: 1,
            minHeight: props.minHeight ?? 320,
            overflowY: "auto",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {props.messages.length === 0 ? (
            <div
              style={{
                margin: "auto",
                maxWidth: 620,
                textAlign: "center",
                color: "#8c8c8c",
                lineHeight: 1.8,
              }}
            >
              {props.emptyText ?? "开始对话。"}
            </div>
          ) : (
            props.messages.map((item, index) => (
              <div
                key={`${item.role}-${index}`}
                style={{
                  alignSelf: item.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "78%",
                  background: item.role === "user" ? "#1677ff" : "#ffffff",
                  color: item.role === "user" ? "#fff" : "#262626",
                  borderRadius: 18,
                  padding: "14px 16px",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.75,
                  boxShadow: item.role === "user"
                    ? "0 8px 20px rgba(22,119,255,0.18)"
                    : "0 6px 18px rgba(0,0,0,0.06)",
                }}
              >
                <div>{item.content}</div>
                {item.reasoning ? (
                  <div
                    style={{
                      marginTop: 10,
                      paddingTop: 10,
                      borderTop: item.role === "user" ? "1px solid rgba(255,255,255,0.22)" : "1px solid #f0f0f0",
                      fontSize: 13,
                      opacity: 0.9,
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Reasoning</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{item.reasoning}</div>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>

        <div
          style={{
            borderTop: "1px solid #f0f0f0",
            background: "#fff",
            padding: 16,
          }}
        >
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Input.TextArea
              value={props.value}
              onChange={(event) => props.onChange(event.target.value)}
              placeholder={props.placeholder}
              autoSize={{ minRows: props.inputMinRows ?? 4, maxRows: props.inputMaxRows ?? 10 }}
              onPressEnter={(event) => {
                if (!event.shiftKey) {
                  event.preventDefault();
                  props.onSend();
                }
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                width: "100%",
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0, flex: "1 1 280px" }}>
                {props.footerLeft ?? <Typography.Text type="secondary">回车发送，Shift+回车换行。</Typography.Text>}
              </div>
              <Space style={{ marginLeft: "auto" }}>
                {props.footerRight}
                <Button type="primary" onClick={props.onSend} loading={props.sending}>
                  {props.sendText ?? "发送"}
                </Button>
              </Space>
            </div>
          </Space>
        </div>
      </div>
    </div>
  );
}
