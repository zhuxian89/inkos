"use client";

import {
  BookOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CodeOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  RightOutlined,
  SearchOutlined,
  SwapOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatKitToolCall, ChatKitToolContentItem, ChatKitToolLocation, ChatKitToolStatus } from "./types";

export type ToolCallCardProps = {
  readonly toolCall: ChatKitToolCall;
  readonly defaultExpanded?: boolean;
};

const terminalFontFamily = "SFMono-Regular, Consolas, Menlo, monospace";

function basename(path: string): string {
  const normalized = (path || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function statusLabel(status: ChatKitToolStatus): string {
  if (status === "running" || status === "in_progress") return "运行中";
  if (status === "error" || status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return "完成";
}

function statusColor(status: ChatKitToolStatus): string {
  if (status === "running" || status === "in_progress") return "#1677ff";
  if (status === "error" || status === "failed") return "#cf1322";
  if (status === "cancelled") return "#8c8c8c";
  return "#389e0d";
}

function isRunningStatus(status: ChatKitToolStatus): boolean {
  return status === "running" || status === "in_progress";
}

function isFailedStatus(status: ChatKitToolStatus): boolean {
  return status === "error" || status === "failed";
}

function stringMeta(meta: Record<string, unknown> | undefined, key: string): string {
  const value = meta?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function toolName(toolCall: ChatKitToolCall): string {
  return stringMeta(toolCall.meta, "tool") || toolCall.title || toolCall.kind || "tool";
}

function renderToolIcon(kind: string): ReactNode {
  if (kind === "read") return <FileTextOutlined />;
  if (kind === "edit") return <EditOutlined />;
  if (kind === "search" || kind === "web_search") return <SearchOutlined />;
  if (kind === "execute") return <CodeOutlined />;
  if (kind === "delete") return <DeleteOutlined />;
  if (kind === "move") return <SwapOutlined />;
  if (kind === "fetch") return <FolderOpenOutlined />;
  if (kind === "book") return <BookOutlined />;
  if (kind === "database") return <DatabaseOutlined />;
  return <ToolOutlined />;
}

function statusIcon(status: ChatKitToolStatus): ReactNode {
  if (isRunningStatus(status)) return <LoadingOutlined spin />;
  if (isFailedStatus(status)) return <CloseCircleFilled />;
  return <CheckCircleFilled />;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function textBlockTitle(item: ChatKitToolContentItem, fallbackIndex: number): string {
  if (item.type === "diff") return item.path || `diff-${fallbackIndex + 1}`;
  return item.path || `text-${fallbackIndex + 1}`;
}

function renderStructuredDiff(path: string, oldText?: string, newText?: string): string {
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  if (typeof oldText === "string" && oldText !== "") {
    lines.push(...oldText.split("\n").map((line) => `-${line}`));
  }
  if (typeof newText === "string" && newText !== "") {
    lines.push(...newText.split("\n").map((line) => `+${line}`));
  }
  return lines.join("\n");
}

function contentText(item: ChatKitToolContentItem): string {
  if (item.type === "diff") {
    return renderStructuredDiff(item.path || "(unknown)", item.oldText, item.newText);
  }
  if (item.changeKind === "add") {
    return renderStructuredDiff(item.path || "(unknown)", undefined, item.text);
  }
  if (item.changeKind === "delete") {
    return renderStructuredDiff(item.path || "(unknown)", item.text, undefined);
  }
  return item.text || "";
}

function CodeBlock(props: Readonly<{ readonly title: string; readonly content: string; readonly danger?: boolean }>) {
  if (!props.content) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ color: "var(--text-secondary, #8c8c8c)", fontSize: 11, fontWeight: 600, wordBreak: "break-all" }}>
        {props.title}
      </div>
      <pre
        style={{
          margin: 0,
          padding: 8,
          borderRadius: 6,
          background: props.danger ? "rgba(207,19,34,0.06)" : "rgba(0,0,0,0.03)",
          border: props.danger ? "1px solid rgba(207,19,34,0.16)" : "1px solid rgba(0,0,0,0.04)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: "min(52vh, 520px)",
          overflow: "auto",
          color: props.danger ? "#cf1322" : "var(--text-secondary, #595959)",
          lineHeight: 1.45,
          fontFamily: terminalFontFamily,
          fontSize: 12,
        }}
      >
        {props.content}
      </pre>
    </div>
  );
}

function locationNames(locations?: ReadonlyArray<ChatKitToolLocation>): string[] {
  if (!locations?.length) return [];
  return Array.from(new Set(locations.map((location) => basename(location.path)).filter(Boolean)));
}

export const ToolCallCard = memo(function ToolCallCard({
  toolCall,
  defaultExpanded = false,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const kind = toolCall.kind.toLowerCase();
  const name = toolName(toolCall);
  const title = toolCall.title || name;
  const args = toolCall.meta?.args;
  const error = stringMeta(toolCall.meta, "error");
  const isFileChange =
    kind === "edit"
    || kind === "delete"
    || kind === "move"
    || Boolean(toolCall.content?.some((item) => item.type === "diff" || item.changeKind));
  const fileNames = useMemo(() => {
    const contentPaths = toolCall.content?.map((item) => item.path).filter((path): path is string => Boolean(path)) ?? [];
    return Array.from(new Set([...locationNames(toolCall.locations), ...contentPaths.map(basename)]));
  }, [toolCall.content, toolCall.locations]);
  const hasDetails = Boolean(
    toolCall.content?.length
    || toolCall.locations?.length
    || toolCall.result
    || args
    || error,
  );

  useEffect(() => {
    if (defaultExpanded || !isRunningStatus(toolCall.status) || error) {
      setExpanded(true);
    }
  }, [defaultExpanded, error, toolCall.status]);

  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: 8,
        border: isFileChange ? "1px solid rgba(22,119,255,0.22)" : "1px solid var(--border-color, #e8e8e8)",
        background: isFileChange ? "rgba(22,119,255,0.035)" : "var(--content-bg, #fff)",
        fontSize: 12,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={hasDetails ? () => setExpanded((current) => !current) : undefined}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 9px",
          border: "none",
          background: "transparent",
          cursor: hasDetails ? "pointer" : "default",
          textAlign: "left",
          color: "inherit",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", color: "#1677ff", flexShrink: 0 }}>
          {renderToolIcon(kind)}
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, gap: 2 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ color: "var(--text-primary, #262626)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {title}
            </span>
            <code
              style={{
                color: "var(--text-secondary, #8c8c8c)",
                fontFamily: terminalFontFamily,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {name}
            </code>
          </span>
          {toolCall.callId ? (
            <span style={{ color: "var(--text-secondary, #595959)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {toolCall.callId}
            </span>
          ) : null}
        </span>
        {fileNames.length > 0 ? (
          <span
            style={{
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              borderRadius: 999,
              background: "rgba(22,119,255,0.1)",
              color: "#0958d9",
              padding: "1px 6px",
              fontSize: 11,
              fontWeight: 600,
              flexShrink: 0,
            }}
            title={fileNames.join(" ")}
          >
            {fileNames.join(" ")}
          </span>
        ) : null}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: statusColor(toolCall.status), flexShrink: 0, fontWeight: 500 }}>
          {statusIcon(toolCall.status)}
          <span>{statusLabel(toolCall.status)}</span>
        </span>
        {hasDetails ? (
          <RightOutlined
            style={{
              color: "var(--text-secondary, #8c8c8c)",
              fontSize: 11,
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.2s",
              flexShrink: 0,
            }}
          />
        ) : null}
      </button>
      {expanded && hasDetails ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "8px 10px 10px",
            borderTop: "1px solid var(--border-color, #f0f0f0)",
          }}
        >
          {error ? <CodeBlock title="错误" content={error} danger /> : null}
          {args ? <CodeBlock title="参数" content={formatJson(args)} /> : null}
          {toolCall.content?.map((item, index) => (
            <CodeBlock
              key={`${item.type}-${item.path ?? ""}-${index}`}
              title={textBlockTitle(item, index)}
              content={contentText(item)}
              danger={isFailedStatus(toolCall.status)}
            />
          ))}
          {toolCall.locations?.length ? (
            <CodeBlock
              title="位置"
              content={toolCall.locations.map((location) => `${location.path}${location.line ? `:${location.line}` : ""}`).join("\n")}
            />
          ) : null}
          {toolCall.result ? (
            <CodeBlock
              title="原始结果"
              content={toolCall.result}
              danger={isFailedStatus(toolCall.status)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
