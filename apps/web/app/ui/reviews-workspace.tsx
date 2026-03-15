"use client";

import { Alert, Button, Card, Input, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import { IssueTags } from "./issue-tags";

interface Pending {
  readonly bookId: string;
  readonly title: string;
  readonly chapter: number;
  readonly chapterTitle: string;
  readonly wordCount: number;
  readonly status: string;
  readonly issues: ReadonlyArray<string>;
}

export function ReviewsWorkspace() {
  const [pending, setPending] = useState<ReadonlyArray<Pending>>([]);
  const [bookId, setBookId] = useState<string>("");
  const [result, setResult] = useState<unknown>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [runningAction, setRunningAction] = useState<string | null>(null);

  async function loadPending(): Promise<void> {
    setIsRefreshing(true);
    const query = bookId ? `?bookId=${encodeURIComponent(bookId)}` : "";
    try {
      const response = await fetch(`/api/inkos/review/pending${query}`, { cache: "no-store" });
      const data = await response.json();
      setPending(data.pending ?? []);
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    void loadPending();
  }, []);

  function callAction(action: "approve" | "reject", item: Pending): void {
    const actionKey = `${action}:${item.bookId}:${item.chapter}`;
    setRunningAction(actionKey);
    void fetch(`/api/inkos/review/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId: item.bookId,
        chapter: item.chapter,
        ...(action === "reject" ? { reason: "来自审核页的驳回" } : {}),
      }),
    })
      .then((response) => response.json())
      .then(async (data) => {
        setResult(data);
        await loadPending();
      })
      .finally(() => setRunningAction(null));
  }

  function approveAll(): void {
    setRunningAction("approve-all");
    void fetch("/api/inkos/review/approve-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookId: bookId || undefined }),
    })
      .then((response) => response.json())
      .then(async (data) => {
        setResult(data);
        await loadPending();
      })
      .finally(() => setRunningAction(null));
  }

  const columns: ColumnsType<Pending> = [
    {
      title: "书籍",
      key: "book",
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.title}</Typography.Text>
          <Typography.Text type="secondary">{row.bookId}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "章节",
      key: "chapter",
      render: (_, row) => (
        <Typography.Text>Ch.{row.chapter} · {row.chapterTitle}</Typography.Text>
      ),
    },
    { title: "字数", dataIndex: "wordCount", key: "wordCount", width: 120 },
    { title: "状态", dataIndex: "status", key: "status", width: 140 },
    {
      title: "问题",
      key: "issues",
      render: (_, row) => <IssueTags issues={row.issues} maxVisible={2} />,
    },
    {
      title: "操作",
      key: "actions",
      width: 180,
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => callAction("approve", row)} loading={runningAction === `approve:${row.bookId}:${row.chapter}`}>
            通过
          </Button>
          <Button danger size="small" onClick={() => callAction("reject", row)} loading={runningAction === `reject:${row.bookId}:${row.chapter}`}>
            驳回
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card title="待审核队列" extra={<Tag color="blue">{pending.length} 条</Tag>}>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input
            placeholder="按 bookId 过滤（可选）"
            value={bookId}
            onChange={(event) => setBookId(event.target.value)}
            style={{ width: 280 }}
          />
          <Button loading={isRefreshing} onClick={() => void loadPending()}>刷新</Button>
          <Button type="primary" onClick={approveAll} loading={runningAction === "approve-all"}>全部通过</Button>
        </Space>
        <Table
          rowKey={(row) => `${row.bookId}-${row.chapter}`}
          dataSource={pending.slice()}
          columns={columns}
          pagination={{ pageSize: 8 }}
        />
      </Card>

      <Card title="结果">
        {!result ? (
          <Typography.Text type="secondary">执行审核动作后这里显示结果。</Typography.Text>
        ) : (
          <Alert type="info" showIcon message={<pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>} />
        )}
      </Card>
    </Space>
  );
}
