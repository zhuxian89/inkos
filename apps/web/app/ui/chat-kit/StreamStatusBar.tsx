"use client";

import { memo } from "react";

export type StreamStatusBarProps = {
  readonly text?: string;
  readonly visible?: boolean;
};

/** 照抄 mindfs 流式状态语义（脉冲点 + 文案）；自绘、与 antd 无冲突 */
export const StreamStatusBar = memo(function StreamStatusBar({
  text = "正在生成…",
  visible = true,
}: StreamStatusBarProps) {
  if (!visible) return null;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 2px",
        fontSize: 12,
        color: "var(--text-secondary, #8c8c8c)",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "#8b5cf6",
          animation: "inkos-chat-pulse 1.2s ease-in-out infinite",
        }}
      />
      <span>{text}</span>
    </div>
  );
});
