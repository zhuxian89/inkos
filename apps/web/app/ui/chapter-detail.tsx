"use client";

import { Button, Card, Descriptions, Space, Typography, message } from "antd";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { IssueTags } from "./issue-tags";

interface DetailResponse {
  readonly ok: boolean;
  readonly bookId?: string;
  readonly chapter?: number;
  readonly title?: string;
  readonly filePath?: string;
  readonly rawContent?: string;
  readonly content?: string;
  readonly meta?: {
    readonly status: string;
    readonly wordCount: number;
    readonly auditIssues: ReadonlyArray<string>;
    readonly updatedAt: string;
  } | null;
  readonly error?: string;
}

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
}

interface ChaptersResponse {
  readonly chapters?: ReadonlyArray<ChapterMeta>;
}

export function ChapterDetailPage(props: Readonly<{ bookId: string; chapter: string }>) {
  const { bookId, chapter } = props;
  const [data, setData] = useState<DetailResponse | null>(null);
  const [chapters, setChapters] = useState<ReadonlyArray<ChapterMeta>>([]);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapter)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((json: DetailResponse) => setData(json));
  }, [bookId, chapter]);

  useEffect(() => {
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters`, { cache: "no-store" })
      .then((response) => response.json())
      .then((json: ChaptersResponse) => setChapters(json.chapters ?? []));
  }, [bookId]);

  const currentChapterNumber = Number.parseInt(chapter, 10);
  const currentChapterIndex = useMemo(
    () => chapters.findIndex((item) => item.number === currentChapterNumber),
    [chapters, currentChapterNumber],
  );
  const previousChapter = currentChapterIndex > 0 ? chapters[currentChapterIndex - 1] : null;
  const nextChapter = currentChapterIndex >= 0 && currentChapterIndex < chapters.length - 1
    ? chapters[currentChapterIndex + 1]
    : null;

  async function copyToClipboard(text: string): Promise<boolean> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fallback below.
      }
    }

    if (typeof document === "undefined") return false;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function copyChapterContent(): void {
    const content = data?.rawContent ?? data?.content;
    if (!content) {
      void messageApi.warning("当前没有可复制的 Markdown 源文");
      return;
    }
    void copyToClipboard(content).then((ok) => {
      if (ok) {
        void messageApi.success("已复制 Markdown 源文到剪贴板");
      } else {
        void messageApi.error("复制失败，请稍后重试");
      }
    });
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {contextHolder}
      <Card
        style={{
          borderRadius: 24,
          background: "rgba(255,255,255,0.94)",
        }}
        title={<span style={{ color: "#21353b" }}>{`章节详情 · ${bookId} / ${chapter}`}</span>}
        extra={(
          <Space wrap>
            {previousChapter ? (
              <Link href={`/books/${encodeURIComponent(bookId)}/chapters/${previousChapter.number}`}>
                <Button>{`上一章 · ${previousChapter.number}`}</Button>
              </Link>
            ) : (
              <Button disabled>上一章</Button>
            )}
            {nextChapter ? (
              <Link href={`/books/${encodeURIComponent(bookId)}/chapters/${nextChapter.number}`}>
                <Button type="primary">{`下一章 · ${nextChapter.number}`}</Button>
              </Link>
            ) : (
              <Button type="primary" disabled>下一章</Button>
            )}
            <Link href={`/books/${encodeURIComponent(bookId)}`}><Button>返回工作台</Button></Link>
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

      <Card
        title="正文"
        extra={(
          <Button onClick={copyChapterContent} disabled={!data?.rawContent && !data?.content}>
            复制 Markdown 源文
          </Button>
        )}
        bodyStyle={{
          padding: 0,
          background:
            "radial-gradient(circle at top, rgba(255,249,230,0.96), rgba(244,232,204,0.96) 58%, rgba(233,219,188,0.96))",
        }}
      >
        <div
          style={{
            maxWidth: 880,
            margin: "0 auto",
            padding: "40px 36px 48px",
            minHeight: 520,
            background:
              "linear-gradient(180deg, rgba(255,251,236,0.88), rgba(245,235,208,0.92))",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.75), 0 18px 40px rgba(96,74,40,0.08)",
            borderLeft: "1px solid rgba(125,92,48,0.12)",
            borderRight: "1px solid rgba(125,92,48,0.12)",
          }}
        >
          <Typography.Paragraph
            style={{
              whiteSpace: "pre-wrap",
              marginBottom: 0,
              fontSize: 19,
              lineHeight: 2.05,
              color: "#3b2f22",
              letterSpacing: "0.02em",
              fontFamily: "\"Songti SC\", \"STSong\", \"Noto Serif SC\", serif",
            }}
          >
            {data?.content ?? data?.error ?? "正在加载正文..."}
          </Typography.Paragraph>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 32,
              paddingTop: 24,
              borderTop: "1px solid rgba(125,92,48,0.16)",
            }}
          >
            {previousChapter ? (
              <Link href={`/books/${encodeURIComponent(bookId)}/chapters/${previousChapter.number}`}>
                <Button>{`← 上一章 · ${previousChapter.number}`}</Button>
              </Link>
            ) : (
              <Button disabled>{"← 上一章"}</Button>
            )}
            {nextChapter ? (
              <Link href={`/books/${encodeURIComponent(bookId)}/chapters/${nextChapter.number}`}>
                <Button type="primary">{`下一章 · ${nextChapter.number} →`}</Button>
              </Link>
            ) : (
              <Button type="primary" disabled>{"下一章 →"}</Button>
            )}
          </div>
        </div>
      </Card>
    </Space>
  );
}
