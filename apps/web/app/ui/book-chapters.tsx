"use client";

import { App, Alert, Button, Card, Descriptions, Dropdown, Grid, Input, Modal, Popconfirm, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { MoreOutlined } from "@ant-design/icons";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./chat-panel";
import { ChatKitStreamError, consumeChatKitStream, messagesToChatKitItems, type ChatKitItem } from "./chat-kit";
import { ChapterChatSocketUnavailableError, consumeChapterChatWebSocket } from "./chat-kit/chapter-chat-websocket";
import { ChatFactLogPanel } from "./chat-fact-log-panel";
import { clearPersistedChatSession, loadPersistedChatSession, savePersistedChatSession } from "./chat-persistence";
import { CHAT_MODAL_BODY_HEIGHT, CHAT_MODAL_DESKTOP_BODY_HEIGHT, CHAT_MODAL_DESKTOP_WIDTH, CHAT_MODAL_WIDTH } from "./chat-modal";
import { IssueTags } from "./issue-tags";
import { ChapterActions } from "./chapter-actions";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssues: ReadonlyArray<string>;
}


interface ChapterChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
  readonly items?: ReadonlyArray<ChatKitItem>;
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
const CHAPTER_CHAT_PROFILE_STORAGE_PREFIX = "inkos.chapter-chat-profile.";

export function BookChapters({ bookId, embedded = false }: Readonly<{ bookId: string; embedded?: boolean }>) {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [chapters, setChapters] = useState<ReadonlyArray<ChapterMeta>>([]);
  const [actionResult, setActionResult] = useState<unknown>(null);
  const [openingChapter, setOpeningChapter] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [reviewAction, setReviewAction] = useState<string | null>(null);
  const [chatChapter, setChatChapter] = useState<ChapterMeta | null>(null);
  const [chatMessages, setChatMessages] = useState<ReadonlyArray<ChapterChatMessage>>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatting, setChatting] = useState(false);
  const [chatLiveItems, setChatLiveItems] = useState<ReadonlyArray<ChatKitItem> | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLogOpen, setChatLogOpen] = useState(false);
  const [chatProfiles, setChatProfiles] = useState<ReadonlyArray<LlmProfile>>([]);
  const [chatProfileId, setChatProfileId] = useState<string | undefined>(undefined);
  const [replacingChapter, setReplacingChapter] = useState(false);
  const [replacePreviewOpen, setReplacePreviewOpen] = useState(false);
  const [replacePreviewLoading, setReplacePreviewLoading] = useState(false);
  const [replaceOriginalContent, setReplaceOriginalContent] = useState("");
  const [replaceCandidateContent, setReplaceCandidateContent] = useState("");
  const chatAbortRef = useRef<AbortController | null>(null);

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

  function isCancelledError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybe = error as { code?: unknown; message?: unknown; name?: unknown };
    if (maybe.code === "JOB_CANCELLED") return true;
    if (maybe.name === "AbortError") return true;
    return typeof maybe.message === "string" && maybe.message.includes("取消");
  }

  function chapterModelMessages(messages: ReadonlyArray<ChapterChatMessage>): ReadonlyArray<Pick<ChapterChatMessage, "role" | "content">> {
    return messages.map((item) => ({
      role: item.role,
      content: item.content,
    }));
  }

  function abortChapterChatStream(): void {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
  }

  function stopChapterChat(): void {
    if (!chatting) return;
    abortChapterChatStream();
    setChatting(false);
    setChatLiveItems(null);
    setChatError(null);
    void message.success("已停止本次章节对话");
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

  async function refreshChapterWords(chapter: number): Promise<void> {
    setOpeningChapter(chapter);
    try {
      const response = await fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error ?? "重算字数失败");
      }
      const list = Array.isArray(data.chapters) ? (data.chapters as ReadonlyArray<ChapterMeta>) : [];
      setChapters(list);
      const current = list.find((item) => item.number === chapter);
      void message.success(`已校准 Ch.${chapter} 字数${current ? `：${current.wordCount.toLocaleString()} 字` : ""}`);
    } catch (error: unknown) {
      void message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningChapter(null);
    }
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

  function deleteChapter(chapter: number): void {
    const actionKey = `delete:${chapter}`;
    setReviewAction(actionKey);
    void fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${chapter}`, {
      method: "DELETE",
    })
      .then(async (response) => {
        const data = await response.json();
        setActionResult(data);
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error ?? "删章失败");
        }
        await loadChapters();
        void message.success(`已删 Ch.${chapter}`);
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setReviewAction(null));
  }

  function openChapterChat(row: ChapterMeta): void {
    abortChapterChatStream();
    setChatChapter(row);
    setChatError(null);
    setChatLiveItems(null);
    setChatMessages(loadStoredChapterChat(row.number));
    void loadPersistedChatSession("chapter-chat", chapterSessionKey(row.number)).then((messages) => {
      if (Array.isArray(messages) && messages.length > 0) {
        setChatMessages(messages as ReadonlyArray<ChapterChatMessage>);
      }
    });
    setChatDraft("");
    void loadChatProfiles(row.number);
  }

  function sendChapterChat(): void {
    if (!chatChapter || !chatDraft.trim() || chatting) return;
    const chapterNumber = chatChapter.number;
    const nextMessages = [...chatMessages, { role: "user" as const, content: chatDraft.trim() }];
    setChatMessages(nextMessages);
    setChatLiveItems(messagesToChatKitItems(nextMessages));
    persistChapterChat(chapterNumber, nextMessages);
    setChatDraft("");
    setChatting(true);
    setChatError(null);
    abortChapterChatStream();
    const abortController = new AbortController();
    chatAbortRef.current = abortController;

    void (async () => {
      try {
        const streamOptions = {
          signal: abortController.signal,
          onFrame: (items: ChatKitItem[]) => {
            if (!abortController.signal.aborted) {
              setChatLiveItems(items);
            }
          },
        };
        let streamed;
        try {
          streamed = await consumeChapterChatWebSocket({
            bookId,
            chapterNumber,
            messages: nextMessages,
            profileId: chatProfileId,
            ...streamOptions,
          });
        } catch (error) {
          if (!(error instanceof ChapterChatSocketUnavailableError)) throw error;
          const response = await fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}/chat-stream`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: chapterModelMessages(nextMessages), profileId: chatProfileId }),
            signal: abortController.signal,
          });
          if (!response.ok) throw new Error(await response.text() || "章节对话失败");
          if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
            throw new Error("期望 SSE 流式响应，但服务端返回了非流式内容");
          }
          streamed = await consumeChatKitStream(response, nextMessages, streamOptions);
        }
        if (abortController.signal.aborted) return;
        const content = streamed.content.trim() || "已完成本次处理，但没有返回可显示的正文回复。";
        const updated = [...nextMessages, {
          role: "assistant" as const,
          content,
          reasoning: typeof streamed.reasoning === "string" && streamed.reasoning.trim()
            ? streamed.reasoning
            : undefined,
          items: streamed.items,
        }];
        setChatMessages(updated);
        setChatLiveItems(null);
        persistChapterChat(chapterNumber, updated);
      } catch (error: unknown) {
        if (isCancelledError(error)) return;
        const errorText = error instanceof Error ? error.message : String(error);
        if (error instanceof ChatKitStreamError && error.partial.items.length > 0) {
          const updated = [...nextMessages, {
            role: "assistant" as const,
            content: error.partial.content.trim() || "（生成中断，未返回完整正文。）",
            reasoning: error.partial.reasoning,
            items: error.partial.items,
          }];
          setChatMessages(updated);
          persistChapterChat(chapterNumber, updated);
        }
        setChatError(errorText);
        setChatLiveItems(null);
        setActionResult({ ok: false, scope: "chapter-chat", error: errorText });
        void message.error(errorText);
      } finally {
        if (chatAbortRef.current === abortController) {
          chatAbortRef.current = null;
        }
        setChatting(false);
      }
    })();
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
      await refreshChapterWords(chatChapter.number);
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
          <Button size="small" loading={openingChapter === row.number} onClick={() => void refreshChapterWords(row.number)}>校字</Button>
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
              <Popconfirm title={`确认删除 Ch.${row.number}？`} description="会删除章节文件并清理 story 关联表格，且不可恢复。" okText="删除" cancelText="取消" onConfirm={() => deleteChapter(row.number)}>
                <Button danger size="small" loading={reviewAction === `delete:${row.number}`}>删章</Button>
              </Popconfirm>
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
                    <Button loading={openingChapter === row.number} onClick={() => void refreshChapterWords(row.number)}>校字</Button>
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
                      <Popconfirm title={`确认删除 Ch.${row.number}？`} description="会删除章节文件并清理 story 关联表格，且不可恢复。" okText="删除" cancelText="取消" onConfirm={() => deleteChapter(row.number)}>
                        <Button danger loading={reviewAction === `delete:${row.number}`}>删章</Button>
                      </Popconfirm>
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
          <Typography.Text type="secondary">点击“审计 / 修订 / 通过 / 删章”后这里显示结果。</Typography.Text>
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
        width={isMobile ? "94vw" : CHAT_MODAL_DESKTOP_WIDTH}
        style={{ top: isMobile ? 8 : 12 }}
        styles={{ body: { paddingTop: 8, height: isMobile ? "76vh" : CHAT_MODAL_DESKTOP_BODY_HEIGHT, overflow: "hidden" } }}
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
              gridTemplateColumns: !isMobile && chatLogOpen ? "minmax(0,1fr) 420px" : "minmax(0,1fr)",
              gap: 12,
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <ChatPanel
              messages={chatMessages}
              items={chatLiveItems}
              value={chatDraft}
              onChange={setChatDraft}
              onSend={sendChapterChat}
              sending={chatting}
              placeholder="例如：把第三段里‘八十九天’改成‘八十八天’，并同步修正 current_state.md 里的对应表述。"
              emptyText="先说一句你想改什么，例如“把这一句改顺一点”“修一下 current_state.md 里的倒计时表述”。"
              minHeight={220}
              maxHeight="100%"
              topBar={(
                <Space wrap style={isMobile ? { width: "100%" } : undefined}>
                  <Select
                    style={isMobile ? { width: "100%" } : { minWidth: 280 }}
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
                </Space>
              )}
              footerRight={(
                <Space>
                  {!isMobile ? (
                    <Button onClick={() => setChatLogOpen((value) => !value)}>
                      {chatLogOpen ? "收起日志" : "实时日志"}
                    </Button>
                  ) : null}
                  <Button danger onClick={stopChapterChat} disabled={!chatting}>
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
              <ChatFactLogPanel title="实时日志 · 章节对话" eventIncludes="chapter.chat" />
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
