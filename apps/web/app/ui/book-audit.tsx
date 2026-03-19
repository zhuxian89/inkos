"use client";

import { Alert, Button, Card, Form, InputNumber, Select, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useEffect, useState } from "react";
import { IssueTags } from "./issue-tags";
import {
  buildReviseSelectOptions,
  ReviseModeGuide,
  type ReviseMode,
} from "./revise-mode-guide";

interface PendingReview {
  readonly bookId: string;
  readonly chapter: number;
  readonly chapterTitle: string;
  readonly wordCount: number;
  readonly status: string;
  readonly issues: ReadonlyArray<string>;
}

interface ActionResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly result?: {
    readonly chapterNumber: number;
    readonly passed: boolean;
    readonly summary: string;
    readonly issues: ReadonlyArray<{ readonly severity: string; readonly category: string; readonly description: string }>;
  };
}

interface AuditValues {
  readonly chapter?: number;
}

interface ReviseValues {
  readonly chapter?: number;
  readonly mode: ReviseMode;
}

export function BookAuditPanel({ bookId }: Readonly<{ bookId: string }>) {
  const [pending, setPending] = useState<ReadonlyArray<PendingReview>>([]);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isRevising, setIsRevising] = useState(false);
  const [auditForm] = Form.useForm<AuditValues>();
  const [reviseForm] = Form.useForm<ReviseValues>();
  const selectedReviseMode = Form.useWatch("mode", reviseForm) ?? "rewrite";

  async function loadPending(): Promise<void> {
    setIsRefreshing(true);
    try {
      const response = await fetch(`/api/inkos/review/pending?bookId=${encodeURIComponent(bookId)}`, { cache: "no-store" });
      const data = await response.json();
      setPending(data.pending ?? []);
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    reviseForm.setFieldsValue({ mode: "rewrite", chapter: undefined });
    void loadPending();
  }, [bookId, reviseForm]);

  function runAudit(values: AuditValues): void {
    setIsAuditing(true);
    void fetch("/api/inkos/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId,
        chapter: values.chapter || undefined,
      }),
    })
      .then((response) => response.json())
      .then(async (data: ActionResult) => {
        setResult(data);
        await loadPending();
      })
      .finally(() => setIsAuditing(false));
  }

  function runRevise(values: ReviseValues): void {
    setIsRevising(true);
    void fetch("/api/inkos/revise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId,
        chapter: values.chapter || undefined,
        mode: values.mode,
      }),
    })
      .then((response) => response.json())
      .then(async (data: ActionResult) => {
        setResult(data);
        await loadPending();
      })
      .finally(() => setIsRevising(false));
  }

  const columns: ColumnsType<PendingReview> = [
    { title: "章节", key: "chapter", render: (_, row) => `Ch.${row.chapter} · ${row.chapterTitle}` },
    { title: "字数", dataIndex: "wordCount", key: "wordCount", width: 120 },
    { title: "状态", dataIndex: "status", key: "status", width: 140 },
    {
      title: "问题",
      key: "issues",
      render: (_, row) => <IssueTags issues={row.issues} maxVisible={2} />,
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={`审计面板 · ${bookId}`}
        extra={(
          <Space>
            <Link href={`/books/${encodeURIComponent(bookId)}`}><Button>返回工作台</Button></Link>
            <Button loading={isRefreshing} onClick={() => void loadPending()}>刷新队列</Button>
          </Space>
        )}
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Card title="执行审计">
            <Form layout="vertical" form={auditForm} onFinish={runAudit}>
              <Form.Item label="章节号（可选）" name="chapter">
                <InputNumber min={1} style={{ width: "100%" }} placeholder="为空表示最新章节" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={isAuditing}>开始审计</Button>
            </Form>
          </Card>

          <Card title="执行修订">
            <Form layout="vertical" form={reviseForm} onFinish={runRevise}>
              <Form.Item label="章节号（可选）" name="chapter">
                <InputNumber min={1} style={{ width: "100%" }} placeholder="为空表示最新章节" />
              </Form.Item>
              <Form.Item label="模式" name="mode" rules={[{ required: true }]}>
                <Select options={buildReviseSelectOptions()} optionLabelProp="label" />
              </Form.Item>
              <ReviseModeGuide mode={selectedReviseMode} />
              <Button danger htmlType="submit" loading={isRevising}>开始修订</Button>
            </Form>
          </Card>
        </Space>
      </Card>

      <Card title="待审核队列">
        <Table rowKey={(row) => `${row.bookId}-${row.chapter}`} dataSource={pending.slice()} columns={columns} pagination={{ pageSize: 8 }} />
      </Card>

      <Card title="最近操作">
        {!result ? (
          <Typography.Text type="secondary">执行“审计 / 修订”后这里展示结果。</Typography.Text>
        ) : (
          <Alert type={result.ok ? "success" : "error"} showIcon message={<pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>} />
        )}
      </Card>
    </Space>
  );
}
