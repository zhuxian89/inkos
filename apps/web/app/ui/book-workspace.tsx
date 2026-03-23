"use client";

import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Tabs,
  Tag,
  Typography,
  Upload,
  Grid,
} from "antd";
import { UploadOutlined } from "@ant-design/icons";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookChapters } from "./book-chapters";
import { ChatPanel } from "./chat-panel";
import { ChatFactLogPanel } from "./chat-fact-log-panel";
import { clearPersistedChatSession, loadPersistedChatSession, savePersistedChatSession } from "./chat-persistence";
import { CHAT_MODAL_BODY_HEIGHT, CHAT_MODAL_WIDTH } from "./chat-modal";
import { labelBookStatus, labelGenre, labelPlatform } from "./labels";

interface ChapterStatus {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssues: ReadonlyArray<string>;
}

interface BookStatusResponse {
  readonly ok: boolean;
  readonly status?: {
    readonly title: string;
    readonly genre: string;
    readonly platform: string;
    readonly status: string;
    readonly chaptersWritten: number;
    readonly totalWords: number;
    readonly nextChapter: number;
    readonly chapters: ReadonlyArray<ChapterStatus>;
  };
  readonly error?: string;
}

interface WriteValues {
  readonly count: number;
  readonly words?: number;
  readonly context?: string;
}

interface BookConfigResponse {
  readonly ok: boolean;
  readonly book?: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly platform: string;
    readonly status: string;
    readonly targetChapters: number;
    readonly chapterWordCount: number;
  };
  readonly error?: string;
}

interface BookSettingsValues {
  readonly genre: "xuanhuan" | "xianxia" | "chuanyue" | "urban" | "horror" | "other";
  readonly platform: "tomato" | "feilu" | "qidian" | "other";
  readonly status: "incubating" | "outlining" | "active" | "paused" | "completed" | "dropped";
  readonly targetChapters: number;
  readonly chapterWordCount: number;
}

interface ExportValues {
  readonly format: "txt" | "md";
  readonly output?: string;
  readonly approvedOnly?: boolean;
}

interface StyleImportValues {
  readonly name?: string;
  readonly statsOnly?: boolean;
}

interface CanonValues {
  readonly from: string;
}

interface InitAssistantMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
}

interface InitAssistantResult {
  readonly ok: boolean;
  readonly reply?: string;
  readonly brief?: string;
  readonly reasoning?: string;
  readonly error?: string;
}

interface LlmProfile {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly isActive: boolean;
}

interface LlmProfilesResponse {
  readonly ok: boolean;
  readonly profiles: ReadonlyArray<LlmProfile>;
  readonly activeProfileId: string | null;
}

const BOOK_ASSISTANT_CHAT_STORAGE_PREFIX = "inkos.book-init-chat.";
const BOOK_ASSISTANT_BRIEF_STORAGE_PREFIX = "inkos.book-init-brief.";
const BOOK_ASSISTANT_OPTIONS_STORAGE_PREFIX = "inkos.book-init-options.";
const BOOK_ASSISTANT_PROFILE_STORAGE_PREFIX = "inkos.book-init-profile.";

export function BookWorkspace({ bookId }: Readonly<{ bookId: string }>) {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [statusData, setStatusData] = useState<BookStatusResponse | null>(null);
  const [bookConfigData, setBookConfigData] = useState<BookConfigResponse | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [writeStep, setWriteStep] = useState<string | null>(null);
  const [isWriting, setIsWriting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [authorBrief, setAuthorBrief] = useState("");
  const [isSavingBrief, setIsSavingBrief] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [toolAction, setToolAction] = useState<string | null>(null);
  const [assistantMessages, setAssistantMessages] = useState<ReadonlyArray<InitAssistantMessage>>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [chatting, setChatting] = useState(false);
  const [assistantJobId, setAssistantJobId] = useState<string | null>(null);
  const [assistantChatError, setAssistantChatError] = useState<string | null>(null);
  const [assistantLogOpen, setAssistantLogOpen] = useState(false);
  const [assistantModalOpen, setAssistantModalOpen] = useState(false);
  const [assistantUseStream, setAssistantUseStream] = useState(true);
  const [assistantIncludeReasoning, setAssistantIncludeReasoning] = useState(false);
  const [assistantProfiles, setAssistantProfiles] = useState<ReadonlyArray<LlmProfile>>([]);
  const [assistantProfileId, setAssistantProfileId] = useState<string | undefined>(undefined);
  const [styleFile, setStyleFile] = useState<File | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [writeForm] = Form.useForm<WriteValues>();
  const [settingsForm] = Form.useForm<BookSettingsValues>();
  const [exportForm] = Form.useForm<ExportValues>();
  const [styleForm] = Form.useForm<StyleImportValues>();
  const [canonForm] = Form.useForm<CanonValues>();

  function assistantChatStorageKey(): string {
    return `${BOOK_ASSISTANT_CHAT_STORAGE_PREFIX}${bookId}`;
  }

  function assistantSessionKey(): string {
    return `book:${bookId}`;
  }

  function assistantBriefStorageKey(): string {
    return `${BOOK_ASSISTANT_BRIEF_STORAGE_PREFIX}${bookId}`;
  }

  function assistantOptionsStorageKey(): string {
    return `${BOOK_ASSISTANT_OPTIONS_STORAGE_PREFIX}${bookId}`;
  }

  function assistantProfileStorageKey(): string {
    return `${BOOK_ASSISTANT_PROFILE_STORAGE_PREFIX}${bookId}`;
  }

  function loadStoredAssistantMessages(): ReadonlyArray<InitAssistantMessage> {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(assistantChatStorageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ReadonlyArray<InitAssistantMessage>;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function persistAssistantMessages(messages: ReadonlyArray<InitAssistantMessage>): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(assistantChatStorageKey(), JSON.stringify(messages));
    void savePersistedChatSession("book-chat", assistantSessionKey(), {
      bookId,
      title: bookConfigData?.book?.title ?? bookId,
      messages,
      meta: { source: "book-workspace" },
    });
  }

  function persistAssistantBrief(brief: string): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(assistantBriefStorageKey(), brief);
  }

  function loadStoredAssistantOptions(): { readonly useStream: boolean; readonly includeReasoning: boolean } {
    if (typeof window === "undefined") {
      return { useStream: true, includeReasoning: false };
    }
    try {
      const raw = window.localStorage.getItem(assistantOptionsStorageKey());
      if (!raw) return { useStream: true, includeReasoning: false };
      const parsed = JSON.parse(raw) as { useStream?: boolean; includeReasoning?: boolean };
      return {
        useStream: parsed.useStream !== false,
        includeReasoning: parsed.includeReasoning === true,
      };
    } catch {
      return { useStream: true, includeReasoning: false };
    }
  }

  function persistAssistantOptions(options: { readonly useStream: boolean; readonly includeReasoning: boolean }): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(assistantOptionsStorageKey(), JSON.stringify(options));
  }

  function loadStoredAssistantProfileId(): string | undefined {
    if (typeof window === "undefined") return undefined;
    const value = window.localStorage.getItem(assistantProfileStorageKey());
    return value?.trim() ? value : undefined;
  }

  function persistAssistantProfileId(profileId?: string): void {
    if (typeof window === "undefined") return;
    if (profileId?.trim()) {
      window.localStorage.setItem(assistantProfileStorageKey(), profileId.trim());
      return;
    }
    window.localStorage.removeItem(assistantProfileStorageKey());
  }

  async function loadAssistantProfiles(): Promise<void> {
    const response = await fetch("/api/inkos/llm-profiles", { cache: "no-store" });
    const data = (await response.json()) as LlmProfilesResponse;
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    setAssistantProfiles(profiles);
    const stored = loadStoredAssistantProfileId();
    const fallback = data.activeProfileId ?? profiles.find((item) => item.isActive)?.id;
    const selected = stored && profiles.some((item) => item.id === stored) ? stored : fallback ?? undefined;
    setAssistantProfileId(selected);
    persistAssistantProfileId(selected);
  }

  async function pollJob(jobId: string): Promise<unknown> {
    const intervalMs = 3000;
    const maxTransientFailures = 12;
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
      if (maybe.name === "TypeError") return true;
      if (typeof maybe.message !== "string") return false;
      const message = maybe.message.toLowerCase();
      return message.includes("failed to fetch")
        || message.includes("networkerror")
        || message.includes("network request failed")
        || message.includes("load failed");
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

        const job = await response.json() as { status?: string; result?: unknown; error?: string };
        if (job.status === "done") {
          return job.result;
        }
        if (job.status === "cancelled") {
          const error = new Error(job.error ?? "任务已取消");
          (error as Error & { code?: string }).code = "JOB_CANCELLED";
          throw error;
        }
        if (job.status === "error") {
          throw new Error(job.error ?? "任务执行失败");
        }

        transientFailures = 0;
      } catch (error) {
        if (isCancelledError(error)) throw error;
        if (isTransientPollError(error) && transientFailures < maxTransientFailures) {
          transientFailures += 1;
          await wait(Math.min(intervalMs + transientFailures * 300, 6000));
          continue;
        }
        throw error;
      }

      if (Date.now() - startedAt >= maxWaitMs) {
        throw new Error("任务轮询超时，请稍后重试或查看任务结果");
      }
      await wait(intervalMs);
    }
  }

  function isCancelledError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybe = error as { code?: unknown; message?: unknown; name?: unknown };
    if (maybe.code === "JOB_CANCELLED") return true;
    if (maybe.name === "AbortError") return true;
    return typeof maybe.message === "string" && maybe.message.includes("取消");
  }

  function stopInitAssistantMessage(): void {
    if (!assistantJobId || !chatting) return;
    void fetch(`/api/inkos/jobs/${encodeURIComponent(assistantJobId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "用户停止生成" }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error ?? "停止失败");
        }
        setChatting(false);
        setAssistantJobId(null);
        setAssistantChatError(null);
        void message.success("已停止本次生成");
      })
      .catch((error: unknown) => {
        const errorText = error instanceof Error ? error.message : String(error);
        setAssistantChatError(errorText);
        setResult({ ok: false, scope: "init-assistant-chat", error: errorText });
        void message.error(errorText);
      });
  }

  function clearAssistantConversation(): void {
    setAssistantMessages([]);
    setAssistantDraft("");
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(assistantChatStorageKey());
    }
    void clearPersistedChatSession("book-chat", assistantSessionKey());
  }

  async function loadBookPanels(): Promise<void> {
    setIsRefreshing(true);
    try {
      const [statusResponse, briefResponse, configResponse] = await Promise.all([
        fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/status`, { cache: "no-store" }).then((response) => response.json()),
        fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/init-brief`, { cache: "no-store" }).then((response) => response.json()),
        fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/config`, { cache: "no-store" }).then((response) => response.json()),
      ]);
      setStatusData(statusResponse as BookStatusResponse);
      const nextBrief = typeof briefResponse?.content === "string" ? briefResponse.content : "";
      setAuthorBrief(nextBrief);
      persistAssistantBrief(nextBrief);
      setAssistantMessages(loadStoredAssistantMessages());
      void loadPersistedChatSession("book-chat", assistantSessionKey()).then((messages) => {
        if (Array.isArray(messages) && messages.length > 0) {
          setAssistantMessages(messages as ReadonlyArray<InitAssistantMessage>);
        }
      });
      const storedOptions = loadStoredAssistantOptions();
      setAssistantUseStream(storedOptions.useStream);
      setAssistantIncludeReasoning(storedOptions.includeReasoning);
      await loadAssistantProfiles();

      const configData = configResponse as BookConfigResponse;
      setBookConfigData(configData);
      if (configData.book) {
        settingsForm.setFieldsValue({
          genre: configData.book.genre as BookSettingsValues["genre"],
          platform: configData.book.platform as BookSettingsValues["platform"],
          status: configData.book.status as BookSettingsValues["status"],
          targetChapters: configData.book.targetChapters,
          chapterWordCount: configData.book.chapterWordCount,
        });
      }
    } finally {
      setIsRefreshing(false);
    }
  }

  function saveAuthorBrief(): void {
    if (isSavingBrief) return;
    setIsSavingBrief(true);
    setResult(null);
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/init-brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: authorBrief }),
    })
      .then((response) => response.json())
      .then((data) => {
        setResult(data);
        void message.success(data?.ok ? "长期创作约束已保存，后续续写会自动读取" : data?.error ?? "保存失败");
      })
      .finally(() => setIsSavingBrief(false));
  }

  function saveBookSettings(values: BookSettingsValues): void {
    if (isSavingSettings) return;
    setIsSavingSettings(true);
    setResult(null);
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    })
      .then((response) => response.json())
      .then(async (data) => {
        setResult(data);
        if (data?.ok) {
          void message.success("书籍设定已保存");
        } else {
          void message.error(data?.error ?? "保存失败");
        }
        await loadBookPanels();
      })
      .finally(() => setIsSavingSettings(false));
  }

  useEffect(() => {
    writeForm.setFieldsValue({ count: 1, words: undefined, context: "" });
    exportForm.setFieldsValue({ format: "txt", approvedOnly: false, output: "" });
    styleForm.setFieldsValue({ name: "", statsOnly: false });
    canonForm.setFieldsValue({ from: "" });
    void loadBookPanels();

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [bookId, canonForm, exportForm, settingsForm, styleForm, writeForm]);

  function writeNext(values: WriteValues): void {
    if (isWriting) return;
    setIsWriting(true);
    setWriteStep("提交中...");
    setResult(null);

    void fetch("/api/inkos/writing/next", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId,
        count: values.count,
        words: values.words || undefined,
        context: values.context || undefined,
      }),
    })
      .then((response) => response.json())
      .then((data: { ok: boolean; jobId?: string; error?: string }) => {
        if (!data.ok || !data.jobId) {
          setResult(data);
          setIsWriting(false);
          setWriteStep(null);
          return;
        }

        const jobId = data.jobId;
        pollRef.current = setInterval(async () => {
          try {
            const pollRes = await fetch(`/api/inkos/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
            const job = await pollRes.json();
            setWriteStep(job.step ?? "执行中...");
            if (job.status === "done" || job.status === "error") {
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
              setResult(job.status === "done" ? job.result : { ok: false, error: job.error });
              setIsWriting(false);
              setWriteStep(null);
              await loadBookPanels();
            }
          } catch {
            // keep polling
          }
        }, 3000);
      })
      .catch(() => {
        setIsWriting(false);
        setWriteStep(null);
      });
  }

  function draftOnly(values: WriteValues): void {
    if (toolAction || isWriting) return;
    setToolAction("draft");
    setResult(null);
    setWriteStep("草稿生成中...");
    void fetch("/api/inkos/commands/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        async: true,
        values: {
          bookId,
          words: values.words || undefined,
          context: values.context || undefined,
        },
      }),
    })
      .then((response) => response.json())
      .then(async (data: { ok?: boolean; jobId?: string; error?: string }) => {
        if (!data?.ok || !data.jobId) {
          setResult(data);
          void message.error(data?.error ?? "草稿生成失败");
          return;
        }

        const jobId = data.jobId;
        const timer = setInterval(async () => {
          try {
            const pollRes = await fetch(`/api/inkos/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
            const job = await pollRes.json();
            setWriteStep(job.step ?? "草稿生成中...");
            if (job.status === "done" || job.status === "error") {
              clearInterval(timer);
              setResult(job.status === "done" ? job.result : { ok: false, error: job.error });
              if (job.status === "done") {
                void message.success("草稿已生成");
                await loadBookPanels();
              } else {
                void message.error(job.error ?? "草稿生成失败");
              }
              setToolAction(null);
              setWriteStep(null);
            }
          } catch {
            // keep polling
          }
        }, 3000);
      })
      .catch((error: unknown) => {
        setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
        void message.error(error instanceof Error ? error.message : String(error));
        setToolAction(null);
        setWriteStep(null);
      });
  }

  function runBookCommand(commandId: string, values: Record<string, unknown>): void {
    if (toolAction) return;
    setToolAction(commandId);
    setResult(null);
    void fetch(`/api/inkos/commands/${commandId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { bookId, ...values } }),
    })
      .then((response) => response.json())
      .then((data) => setResult(data))
      .finally(() => setToolAction(null));
  }

  function downloadBookExport(values: ExportValues): void {
    const format = values.format === "md" ? "md" : "txt";
    const params = new URLSearchParams({ format });
    if (values.approvedOnly) {
      params.set("approvedOnly", "true");
    }
    const href = `/api/inkos/books/${encodeURIComponent(bookId)}/export?${params.toString()}`;
    if (typeof window === "undefined") return;
    const link = document.createElement("a");
    link.href = href;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function importStyle(values: StyleImportValues): Promise<void> {
    if (toolAction || !styleFile) {
      if (!styleFile) {
        void message.error("请先选择一个 txt 文件");
      }
      return;
    }

    setToolAction("style.import");
    setResult(null);
    try {
      const content = await styleFile.text();
      const response = await fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/style-import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: styleFile.name,
          content,
          name: values.name || undefined,
          statsOnly: values.statsOnly ?? false,
        }),
      });
      const data = await response.json();
      setResult(data);
      if (!data?.ok) {
        throw new Error(data?.error ?? "导入参考文风失败");
      }
      setStyleFile(null);
      styleForm.resetFields();
      styleForm.setFieldsValue({ name: "", statsOnly: false });
      void message.success("参考文风已上传并导入");
    } catch (error: unknown) {
      void message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setToolAction(null);
    }
  }

  function sendInitAssistantMessage(): void {
    const draft = assistantDraft.trim();
    if (!draft || chatting || !bookConfigData?.book) return;

    const nextMessages = [...assistantMessages, { role: "user" as const, content: draft }];
    const currentSettings = settingsForm.getFieldsValue();
    const contextLines = [
      `当前书籍ID：${bookId}`,
      `当前状态：${currentSettings.status ?? bookConfigData.book.status}`,
      `目标章节：${currentSettings.targetChapters ?? bookConfigData.book.targetChapters}`,
      `每章字数：${currentSettings.chapterWordCount ?? bookConfigData.book.chapterWordCount}`,
      "任务：这是一本已经创建的书，请基于已有设定继续补全或修正，不要把它当成全新开书。",
    ];

    setAssistantMessages(nextMessages);
    persistAssistantMessages(nextMessages);
    setAssistantDraft("");
    setChatting(true);
    setAssistantChatError(null);

    void fetch("/api/inkos/init-assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId,
        title: bookConfigData.book.title,
        genre: currentSettings.genre ?? bookConfigData.book.genre,
        platform: currentSettings.platform ?? bookConfigData.book.platform,
        targetChapters: currentSettings.targetChapters ?? bookConfigData.book.targetChapters,
        chapterWords: currentSettings.chapterWordCount ?? bookConfigData.book.chapterWordCount,
        context: contextLines.join("\n"),
        currentBrief: authorBrief || undefined,
        useStream: assistantUseStream,
        includeReasoning: assistantIncludeReasoning,
        profileId: assistantProfileId,
        async: true,
        messages: nextMessages,
      }),
    })
      .then(async (response) => {
        const data = await response.json() as { ok?: boolean; error?: string; jobId?: string };
        if (!response.ok || !data.ok || !data.jobId) {
          throw new Error(data.error ?? "智能初始化对话失败");
        }
        const jobId = String(data.jobId);
        setAssistantJobId(jobId);
        const result = (await pollJob(jobId)) as InitAssistantResult;
        const updatedMessages = [
          ...nextMessages,
          {
            role: "assistant" as const,
            content: result.reply?.trim() || "我已经根据当前书籍设定整理了修改方向。",
            reasoning: typeof result.reasoning === "string" ? result.reasoning : undefined,
          },
        ];
        setAssistantMessages(updatedMessages);
        persistAssistantMessages(updatedMessages);
        if (typeof result.brief === "string") {
          setAuthorBrief(result.brief);
          persistAssistantBrief(result.brief);
        }
      })
      .catch((error: unknown) => {
        if (isCancelledError(error)) return;
        const errorText = error instanceof Error ? error.message : String(error);
        setAssistantChatError(errorText);
        setResult({ ok: false, scope: "init-assistant-chat", error: errorText });
        void message.error(errorText);
      })
      .finally(() => {
        setChatting(false);
        setAssistantJobId(null);
      });
  }

  const tabs = [
    {
      key: "write",
      label: "续写",
      children: (
        <Card
          title="续写下一章"
          extra={(
            <Space wrap>
              {bookConfigData?.book ? (
                <>
                  <Tag>{labelGenre(bookConfigData.book.genre)}</Tag>
                  <Tag>{labelPlatform(bookConfigData.book.platform)}</Tag>
                  <Tag color="blue">{labelBookStatus(bookConfigData.book.status)}</Tag>
                </>
              ) : null}
            </Space>
          )}
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message={`当前会续写第 ${statusData?.status?.nextChapter ?? 1} 章`}
              description={`当前已写 ${statusData?.status?.chaptersWritten ?? 0} 章，总字数 ${statusData?.status?.totalWords ?? 0}。${
                bookConfigData?.book ? `目标 ${bookConfigData.book.targetChapters} 章，每章约 ${bookConfigData.book.chapterWordCount} 字。` : ""
              }`}
            />
            <Form layout="vertical" form={writeForm} onFinish={writeNext}>
              <Row gutter={16}>
                <Col xs={24} md={8}>
                  <Form.Item name="count" label="生成章数" rules={[{ required: true }]}>
                    <InputNumber min={1} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item name="words" label="覆盖字数（可选）">
                    <InputNumber min={200} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item name="context" label="本次续写要求（可选）">
                <Input.TextArea rows={6} placeholder="只写这一章要发生什么，比如：推进主线冲突、加快节奏、结尾抛出钩子。" />
              </Form.Item>
              <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 12, alignItems: isMobile ? "stretch" : "center" }}>
                <Button type="primary" htmlType="submit" size="large" block={isMobile} loading={isWriting}>开始续写</Button>
                <Button size="large" block={isMobile} loading={toolAction === "draft"} onClick={() => draftOnly(writeForm.getFieldsValue())}>
                  只写草稿
                </Button>
                {writeStep ? <Typography.Text type="secondary">{writeStep}</Typography.Text> : null}
              </div>
            </Form>
          </Space>
        </Card>
      ),
    },
    {
      key: "chapters",
      label: "章节区",
      children: <BookChapters bookId={bookId} embedded />,
    },
    {
      key: "tools",
      label: "书籍工具",
      children: (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={8}>
            <Card size="small" title="导出书籍">
              <Form layout="vertical" form={exportForm} onFinish={(values) => runBookCommand("export", { ...values })}>
                <Form.Item label="导出格式" name="format" rules={[{ required: true }]}>
                  <Select options={[{ value: "txt", label: "TXT" }, { value: "md", label: "Markdown" }]} />
                </Form.Item>
                <Form.Item label="输出路径（可选）" name="output">
                  <Input placeholder="可留空，使用默认导出路径" />
                </Form.Item>
                <Form.Item name="approvedOnly" valuePropName="checked">
                  <Checkbox>只导出已通过章节</Checkbox>
                </Form.Item>
                <Space>
                  <Button type="primary" htmlType="submit" loading={toolAction === "export"}>
                    导出到服务器
                  </Button>
                  <Button onClick={() => downloadBookExport(exportForm.getFieldsValue() as ExportValues)}>
                    下载到本地
                  </Button>
                </Space>
              </Form>
            </Card>
          </Col>
          <Col xs={24} xl={8}>
            <Card size="small" title="导入参考文风">
              <Form layout="vertical" form={styleForm} onFinish={importStyle}>
                <Form.Item label="上传 txt 文件" required>
                  <Upload
                    accept=".txt,text/plain"
                    beforeUpload={(file) => {
                      setStyleFile(file);
                      return false;
                    }}
                    maxCount={1}
                    onRemove={() => {
                      setStyleFile(null);
                    }}
                    fileList={styleFile ? [styleFile as unknown as import("antd").UploadFile] : []}
                  >
                    <Button icon={<UploadOutlined />}>选择 txt 文件</Button>
                  </Upload>
                </Form.Item>
                <Form.Item label="来源名称（可选）" name="name">
                  <Input placeholder="如 某作者 / 某本参考书" />
                </Form.Item>
                <Form.Item name="statsOnly" valuePropName="checked">
                  <Checkbox>仅导入统计指纹，不生成文风指南</Checkbox>
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={toolAction === "style.import"}>导入文风</Button>
              </Form>
            </Card>
          </Col>
          <Col xs={24} xl={8}>
            <Card size="small" title="导入正传正典">
              <Form layout="vertical" form={canonForm} onFinish={(values) => runBookCommand("import.canon", { ...values })}>
                <Form.Item label="正传书籍 ID" name="from" rules={[{ required: true }]}>
                  <Input placeholder="输入父书 bookId" />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={toolAction === "import.canon"}>导入正典</Button>
              </Form>
            </Card>
          </Col>
        </Row>
      ),
    },
    {
      key: "settings",
      label: "书籍设定",
      children: (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={10}>
            <Card title="书籍设定">
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Typography.Text type="secondary">
                  这里管理这本书的长期参数。需要改题材、平台、章节规模时，在这里调整。
                </Typography.Text>
                <Form layout="vertical" form={settingsForm} onFinish={saveBookSettings}>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item name="genre" label="题材" rules={[{ required: true }]}>
                        <Select options={[
                          { value: "chuanyue", label: "穿越" },
                          { value: "xuanhuan", label: "玄幻" },
                          { value: "xianxia", label: "仙侠" },
                          { value: "urban", label: "都市" },
                          { value: "horror", label: "恐怖" },
                          { value: "other", label: "其他" },
                        ]} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
                        <Select options={[
                          { value: "tomato", label: "番茄" },
                          { value: "feilu", label: "飞卢" },
                          { value: "qidian", label: "起点" },
                          { value: "other", label: "其他" },
                        ]} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item name="status" label="状态" rules={[{ required: true }]}>
                        <Select options={[
                          { value: "incubating", label: "孵化中" },
                          { value: "outlining", label: "构思中" },
                          { value: "active", label: "连载中" },
                          { value: "paused", label: "暂停" },
                          { value: "completed", label: "已完结" },
                          { value: "dropped", label: "已放弃" },
                        ]} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="targetChapters" label="目标章节数" rules={[{ required: true }]}>
                        <InputNumber min={1} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item name="chapterWordCount" label="每章字数" rules={[{ required: true }]}>
                    <InputNumber min={1000} style={{ width: "100%" }} />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" loading={isSavingSettings}>保存书籍设定</Button>
                </Form>
              </Space>
            </Card>
          </Col>
          <Col xs={24} xl={14}>
            <Card title="智能初始化对话">
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Typography.Text type="secondary">
                  这里可以继续像编辑一样和系统对话，补强书名、主线、角色、阶段高潮和结局。对话会自动读取当前书籍设定和已保存的长期创作约束。
                </Typography.Text>
                <Space>
                  <Button type="primary" onClick={() => setAssistantModalOpen(true)}>
                    打开智能初始化对话
                  </Button>
                  <Button onClick={clearAssistantConversation} disabled={chatting}>
                    清空对话
                  </Button>
                </Space>
                <div>
                  <Typography.Text strong>当前长期创作约束</Typography.Text>
                  <Input.TextArea
                    rows={10}
                    value={authorBrief}
                    onChange={(event) => {
                      setAuthorBrief(event.target.value);
                      persistAssistantBrief(event.target.value);
                    }}
                    placeholder="这里保存的是这本书长期生效的创作约束。创建时填写的长期约束也会保存在这里，后续每次续写都会读取。"
                    style={{ marginTop: 8 }}
                  />
                </div>
              </Space>
            </Card>
          </Col>
        </Row>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        size={isMobile ? "small" : "default"}
        style={{
          borderRadius: 26,
          overflow: "hidden",
          background: "linear-gradient(135deg, rgba(17,31,37,0.96) 0%, rgba(34,56,60,0.92) 48%, rgba(96,130,122,0.86) 100%)",
          boxShadow: "0 24px 56px rgba(10,18,24,0.18)",
        }}
        title={(
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Typography.Text style={{ color: "rgba(213, 227, 223, 0.72)", letterSpacing: "0.16em", textTransform: "uppercase", fontSize: 11 }}>
              书阁主案 · 卷宗总览
            </Typography.Text>
            <Typography.Title level={isMobile ? 5 : 4} ellipsis={{ tooltip: statusData?.status?.title ?? bookId }} style={{ margin: 0, color: "#f2f7f6" }}>
              {statusData?.status?.title ?? bookId}
            </Typography.Title>
            <Typography.Text style={{ color: "rgba(224, 236, 233, 0.78)" }} ellipsis={{ tooltip: bookId }}>
              书籍工作台 · {bookId}
            </Typography.Text>
          </div>
        )}
        extra={null}
        bodyStyle={isMobile ? { padding: 12 } : { padding: 18 }}
      >
        <Space wrap size={[8, 8]} style={{ marginBottom: 12 }}>
          {statusData?.status?.genre ? <Tag color="default">{labelGenre(statusData.status.genre)}</Tag> : null}
          {statusData?.status?.platform ? <Tag color="default">{labelPlatform(statusData.status.platform)}</Tag> : null}
          {statusData?.status?.status ? <Tag color="cyan">{labelBookStatus(statusData.status.status)}</Tag> : null}
        </Space>
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={12} lg={6}><Card size={isMobile ? "small" : "default"} style={{ borderRadius: 20, background: "rgba(255,255,255,0.92)" }} bodyStyle={isMobile ? { padding: 14 } : { padding: 16 }}><Statistic title="状态" value={statusData?.status?.status ? labelBookStatus(statusData.status.status) : "-"} valueStyle={{ fontSize: isMobile ? 18 : 26, color: "#214047" }} /></Card></Col>
          <Col xs={12} sm={12} lg={6}><Card size={isMobile ? "small" : "default"} style={{ borderRadius: 20, background: "rgba(255,255,255,0.92)" }} bodyStyle={isMobile ? { padding: 14 } : { padding: 16 }}><Statistic title="已写章节" value={statusData?.status?.chaptersWritten ?? 0} valueStyle={{ fontSize: isMobile ? 18 : 26, color: "#214047" }} /></Card></Col>
          <Col xs={12} sm={12} lg={6}><Card size={isMobile ? "small" : "default"} style={{ borderRadius: 20, background: "rgba(255,255,255,0.92)" }} bodyStyle={isMobile ? { padding: 14 } : { padding: 16 }}><Statistic title="总字数" value={statusData?.status?.totalWords ?? 0} valueStyle={{ fontSize: isMobile ? 18 : 26, color: "#214047" }} /></Card></Col>
          <Col xs={12} sm={12} lg={6}><Card size={isMobile ? "small" : "default"} style={{ borderRadius: 20, background: "rgba(255,255,255,0.92)" }} bodyStyle={isMobile ? { padding: 14 } : { padding: 16 }}><Statistic title="下一章" value={statusData?.status?.nextChapter ?? 1} prefix="Ch." valueStyle={{ fontSize: isMobile ? 18 : 26, color: "#214047" }} /></Card></Col>
        </Row>
      </Card>

      <Card style={{ borderRadius: 24, background: "rgba(255,255,255,0.88)" }} bodyStyle={{ paddingTop: 10 }}>
        <Tabs defaultActiveKey="write" items={tabs} size={isMobile ? "small" : "middle"} tabBarGutter={isMobile ? 12 : 32} />
      </Card>

      <Card title="最近结果" style={{ borderRadius: 24, background: "rgba(255,255,255,0.9)" }}>
        {!result ? (
          <Typography.Text type="secondary">执行“续写 / 保存设定 / 保存简报 / 书籍工具”后这里显示结果。</Typography.Text>
        ) : (
          <Alert type="info" showIcon message={<pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>} />
        )}
      </Card>

      <Modal
        title="智能初始化对话"
        open={assistantModalOpen}
        onCancel={() => setAssistantModalOpen(false)}
        footer={null}
        maskClosable={false}
        keyboard
        width={isMobile ? "94vw" : (assistantLogOpen ? "min(1640px, 98vw)" : CHAT_MODAL_WIDTH)}
        styles={{ body: { height: CHAT_MODAL_BODY_HEIGHT, overflow: "hidden" } }}
        destroyOnHidden={false}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", height: "100%", minHeight: 0 }}>
          <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
            这里继续补强书名、主线、角色、阶段高潮和结局。助手会自动读取当前书籍的 `story` 路径、已保存简报、状态卡、伏笔池和章节摘要。
          </Typography.Text>
          {assistantChatError ? (
            <Alert
              type="error"
              showIcon
              closable
              onClose={() => setAssistantChatError(null)}
              message="智能初始化对话执行失败"
              description={assistantChatError}
            />
          ) : null}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: !isMobile && assistantLogOpen ? "minmax(0,1fr) 420px" : "1fr",
              gap: 12,
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <ChatPanel
              messages={assistantMessages}
              value={assistantDraft}
              onChange={setAssistantDraft}
              onSend={sendInitAssistantMessage}
              sending={chatting}
              placeholder="例如：现在这本书的开篇还不够狠，帮我把前三章改成更强冲突的穿越翻盘局，同时给出两个更抓人的书名。"
              emptyText="先说一句你要怎么改这本书，比如“把男主目标改得更强”“给我三个更狠的书名”“结局想更爽一点”。"
              minHeight={260}
              maxHeight="100%"
              topBar={(
                <Space wrap>
                  <Select
                    style={{ minWidth: 280 }}
                    value={assistantProfileId}
                    onChange={(value) => {
                      const next = value || undefined;
                      setAssistantProfileId(next);
                      persistAssistantProfileId(next);
                    }}
                    placeholder="使用当前激活配置"
                    options={assistantProfiles.map((item) => ({
                      value: item.id,
                      label: item.isActive ? `${item.name} · ${item.model}（当前激活）` : `${item.name} · ${item.model}`,
                    }))}
                  />
                  <Checkbox
                    checked={assistantUseStream}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setAssistantUseStream(next);
                      persistAssistantOptions({
                        useStream: next,
                        includeReasoning: assistantIncludeReasoning,
                      });
                    }}
                  >
                    使用流式
                  </Checkbox>
                  <Checkbox
                    checked={assistantIncludeReasoning}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setAssistantIncludeReasoning(next);
                      persistAssistantOptions({
                        useStream: assistantUseStream,
                        includeReasoning: next,
                      });
                    }}
                  >
                    展示 reasoning
                  </Checkbox>
                </Space>
              )}
              footerRight={(
                <>
                  {!isMobile ? (
                    <Button onClick={() => setAssistantLogOpen((value) => !value)}>
                      {assistantLogOpen ? "收起日志" : "实时日志"}
                    </Button>
                  ) : null}
                  <Button onClick={clearAssistantConversation} disabled={chatting || isSavingBrief}>
                    清空对话
                  </Button>
                  <Button danger onClick={stopInitAssistantMessage} disabled={!chatting || !assistantJobId}>
                    停止
                  </Button>
                </>
              )}
              containerStyle={{ height: "100%", minHeight: 0 }}
            />
            {!isMobile && assistantLogOpen ? (
              <ChatFactLogPanel title="实时日志 · 初始化助手" eventIncludes="init_assistant" />
            ) : null}
          </div>
        </div>
      </Modal>
    </Space>
  );
}
