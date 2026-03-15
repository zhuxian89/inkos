"use client";

import { Popover, Space, Tag, Typography } from "antd";

function shorten(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function IssueTags({
  issues,
  maxVisible = 3,
  maxLen = 36,
}: Readonly<{
  issues: ReadonlyArray<string>;
  maxVisible?: number;
  maxLen?: number;
}>) {
  if (!issues.length) {
    return <Typography.Text type="secondary">-</Typography.Text>;
  }

  const visible = issues.slice(0, Math.max(0, maxVisible));
  const hidden = issues.slice(Math.max(0, maxVisible));

  const popoverContent = (
    <div style={{ maxWidth: 640, maxHeight: 360, overflow: "auto" }}>
      <Typography.Text type="secondary">
        {issues.length} 条问题
      </Typography.Text>
      <div style={{ marginTop: 8 }}>
        {issues.map((issue, index) => (
          <Typography.Paragraph key={`${index}-${issue}`} style={{ marginBottom: 8 }}>
            {issue}
          </Typography.Paragraph>
        ))}
      </div>
    </div>
  );

  return (
    <Space wrap size={[4, 6]}>
      {visible.map((issue, index) => {
        const tag = (
          <Tag key={`${index}-${issue}`}>
            <span
              style={{
                display: "inline-block",
                maxWidth: 260,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                verticalAlign: "bottom",
              }}
            >
              {shorten(issue, maxLen)}
            </span>
          </Tag>
        );

        if (issue.length <= maxLen) return tag;

        return (
          <Popover
            key={`${index}-${issue}`}
            content={<Typography.Paragraph style={{ marginBottom: 0, maxWidth: 640 }}>{issue}</Typography.Paragraph>}
            trigger="click"
          >
            {tag}
          </Popover>
        );
      })}
      {hidden.length ? (
        <Popover content={popoverContent} trigger="click">
          <Tag style={{ cursor: "pointer" }} title="点击查看全部问题">
            ...（{hidden.length}）
          </Tag>
        </Popover>
      ) : null}
    </Space>
  );
}
