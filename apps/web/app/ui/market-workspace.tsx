"use client";

import { Alert, Button, Card, List, Progress, Space, Tag, Typography } from "antd";
import { useState } from "react";

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

export function MarketWorkspace() {
  const [result, setResult] = useState<RadarCommandResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const parsed = result?.parsed;
  const recommendations = parsed?.recommendations ?? [];

  function runRadar(): void {
    if (isRunning) return;
    setIsRunning(true);
    void fetch("/api/inkos/commands/radar.scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: {} }),
    })
      .then((response) => response.json())
      .then((data: RadarCommandResult) => setResult(data))
      .finally(() => setIsRunning(false));
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title="市场趋势"
        extra={<Button type="primary" loading={isRunning} onClick={runRadar}>扫描趋势</Button>}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这个功能对应 `radar scan`。它会抓取番茄和起点的热榜数据，再整理成开书建议和对标书，适合在开新书前先做市场研究。
        </Typography.Paragraph>
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
    </Space>
  );
}
