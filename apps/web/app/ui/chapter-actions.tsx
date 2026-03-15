"use client";

import { App, Button, Dropdown, Input, Modal, Space, Typography } from "antd";
import type { MenuProps } from "antd";
import { useState } from "react";

type ReviseMode = "spot-fix" | "rewrite" | "polish" | "rework";

const REVISE_ITEMS: MenuProps["items"] = [
  { key: "spot-fix", label: "定点修复（spot-fix）" },
  { key: "polish", label: "润色（polish）" },
  { key: "rewrite", label: "重写（rewrite）" },
  { key: "rework", label: "重构（rework）" },
];

export function ChapterActions(props: Readonly<{
  bookId: string;
  chapter: number;
  onResult?: (result: unknown) => void;
  onDone?: () => void | Promise<void>;
}>) {
  const { message } = App.useApp();
  const [isAuditing, setIsAuditing] = useState(false);
  const [reviseMode, setReviseMode] = useState<ReviseMode | null>(null);
  const [pendingMode, setPendingMode] = useState<ReviseMode | null>(null);
  const [instruction, setInstruction] = useState("");

  const MODE_LABELS: Record<ReviseMode, string> = {
    "spot-fix": "定点修复",
    polish: "润色",
    rewrite: "重写",
    rework: "重构",
  };

  function audit(): void {
    setIsAuditing(true);
    void fetch("/api/inkos/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookId: props.bookId, chapter: props.chapter }),
    })
      .then(async (response) => {
        const data = await response.json();
        props.onResult?.(data);
        if (!response.ok || !data?.ok) {
          void message.error(data?.error ?? "审计失败");
          return;
        }
        void message.success("审计完成");
        await props.onDone?.();
      })
      .catch((error: unknown) => {
        props.onResult?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setIsAuditing(false));
  }

  function revise(mode: ReviseMode, nextInstruction?: string): void {
    setReviseMode(mode);
    void fetch("/api/inkos/revise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId: props.bookId,
        chapter: props.chapter,
        mode,
        instruction: nextInstruction?.trim() || undefined,
      }),
    })
      .then(async (response) => {
        const data = await response.json();
        props.onResult?.(data);
        if (!response.ok || !data?.ok) {
          void message.error(data?.error ?? "修订失败");
          return;
        }
        void message.success("修订完成");
        await props.onDone?.();
      })
      .catch((error: unknown) => {
        props.onResult?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setReviseMode(null);
        setPendingMode(null);
        setInstruction("");
      });
  }

  function openReviseModal(mode: ReviseMode): void {
    setPendingMode(mode);
    setInstruction("");
  }

  const isRevising = reviseMode !== null;
  const isBusy = isAuditing || isRevising;

  return (
    <Space>
      <Button size="small" loading={isAuditing} disabled={isBusy} onClick={audit}>审计</Button>
      <Dropdown
        trigger={["click"]}
        disabled={isBusy}
        menu={{
          items: REVISE_ITEMS,
          onClick: (evt) => openReviseModal(evt.key as ReviseMode),
        }}
      >
        <Button size="small" loading={isRevising} disabled={isBusy}>修订</Button>
      </Dropdown>
      <Modal
        title={pendingMode ? `${MODE_LABELS[pendingMode]} · 第 ${props.chapter} 章` : "修订"}
        open={pendingMode !== null}
        onCancel={() => {
          if (isRevising) return;
          setPendingMode(null);
          setInstruction("");
        }}
        onOk={() => {
          if (!pendingMode) return;
          revise(pendingMode, instruction);
        }}
        okText="开始修订"
        cancelText="取消"
        confirmLoading={isRevising}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            可选填写这次修订的额外要求。不填也会按当前模式和审计结果自动处理。
          </Typography.Text>
          <Input.TextArea
            rows={5}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="例如：压缩前半段铺垫；把男主反击写得更狠；结尾钩子更强。"
          />
        </Space>
      </Modal>
    </Space>
  );
}
