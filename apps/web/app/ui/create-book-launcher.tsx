"use client";

import { App, Button, Card, Form, Input, InputNumber, Modal, Radio, Select, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

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
}

interface InitAssistantResult {
  readonly ok: boolean;
  readonly reply?: string;
  readonly brief?: string;
  readonly error?: string;
}

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
  const [createResult, setCreateResult] = useState<unknown>(null);
  const createPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [form] = Form.useForm<CreateBookValues>();
  const selectedCreateMode = Form.useWatch("initMode", form) ?? "full";

  useEffect(() => {
    form.setFieldsValue({
      title: "",
      genre: "xuanhuan",
      platform: "tomato",
      targetChapters: 200,
      chapterWords: 3000,
      initMode: "full",
      context: "",
    });

    return () => {
      if (createPollRef.current) clearInterval(createPollRef.current);
      createPollRef.current = null;
    };
  }, [form]);

  function resetAssistant(): void {
    setAssistantMessages([]);
    setAssistantDraft("");
    setAssistantBrief("");
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
        messages: nextMessages,
      }),
    })
      .then(async (response) => {
        const data = (await response.json()) as InitAssistantResult;
        if (!response.ok || !data.ok) {
          void message.error(data.error ?? "智能初始化对话失败");
          return;
        }
        setAssistantMessages((prev) => [...prev, { role: "assistant", content: data.reply?.trim() || "我已经整理好了当前方向，你可以继续补充。" }]);
        setAssistantBrief(data.brief ?? "");
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setChatting(false));
  }

  function submitCreateBook(values: CreateBookValues): void {
    if (isCreating) return;
    if (values.initMode === "smart" && !assistantBrief.trim()) {
      void message.error("请先完成一次智能初始化对话，生成创作简报后再创建。");
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
                form.setFieldsValue({ genre: "xuanhuan", platform: "tomato", targetChapters: 200, chapterWords: 3000, initMode: "full", context: "" });
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
        width={860}
        destroyOnHidden
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            先定义这本书的基础参数。高阶的创作方向可以用“智能初始化”慢慢聊清楚。
          </Typography.Text>
          <Form layout="vertical" form={form} onFinish={submitCreateBook}>
            <Form.Item label="书名" name="title" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item label="题材" name="genre" rules={[{ required: true }]}>
              <Select options={[
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
            <Space style={{ width: "100%" }} size={12}>
              <Form.Item label="目标章节数" name="targetChapters" rules={[{ required: true }]} style={{ flex: 1 }}>
                <InputNumber min={1} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="每章字数" name="chapterWords" rules={[{ required: true }]} style={{ flex: 1 }}>
                <InputNumber min={500} style={{ width: "100%" }} />
              </Form.Item>
            </Space>
            <Form.Item label="长期创作约束" name="context">
              <Input.TextArea rows={4} />
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
            {selectedCreateMode === "smart" ? (
              <Card size="small" title="智能初始化">
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <div style={{ maxHeight: 220, overflow: "auto", padding: 12, border: "1px solid #f0f0f0", borderRadius: 8 }}>
                    {assistantMessages.length === 0 ? (
                      <Typography.Text type="secondary">先说说主题、主线、人物或结局，系统会整理成创作简报。</Typography.Text>
                    ) : (
                      <Space direction="vertical" size={10} style={{ width: "100%" }}>
                        {assistantMessages.map((message, index) => (
                          <div key={`${message.role}-${index}`}>
                            <Typography.Text strong>{message.role === "user" ? "你" : "初始化助手"}</Typography.Text>
                            <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{message.content}</div>
                          </div>
                        ))}
                      </Space>
                    )}
                  </div>
                  <Input.TextArea
                    rows={4}
                    value={assistantDraft}
                    onChange={(event) => setAssistantDraft(event.target.value)}
                    placeholder="例如：我想写一本都市修仙，前期压抑，中期反杀，结局建立新秩序。"
                  />
                  <Button onClick={sendInitAssistantMessage} loading={chatting}>发送给初始化助手</Button>
                  <div>
                    <Typography.Text strong>创作简报</Typography.Text>
                    <Input.TextArea
                      rows={8}
                      value={assistantBrief}
                      onChange={(event) => setAssistantBrief(event.target.value)}
                      placeholder="对话整理出的创作简报会显示在这里，创建后也可以继续修改。"
                      style={{ marginTop: 8 }}
                    />
                  </div>
                </Space>
              </Card>
            ) : null}
            <Space>
              <Button type="primary" htmlType="submit" loading={isCreating}>创建书籍</Button>
              {createStep ? <Typography.Text type="secondary">{createStep}</Typography.Text> : null}
            </Space>
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
