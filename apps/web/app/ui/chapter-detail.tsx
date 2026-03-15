"use client";

import { Button, Card, Descriptions, Space, Typography } from "antd";
import Link from "next/link";
import { useEffect, useState } from "react";
import { IssueTags } from "./issue-tags";

interface DetailResponse {
  readonly ok: boolean;
  readonly bookId?: string;
  readonly chapter?: number;
  readonly title?: string;
  readonly filePath?: string;
  readonly content?: string;
  readonly meta?: {
    readonly status: string;
    readonly wordCount: number;
    readonly auditIssues: ReadonlyArray<string>;
    readonly updatedAt: string;
  } | null;
  readonly error?: string;
}

export function ChapterDetailPage(props: Readonly<{ bookId: string; chapter: string }>) {
  const { bookId, chapter } = props;
  const [data, setData] = useState<DetailResponse | null>(null);

  useEffect(() => {
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapter)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((json: DetailResponse) => setData(json));
  }, [bookId, chapter]);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={`章节详情 · ${bookId} / ${chapter}`}
        extra={(
          <Space>
            <Link href={`/books/${encodeURIComponent(bookId)}/chapters`}><Button>返回章节列表</Button></Link>
          </Space>
        )}
      >
        {!data ? (
          <Typography.Text type="secondary">正在加载章节信息...</Typography.Text>
        ) : (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="是否成功">{String(data.ok)}</Descriptions.Item>
            <Descriptions.Item label="章节号">{data.chapter ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="标题">{data.title ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="文件路径">{data.filePath ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="状态">{data.meta?.status ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="字数">{data.meta?.wordCount ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{data.meta?.updatedAt ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="问题">
              <IssueTags issues={data.meta?.auditIssues ?? []} maxVisible={2} />
            </Descriptions.Item>
            <Descriptions.Item label="错误">{data.error ?? "-"}</Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Card title="正文">
        <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
          {data?.content ?? data?.error ?? "正在加载正文..."}
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}
