"use client";

import { Alert, Button, Card, Space, Tag, Typography } from "antd";
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
  readonly error?: string;
}

export function ChatFactLogPanel(props: Readonly<{
  readonly title: string;
  readonly eventIncludes: string;
}>) {
  const [logs, setLogs] = useState<ReadonlyArray<ServiceLogEntry>>([]);
  const [lastId, setLastId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  async function fetchLogs(reset = false): Promise<void> {
    const params = new URLSearchParams();
    params.set("limit", reset ? "260" : "120");
    if (!reset && lastId > 0) params.set("sinceId", String(lastId));
    if (props.eventIncludes.trim()) params.set("eventIncludes", props.eventIncludes.trim());
    const response = await fetch(`/api/inkos/logs?${params.toString()}`, { cache: "no-store" });
    const data = await response.json() as LogsResponse;
    if (!response.ok || !data.ok) {
      throw new Error(data.error ?? "日志读取失败");
    }
    const incoming = Array.isArray(data.logs) ? data.logs : [];
    setLastId(typeof data.lastId === "number" ? data.lastId : lastId);
    if (reset) {
      setLogs(incoming.slice(-320));
    } else if (incoming.length > 0) {
      setLogs((prev) => [...prev, ...incoming].slice(-320));
    }
    setError(null);
  }

  useEffect(() => {
    void fetchLogs(true).catch((fetchError: unknown) => {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.eventIncludes]);

  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => {
      void fetchLogs(false).catch((fetchError: unknown) => {
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [polling, lastId, props.eventIncludes]);

  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs]);

  const rows = useMemo(() => logs.map((entry) => {
    const time = entry.timestamp.slice(11, 19);
    const metaText = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
    return `${time} ${entry.level} ${entry.event}${metaText}`;
  }), [logs]);

  return (
    <Card
      size="small"
      title={props.title}
      styles={{
        body: {
          padding: 0,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        },
      }}
      style={{ height: "100%", borderRadius: 14, background: "rgba(255,255,255,0.92)" }}
      extra={(
        <Space size={6}>
          <Tag color="blue">{`${logs.length} 条`}</Tag>
          <Button size="small" onClick={() => setPolling((value) => !value)}>
            {polling ? "暂停" : "继续"}
          </Button>
          <Button
            size="small"
            onClick={() => {
              setLogs([]);
              setLastId(0);
              void fetchLogs(true).catch((fetchError: unknown) => {
                setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
              });
            }}
          >
            刷新
          </Button>
        </Space>
      )}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ margin: "10px 10px 0" }}
          message="日志读取失败"
          description={error}
        />
      ) : null}
      <div
        ref={bodyRef}
        style={{
          flex: 1,
          minHeight: 0,
          margin: 10,
          borderRadius: 10,
          padding: 10,
          background: "#0f1820",
          color: "#d8e8e4",
          fontFamily: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.6,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {rows.length > 0 ? rows.join("\n") : (
          <Typography.Text style={{ color: "rgba(216,232,228,0.78)" }}>
            暂无日志，等待新事件...
          </Typography.Text>
        )}
      </div>
    </Card>
  );
}
