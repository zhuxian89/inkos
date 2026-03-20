"use client";

import { App, Button, Dropdown, Input, Modal, Space, Typography } from "antd";
import type { MenuProps } from "antd";
import { useState } from "react";
import {
  buildReviseMenuItems,
  getReviseModeLabel,
  ReviseModeGuide,
  type ReviseMode,
} from "./revise-mode-guide";

const REVISE_ITEMS: MenuProps["items"] = buildReviseMenuItems();

export function ChapterActions(props: Readonly<{
  bookId: string;
  chapter: number;
  onResult?: (result: unknown) => void;
  onDone?: () => void | Promise<void>;
  compact?: boolean;
}>) {
  const { message } = App.useApp();
  const [isAuditing, setIsAuditing] = useState(false);
  const [reviseMode, setReviseMode] = useState<ReviseMode | null>(null);
  const [pendingMode, setPendingMode] = useState<ReviseMode | null>(null);
  const [instruction, setInstruction] = useState("");

  async function pollJob(jobId: string): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const response = await fetch(`/api/inkos/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
          const job = await response.json();
          if (job.status === "done") {
            clearInterval(timer);
            resolve(job.result);
            return;
          }
          if (job.status === "error") {
            clearInterval(timer);
            reject(new Error(job.error ?? "任务执行失败"));
          }
        } catch (error) {
          clearInterval(timer);
          reject(error);
        }
      }, 3000);
    });
  }

  function audit(): void {
    setIsAuditing(true);
    void fetch("/api/inkos/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookId: props.bookId, chapter: props.chapter, async: true }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data?.ok || !data?.jobId) {
          props.onResult?.(data);
          void message.error(data?.error ?? "审计失败");
          return;
        }
        const result = await pollJob(String(data.jobId));
        props.onResult?.(result);
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
        async: true,
      }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data?.ok || !data?.jobId) {
          props.onResult?.(data);
          void message.error(data?.error ?? "修订失败");
          return;
        }
        const result = await pollJob(String(data.jobId));
        props.onResult?.(result);
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

  const buttonSize = props.compact ? "middle" : "small";

  return (
    <div style={{ display: "grid", gridTemplateColumns: props.compact ? "1fr 1fr" : undefined, gap: props.compact ? 8 : 0, width: props.compact ? "100%" : undefined }}>
      <Button size={buttonSize} block={props.compact} loading={isAuditing} disabled={isBusy} onClick={audit}>审计</Button>
      <Dropdown
        trigger={["click"]}
        disabled={isBusy}
        menu={{
          items: REVISE_ITEMS,
          onClick: (evt) => openReviseModal(evt.key as ReviseMode),
        }}
      >
        <Button size={buttonSize} block={props.compact} loading={isRevising} disabled={isBusy}>修订</Button>
      </Dropdown>
      <Modal
        title={pendingMode ? `${getReviseModeLabel(pendingMode)} · 第 ${props.chapter} 章` : "修订"}
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
          {pendingMode ? <ReviseModeGuide mode={pendingMode} /> : null}
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
    </div>
  );
}
