"use client";

import { App, Button, Card, Checkbox, Col, Divider, Form, Grid, Input, InputNumber, Modal, Radio, Row, Select, Space, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./chat-panel";
import { clearPersistedChatSession, loadPersistedChatSession, savePersistedChatSession } from "./chat-persistence";
import { CHAT_MODAL_BODY_HEIGHT, CHAT_MODAL_WIDTH } from "./chat-modal";

interface CreateBookValues {
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly targetChapters: number;
  readonly chapterWords: number;
  readonly initMode: "fast" | "full" | "smart";
  readonly context?: string;
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

const CREATE_BOOK_CHAT_STORAGE_KEY = "inkos.create-book.smart-chat";
const CREATE_BOOK_BRIEF_STORAGE_KEY = "inkos.create-book.smart-brief";
const CREATE_BOOK_CHAT_OPTIONS_STORAGE_KEY = "inkos.create-book.smart-chat-options";
const CREATE_BOOK_CHAT_PROFILE_STORAGE_KEY = "inkos.create-book.smart-chat-profile";

export function CreateBookLauncher(props: Readonly<{
  readonly buttonText?: string;
  readonly buttonType?: "default" | "primary";
  readonly onCreated?: () => void | Promise<void>;
}>) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createStep, setCreateStep] = useState<string | null>(null);
  const [chatting, setChatting] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<ReadonlyArray<InitAssistantMessage>>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [assistantBrief, setAssistantBrief] = useState("");
  const [assistantUseStream, setAssistantUseStream] = useState(true);
  const [assistantIncludeReasoning, setAssistantIncludeReasoning] = useState(false);
  const [assistantProfiles, setAssistantProfiles] = useState<ReadonlyArray<LlmProfile>>([]);
  const [assistantProfileId, setAssistantProfileId] = useState<string | undefined>(undefined);
  const [createResult, setCreateResult] = useState<unknown>(null);
  const createPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [form] = Form.useForm<CreateBookValues>();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const selectedCreateMode = Form.useWatch("initMode", form) ?? "full";

  function assistantSessionKey(): string {
    return "book:new";
  }

  function loadStoredAssistantMessages(): ReadonlyArray<InitAssistantMessage> {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(CREATE_BOOK_CHAT_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ReadonlyArray<InitAssistantMessage>;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function persistAssistantMessages(messages: ReadonlyArray<InitAssistantMessage>): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CREATE_BOOK_CHAT_STORAGE_KEY, JSON.stringify(messages));
    void savePersistedChatSession("book-chat", assistantSessionKey(), {
      title: "新建书籍智能初始化",
      messages,
      meta: { source: "create-book-launcher" },
    });
  }

  function loadStoredAssistantBrief(): string {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(CREATE_BOOK_BRIEF_STORAGE_KEY) ?? "";
  }

  function loadStoredAssistantChatOptions(): { readonly useStream: boolean; readonly includeReasoning: boolean } {
    if (typeof window === "undefined") {
      return { useStream: true, includeReasoning: false };
    }
    try {
      const raw = window.localStorage.getItem(CREATE_BOOK_CHAT_OPTIONS_STORAGE_KEY);
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

  function persistAssistantChatOptions(options: { readonly useStream: boolean; readonly includeReasoning: boolean }): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CREATE_BOOK_CHAT_OPTIONS_STORAGE_KEY, JSON.stringify(options));
  }

  function loadStoredAssistantProfileId(): string | undefined {
    if (typeof window === "undefined") return undefined;
    const value = window.localStorage.getItem(CREATE_BOOK_CHAT_PROFILE_STORAGE_KEY);
    return value?.trim() ? value : undefined;
  }

  function persistAssistantProfileId(profileId?: string): void {
    if (typeof window === "undefined") return;
    if (profileId?.trim()) {
      window.localStorage.setItem(CREATE_BOOK_CHAT_PROFILE_STORAGE_KEY, profileId.trim());
      return;
    }
    window.localStorage.removeItem(CREATE_BOOK_CHAT_PROFILE_STORAGE_KEY);
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

  function persistAssistantBrief(brief: string): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CREATE_BOOK_BRIEF_STORAGE_KEY, brief);
  }

  useEffect(() => {
    form.setFieldsValue({
      title: "",
      genre: "chuanyue",
      platform: "tomato",
      targetChapters: 200,
      chapterWords: 3000,
      initMode: "full",
      context: "",
    });
    setAssistantMessages(loadStoredAssistantMessages());
    void loadPersistedChatSession("book-chat", assistantSessionKey()).then((messages) => {
      if (Array.isArray(messages) && messages.length > 0) {
        setAssistantMessages(messages as ReadonlyArray<InitAssistantMessage>);
      }
    });
    setAssistantBrief(loadStoredAssistantBrief());
    const storedOptions = loadStoredAssistantChatOptions();
    setAssistantUseStream(storedOptions.useStream);
    setAssistantIncludeReasoning(storedOptions.includeReasoning);
    void loadAssistantProfiles();

    return () => {
      if (createPollRef.current) clearInterval(createPollRef.current);
      createPollRef.current = null;
    };
  }, [form]);

  function resetAssistant(): void {
    setAssistantMessages([]);
    setAssistantDraft("");
    setAssistantBrief("");
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(CREATE_BOOK_CHAT_STORAGE_KEY);
      window.localStorage.removeItem(CREATE_BOOK_BRIEF_STORAGE_KEY);
    }
    void clearPersistedChatSession("book-chat", assistantSessionKey());
  }

  function closeModal(): void {
    if (isCreating) return;
    setOpen(false);
    setCreateStep(null);
    setCreateResult(null);
  }

  function sendInitAssistantMessage(): void {
    const draft = assistantDraft.trim();
    if (!draft || chatting) return;

    const values = form.getFieldsValue();
    const nextMessages = [...assistantMessages, { role: "user" as const, content: draft }];
    setAssistantMessages(nextMessages);
    persistAssistantMessages(nextMessages);
    setAssistantDraft("");
    setChatting(true);

    void fetch("/api/inkos/init-assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: values.title || "未命名作品",
        genre: values.genre || "other",
        platform: values.platform || "tomato",
        targetChapters: values.targetChapters || 200,
        chapterWords: values.chapterWords || 3000,
        context: values.context || undefined,
        currentBrief: assistantBrief || undefined,
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
          void message.error(data.error ?? "智能初始化对话失败");
          return;
        }
        const result = await new Promise<InitAssistantResult>((resolve, reject) => {
          const timer = setInterval(async () => {
            try {
              const pollRes = await fetch(`/api/inkos/jobs/${encodeURIComponent(String(data.jobId))}`, { cache: "no-store" });
              const job = await pollRes.json();
              if (job.status === "done") {
                clearInterval(timer);
                resolve(job.result as InitAssistantResult);
                return;
              }
              if (job.status === "error") {
                clearInterval(timer);
                reject(new Error(job.error ?? "智能初始化对话失败"));
              }
            } catch (error) {
              clearInterval(timer);
              reject(error);
            }
          }, 3000);
        });
        setAssistantMessages((prev) => {
          const updated = [...prev, {
            role: "assistant" as const,
            content: result.reply?.trim() || "我已经整理好了当前方向，你可以继续补充。",
            reasoning: typeof result.reasoning === "string" ? result.reasoning : undefined,
          }];
          persistAssistantMessages(updated);
          return updated;
        });
        const nextBrief = result.brief ?? "";
        setAssistantBrief(nextBrief);
        persistAssistantBrief(nextBrief);
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setChatting(false));
  }

  function submitCreateBook(values: CreateBookValues): void {
    if (isCreating) return;
    if (values.initMode === "smart" && !assistantBrief.trim()) {
      void message.error("请先完成一次智能初始化对话，生成长期创作约束后再创建。");
      return;
    }

    setIsCreating(true);
    setCreateStep("提交中...");
    setCreateResult(null);

    void fetch("/api/inkos/books", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: values.title,
        genre: values.genre,
        platform: values.platform,
        targetChapters: values.targetChapters,
        chapterWords: values.chapterWords,
        context: values.context || undefined,
        initMode: values.initMode,
        authorBrief: values.initMode === "smart" ? assistantBrief || undefined : undefined,
      }),
    })
      .then((response) => response.json())
      .then((data: { ok: boolean; jobId?: string; bookId?: string; error?: string }) => {
        if (!data.ok || !data.jobId) {
          setCreateResult(data);
          setCreateStep(null);
          setIsCreating(false);
          void message.error(data.error ?? "创建书籍失败");
          return;
        }

        createPollRef.current = setInterval(async () => {
          try {
            const pollRes = await fetch(`/api/inkos/jobs/${encodeURIComponent(data.jobId!)}`, { cache: "no-store" });
            const job = await pollRes.json();
            setCreateStep(job.step ?? "执行中...");
            if (job.status === "done" || job.status === "error") {
              if (createPollRef.current) clearInterval(createPollRef.current);
              createPollRef.current = null;
              setCreateResult(job.status === "done" ? job.result : { ok: false, error: job.error });
              setCreateStep(null);
              setIsCreating(false);

              if (job.status === "done") {
                void message.success("书籍创建完成");
                await props.onCreated?.();
                setOpen(false);
                form.resetFields();
                form.setFieldsValue({ genre: "chuanyue", platform: "tomato", targetChapters: 200, chapterWords: 3000, initMode: "full", context: "" });
                resetAssistant();
              } else {
                void message.error(job.error ?? "创建书籍失败");
              }
            }
          } catch {
            // keep polling
          }
        }, 3000);
      })
      .catch((error: unknown) => {
        setCreateStep(null);
        setIsCreating(false);
        void message.error(error instanceof Error ? error.message : String(error));
      });
  }

  return (
    <>
      <Button type={props.buttonType ?? "primary"} onClick={() => setOpen(true)}>
        {props.buttonText ?? "创建书籍"}
      </Button>
      <Modal
        title="创建书籍"
        open={open}
        onCancel={closeModal}
        footer={null}
        maskClosable={false}
        keyboard
        width={selectedCreateMode === "smart" ? (isMobile ? "94vw" : CHAT_MODAL_WIDTH) : 860}
        styles={selectedCreateMode === "smart" ? { body: { height: CHAT_MODAL_BODY_HEIGHT, overflow: "hidden" } } : undefined}
        destroyOnHidden
      >
        <Space direction="vertical" size={16} style={{ width: "100%", height: selectedCreateMode === "smart" ? "100%" : undefined }}>
          <Typography.Text type="secondary">
            创建流程分成两部分：左侧确定基础参数，右侧通过多轮对话把书名、主线、角色和结局方向聊清楚。
          </Typography.Text>
          <Form layout="vertical" form={form} onFinish={submitCreateBook} style={selectedCreateMode === "smart" ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } : undefined}>
            <Row gutter={[16, 16]}>
              <Col xs={24} lg={selectedCreateMode === "smart" ? 10 : 24}>
                <Card
                  size="small"
                  title="基本信息"
                  extra={<Tag color={selectedCreateMode === "smart" ? "blue" : "default"}>{selectedCreateMode === "smart" ? "智能初始化" : "标准模式"}</Tag>}
                >
                  <Form.Item label="书名" name="title" rules={[{ required: true }]}>
                    <Input placeholder="先写一个暂定名，也可以在右侧对话里慢慢确认" />
                  </Form.Item>
                  <Form.Item label="题材" name="genre" rules={[{ required: true }]}>
                    <Select options={[
                      { value: "chuanyue", label: "穿越" },
                      { value: "xuanhuan", label: "玄幻" },
                      { value: "xianxia", label: "仙侠" },
                      { value: "urban", label: "都市" },
                      { value: "horror", label: "恐怖" },
                      { value: "other", label: "其他" },
                    ]} />
                  </Form.Item>
                  <Form.Item label="平台" name="platform" rules={[{ required: true }]}>
                    <Select options={[
                      { value: "tomato", label: "番茄" },
                      { value: "feilu", label: "飞卢" },
                      { value: "qidian", label: "起点" },
                      { value: "other", label: "其他" },
                    ]} />
                  </Form.Item>
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item label="目标章节数" name="targetChapters" rules={[{ required: true }]}>
                        <InputNumber min={1} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item label="每章字数" name="chapterWords" rules={[{ required: true }]}>
                        <InputNumber min={500} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item label="长期创作约束" name="context">
                    <Input.TextArea rows={5} placeholder="这里写长期有效的创作要求。创建后会并入这本书的长期创作约束，并在后续每次续写时被读取。" />
                  </Form.Item>
                  <Form.Item label="初始化方式" name="initMode" rules={[{ required: true }]}>
                    <Radio.Group
                      optionType="button"
                      buttonStyle="solid"
                      options={[
                        { value: "fast", label: "快速初始化" },
                        { value: "full", label: "完整初始化" },
                        { value: "smart", label: "智能初始化" },
                      ]}
                    />
                  </Form.Item>
                  <Divider style={{ margin: "12px 0" }} />
                  <Space>
                    <Button type="primary" htmlType="submit" loading={isCreating}>创建书籍</Button>
                    {createStep ? <Typography.Text type="secondary">{createStep}</Typography.Text> : null}
                  </Space>
                </Card>
              </Col>

              {selectedCreateMode === "smart" ? (
                <Col xs={24} lg={14} style={{ display: "flex", minHeight: 0 }}>
                  <Card
                    size="small"
                    title="智能初始化对话"
                    style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
                    bodyStyle={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", height: "100%", minHeight: 0 }}>
                      <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
                        这里用来多轮确认书名、卖点、主线、角色关系、阶段高潮和结局方向。左边的基础参数会作为上下文一起参与对话。
                      </Typography.Text>
                      <ChatPanel
                        messages={assistantMessages}
                        value={assistantDraft}
                        onChange={setAssistantDraft}
                        onSend={sendInitAssistantMessage}
                        sending={chatting}
                        placeholder="例如：我想写一本短篇穿越爽文，地点在武大图书馆，人物和案件全部架空，男主重生后要一步步翻盘，结局必须痛快。"
                        emptyText="先说说你想写什么，比如主题、人物、冲突、结局倾向。助手会一边追问，一边整理成长期创作约束；左侧填写的要求也会并进去。"
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
                                persistAssistantChatOptions({
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
                                persistAssistantChatOptions({
                                  useStream: assistantUseStream,
                                  includeReasoning: next,
                                });
                              }}
                            >
                              展示 reasoning
                            </Checkbox>
                          </Space>
                        )}
                        footerLeft={<Typography.Text type="secondary">建议连续聊 3 到 5 轮，再创建。</Typography.Text>}
                        footerRight={(
                          <Button
                            onClick={() => resetAssistant()}
                            disabled={chatting}
                          >
                            清空对话
                          </Button>
                        )}
                        sendText="发送给初始化助手"
                        containerStyle={{ flex: 1, minHeight: 0 }}
                      />
                      <div style={{ flexShrink: 0 }}>
                        <Typography.Text strong>长期创作约束</Typography.Text>
                        <Input.TextArea
                          rows={6}
                          value={assistantBrief}
                          onChange={(event) => {
                            setAssistantBrief(event.target.value);
                            persistAssistantBrief(event.target.value);
                          }}
                          placeholder="对话整理出的长期创作约束会显示在这里。创建时会与左侧填写内容合并保存，创建后也可以继续修改。"
                          style={{ marginTop: 8 }}
                        />
                      </div>
                    </div>
                  </Card>
                </Col>
              ) : null}
            </Row>
          </Form>
          {createResult ? (
            <Card size="small" title="结果">
              <pre style={{ margin: 0 }}>{JSON.stringify(createResult, null, 2)}</pre>
            </Card>
          ) : null}
        </Space>
      </Modal>
    </>
  );
}
