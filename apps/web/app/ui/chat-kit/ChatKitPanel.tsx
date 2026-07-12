"use client";

import { Button, Input, Space } from "antd";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { ChatKitMarkdown } from "./ChatKitMarkdown";
import { StreamStatusBar } from "./StreamStatusBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import type { ChatKitItem } from "./types";

/**
 * 对话壳：时间线块优先照抄 mindfs 自绘；
 * 输入区用 antd（与 InkOS 全局表单一致，避免两套 Input 行为）。
 */
export function ChatKitPanel(props: Readonly<{
  readonly items: ReadonlyArray<ChatKitItem>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly sending?: boolean;
  readonly placeholder?: string;
  readonly emptyText?: string;
  readonly topBar?: ReactNode;
  readonly footerLeft?: ReactNode;
  readonly maxHeight?: number | string;
  readonly containerStyle?: CSSProperties;
}>) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const maxHeight = props.maxHeight ?? 460;

  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [props.items, props.sending]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", ...props.containerStyle }}>
      {props.topBar}
      <div
        ref={bodyRef}
        style={{
          flex: 1,
          minHeight: 200,
          maxHeight,
          overflowY: "auto",
          padding: 12,
          borderRadius: 12,
          border: "1px solid #f0f0f0",
          background: "#fff",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {props.items.length === 0 ? (
          <div style={{ color: "#8c8c8c", fontSize: 13, whiteSpace: "pre-wrap" }}>
            {props.emptyText ?? "开始测试模型对话"}
          </div>
        ) : (
          props.items.map((item) => {
            if (item.kind === "user") {
              return (
                <div key={item.id} style={{ display: "flex", justifyContent: "flex-end" }}>
                  <div
                    style={{
                      maxWidth: "85%",
                      padding: "8px 12px",
                      borderRadius: 12,
                      background: "#1677ff",
                      color: "#fff",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontSize: 14,
                      lineHeight: 1.6,
                    }}
                  >
                    {item.content}
                  </div>
                </div>
              );
            }
            if (item.kind === "thought") {
              return (
                <div key={item.id} style={{ maxWidth: "92%" }}>
                  <ThinkingBlock content={item.content} />
                </div>
              );
            }
            if (item.kind === "tool") {
              return (
                <div key={item.id} style={{ maxWidth: "92%" }}>
                  <ToolCallCard
                    toolCall={item.toolCall}
                  />
                </div>
              );
            }
            if (item.kind === "status") {
              return <StreamStatusBar key={item.id} text={item.text} />;
            }
            return (
              <div key={item.id} style={{ maxWidth: "92%", fontSize: 14, lineHeight: 1.65 }}>
                <ChatKitMarkdown content={item.content} />
                {item.streaming ? <StreamStatusBar text="正在生成…" /> : null}
              </div>
            );
          })
        )}
        {props.sending && !props.items.some((i) => i.kind === "status" || (i.kind === "assistant_text" && i.streaming)) ? (
          <StreamStatusBar />
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {props.footerLeft}
        <Input.TextArea
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder ?? "输入消息，测试该模型…"}
          autoSize={{ minRows: 2, maxRows: 6 }}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              props.onSend();
            }
          }}
          disabled={props.sending}
        />
        <Space style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button type="primary" onClick={props.onSend} loading={props.sending} disabled={!props.value.trim()}>
            发送
          </Button>
        </Space>
      </div>
      <style>{`@keyframes inkos-chat-pulse{0%,100%{opacity:0.35}50%{opacity:1}}`}</style>
    </div>
  );
}
