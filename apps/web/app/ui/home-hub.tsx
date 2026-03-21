"use client";

import { ArrowRightOutlined, DeleteOutlined } from "@ant-design/icons";
import { App, Alert, Button, Card, Col, Empty, Grid, List, Popconfirm, Row, Space, Statistic, Tag, Typography } from "antd";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { CreateBookLauncher } from "./create-book-launcher";
import { labelBookStatus, labelGenre, labelPlatform } from "./labels";

interface Summary {
  readonly initialized: boolean;
  readonly projectRoot: string;
  readonly books: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly platform: string;
    readonly status: string;
    readonly chapters: number;
    readonly totalWords: number;
    readonly pendingReviews: number;
  }>;
}

export function HomeHub() {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [isPending, startTransition] = useTransition();

  async function loadSummary(): Promise<void> {
    void fetch("/api/inkos/summary", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: Summary) => setSummary(data));
  }

  useEffect(() => {
    void loadSummary();
  }, []);

  function deleteBook(bookId: string): void {
    startTransition(() => {
      void fetch(`/api/inkos/books?bookId=${encodeURIComponent(bookId)}`, {
        method: "DELETE",
      })
        .then((response) => response.json())
        .then(async (data) => {
          if (!data?.ok) {
            void message.error(data?.error ?? "删除失败");
            return;
          }
          void message.success("书籍已删除");
          await loadSummary();
        })
        .catch((error: unknown) => {
          void message.error(error instanceof Error ? error.message : String(error));
        });
    });
  }

  const pendingReviews = summary?.books.reduce((sum, book) => sum + book.pendingReviews, 0) ?? 0;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        bordered={false}
        style={{
          overflow: "hidden",
          background: "linear-gradient(135deg, rgba(236, 245, 242, 0.98) 0%, rgba(225, 239, 235, 0.96) 48%, rgba(208, 228, 223, 0.94) 100%)",
          boxShadow: "0 18px 42px rgba(60, 92, 90, 0.12)",
          border: "1px solid rgba(95, 143, 138, 0.12)",
        }}
        bodyStyle={{ padding: isMobile ? 18 : 26 }}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Typography.Text style={{ color: "rgba(58, 88, 86, 0.7)", letterSpacing: "0.18em", textTransform: "uppercase", fontSize: 12 }}>
            青云晨雾 · 书卷世界
          </Typography.Text>
          <Typography.Title level={isMobile ? 3 : 2} style={{ margin: 0, color: "#1f3536" }}>
            写作工作台
          </Typography.Title>
          <Typography.Paragraph style={{ margin: 0, color: "rgba(42, 74, 72, 0.82)", maxWidth: 720, lineHeight: 1.85 }}>
            在这里统览书卷、审计、修订与章节流转。让每一本书像宗门秘卷一样，有脉络、有锋芒，也有它自己的天命。
          </Typography.Paragraph>
        </Space>
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={12} sm={12} lg={6}>
          <Card size={isMobile ? "small" : "default"} bodyStyle={isMobile ? { padding: 16 } : { padding: 18 }} style={{ borderRadius: 22, background: "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(244,248,247,0.92) 100%)" }}>
            <Statistic title="工作区" value={summary?.initialized ? "已就绪" : "未初始化"} valueStyle={{ fontSize: isMobile ? 20 : 28, color: "#224047" }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <Card size={isMobile ? "small" : "default"} bodyStyle={isMobile ? { padding: 16 } : { padding: 18 }} style={{ borderRadius: 22, background: "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(244,248,247,0.92) 100%)" }}>
            <Statistic title="书籍数" value={summary?.books.length ?? 0} valueStyle={{ fontSize: isMobile ? 20 : 28, color: "#224047" }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <Card size={isMobile ? "small" : "default"} bodyStyle={isMobile ? { padding: 16 } : { padding: 18 }} style={{ borderRadius: 22, background: "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(244,248,247,0.92) 100%)" }}>
            <Statistic title="待审核" value={pendingReviews} valueStyle={{ fontSize: isMobile ? 20 : 28, color: "#224047" }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} lg={6}>
          <Card size={isMobile ? "small" : "default"} bodyStyle={isMobile ? { padding: 16 } : { padding: 18 }} style={{ borderRadius: 22, background: "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(244,248,247,0.92) 100%)" }}>
            <Statistic title="项目目录" value={summary?.projectRoot ? "已配置" : "未知"} valueStyle={{ fontSize: isMobile ? 20 : 28, color: "#224047" }} />
          </Card>
        </Col>
      </Row>

      {!summary?.initialized ? (
        <Alert
          type="warning"
          showIcon
          message="工作区尚未初始化"
          description={
            <Space>
              <Typography.Text>先完成模型配置和项目初始化。</Typography.Text>
              <Link href="/settings">
                <Button type="primary">打开配置</Button>
              </Link>
            </Space>
          }
        />
      ) : (
        <Card
          title={<span style={{ letterSpacing: "0.06em" }}>书籍卷册</span>}
          size={isMobile ? "small" : "default"}
          style={{ borderRadius: 24, background: "rgba(255,255,255,0.9)" }}
          extra={(
            <CreateBookLauncher
              onCreated={loadSummary}
              buttonText={isMobile ? "新建" : undefined}
              buttonType="primary"
            />
          )}
          bodyStyle={isMobile ? { padding: 12 } : { padding: 18 }}
        >
          {summary.books.length ? (
            <List
              itemLayout="vertical"
              dataSource={summary.books.slice()}
              renderItem={(book) => (
                <List.Item style={{ paddingInline: 0 }}>
                  <Card
                    size={isMobile ? "small" : "default"}
                    bodyStyle={isMobile ? { padding: 14 } : { padding: 18 }}
                    style={{
                      borderRadius: 22,
                      background: "linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(246,249,248,0.92) 100%)",
                      border: "1px solid rgba(76, 109, 108, 0.08)",
                    }}
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <Typography.Text style={{ color: "#7b8d91", letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 11 }}>
                          卷册 · {labelGenre(book.genre)}
                        </Typography.Text>
                        <Typography.Title level={isMobile ? 5 : 4} ellipsis={{ tooltip: book.title }} style={{ margin: 0, color: "#1d2a2f" }}>
                          {book.title}
                        </Typography.Title>
                        <Typography.Text type="secondary" ellipsis={{ tooltip: book.id }}>
                          ID：{book.id}
                        </Typography.Text>
                      </div>

                      <Space wrap size={[8, 8]}>
                        <Tag color="default" title={book.genre}>{labelGenre(book.genre)}</Tag>
                        <Tag color="default" title={book.platform}>{labelPlatform(book.platform)}</Tag>
                        <Tag color="cyan" title={book.status}>{labelBookStatus(book.status)}</Tag>
                        {book.pendingReviews > 0 ? <Tag color="gold">待审核 {book.pendingReviews}</Tag> : null}
                      </Space>

                      <Row gutter={[8, 8]}>
                        <Col xs={12} sm={8}>
                          <Statistic title="章节" value={book.chapters} valueStyle={{ fontSize: isMobile ? 18 : 24 }} />
                        </Col>
                        <Col xs={12} sm={8}>
                          <Statistic title="字数" value={book.totalWords} formatter={(value) => `${Number(value).toLocaleString()} 字`} valueStyle={{ fontSize: isMobile ? 18 : 24 }} />
                        </Col>
                        <Col xs={12} sm={8}>
                          <Statistic title="待审核" value={book.pendingReviews} valueStyle={{ fontSize: isMobile ? 18 : 24 }} />
                        </Col>
                      </Row>

                      <div style={{ display: "flex", gap: 8, flexDirection: isMobile ? "column" : "row" }}>
                        <Link href={`/books/${encodeURIComponent(book.id)}`} style={{ flex: 1 }}>
                          <Button block type="primary" icon={<ArrowRightOutlined />}>入卷观书</Button>
                        </Link>
                        <Popconfirm
                          cancelText="取消"
                          description={`确认删除《${book.title}》吗？`}
                          okButtonProps={{ danger: true, loading: isPending }}
                          okText="确认删除"
                          onConfirm={() => deleteBook(book.id)}
                          title="删除书籍"
                        >
                          <Button block danger icon={<DeleteOutlined />} type={isMobile ? "default" : "text"}>弃卷</Button>
                        </Popconfirm>
                      </div>
                    </Space>
                  </Card>
                </List.Item>
              )}
            />
          ) : (
            <Empty description="暂无书籍，先完成配置再创建书籍" />
          )}
        </Card>
      )}
    </Space>
  );
}
