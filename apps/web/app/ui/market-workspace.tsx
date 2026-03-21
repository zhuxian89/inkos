"use client";

import { Alert, Button, Card, List, Modal, Popconfirm, Progress, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";

interface RadarRecommendation {
  readonly platform: string;
  readonly genre: string;
  readonly concept: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly benchmarkTitles: ReadonlyArray<string>;
}

interface RadarParsed {
  readonly recommendations?: ReadonlyArray<RadarRecommendation>;
  readonly marketSummary?: string;
  readonly timestamp?: string;
  readonly savedTo?: string;
}

interface RadarCommandResult {
  readonly ok: boolean;
  readonly parsed?: RadarParsed;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

interface RadarHistoryItem {
  readonly id: string;
  readonly filename: string;
  readonly path: string;
  readonly timestamp: string;
  readonly recommendationCount: number;
  readonly marketSummary: string;
  readonly size: number;
}

export function MarketWorkspace() {
  const [result, setResult] = useState<RadarCommandResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [history, setHistory] = useState<ReadonlyArray<RadarHistoryItem>>([]);
  const [selectedHistory, setSelectedHistory] = useState<{ id: string; data: unknown } | null>(null);

  const parsed = result?.parsed;
  const recommendations = parsed?.recommendations ?? [];

  async function loadHistory(): Promise<void> {
    const response = await fetch("/api/inkos/radar/history", { cache: "no-store" });
    const data = await response.json();
    setHistory(Array.isArray(data.scans) ? data.scans : []);
  }

  useEffect(() => {
    void loadHistory();
  }, []);

  function runRadar(): void {
    if (isRunning) return;
    setIsRunning(true);
    void fetch("/api/inkos/commands/radar.scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: {} }),
    })
      .then((response) => response.json())
      .then(async (data: RadarCommandResult) => {
        setResult(data);
        await loadHistory();
      })
      .finally(() => setIsRunning(false));
  }

  function openHistoryDetail(id: string): void {
    void fetch(`/api/inkos/radar/history/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!data?.ok) throw new Error(data?.error ?? "读取历史失败");
        setSelectedHistory({ id, data: data.data });
      });
  }

  function deleteHistory(id: string): void {
    void fetch(`/api/inkos/radar/history/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then((response) => response.json())
      .then(async () => {
        if (selectedHistory?.id === id) {
          setSelectedHistory(null);
        }
        await loadHistory();
      });
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={<span style={{ color: "#f2f7f6" }}>市场趋势</span>}
        extra={<Button type="primary" loading={isRunning} onClick={runRadar}>扫描趋势</Button>}
        style={{ borderRadius: 24, overflow: "hidden", background: "linear-gradient(135deg, rgba(16,29,35,0.96) 0%, rgba(33,55,60,0.92) 52%, rgba(102,128,121,0.84) 100%)" }}
      >
        <Typography.Paragraph style={{ marginBottom: 0, color: "rgba(227, 236, 234, 0.8)" }}>
          这个功能对应 `radar scan`。它会抓取番茄和起点的热榜数据，再整理成开书建议和对标书，适合在开新书前先做市场研究。
        </Typography.Paragraph>
      </Card>

      <Card title="扫描历史" style={{ borderRadius: 22, background: "rgba(255,255,255,0.9)" }}>
        {history.length === 0 ? (
          <Typography.Text type="secondary">暂无扫描历史。</Typography.Text>
        ) : (
          <List
            dataSource={history.slice()}
            renderItem={(item) => (
              <List.Item key={item.id}>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Space wrap>
                    <Tag>{item.timestamp}</Tag>
                    <Tag color="cyan">建议 {item.recommendationCount}</Tag>
                    <Tag>{(item.size / 1024).toFixed(1)} KB</Tag>
                  </Space>
                  <Typography.Text>{item.marketSummary.slice(0, 120) || item.filename}</Typography.Text>
                  <Space>
                    <Button size="small" onClick={() => openHistoryDetail(item.id)}>详情</Button>
                    <Popconfirm title="确认删除这条扫描历史吗？" onConfirm={() => deleteHistory(item.id)}>
                      <Button size="small" danger>删除</Button>
                    </Popconfirm>
                  </Space>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      {!result ? (
        <Card>
          <Typography.Text type="secondary">点击“扫描趋势”后，这里会显示当前市场概述和开书建议。</Typography.Text>
        </Card>
      ) : !result.ok ? (
        <Alert
          type="error"
          showIcon
          message="趋势扫描失败"
          description={<pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>}
        />
      ) : (
        <>
          <Card title="市场概述" extra={parsed?.timestamp ? <Tag>{parsed.timestamp}</Tag> : null}>
            <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
              {parsed?.marketSummary || "暂无市场概述。"}
            </Typography.Paragraph>
            {parsed?.savedTo ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                结果已保存到：{parsed.savedTo}
              </Typography.Paragraph>
            ) : null}
          </Card>

          <Card title={`开书建议 (${recommendations.length})`}>
            <List
              dataSource={recommendations.slice()}
              renderItem={(item, index) => (
                <List.Item key={`${item.platform}-${item.genre}-${index}`}>
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    <Space wrap>
                      <Tag color="blue">{item.platform}</Tag>
                      <Tag>{item.genre}</Tag>
                      <Typography.Text strong>{item.concept}</Typography.Text>
                    </Space>
                    <div>
                      <Typography.Text type="secondary">匹配度</Typography.Text>
                      <Progress percent={Math.round(item.confidence * 100)} size="small" style={{ marginTop: 4, maxWidth: 320 }} />
                    </div>
                    <Typography.Paragraph style={{ marginBottom: 0 }}>
                      {item.reasoning}
                    </Typography.Paragraph>
                    {item.benchmarkTitles.length > 0 ? (
                      <Space wrap>
                        <Typography.Text type="secondary">对标书：</Typography.Text>
                        {item.benchmarkTitles.map((title) => <Tag key={title}>{title}</Tag>)}
                      </Space>
                    ) : null}
                  </Space>
                </List.Item>
              )}
            />
          </Card>

          <Card title="原始结果">
            <pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>
          </Card>
        </>
      )}

      <Modal
        open={Boolean(selectedHistory)}
        onCancel={() => setSelectedHistory(null)}
        footer={null}
        maskClosable={false}
        keyboard
        width="min(960px, 94vw)"
        title={selectedHistory ? `扫描历史 · ${selectedHistory.id}` : "扫描历史"}
        destroyOnClose
      >
        {selectedHistory ? (() => {
          const detail = selectedHistory.data as RadarParsed;
          const detailRecommendations = detail?.recommendations ?? [];
          return (
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <Card size="small" style={{ borderRadius: 18, background: "rgba(255,255,255,0.92)" }}>
                <Space wrap size={[8, 8]}>
                  {detail?.timestamp ? <Tag>{detail.timestamp}</Tag> : null}
                  <Tag color="cyan">建议 {detailRecommendations.length}</Tag>
                  <Tag>{selectedHistory.id}</Tag>
                </Space>
              </Card>

              <Card title="市场概述" size="small" style={{ borderRadius: 18, background: "rgba(255,255,255,0.92)" }}>
                <Typography.Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                  {detail?.marketSummary || "暂无市场概述。"}
                </Typography.Paragraph>
              </Card>

              <Card title={`开书建议 (${detailRecommendations.length})`} size="small" style={{ borderRadius: 18, background: "rgba(255,255,255,0.92)" }}>
                <List
                  dataSource={detailRecommendations.slice()}
                  renderItem={(item, index) => (
                    <List.Item key={`${item.platform}-${item.genre}-${index}`}>
                      <Space direction="vertical" size={10} style={{ width: "100%" }}>
                        <Space wrap>
                          <Tag color="blue">{item.platform}</Tag>
                          <Tag>{item.genre}</Tag>
                          <Typography.Text strong>{item.concept}</Typography.Text>
                        </Space>
                        <div>
                          <Typography.Text type="secondary">匹配度</Typography.Text>
                          <Progress percent={Math.round(item.confidence * 100)} size="small" style={{ marginTop: 4, maxWidth: 320 }} />
                        </div>
                        <Typography.Paragraph style={{ marginBottom: 0 }}>{item.reasoning}</Typography.Paragraph>
                        {item.benchmarkTitles.length > 0 ? (
                          <Space wrap>
                            <Typography.Text type="secondary">对标书：</Typography.Text>
                            {item.benchmarkTitles.map((title) => <Tag key={title}>{title}</Tag>)}
                          </Space>
                        ) : null}
                      </Space>
                    </List.Item>
                  )}
                />
              </Card>

              <Card title="原始 JSON" size="small" style={{ borderRadius: 18, background: "rgba(255,255,255,0.92)" }}>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "28vh", overflow: "auto" }}>
                  {JSON.stringify(selectedHistory.data, null, 2)}
                </pre>
              </Card>
            </Space>
          );
        })() : null}
      </Modal>
    </Space>
  );
}
