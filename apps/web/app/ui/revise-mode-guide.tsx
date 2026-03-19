"use client";

import { Alert, Space, Tag, Typography } from "antd";
import type { MenuProps } from "antd";
import type { ReactNode } from "react";

export type ReviseMode = "spot-fix" | "rewrite" | "polish" | "rework";

interface ReviseModeMeta {
  readonly mode: ReviseMode;
  readonly title: string;
  readonly label: string;
  readonly shortHint: string;
  readonly bestFor: string;
  readonly avoidWhen: string;
  readonly recommended?: string;
}

export const REVISE_MODE_ORDER: ReadonlyArray<ReviseMode> = [
  "spot-fix",
  "polish",
  "rewrite",
  "rework",
];

export const REVISE_MODE_META: Record<ReviseMode, ReviseModeMeta> = {
  "spot-fix": {
    mode: "spot-fix",
    title: "定点修复",
    label: "定点修复（spot-fix）",
    shortHint: "只修 1-2 个定位很清楚的问题",
    bestFor: "数值、称谓、时间线、单句 OOC、正文与真相文件的一两处小冲突。",
    avoidWhen: "设定冲突已经蔓延到多段，或审计问题涉及节奏、结构、支线推进。",
  },
  polish: {
    mode: "polish",
    title: "润色",
    label: "润色（polish）",
    shortHint: "事实没错，只是表达不够好",
    bestFor: "台词不顺、文风发虚、轻度流水账、AI 味偏重，但剧情和事实基本没问题。",
    avoidWhen: "需要改剧情因果、增删场景，或审计指出的是设定/结构层问题。",
  },
  rewrite: {
    mode: "rewrite",
    title: "重写",
    label: "重写（rewrite）",
    shortHint: "多数审计问题先选它",
    bestFor: "一章里有多个中等问题，事实大体正确，但叙述顺序、画面力度、钩子、角色反应都需要重写。",
    avoidWhen: "只想修一两个小点，或你已经确认整章骨架都要重搭。",
    recommended: "多数审计不过时，先用这个最稳。",
  },
  rework: {
    mode: "rework",
    title: "重构",
    label: "重构（rework）",
    shortHint: "章节骨架有问题时再用",
    bestFor: "节奏崩、爽点没落地、冲突组织失衡、支线推进方式不对，需要重排整章结构。",
    avoidWhen: "只是文句不好看，或者只存在一两处单点错误。",
  },
};

export function getReviseModeLabel(mode: ReviseMode): string {
  return REVISE_MODE_META[mode].title;
}

function renderModeLabel(meta: ReviseModeMeta, compact = false): ReactNode {
  return (
    <Space direction="vertical" size={compact ? 0 : 2} style={{ width: "100%" }}>
      <Space size={8} wrap>
        <Typography.Text strong>{meta.label}</Typography.Text>
        {meta.recommended ? <Tag color="blue">推荐</Tag> : null}
      </Space>
      <Typography.Text type="secondary">{meta.shortHint}</Typography.Text>
    </Space>
  );
}

export function buildReviseMenuItems(): MenuProps["items"] {
  return REVISE_MODE_ORDER.map((mode) => ({
    key: mode,
    label: renderModeLabel(REVISE_MODE_META[mode]),
  }));
}

export function buildReviseSelectOptions(): Array<{ value: ReviseMode; label: ReactNode }> {
  return REVISE_MODE_ORDER.map((mode) => ({
    value: mode,
    label: renderModeLabel(REVISE_MODE_META[mode], true),
  }));
}

export function ReviseModeGuide(props: Readonly<{ mode: ReviseMode }>) {
  const meta = REVISE_MODE_META[props.mode];

  return (
    <Alert
      type={meta.mode === "rewrite" ? "info" : "warning"}
      showIcon
      message={(
        <Space size={8} wrap>
          <Typography.Text strong>{meta.title}</Typography.Text>
          {meta.recommended ? <Tag color="blue">{meta.recommended}</Tag> : null}
        </Space>
      )}
      description={(
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          <Typography.Text type="secondary">适合：{meta.bestFor}</Typography.Text>
          <Typography.Text type="secondary">别用在：{meta.avoidWhen}</Typography.Text>
        </Space>
      )}
    />
  );
}
