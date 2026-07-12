"use client";

import { memo } from "react";
import type { ChatKitToolStatus } from "./types";

export type ToolCallCardProps = {
  readonly name: string;
  readonly status: ChatKitToolStatus;
  readonly argsPreview?: string;
  readonly resultPreview?: string;
  readonly error?: string;
  readonly defaultExpanded?: boolean;
};

function statusLabel(status: ChatKitToolStatus): string {
  if (status === "running") return "运行中";
  if (status === "error") return "失败";
  return "完成";
}

function statusColor(status: ChatKitToolStatus): string {
  if (status === "running") return "#1677ff";
  if (status === "error") return "#cf1322";
  return "#389e0d";
}

/**
 * 简化自绘工具卡（对齐 mindfs 信息密度，无 Tailwind/详情 API，与 antd 无冲突）。
 * mindfs 原版 ToolCallCard 过重且依赖 session API，故只抄交互骨架。
 */
export const ToolCallCard = memo(function ToolCallCard({
  name,
  status,
  argsPreview,
  resultPreview,
  error,
  defaultExpanded = false,
}: ToolCallCardProps) {
  const expanded = defaultExpanded || status === "error" || Boolean(error);
  const detail = error || resultPreview || argsPreview;

  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--border-color, #e8e8e8)",
        background: "var(--content-bg, #fff)",
        padding: "8px 10px",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span aria-hidden>🔧</span>
          <code
            style={{
              fontFamily: "SFMono-Regular, Consolas, Menlo, monospace",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {name}
          </code>
        </span>
        <span style={{ color: statusColor(status), flexShrink: 0, fontWeight: 500 }}>
          {status === "running" ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: statusColor(status),
                  animation: "inkos-chat-pulse 1.2s ease-in-out infinite",
                }}
              />
              {statusLabel(status)}
            </span>
          ) : (
            statusLabel(status)
          )}
        </span>
      </div>
      {expanded && detail ? (
        <pre
          style={{
            margin: "8px 0 0",
            padding: 8,
            borderRadius: 6,
            background: "rgba(0,0,0,0.03)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 160,
            overflow: "auto",
            color: error ? "#cf1322" : "var(--text-secondary, #595959)",
            lineHeight: 1.45,
          }}
        >
          {detail}
        </pre>
      ) : null}
    </div>
  );
});
