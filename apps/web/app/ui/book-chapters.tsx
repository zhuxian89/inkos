"use client";

import { App, Alert, Button, Card, Checkbox, Descriptions, Dropdown, Grid, Input, Modal, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { MoreOutlined } from "@ant-design/icons";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChatPanel } from "./chat-panel";
import { ChatFactLogPanel } from "./chat-fact-log-panel";
import { clearPersistedChatSession, loadPersistedChatSession, savePersistedChatSession } from "./chat-persistence";
import { CHAT_MODAL_BODY_HEIGHT, CHAT_MODAL_WIDTH } from "./chat-modal";
import { IssueTags } from "./issue-tags";
import { ChapterActions } from "./chapter-actions";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssues: ReadonlyArray<string>;
}

interface ChapterDetail {
  readonly ok: boolean;
  readonly chapter?: number;
  readonly title?: string;
  readonly content?: string;
  readonly filePath?: string;
  readonly error?: string;
}

interface ChapterChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
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

const CHAPTER_CHAT_STORAGE_PREFIX = "inkos.chapter-chat.";
const CHAPTER_CHAT_OPTIONS_STORAGE_PREFIX = "inkos.chapter-chat-options.";
const CHAPTER_CHAT_PROFILE_STORAGE_PREFIX = "inkos.chapter-chat-profile.";

export function BookChapters({ bookId, embedded = false }: Readonly<{ bookId: string; embedded?: boolean }>) {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [chapters, setChapters] = useState<ReadonlyArray<ChapterMeta>>([]);
  const [detail, setDetail] = useState<ChapterDetail | null>(null);
  const [actionResult, setActionResult] = useState<unknown>(null);
  const [openingChapter, setOpeningChapter] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [reviewAction, setReviewAction] = useState<string | null>(null);
  const [chatChapter, setChatChapter] = useState<ChapterMeta | null>(null);
  const [chatMessages, setChatMessages] = useState<ReadonlyArray<ChapterChatMessage>>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatting, setChatting] = useState(false);
  const [chatJobId, setChatJobId] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLogOpen, setChatLogOpen] = useState(false);
  const [chatUseStream, setChatUseStream] = useState(true);
  const [chatIncludeReasoning, setChatIncludeReasoning] = useState(false);
  const [chatProfiles, setChatProfiles] = useState<ReadonlyArray<LlmProfile>>([]);
  const [chatProfileId, setChatProfileId] = useState<string | undefined>(undefined);
  const [replacingChapter, setReplacingChapter] = useState(false);
  const [replacePreviewOpen, setReplacePreviewOpen] = useState(false);
  const [replacePreviewLoading, setReplacePreviewLoading] = useState(false);
  const [replaceOriginalContent, setReplaceOriginalContent] = useState("");
  const [replaceCandidateContent, setReplaceCandidateContent] = useState("");

  function chapterChatStorageKey(chapter: number): string {
    return `${CHAPTER_CHAT_STORAGE_PREFIX}${bookId}.${chapter}`;
  }

  function chapterSessionKey(chapter: number): string {
    return `chapter:${bookId}:${chapter}`;
  }

  function loadStoredChapterChat(chapter: number): ReadonlyArray<ChapterChatMessage> {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(chapterChatStorageKey(chapter));
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ReadonlyArray<ChapterChatMessage>;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function persistChapterChat(chapter: number, messages: ReadonlyArray<ChapterChatMessage>): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(chapterChatStorageKey(chapter), JSON.stringify(messages));
    void savePersistedChatSession("chapter-chat", chapterSessionKey(chapter), {
      bookId,
      chapterNumber: chapter,
      title: chapters.find((item) => item.number === chapter)?.title ?? `Ch.${chapter}`,
      messages,
      meta: { source: "book-chapters" },
    });
  }

  function chapterChatOptionsStorageKey(chapter: number): string {
    return `${CHAPTER_CHAT_OPTIONS_STORAGE_PREFIX}${bookId}.${chapter}`;
  }

  function loadStoredChapterChatOptions(chapter: number): { readonly useStream: boolean; readonly includeReasoning: boolean } {
    if (typeof window === "undefined") {
      return { useStream: true, includeReasoning: false };
    }
    try {
      const raw = window.localStorage.getItem(chapterChatOptionsStorageKey(chapter));
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

  function persistChapterChatOptions(chapter: number, options: { readonly useStream: boolean; readonly includeReasoning: boolean }): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(chapterChatOptionsStorageKey(chapter), JSON.stringify(options));
  }

  function chapterChatProfileStorageKey(chapter: number): string {
    return `${CHAPTER_CHAT_PROFILE_STORAGE_PREFIX}${bookId}.${chapter}`;
  }

  function loadStoredChapterChatProfileId(chapter: number): string | undefined {
    if (typeof window === "undefined") return undefined;
    const value = window.localStorage.getItem(chapterChatProfileStorageKey(chapter));
    return value?.trim() ? value : undefined;
  }

  function persistChapterChatProfileId(chapter: number, profileId?: string): void {
    if (typeof window === "undefined") return;
    if (profileId?.trim()) {
      window.localStorage.setItem(chapterChatProfileStorageKey(chapter), profileId.trim());
      return;
    }
    window.localStorage.removeItem(chapterChatProfileStorageKey(chapter));
  }

  async function loadChatProfiles(chapter: number): Promise<void> {
    const response = await fetch("/api/inkos/llm-profiles", { cache: "no-store" });
    const data = (await response.json()) as LlmProfilesResponse;
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    setChatProfiles(profiles);
    const stored = loadStoredChapterChatProfileId(chapter);
    const fallback = data.activeProfileId ?? profiles.find((item) => item.isActive)?.id;
    const selected = stored && profiles.some((item) => item.id === stored) ? stored : fallback ?? undefined;
    setChatProfileId(selected);
    persistChapterChatProfileId(chapter, selected);
  }

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
          if (job.status === "cancelled") {
            clearInterval(timer);
            const error = new Error(job.error ?? "任务已取消");
            (error as Error & { code?: string }).code = "JOB_CANCELLED";
            reject(error);
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

  function isCancelledError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybe = error as { code?: unknown; message?: unknown; name?: unknown };
    if (maybe.code === "JOB_CANCELLED") return true;
    if (maybe.name === "AbortError") return true;
    return typeof maybe.message === "string" && maybe.message.includes("取消");
  }

  function stopChapterChat(): void {
    if (!chatJobId || !chatting) return;
    void fetch(`/api/inkos/jobs/${encodeURIComponent(chatJobId)}`, {
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
        setChatJobId(null);
        setChatError(null);
        void message.success("已停止本次章节对话");
      })
      .catch((error: unknown) => {
        const errorText = error instanceof Error ? error.message : String(error);
        setChatError(errorText);
        setActionResult({ ok: false, scope: "chapter-chat", error: errorText });
        void message.error(errorText);
      });
  }

  async function loadChapters(): Promise<void> {
    setIsRefreshing(true);
    try {
      const response = await fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters`, { cache: "no-store" });
      const data = await response.json();
      setChapters(data.chapters ?? []);
    } finally {
      setIsRefreshing(false);
    }
  }

  function loadChapterDetail(chapter: number): void {
    setOpeningChapter(chapter);
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${chapter}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data: ChapterDetail) => setDetail(data))
      .finally(() => setOpeningChapter(null));
  }

  useEffect(() => {
    void loadChapters();
  }, [bookId]);

  function callReviewAction(action: "approve" | "reject", chapter: number): void {
    const actionKey = `${action}:${chapter}`;
    setReviewAction(actionKey);
    void fetch(`/api/inkos/review/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId,
        chapter,
        ...(action === "reject" ? { reason: "来自章节区的驳回" } : {}),
      }),
    })
      .then(async (response) => {
        const data = await response.json();
        setActionResult(data);
        if (!response.ok || !data?.ok) {
          void message.error(data?.error ?? `${action === "approve" ? "通过" : "驳回"}失败`);
          return;
        }
        void message.success(action === "approve" ? "已通过" : "已驳回");
        await loadChapters();
      })
      .finally(() => setReviewAction(null));
  }

  function openChapterChat(row: ChapterMeta): void {
    setChatChapter(row);
    setChatError(null);
    setChatMessages(loadStoredChapterChat(row.number));
    void loadPersistedChatSession("chapter-chat", chapterSessionKey(row.number)).then((messages) => {
      if (Array.isArray(messages) && messages.length > 0) {
        setChatMessages(messages as ReadonlyArray<ChapterChatMessage>);
      }
    });
    const storedOptions = loadStoredChapterChatOptions(row.number);
    setChatUseStream(storedOptions.useStream);
    setChatIncludeReasoning(storedOptions.includeReasoning);
    setChatDraft("");
    void loadChatProfiles(row.number);
  }

  function sendChapterChat(): void {
    if (!chatChapter || !chatDraft.trim() || chatting) return;
    const chapterNumber = chatChapter.number;
    const nextMessages = [...chatMessages, { role: "user" as const, content: chatDraft.trim() }];
    setChatMessages(nextMessages);
    persistChapterChat(chapterNumber, nextMessages);
    setChatDraft("");
    setChatting(true);
    setChatError(null);
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: nextMessages,
        useStream: chatUseStream,
        includeReasoning: chatIncludeReasoning,
        profileId: chatProfileId,
        async: true,
      }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data?.ok || !data?.jobId) {
          throw new Error(data?.error ?? "章节对话失败");
        }
        const jobId = String(data.jobId);
        setChatJobId(jobId);
        const result = await pollJob(jobId) as {
          ok?: boolean;
          reply?: string;
          reasoning?: string;
        };
        const content = typeof result?.reply === "string" && result.reply.trim()
          ? result.reply.trim()
          : "已完成本次处理，但没有返回可显示的正文回复。";
        setChatMessages((prev) => {
          const updated = [...prev, {
            role: "assistant" as const,
            content,
            reasoning: typeof result?.reasoning === "string" ? result.reasoning : undefined,
          }];
          persistChapterChat(chapterNumber, updated);
          return updated;
        });
      })
      .catch((error: unknown) => {
        if (isCancelledError(error)) return;
        const errorText = error instanceof Error ? error.message : String(error);
        setChatError(errorText);
        setActionResult({ ok: false, scope: "chapter-chat", error: errorText });
        void message.error(errorText);
      })
      .finally(() => {
        setChatting(false);
        setChatJobId(null);
      });
  }

  function latestAssistantReply(): string {
    const reversed = [...chatMessages].reverse();
    return reversed.find((item) => item.role === "assistant")?.content?.trim() ?? "";
  }

  async function confirmReplaceChapter(content: string): Promise<void> {
    if (!chatChapter) return;
    setReplacingChapter(true);
    try {
      const response = await fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${chatChapter.number}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await response.json();
      setActionResult(data);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error ?? "整章替换失败");
      }
      void message.success("已用最后一条助手回复替换全文");
      setReplacePreviewOpen(false);
      await loadChapters();
      loadChapterDetail(chatChapter.number);
    } catch (error: unknown) {
      void message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setReplacingChapter(false);
    }
  }

  function replaceChapterWithLatestReply(): void {
    if (!chatChapter || replacingChapter || replacePreviewLoading) return;
    const content = latestAssistantReply();
    if (!content) {
      void message.error("没有可替换的助手回复");
      return;
    }
    setReplacePreviewLoading(true);
    setReplaceCandidateContent(content);
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${chatChapter.number}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error ?? "读取原章节失败");
        }
        setReplaceOriginalContent(String(data.content ?? ""));
        setReplacePreviewOpen(true);
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setReplacePreviewLoading(false));
  }

  const chatMenuItems = [
    {
      key: "clear",
      label: "清空对话",
      disabled: chatting,
      onClick: () => {
        if (!chatChapter) return;
        setChatMessages([]);
        setChatDraft("");
        persistChapterChat(chatChapter.number, []);
        void clearPersistedChatSession("chapter-chat", chapterSessionKey(chatChapter.number));
      },
    },
    {
      key: "replace",
      label: "用最后回复替换全文",
      disabled: chatting || replacingChapter || !latestAssistantReply(),
      onClick: () => replaceChapterWithLatestReply(),
    },
  ];

  const columns: ColumnsType<ChapterMeta> = [
    {
      title: "操作",
      key: "actions",
      width: embedded ? 360 : 320,
      render: (_, row) => (
        <Space>
          <Button size="small" loading={openingChapter === row.number} onClick={() => loadChapterDetail(row.number)}>打开</Button>
          <Button size="small" onClick={() => openChapterChat(row)}>对话</Button>
          <Link
            href={`/books/${encodeURIComponent(bookId)}/chapters/${row.number}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button size="small" type="link">详情</Button>
          </Link>
          <ChapterActions
            bookId={bookId}
            chapter={row.number}
            onResult={setActionResult}
            onDone={() => void loadChapters()}
          />
          {row.status === "ready-for-review" ? (
            <>
              <Button size="small" loading={reviewAction === `approve:${row.number}`} onClick={() => callReviewAction("approve", row.number)}>通过</Button>
              <Button danger size="small" loading={reviewAction === `reject:${row.number}`} onClick={() => callReviewAction("reject", row.number)}>驳回</Button>
            </>
          ) : null}
        </Space>
      ),
    },
    { title: "章节", dataIndex: "number", key: "number", width: 100, render: (value: number) => `Ch.${value}` },
    { title: "标题", dataIndex: "title", key: "title" },
    { title: "状态", dataIndex: "status", key: "status", width: 130 },
    { title: "字数", dataIndex: "wordCount", key: "wordCount", width: 120 },
    {
      title: "问题",
      key: "issues",
      render: (_, row) => <IssueTags issues={row.auditIssues} maxVisible={2} />,
    },
  ];

  const content = (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        size={isMobile ? "small" : "default"}
        style={embedded ? { borderRadius: 22, background: "rgba(255,255,255,0.9)" } : {
          borderRadius: 24,
          overflow: "hidden",
          background: "linear-gradient(135deg, rgba(16,29,35,0.96) 0%, rgba(33,55,60,0.92) 52%, rgba(102,128,121,0.84) 100%)",
        }}
        title={embedded ? "章节区" : <span style={{ color: "#f2f7f6" }}>{`章节卷册 · ${bookId}`}</span>}
        extra={(
          <div style={{ display: "flex", gap: 8, flexDirection: isMobile ? "column" : "row", width: isMobile ? 120 : undefined }}>
            {!embedded ? <Link href={`/books/${encodeURIComponent(bookId)}`}><Button block>返回工作台</Button></Link> : null}
            <Button block loading={isRefreshing} onClick={() => void loadChapters()}>刷新</Button>
          </div>
        )}
        bodyStyle={isMobile ? { padding: 12 } : { padding: 16 }}
      >
        {isMobile ? (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {chapters.map((row) => (
              <Card key={row.number} size="small" style={{ borderRadius: 18, background: "rgba(255,255,255,0.94)" }} bodyStyle={{ padding: 14 }}>
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <Typography.Title level={5} style={{ margin: 0 }}>
                      Ch.{row.number} · {row.title}
                    </Typography.Title>
                    <Space wrap size={[8, 8]}>
                      <Tag color="blue">{row.status}</Tag>
                      <Tag>{row.wordCount.toLocaleString()} 字</Tag>
                    </Space>
                  </div>

                  <IssueTags issues={row.auditIssues} maxVisible={3} />

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                    <Button loading={openingChapter === row.number} onClick={() => loadChapterDetail(row.number)}>打开</Button>
                    <Button onClick={() => openChapterChat(row)}>对话</Button>
                    <Link
                      href={`/books/${encodeURIComponent(bookId)}/chapters/${row.number}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button block>详情</Button>
                    </Link>
                  </div>

                  <ChapterActions
                    bookId={bookId}
                    chapter={row.number}
                    onResult={setActionResult}
                    onDone={() => void loadChapters()}
                    compact
                  />

                  {row.status === "ready-for-review" ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                      <Button loading={reviewAction === `approve:${row.number}`} onClick={() => callReviewAction("approve", row.number)}>通过</Button>
                      <Button danger loading={reviewAction === `reject:${row.number}`} onClick={() => callReviewAction("reject", row.number)}>驳回</Button>
                    </div>
                  ) : null}
                </Space>
              </Card>
            ))}
          </Space>
        ) : (
          <Table rowKey="number" columns={columns} dataSource={chapters.slice()} pagination={{ pageSize: 10 }} scroll={{ x: 1100 }} />
        )}
      </Card>

      <Card title="操作结果" style={{ borderRadius: 22, background: "rgba(255,255,255,0.9)" }}>
        {!actionResult ? (
          <Typography.Text type="secondary">点击“审计 / 修订 / 通过 / 驳回”后这里显示结果。</Typography.Text>
        ) : (
          <Alert type="info" showIcon message={<pre style={{ margin: 0 }}>{JSON.stringify(actionResult, null, 2)}</pre>} />
        )}
      </Card>

      <Modal
        open={Boolean(chatChapter)}
        onCancel={() => {
          if (!chatting) setChatChapter(null);
        }}
        footer={null}
        maskClosable={false}
        keyboard
        width={isMobile ? "94vw" : (chatLogOpen ? "min(1640px, 98vw)" : CHAT_MODAL_WIDTH)}
        style={{ top: isMobile ? 8 : 20 }}
        styles={{ body: { paddingTop: 8, height: isMobile ? "76vh" : CHAT_MODAL_BODY_HEIGHT, overflow: "hidden" } }}
        destroyOnClose
        title={chatChapter ? `Ch.${chatChapter.number} · ${chatChapter.title}` : "章节对话"}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", height: "100%", minHeight: 0 }}>
          <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
            围绕本章讨论问题与修改方向。
          </Typography.Text>
          {chatError ? (
            <Alert
              type="error"
              showIcon
              closable
              onClose={() => setChatError(null)}
              message="章节对话执行失败"
              description={chatError}
            />
          ) : null}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: !isMobile && chatLogOpen ? "minmax(0,1fr) 420px" : "1fr",
              gap: 12,
              flex: 1,
              minHeight: 0,
            }}
          >
            <ChatPanel
              messages={chatMessages}
              value={chatDraft}
              onChange={setChatDraft}
              onSend={sendChapterChat}
              sending={chatting}
              placeholder="例如：把第三段里‘八十九天’改成‘八十八天’，并同步修正 current_state.md 里的对应表述。"
              emptyText="先说一句你想改什么，例如“把这一句改顺一点”“修一下 current_state.md 里的倒计时表述”。"
              minHeight={220}
              maxHeight="100%"
              topBar={(
                <Space wrap>
                  <Select
                    style={{ minWidth: 280 }}
                    value={chatProfileId}
                    onChange={(value) => {
                      if (!chatChapter) return;
                      const next = value || undefined;
                      setChatProfileId(next);
                      persistChapterChatProfileId(chatChapter.number, next);
                    }}
                    placeholder="使用当前激活配置"
                    options={chatProfiles.map((item) => ({
                      value: item.id,
                      label: item.isActive ? `${item.name} · ${item.model}（当前激活）` : `${item.name} · ${item.model}`,
                    }))}
                  />
                  <Checkbox
                    checked={chatUseStream}
                    onChange={(event) => {
                      if (!chatChapter) return;
                      const next = event.target.checked;
                      setChatUseStream(next);
                      persistChapterChatOptions(chatChapter.number, {
                        useStream: next,
                        includeReasoning: chatIncludeReasoning,
                      });
                    }}
                  >
                    使用流式
                  </Checkbox>
                  <Checkbox
                    checked={chatIncludeReasoning}
                    onChange={(event) => {
                      if (!chatChapter) return;
                      const next = event.target.checked;
                      setChatIncludeReasoning(next);
                      persistChapterChatOptions(chatChapter.number, {
                        useStream: chatUseStream,
                        includeReasoning: next,
                      });
                    }}
                  >
                    展示 reasoning
                  </Checkbox>
                </Space>
              )}
              footerRight={(
                <Space>
                  {!isMobile ? (
                    <Button onClick={() => setChatLogOpen((value) => !value)}>
                      {chatLogOpen ? "收起日志" : "事实日志"}
                    </Button>
                  ) : null}
                  <Button danger onClick={stopChapterChat} disabled={!chatting || !chatJobId}>
                    停止
                  </Button>
                  <Dropdown menu={{ items: chatMenuItems }} trigger={["click"]}>
                    <Button icon={<MoreOutlined />} disabled={chatting || replacingChapter}>
                      更多
                    </Button>
                  </Dropdown>
                </Space>
              )}
              containerStyle={{ height: "100%", minHeight: 0 }}
            />
            {!isMobile && chatLogOpen ? (
              <ChatFactLogPanel title="事实日志 · 章节对话" eventIncludes="chapter.chat" />
            ) : null}
          </div>
        </div>
      </Modal>

      <Modal
        open={replacePreviewOpen}
        onCancel={() => {
          if (!replacingChapter) setReplacePreviewOpen(false);
        }}
        title={chatChapter ? `替换预览 · Ch.${chatChapter.number} ${chatChapter.title}` : "替换预览"}
        maskClosable={false}
        keyboard
        width={CHAT_MODAL_WIDTH}
        style={{ top: 20 }}
        styles={{ body: { height: CHAT_MODAL_BODY_HEIGHT, overflow: "hidden" } }}
        destroyOnClose
        okText="确认替换"
        cancelText="取消"
        confirmLoading={replacingChapter}
        onOk={() => void confirmReplaceChapter(replaceCandidateContent)}
      >
        <Space direction="vertical" size={12} style={{ width: "100%", height: "100%" }}>
          <Typography.Text type="secondary">左边是当前章节原文，右边是最后一条助手回复。确认后才会覆盖全文。</Typography.Text>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
              gap: 16,
              width: "100%",
            }}
          >
            <div>
              <Typography.Title level={5}>当前原文</Typography.Title>
              <Input.TextArea
                readOnly
                value={replaceOriginalContent}
                autoSize={false}
                style={{ height: "72vh" }}
              />
            </div>
            <div>
              <Typography.Title level={5}>将要替换的新全文</Typography.Title>
              <Input.TextArea
                value={replaceCandidateContent}
                onChange={(event) => setReplaceCandidateContent(event.target.value)}
                autoSize={false}
                style={{ height: "72vh" }}
              />
            </div>
          </div>
        </Space>
      </Modal>
    </Space>
  );

  return content;
}
