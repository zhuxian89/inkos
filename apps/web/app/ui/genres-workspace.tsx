"use client";

import { App, Alert, Button, Card, Checkbox, Col, Form, Input, Row, Space, Typography } from "antd";
import { useEffect, useState } from "react";

interface GenreItem {
  readonly id: string;
  readonly name: string;
  readonly source: "builtin" | "project";
}

interface CommandResult {
  readonly ok: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

interface CreateGenreValues {
  readonly id: string;
  readonly name?: string;
  readonly numerical?: boolean;
  readonly power?: boolean;
  readonly era?: boolean;
}

function parseGenreList(stdout: string): ReadonlyArray<GenreItem> {
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*([^\s]+)\s+(.+?)\s+\[(builtin|project)\]\s*$/))
    .filter((entry): entry is RegExpMatchArray => entry !== null)
    .map((entry) => ({
      id: entry[1]!,
      name: entry[2]!.trim(),
      source: entry[3]! as "builtin" | "project",
    }));
}

export function GenresWorkspace() {
  const { message } = App.useApp();
  const [genres, setGenres] = useState<ReadonlyArray<GenreItem>>([]);
  const [selectedGenreId, setSelectedGenreId] = useState<string>("");
  const [detail, setDetail] = useState<string>("");
  const [result, setResult] = useState<CommandResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isShowing, setIsShowing] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [form] = Form.useForm<CreateGenreValues>();

  async function runCommand(commandId: string, values: Record<string, unknown>): Promise<CommandResult> {
    const response = await fetch(`/api/inkos/commands/${commandId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
    });
    return response.json() as Promise<CommandResult>;
  }

  async function loadGenres(): Promise<void> {
    setIsLoading(true);
    try {
      const data = await runCommand("genre.list", {});
      setResult(data);
      const nextGenres = parseGenreList(data.stdout ?? "");
      setGenres(nextGenres);
      if (!selectedGenreId && nextGenres.length > 0) {
        setSelectedGenreId(nextGenres[0]!.id);
      }
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    form.setFieldsValue({ numerical: false, power: false, era: false });
    void loadGenres();
  }, [form]);

  function showGenre(genreId: string): void {
    setSelectedGenreId(genreId);
    setIsShowing(true);
    void runCommand("genre.show", { id: genreId })
      .then((data) => {
        setResult(data);
        setDetail(data.stdout ?? data.stderr ?? data.error ?? "");
      })
      .finally(() => setIsShowing(false));
  }

  function copyGenre(): void {
    if (!selectedGenreId) return;
    setIsCopying(true);
    void runCommand("genre.copy", { id: selectedGenreId })
      .then(async (data) => {
        setResult(data);
        if (data.ok) {
          void message.success("题材已复制到项目目录");
          await loadGenres();
        } else {
          void message.error(data.error ?? data.stderr ?? "复制失败");
        }
      })
      .finally(() => setIsCopying(false));
  }

  function createGenre(values: CreateGenreValues): void {
    setIsCreating(true);
    void runCommand("genre.create", { ...values })
      .then(async (data) => {
        setResult(data);
        if (data.ok) {
          void message.success("题材已创建");
          form.resetFields();
          form.setFieldsValue({ numerical: false, power: false, era: false });
          await loadGenres();
        } else {
          void message.error(data.error ?? data.stderr ?? "创建失败");
        }
      })
      .finally(() => setIsCreating(false));
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card>
        <Typography.Title level={4}>题材库</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这里管理内置题材和项目自定义题材。查看规则、复制到项目、或者从零创建新题材，都在这一页完成。
        </Typography.Paragraph>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={8}>
          <Card
            title="题材列表"
            extra={<Button loading={isLoading} onClick={() => void loadGenres()}>刷新</Button>}
          >
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              {genres.map((genre) => (
                <Button
                  key={`${genre.id}-${genre.source}`}
                  type={selectedGenreId === genre.id ? "primary" : "default"}
                  block
                  onClick={() => showGenre(genre.id)}
                >
                  {genre.name} ({genre.id}) {genre.source === "project" ? "· 项目" : "· 内置"}
                </Button>
              ))}
              {genres.length === 0 ? <Typography.Text type="secondary">暂无题材数据。</Typography.Text> : null}
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={16}>
          <Card
            title={selectedGenreId ? `题材详情 · ${selectedGenreId}` : "题材详情"}
            extra={<Button loading={isCopying} disabled={!selectedGenreId} onClick={copyGenre}>复制到项目</Button>}
          >
            {!selectedGenreId ? (
              <Typography.Text type="secondary">先从左侧选择一个题材。</Typography.Text>
            ) : detail ? (
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{detail}</pre>
            ) : (
              <Button loading={isShowing} onClick={() => showGenre(selectedGenreId)}>加载详情</Button>
            )}
          </Card>
        </Col>
      </Row>

      <Card title="创建新题材">
        <Form layout="vertical" form={form} onFinish={createGenre}>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item label="题材 ID" name="id" rules={[{ required: true }]}>
                <Input placeholder="如 wuxia / romance" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label="显示名称" name="name">
                <Input placeholder="如 武侠 / 言情" />
              </Form.Item>
            </Col>
          </Row>
          <Space size={24} wrap style={{ marginBottom: 16 }}>
            <Form.Item name="numerical" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>启用数值系统</Checkbox>
            </Form.Item>
            <Form.Item name="power" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>启用战力体系</Checkbox>
            </Form.Item>
            <Form.Item name="era" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Checkbox>启用年代考据</Checkbox>
            </Form.Item>
          </Space>
          <Button type="primary" htmlType="submit" loading={isCreating}>创建题材</Button>
        </Form>
      </Card>

      {result ? (
        <Card title="最近结果">
          <Alert type={result.ok ? "success" : "error"} showIcon message={<pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>} />
        </Card>
      ) : null}
    </Space>
  );
}
