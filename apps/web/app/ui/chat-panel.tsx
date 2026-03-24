"use client";

import { Button, Grid, Input, Space, Typography } from "antd";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";

export interface ChatPanelMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
}

const assistantMarkdownComponents: Components = {
  p: ({ children }) => <p style={{ margin: "0 0 12px", lineHeight: 1.75 }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: "0 0 12px", paddingInlineStart: 20 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: "0 0 12px", paddingInlineStart: 20 }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: "4px 0", lineHeight: 1.75 }}>{children}</li>,
  h1: ({ children }) => <h1 style={{ margin: "0 0 12px", fontSize: 22, lineHeight: 1.4 }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ margin: "0 0 12px", fontSize: 20, lineHeight: 1.4 }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ margin: "0 0 10px", fontSize: 18, lineHeight: 1.45 }}>{children}</h3>,
  h4: ({ children }) => <h4 style={{ margin: "0 0 10px", fontSize: 16, lineHeight: 1.45 }}>{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "0 0 12px",
        padding: "6px 0 6px 14px",
        borderLeft: "3px solid rgba(108, 146, 141, 0.45)",
        color: "#52666b",
      }}
    >
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre
      style={{
        margin: "0 0 12px",
        padding: 12,
        borderRadius: 12,
        background: "rgba(29, 45, 52, 0.06)",
        overflowX: "auto",
        whiteSpace: "pre",
        lineHeight: 1.6,
      }}
    >
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code
      style={{
        fontFamily: "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
        fontSize: "0.92em",
      }}
    >
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div style={{ margin: "0 0 12px", overflowX: "auto" }}>
      <table
        style={{
          width: "max-content",
          minWidth: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{
        border: "1px solid #f0f0f0",
        background: "#fafafa",
        padding: "8px 10px",
        textAlign: "left",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      style={{
        border: "1px solid #f0f0f0",
        padding: "8px 10px",
        verticalAlign: "top",
        lineHeight: 1.6,
      }}
    >
      {children}
    </td>
  ),
  hr: () => <hr style={{ border: 0, borderTop: "1px solid #f0f0f0", margin: "12px 0" }} />,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "#1677ff", textDecoration: "underline", wordBreak: "break-all" }}>
      {children}
    </a>
  ),
};

function renderAssistantMarkdown(content?: string): ReactNode {
  if (!content) return null;
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={assistantMarkdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
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
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const frameSizeStyle: CSSProperties = (() => {
    if (typeof props.maxHeight === "number") {
      return { height: props.maxHeight, maxHeight: props.maxHeight };
    }
    if (typeof props.maxHeight === "string") {
      const normalized = props.maxHeight.trim();
      if (normalized === "100%") {
        return {};
      }
      return { maxHeight: normalized };
    }
    return { height: 460, maxHeight: 460 };
  })();

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
          display: "flex",
          flexDirection: "column",
          border: "1px solid rgba(72, 103, 104, 0.08)",
          borderRadius: 18,
          background: "linear-gradient(180deg, rgba(250,252,251,0.96) 0%, rgba(242,247,246,0.92) 100%)",
          overflow: "hidden",
          boxShadow: "0 14px 34px rgba(9, 17, 23, 0.08)",
          ...frameSizeStyle,
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
            props.messages.map((item, index) => {
              return (
                <div
                  key={`${item.role}-${index}`}
                  style={{
                    width: "100%",
                    display: "flex",
                    justifyContent: item.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      maxWidth: "78%",
                      minWidth: 0,
                      background: item.role === "user"
                        ? "linear-gradient(135deg, #4c7471 0%, #628f89 100%)"
                        : "rgba(255,255,255,0.94)",
                      color: item.role === "user" ? "#f6fffd" : "#262626",
                      borderRadius: 18,
                      padding: "14px 16px",
                      whiteSpace: item.role === "user" ? "pre-wrap" : "normal",
                      lineHeight: 1.75,
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                      boxShadow: item.role === "user"
                        ? "0 10px 24px rgba(76,116,113,0.22)"
                        : "0 8px 22px rgba(11,19,24,0.06)",
                    }}
                  >
                    <div>{item.role === "assistant" ? renderAssistantMarkdown(item.content) : item.content}</div>
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
                        <div>{item.role === "assistant" ? renderAssistantMarkdown(item.reasoning) : item.reasoning}</div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div
          style={{
            borderTop: "1px solid rgba(72, 103, 104, 0.08)",
            background: "rgba(255,255,255,0.86)",
            padding: 16,
            backdropFilter: "blur(8px)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
            <Input.TextArea
              value={props.value}
              onChange={(event) => props.onChange(event.target.value)}
              placeholder={props.placeholder}
              autoSize={{ minRows: props.inputMinRows ?? 3, maxRows: props.inputMaxRows ?? 8 }}
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
                flexDirection: isMobile ? "column" : "row",
                justifyContent: "space-between",
                alignItems: isMobile ? "stretch" : "center",
                gap: 12,
                width: "100%",
                flexWrap: isMobile ? "nowrap" : "wrap",
              }}
            >
              <div
                style={{
                  minWidth: 0,
                  flex: isMobile ? undefined : "1 1 280px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {props.footerLeft ?? <Typography.Text type="secondary">回车发送，Shift+回车换行。</Typography.Text>}
              </div>
              {isMobile ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
                  {props.footerRight ? (
                    <Space wrap style={{ width: "100%", justifyContent: "flex-end" }}>
                      {props.footerRight}
                    </Space>
                  ) : null}
                  <Button type="primary" onClick={props.onSend} loading={props.sending} block>
                    {props.sendText ?? "发送"}
                  </Button>
                </div>
              ) : (
                <Space style={{ marginLeft: "auto", flex: "0 1 auto", justifyContent: "flex-end", maxWidth: "100%" }} wrap>
                  <Button type="primary" onClick={props.onSend} loading={props.sending}>
                    {props.sendText ?? "发送"}
                  </Button>
                  {props.footerRight}
                </Space>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
