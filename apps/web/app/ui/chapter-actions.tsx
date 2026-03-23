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
    const intervalMs = 3000;
    const maxWaitMs = 30 * 60 * 1000;
    const startedAt = Date.now();
    let transientFailures = 0;

    const wait = async (ms: number): Promise<void> => {
      await new Promise((resolve) => window.setTimeout(resolve, ms));
    };

    const isTransientPollError = (error: unknown): boolean => {
      if (!error || typeof error !== "object") return false;
      const maybe = error as { code?: unknown; message?: unknown; name?: unknown };
      if (maybe.code === "TRANSIENT_POLL") return true;
      if (maybe.name === "TypeError" || maybe.name === "SyntaxError" || maybe.name === "NetworkError") return true;
      if (typeof maybe.message !== "string") return false;
      const message = maybe.message.toLowerCase();
      return message.includes("failed to fetch")
        || message.includes("networkerror")
        || message.includes("network request failed")
        || message.includes("load failed")
        || message.includes("unexpected end of json input");
    };

    while (true) {
      try {
        const response = await fetch(`/api/inkos/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        if (!response.ok) {
          const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
          if (transientStatuses.has(response.status)) {
            const error = new Error(`任务状态暂时不可用(${response.status})`);
            (error as Error & { code?: string }).code = "TRANSIENT_POLL";
            throw error;
          }
          const data = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(data?.error ?? `任务状态读取失败(${response.status})`);
        }

        const raw = await response.text();
        if (!raw.trim()) {
          const error = new Error("任务状态返回空响应");
          (error as Error & { code?: string }).code = "TRANSIENT_POLL";
          throw error;
        }
        const job = JSON.parse(raw) as { status?: string; result?: unknown; error?: string };

        if (job.status === "done") return job.result;
        if (job.status === "error") throw new Error(job.error ?? "任务执行失败");
        transientFailures = 0;
      } catch (error) {
        if (isTransientPollError(error)) {
          transientFailures += 1;
          await wait(Math.min(intervalMs + transientFailures * 300, 6000));
          continue;
        }
        throw error;
      }

      if (Date.now() - startedAt >= maxWaitMs) {
        throw new Error("任务轮询超时，请稍后重试");
      }
      await wait(intervalMs);
    }
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
        maskClosable={false}
        keyboard
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
