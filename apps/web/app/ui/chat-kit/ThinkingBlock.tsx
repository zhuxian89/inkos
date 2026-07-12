"use client";

import { memo, useEffect, useState } from "react";

export type ThinkingBlockProps = {
  readonly content: string;
  readonly defaultExpanded?: boolean;
};

/**
 * 直接照抄 mindfs ThinkingBlock（自绘、与 antd 无冲突）。
 * 默认折叠；标题「思考过程」+ 字符数。
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  content,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (!defaultExpanded) {
      setExpanded(false);
    }
  }, [defaultExpanded]);

  if (!content) return null;

  return (
    <div
      style={{
        borderRadius: "8px",
        border: "1px solid var(--border-color, #e8e8e8)",
        background: "var(--content-bg, #fafafa)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "5px",
          justifyContent: "space-between",
          padding: "6px 8px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "12px",
          color: "#8b5cf6",
          fontWeight: 500,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", minWidth: 0, flex: 1 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>思考过程</span>
          <span style={{ color: "var(--text-secondary, #8c8c8c)", fontWeight: 400, flexShrink: 0 }}>
            ({content.length} 字符)
          </span>
        </span>
        <span
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
            color: "var(--text-secondary, #8c8c8c)",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>

      {expanded ? (
        <div
          style={{
            padding: "0 10px 10px",
            fontSize: "12px",
            lineHeight: 1.5,
            color: "var(--text-secondary, #595959)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "200px",
            overflow: "auto",
          }}
        >
          {content}
        </div>
      ) : null}
    </div>
  );
});
