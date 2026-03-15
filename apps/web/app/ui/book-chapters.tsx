"use client";

import { App, Alert, Button, Card, Descriptions, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useEffect, useState } from "react";
import { IssueTags } from "./issue-tags";
import { ChapterActions } from "./chapter-actions";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssues: ReadonlyArray<string>;
}

interface ChapterDetail {
  readonly ok: boolean;
  readonly chapter?: number;
  readonly title?: string;
  readonly content?: string;
  readonly filePath?: string;
  readonly error?: string;
}

export function BookChapters({ bookId, embedded = false }: Readonly<{ bookId: string; embedded?: boolean }>) {
  const { message } = App.useApp();
  const [chapters, setChapters] = useState<ReadonlyArray<ChapterMeta>>([]);
  const [detail, setDetail] = useState<ChapterDetail | null>(null);
  const [actionResult, setActionResult] = useState<unknown>(null);
  const [openingChapter, setOpeningChapter] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [reviewAction, setReviewAction] = useState<string | null>(null);

  async function loadChapters(): Promise<void> {
    setIsRefreshing(true);
    try {
      const response = await fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters`, { cache: "no-store" });
      const data = await response.json();
      setChapters(data.chapters ?? []);
    } finally {
      setIsRefreshing(false);
    }
  }

  function loadChapterDetail(chapter: number): void {
    setOpeningChapter(chapter);
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${chapter}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data: ChapterDetail) => setDetail(data))
      .finally(() => setOpeningChapter(null));
  }

  useEffect(() => {
    void loadChapters();
  }, [bookId]);

  function callReviewAction(action: "approve" | "reject", chapter: number): void {
    const actionKey = `${action}:${chapter}`;
    setReviewAction(actionKey);
    void fetch(`/api/inkos/review/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId,
        chapter,
        ...(action === "reject" ? { reason: "来自章节区的驳回" } : {}),
      }),
    })
      .then(async (response) => {
        const data = await response.json();
        setActionResult(data);
        if (!response.ok || !data?.ok) {
          void message.error(data?.error ?? `${action === "approve" ? "通过" : "驳回"}失败`);
          return;
        }
        void message.success(action === "approve" ? "已通过" : "已驳回");
        await loadChapters();
      })
      .finally(() => setReviewAction(null));
  }

  const columns: ColumnsType<ChapterMeta> = [
    {
      title: "操作",
      key: "actions",
      width: embedded ? 360 : 320,
      render: (_, row) => (
        <Space>
          <Button size="small" loading={openingChapter === row.number} onClick={() => loadChapterDetail(row.number)}>打开</Button>
          <Link href={`/books/${encodeURIComponent(bookId)}/chapters/${row.number}`}><Button size="small" type="link">详情</Button></Link>
          <ChapterActions
            bookId={bookId}
            chapter={row.number}
            onResult={setActionResult}
            onDone={() => void loadChapters()}
          />
          {row.status === "ready-for-review" ? (
            <>
              <Button size="small" loading={reviewAction === `approve:${row.number}`} onClick={() => callReviewAction("approve", row.number)}>通过</Button>
              <Button danger size="small" loading={reviewAction === `reject:${row.number}`} onClick={() => callReviewAction("reject", row.number)}>驳回</Button>
            </>
          ) : null}
        </Space>
      ),
    },
    { title: "章节", dataIndex: "number", key: "number", width: 100, render: (value: number) => `Ch.${value}` },
    { title: "标题", dataIndex: "title", key: "title" },
    { title: "状态", dataIndex: "status", key: "status", width: 130 },
    { title: "字数", dataIndex: "wordCount", key: "wordCount", width: 120 },
    {
      title: "问题",
      key: "issues",
      render: (_, row) => <IssueTags issues={row.auditIssues} maxVisible={2} />,
    },
  ];

  const content = (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={embedded ? "章节区" : `章节列表 · ${bookId}`}
        extra={(
          <Space>
            {!embedded ? <Link href={`/books/${encodeURIComponent(bookId)}`}><Button>返回工作台</Button></Link> : null}
            <Button loading={isRefreshing} onClick={() => void loadChapters()}>刷新</Button>
          </Space>
        )}
      >
        <Table rowKey="number" columns={columns} dataSource={chapters.slice()} pagination={{ pageSize: 10 }} />
      </Card>

      <Card title={embedded ? "当前选中章节" : "已选章节"}>
        {!detail ? (
          <Typography.Text type="secondary">点击“打开”查看章节元信息。</Typography.Text>
        ) : (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="是否成功">{String(detail.ok)}</Descriptions.Item>
            <Descriptions.Item label="章节号">{detail.chapter ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="标题">{detail.title ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="文件路径">{detail.filePath ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="错误">{detail.error ?? "-"}</Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Card title="操作结果">
        {!actionResult ? (
          <Typography.Text type="secondary">点击“审计 / 修订 / 通过 / 驳回”后这里显示结果。</Typography.Text>
        ) : (
          <Alert type="info" showIcon message={<pre style={{ margin: 0 }}>{JSON.stringify(actionResult, null, 2)}</pre>} />
        )}
      </Card>
    </Space>
  );

  return content;
}
