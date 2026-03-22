"use client";

import { Alert, Button, Card, Input, Select, Space, Switch, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

interface ServiceLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: "INFO" | "ERROR";
  readonly event: string;
  readonly meta?: Record<string, unknown>;
}

interface LogsResponse {
  readonly ok: boolean;
  readonly logs?: ReadonlyArray<ServiceLogEntry>;
  readonly lastId?: number;
  readonly buffered?: number;
  readonly bufferLimit?: number;
  readonly error?: string;
}

export function LogsWorkspace() {
  const [logs, setLogs] = useState<ReadonlyArray<ServiceLogEntry>>([]);
  const [lastId, setLastId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<"" | "INFO" | "ERROR">("");
  const [eventIncludes, setEventIncludes] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [buffered, setBuffered] = useState(0);
  const [bufferLimit, setBufferLimit] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);

  async function fetchLogs(options?: { readonly reset?: boolean }): Promise<void> {
    const reset = options?.reset === true;
    const params = new URLSearchParams();
    params.set("limit", reset ? "300" : "200");
    if (!reset && lastId > 0) params.set("sinceId", String(lastId));
    if (level) params.set("level", level);
    if (eventIncludes.trim()) params.set("eventIncludes", eventIncludes.trim());

    if (reset) setLoading(true);
    try {
      const response = await fetch(`/api/inkos/logs?${params.toString()}`, { cache: "no-store" });
      const data = await response.json() as LogsResponse;
      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? "日志读取失败");
      }

      const incoming = Array.isArray(data.logs) ? data.logs : [];
      setBuffered(typeof data.buffered === "number" ? data.buffered : 0);
      setBufferLimit(typeof data.bufferLimit === "number" ? data.bufferLimit : 0);
      setLastId(typeof data.lastId === "number" ? data.lastId : lastId);

      if (reset) {
        setLogs(incoming.slice(-500));
      } else if (incoming.length > 0) {
        setLogs((prev) => [...prev, ...incoming].slice(-500));
      }
      setError(null);
    } catch (fetchError: unknown) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      if (reset) setLoading(false);
    }
  }

  useEffect(() => {
    void fetchLogs({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void fetchLogs({ reset: false });
    }, 1500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, lastId, level, eventIncludes]);

  useEffect(() => {
    if (!autoScroll) return;
    const panel = panelRef.current;
    if (!panel) return;
    panel.scrollTop = panel.scrollHeight;
  }, [logs, autoScroll]);

  const logLines = useMemo(() => logs.map((entry) => {
    const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
    return `${entry.timestamp} ${entry.level} ${entry.event}${meta}`;
  }), [logs]);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        style={{
          borderRadius: 24,
          overflow: "hidden",
          background: "linear-gradient(135deg, rgba(16,29,35,0.96) 0%, rgba(33,55,60,0.92) 52%, rgba(102,128,121,0.84) 100%)",
        }}
      >
        <Typography.Text style={{ color: "rgba(214, 227, 223, 0.72)", letterSpacing: "0.16em", textTransform: "uppercase", fontSize: 11 }}>
          Live Trace
        </Typography.Text>
        <Typography.Title level={4} style={{ marginTop: 8, marginBottom: 8, color: "#f2f7f6" }}>实时日志</Typography.Title>
        <Typography.Paragraph style={{ marginBottom: 0, color: "rgba(227, 236, 234, 0.8)" }}>
          直接在页面观察服务端日志滚动，定位 compaction、chat-stream、tool 调用会更快。
        </Typography.Paragraph>
      </Card>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card style={{ borderRadius: 22, background: "rgba(255,255,255,0.9)" }}>
        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap>
            <Select
              style={{ width: 130 }}
              value={level}
              onChange={(value) => {
                setLevel(value);
                setLogs([]);
                setLastId(0);
                void fetchLogs({ reset: true });
              }}
              options={[
                { label: "全部级别", value: "" },
                { label: "INFO", value: "INFO" },
                { label: "ERROR", value: "ERROR" },
              ]}
            />
            <Input
              style={{ width: 280 }}
              placeholder="按 event 过滤，比如 compaction"
              value={eventIncludes}
              onChange={(event) => setEventIncludes(event.target.value)}
              onPressEnter={() => {
                setLogs([]);
                setLastId(0);
                void fetchLogs({ reset: true });
              }}
            />
            <Button
              onClick={() => {
                setLogs([]);
                setLastId(0);
                void fetchLogs({ reset: true });
              }}
              loading={loading}
            >
              刷新
            </Button>
            <Button
              onClick={() => {
                setLogs([]);
                setLastId(0);
              }}
            >
              清空视图
            </Button>
          </Space>
          <Space wrap>
            <Tag color="blue">{`已加载 ${logs.length} 条`}</Tag>
            <Tag>{`服务缓存 ${buffered}/${bufferLimit || "-"}`}</Tag>
            <Space size={4}>
              <Typography.Text type="secondary">自动刷新</Typography.Text>
              <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
            </Space>
            <Space size={4}>
              <Typography.Text type="secondary">自动滚动</Typography.Text>
              <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
            </Space>
          </Space>
        </Space>

        <div
          ref={panelRef}
          style={{
            marginTop: 12,
            borderRadius: 14,
            padding: 12,
            background: "#0f1820",
            color: "#d8e8e4",
            fontFamily: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.55,
            height: "65vh",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {logLines.length > 0 ? logLines.join("\n") : "暂无日志，等待新事件..."}
        </div>
      </Card>
    </Space>
  );
}
