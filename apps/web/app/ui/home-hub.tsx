"use client";

import { ArrowRightOutlined, DeleteOutlined } from "@ant-design/icons";
import { App, Alert, Button, Card, Col, Empty, List, Popconfirm, Row, Space, Statistic, Tag, Typography } from "antd";
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
      <Typography.Title level={3} style={{ marginBottom: 0 }}>
        写作工作台
      </Typography.Title>
      <Typography.Text type="secondary">
        Web 端集中管理书籍、写作与审核流程。
      </Typography.Text>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="工作区" value={summary?.initialized ? "已就绪" : "未初始化"} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="书籍数" value={summary?.books.length ?? 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="待审核" value={pendingReviews} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="项目目录" value={summary?.projectRoot ? "已配置" : "未知"} />
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
          title="书籍列表"
          extra={(
            <CreateBookLauncher onCreated={loadSummary} />
          )}
        >
          {summary.books.length ? (
            <List
              itemLayout="horizontal"
              dataSource={summary.books.slice()}
              renderItem={(book) => (
                <List.Item
                  actions={[
                    <Link href={`/books/${encodeURIComponent(book.id)}`} key="open">
                      <Button type="link" icon={<ArrowRightOutlined />}>进入工作台</Button>
                    </Link>,
                    <Popconfirm
                      cancelText="取消"
                      description={`确认删除《${book.title}》吗？`}
                      key="delete"
                      okButtonProps={{ danger: true, loading: isPending }}
                      okText="确认删除"
                      onConfirm={() => deleteBook(book.id)}
                      title="删除书籍"
                    >
                      <Button danger icon={<DeleteOutlined />} type="link">删除</Button>
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={`${book.title} (${book.id})`}
                    description={(
                      <Space wrap>
                        <Tag title={book.genre}>{labelGenre(book.genre)}</Tag>
                        <Tag title={book.platform}>{labelPlatform(book.platform)}</Tag>
                        <Tag color="blue" title={book.status}>{labelBookStatus(book.status)}</Tag>
                        <Typography.Text type="secondary">
                          {book.chapters} 章 / {book.totalWords.toLocaleString()} 字 / 待审核 {book.pendingReviews}
                        </Typography.Text>
                      </Space>
                    )}
                  />
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
