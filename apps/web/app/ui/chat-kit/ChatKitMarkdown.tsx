"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";

const components: Components = {
  p: ({ children }) => <p style={{ margin: "0 0 10px", lineHeight: 1.7 }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: "0 0 10px", paddingInlineStart: 20 }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: "3px 0", lineHeight: 1.7 }}>{children}</li>,
  code: ({ children }) => (
    <code style={{ fontFamily: "SFMono-Regular, Consolas, Menlo, monospace", fontSize: "0.92em" }}>{children}</code>
  ),
  pre: ({ children }) => (
    <pre
      style={{
        margin: "0 0 10px",
        padding: 10,
        borderRadius: 8,
        background: "rgba(0,0,0,0.04)",
        overflowX: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        lineHeight: 1.55,
      }}
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div style={{ margin: "0 0 10px", overflowX: "auto", maxWidth: "100%" }}>
      <table
        style={{
          width: "100%",
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
        padding: "7px 9px",
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
        padding: "7px 9px",
        verticalAlign: "top",
        lineHeight: 1.6,
      }}
    >
      {children}
    </td>
  ),
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "#1677ff" }}>
      {children}
    </a>
  ),
};

export function ChatKitMarkdown(props: Readonly<{ readonly content: string }>): ReactNode {
  if (!props.content) return null;
  return (
    <div style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {props.content}
      </ReactMarkdown>
    </div>
  );
}
