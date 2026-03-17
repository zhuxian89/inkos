"use client";

import { Alert, Button, Card, Col, Divider, Form, Input, InputNumber, Radio, Row, Select, Space, Statistic, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState, useTransition } from "react";
import { ChatPanel } from "./chat-panel";
import { IssueTags } from "./issue-tags";
import { labelBookStatus, labelGenre, labelPlatform } from "./labels";

interface CommandFieldOption {
  readonly label: string;
  readonly value: string;
}

interface CommandField {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "textarea" | "number" | "boolean" | "select";
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly description?: string;
  readonly defaultValue?: string | number | boolean;
  readonly options?: ReadonlyArray<CommandFieldOption>;
}

interface CommandDefinition {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly fields: ReadonlyArray<CommandField>;
}

interface ProjectSummary {
  readonly projectRoot: string;
  readonly initialized: boolean;
  readonly books: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly platform: string;
    readonly status: string;
    readonly chapters: number;
    readonly totalWords: number;
    readonly pendingReviews: number;
    readonly failedAudits: number;
  }>;
}

interface PendingReview {
  readonly bookId: string;
  readonly title: string;
  readonly chapter: number;
  readonly chapterTitle: string;
  readonly wordCount: number;
  readonly status: string;
  readonly issues: ReadonlyArray<string>;
}

interface CommandCatalogResponse {
  readonly commands: ReadonlyArray<CommandDefinition>;
  readonly daemon: {
    readonly running: boolean;
    readonly pid: number | null;
  };
}

interface CommandResult {
  readonly ok: boolean;
  readonly command?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly parsed?: unknown;
  readonly error?: string;
  readonly raw?: string;
}

interface CreateBookResult {
  readonly ok: boolean;
  readonly jobId?: string;
  readonly bookId?: string;
  readonly title?: string;
  readonly location?: string;
  readonly mode?: string;
  readonly error?: string;
}

interface WriteNextResult {
  readonly ok: boolean;
  readonly bookId?: string;
  readonly error?: string;
}

interface AuditResult {
  readonly ok: boolean;
  readonly bookId?: string;
  readonly error?: string;
}

interface ProjectInitResult {
  readonly ok: boolean;
  readonly projectRoot?: string;
  readonly name?: string;
  readonly error?: string;
}

interface ProjectInitValues {
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

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

interface WriteValues {
  readonly bookId?: string;
  readonly count: number;
  readonly words?: number;
  readonly context?: string;
}

interface AuditValues {
  readonly bookId?: string;
  readonly chapter?: number;
}

function buildInitialValues(fields: ReadonlyArray<CommandField>): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.name, field.defaultValue ?? (field.type === "boolean" ? false : "")]));
}

export function InkosConsole() {
  const [catalog, setCatalog] = useState<CommandCatalogResponse | null>(null);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [pendingReviews, setPendingReviews] = useState<ReadonlyArray<PendingReview>>([]);
  const [selectedCommandId, setSelectedCommandId] = useState<string>("status");
  const [commandFormValues, setCommandFormValues] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectInitResult, setProjectInitResult] = useState<ProjectInitResult | null>(null);
  const [createBookResult, setCreateBookResult] = useState<CreateBookResult | null>(null);
  const [createBookStep, setCreateBookStep] = useState<string | null>(null);
  const [isCreatingBook, setIsCreatingBook] = useState(false);
  const createBookPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [initAssistantMessages, setInitAssistantMessages] = useState<ReadonlyArray<InitAssistantMessage>>([]);
  const [initAssistantDraft, setInitAssistantDraft] = useState("");
  const [initAssistantBrief, setInitAssistantBrief] = useState("");
  const [isChattingInitAssistant, setIsChattingInitAssistant] = useState(false);
  const [writeNextResult, setWriteNextResult] = useState<WriteNextResult | null>(null);
  const [writeStep, setWriteStep] = useState<string | null>(null);
  const [isWriting, setIsWriting] = useState(false);
  const writePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const [projectInitForm] = Form.useForm<ProjectInitValues>();
  const [createBookForm] = Form.useForm<CreateBookValues>();
  const [writeForm] = Form.useForm<WriteValues>();
  const [auditForm] = Form.useForm<AuditValues>();
  const selectedCreateMode = Form.useWatch("initMode", createBookForm) ?? "full";

  async function refreshSummary(): Promise<void> {
    const [catalogResponse, summaryResponse, pendingResponse] = await Promise.all([
      fetch("/api/inkos/commands", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/inkos/summary", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/inkos/review/pending", { cache: "no-store" }).then((response) => response.json()),
    ]);
    setCatalog(catalogResponse);
    setSummary(summaryResponse);
    setPendingReviews(pendingResponse.pending ?? []);
  }

  useEffect(() => {
    projectInitForm.setFieldsValue({
      name: "",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o",
    });
    createBookForm.setFieldsValue({
      title: "",
      genre: "chuanyue",
      platform: "tomato",
      targetChapters: 200,
      chapterWords: 3000,
      initMode: "full",
      context: "",
    });
    writeForm.setFieldsValue({ bookId: "", count: 1, words: undefined, context: "" });
    auditForm.setFieldsValue({ bookId: "", chapter: undefined });

    void refreshSummary().catch((fetchError: unknown) => {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    });

    return () => {
      if (writePollRef.current) clearInterval(writePollRef.current);
      writePollRef.current = null;
      if (createBookPollRef.current) clearInterval(createBookPollRef.current);
      createBookPollRef.current = null;
    };
  }, [auditForm, createBookForm, projectInitForm, writeForm]);

  const commands = catalog?.commands ?? [];
  const selectedCommand = commands.find((command) => command.id === selectedCommandId) ?? commands[0];

  useEffect(() => {
    if (!selectedCommand) return;
    setCommandFormValues(buildInitialValues(selectedCommand.fields));
  }, [selectedCommandId, selectedCommand]);

  function sendInitAssistantMessage(): void {
    const draft = initAssistantDraft.trim();
    if (!draft || isChattingInitAssistant) return;

    const values = createBookForm.getFieldsValue();
    const nextMessages = [...initAssistantMessages, { role: "user" as const, content: draft }];
    setInitAssistantMessages(nextMessages);
    setInitAssistantDraft("");
    setIsChattingInitAssistant(true);
    setError(null);

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
        currentBrief: initAssistantBrief || undefined,
        messages: nextMessages,
      }),
    })
      .then(async (response) => {
        const data = (await response.json()) as InitAssistantResult;
        if (!response.ok || !data.ok) {
          setError(data.error ?? "智能初始化对话失败");
          return;
        }
        const reply = data.reply?.trim() || "我已经整理好了当前方向，你可以继续补充。";
        setInitAssistantMessages((prev) => [...prev, { role: "assistant", content: reply }]);
        setInitAssistantBrief(data.brief ?? "");
      })
      .catch((runError: unknown) => {
        setError(runError instanceof Error ? runError.message : String(runError));
      })
      .finally(() => {
        setIsChattingInitAssistant(false);
      });
  }

  function runCommand(): void {
    if (!selectedCommand) return;
    if (isPending) {
      setError("命令仍在执行，请不要重复提交。");
      return;
    }
    setError(null);
    setResult(null);
    startTransition(() => {
      void fetch(`/api/inkos/commands/${selectedCommand.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: commandFormValues }),
      })
        .then(async (response) => {
          const data = (await response.json()) as CommandResult;
          setResult(data);
          if (!response.ok) {
            const parsedError =
              data.parsed && typeof data.parsed === "object" && "error" in data.parsed
                ? String((data.parsed as { error?: unknown }).error ?? "")
                : "";
            setError(parsedError || data.error || data.stderr || data.raw || "命令执行失败");
            return;
          }
          await refreshSummary();
        })
        .catch((runError: unknown) => {
          setError(runError instanceof Error ? runError.message : String(runError));
        });
    });
  }

  function submitProjectInit(values: ProjectInitValues): void {
    setError(null);
    startTransition(() => {
      void fetch("/api/inkos/project/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: values.name || undefined,
          provider: values.provider,
          baseUrl: values.baseUrl,
          apiKey: values.apiKey,
          model: values.model,
        }),
      }).then(async (response) => {
        const data = (await response.json()) as ProjectInitResult;
        setProjectInitResult(data);
        if (!response.ok) {
          setError(data.error ?? "初始化失败");
          return;
        }
        await refreshSummary();
      }).catch((runError: unknown) => {
        setError(runError instanceof Error ? runError.message : String(runError));
      });
    });
  }

  function submitCreateBook(values: CreateBookValues): void {
    if (isCreatingBook) return;
    if (values.initMode === "smart" && !initAssistantBrief.trim()) {
      setError("请先完成一次智能初始化对话，生成长期创作约束后再创建书籍。");
      return;
    }
    setError(null);
    setIsCreatingBook(true);
    setCreateBookStep("提交中...");
    setCreateBookResult(null);

    fetch("/api/inkos/books", {
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
        authorBrief: values.initMode === "smart" ? initAssistantBrief || undefined : undefined,
      }),
    })
      .then((response) => response.json())
      .then((data: { ok: boolean; jobId?: string; bookId?: string; error?: string }) => {
        if (!data.ok || !data.jobId) {
          setCreateBookResult(data);
          setIsCreatingBook(false);
          setCreateBookStep(null);
          setError(data.error ?? "创建书籍失败");
          return;
        }

        setCreateBookResult({ ok: true, jobId: data.jobId, bookId: data.bookId });
        const jobId = data.jobId;
        createBookPollRef.current = setInterval(async () => {
          try {
            const pollRes = await fetch(`/api/inkos/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
            const job = await pollRes.json();
            setCreateBookStep(job.step ?? "执行中...");
            if (job.status === "done" || job.status === "error") {
              if (createBookPollRef.current) clearInterval(createBookPollRef.current);
              createBookPollRef.current = null;
              setCreateBookResult(job.status === "done" ? job.result : { ok: false, error: job.error });
              if (job.status === "error") setError(job.error ?? "创建书籍失败");
              setIsCreatingBook(false);
              setCreateBookStep(null);
              await refreshSummary();
            }
          } catch {
            // polling error, keep retrying
          }
        }, 3000);
      })
      .catch((runError: unknown) => {
        setError(runError instanceof Error ? runError.message : String(runError));
        setIsCreatingBook(false);
        setCreateBookStep(null);
      });
  }

  function submitWriteNext(values: WriteValues): void {
    if (isWriting) return;
    setError(null);
    setIsWriting(true);
    setWriteStep("提交中...");
    setWriteNextResult(null);

    fetch("/api/inkos/writing/next", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookId: values.bookId || undefined,
        count: values.count,
        words: values.words || undefined,
        context: values.context || undefined,
      }),
    })
      .then((response) => response.json())
      .then((data: { ok: boolean; jobId?: string; error?: string }) => {
        if (!data.ok || !data.jobId) {
          setWriteNextResult(data);
          setIsWriting(false);
          setWriteStep(null);
          setError(data.error ?? "续写失败");
          return;
        }
        const jobId = data.jobId;
        writePollRef.current = setInterval(async () => {
          try {
            const pollRes = await fetch(`/api/inkos/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
            const job = await pollRes.json();
            setWriteStep(job.step ?? "执行中...");
            if (job.status === "done" || job.status === "error") {
              if (writePollRef.current) clearInterval(writePollRef.current);
              writePollRef.current = null;
              setWriteNextResult(job.status === "done" ? job.result : { ok: false, error: job.error });
              if (job.status === "error") setError(job.error ?? "续写失败");
              setIsWriting(false);
              setWriteStep(null);
              await refreshSummary();
            }
          } catch {
            // polling error, keep retrying
          }
        }, 3000);
      })
      .catch((runError: unknown) => {
        setError(runError instanceof Error ? runError.message : String(runError));
        setIsWriting(false);
        setWriteStep(null);
      });
  }

  function submitAudit(values: AuditValues): void {
    setError(null);
    startTransition(() => {
      void fetch("/api/inkos/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookId: values.bookId || undefined,
          chapter: values.chapter || undefined,
        }),
      }).then(async (response) => {
        const data = (await response.json()) as AuditResult;
        setAuditResult(data);
        if (!response.ok) {
          setError(data.error ?? "审计失败");
          return;
        }
        await refreshSummary();
      }).catch((runError: unknown) => {
        setError(runError instanceof Error ? runError.message : String(runError));
      });
    });
  }

  function reviewAction(action: "approve" | "reject", item: PendingReview): void {
    startTransition(() => {
      void fetch(`/api/inkos/review/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookId: item.bookId,
          chapter: item.chapter,
          ...(action === "reject" ? { reason: "来自 Web 控制台的驳回" } : {}),
        }),
      }).then(async (response) => {
        const data = await response.json();
        if (!response.ok) {
          const actionText = action === "approve" ? "通过" : "驳回";
          setError(data.error ?? `${actionText}失败`);
          return;
        }
        await refreshSummary();
      }).catch((runError: unknown) => {
        setError(runError instanceof Error ? runError.message : String(runError));
      });
    });
  }

  const totalChapters = summary?.books.reduce((sum, book) => sum + book.chapters, 0) ?? 0;
  const totalWords = summary?.books.reduce((sum, book) => sum + book.totalWords, 0) ?? 0;
  const totalPending = summary?.books.reduce((sum, book) => sum + book.pendingReviews, 0) ?? 0;
  const daemon = catalog?.daemon;

  const reviewColumns: ColumnsType<PendingReview> = [
    { title: "书籍", key: "book", render: (_, row) => `${row.title} (${row.bookId})` },
    { title: "章节", key: "chapter", render: (_, row) => `Ch.${row.chapter} · ${row.chapterTitle}` },
    { title: "字数", dataIndex: "wordCount", key: "wordCount", width: 120 },
    { title: "状态", dataIndex: "status", key: "status", width: 120 },
    {
      title: "问题",
      key: "issues",
      render: (_, row) => <IssueTags issues={row.issues} maxVisible={2} />,
    },
    {
      title: "操作",
      key: "actions",
      width: 180,
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => reviewAction("approve", row)} loading={isPending}>通过</Button>
          <Button size="small" danger onClick={() => reviewAction("reject", row)} loading={isPending}>驳回</Button>
        </Space>
      ),
    },
  ];

  const bookColumns: ColumnsType<ProjectSummary["books"][number]> = [
    { title: "书籍", key: "book", render: (_, row) => `${row.title} (${row.id})` },
    {
      title: "题材/平台",
      key: "meta",
      render: (_, row) => (
        <Space wrap>
          <Tag title={row.genre}>{labelGenre(row.genre)}</Tag>
          <Tag title={row.platform}>{labelPlatform(row.platform)}</Tag>
        </Space>
      ),
    },
    { title: "状态", dataIndex: "status", key: "status", width: 120, render: (v: string) => <Tag title={v} color="blue">{labelBookStatus(v)}</Tag> },
    { title: "章节数", dataIndex: "chapters", key: "chapters", width: 110 },
    { title: "总字数", dataIndex: "totalWords", key: "totalWords", width: 130 },
    { title: "待审核", dataIndex: "pendingReviews", key: "pendingReviews", width: 110 },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="书籍数" value={summary?.books.length ?? 0} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="章节数" value={totalChapters} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="总字数" value={totalWords} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="守护进程" value={daemon?.running ? "运行中" : "未运行"} suffix={daemon?.pid ? `PID:${daemon.pid}` : ""} /></Card></Col>
      </Row>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Tabs
        items={[
          {
            key: "quick",
            label: "高频操作",
            children: (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                {!summary?.initialized ? (
                  <Card title="初始化工作区">
                    <Form layout="vertical" form={projectInitForm} onFinish={submitProjectInit}>
                      <Form.Item label="项目名称" name="name"><Input /></Form.Item>
                      <Form.Item label="服务商" name="provider" rules={[{ required: true }]}>
                        <Select options={[{ value: "openai", label: "openai" }, { value: "anthropic", label: "anthropic" }]} />
                      </Form.Item>
                      <Form.Item label="Base URL（接口地址）" name="baseUrl" rules={[{ required: true }]}><Input /></Form.Item>
                      <Form.Item label="API Key（密钥）" name="apiKey" rules={[{ required: true }]}><Input.Password /></Form.Item>
                      <Form.Item label="模型" name="model" rules={[{ required: true }]}><Input /></Form.Item>
                      <Button type="primary" htmlType="submit" loading={isPending}>初始化</Button>
                    </Form>
                    {projectInitResult ? <pre>{JSON.stringify(projectInitResult, null, 2)}</pre> : null}
                  </Card>
                ) : null}

                <Row gutter={[16, 16]}>
                  <Col xs={24} xl={8}>
                    <Card title="创建书籍">
                      <Form layout="vertical" form={createBookForm} onFinish={submitCreateBook}>
                        <Form.Item label="书名" name="title" rules={[{ required: true }]}><Input /></Form.Item>
                        <Form.Item label="题材" name="genre" rules={[{ required: true }]}>
                          <Select options={[
                            { value: "chuanyue", label: "穿越（chuanyue）" },
                            { value: "xuanhuan", label: "玄幻（xuanhuan）" },
                            { value: "xianxia", label: "仙侠（xianxia）" },
                            { value: "urban", label: "都市（urban）" },
                            { value: "horror", label: "恐怖（horror）" },
                            { value: "other", label: "其他（other）" },
                          ]} />
                        </Form.Item>
                        <Form.Item label="平台" name="platform" rules={[{ required: true }]}>
                          <Select options={[
                            { value: "tomato", label: "番茄（tomato）" },
                            { value: "feilu", label: "飞卢（feilu）" },
                            { value: "qidian", label: "起点（qidian）" },
                            { value: "other", label: "其他（other）" },
                          ]} />
                        </Form.Item>
                        <Form.Item label="目标章节数" name="targetChapters" rules={[{ required: true }]}><InputNumber min={1} style={{ width: "100%" }} /></Form.Item>
                        <Form.Item label="每章字数" name="chapterWords" rules={[{ required: true }]}><InputNumber min={500} style={{ width: "100%" }} /></Form.Item>
                        <Form.Item label="创作约束" name="context"><Input.TextArea rows={3} /></Form.Item>
                        <Form.Item label="初始化模式" name="initMode" rules={[{ required: true }]}>
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
                          <Card
                            size="small"
                            title="智能初始化对话"
                            style={{ marginBottom: 16, background: "#fafcff" }}
                          >
                            <Space direction="vertical" size={12} style={{ width: "100%" }}>
                              <Typography.Text type="secondary">
                                先和初始化助手聊清楚主题、主线、结局、人物和平台方向，再用整理后的长期创作约束进入完整初始化。
                              </Typography.Text>
                              <ChatPanel
                                messages={initAssistantMessages}
                                value={initAssistantDraft}
                                onChange={setInitAssistantDraft}
                                onSend={sendInitAssistantMessage}
                                sending={isChattingInitAssistant}
                                placeholder="例如：我想写一本都市修仙，主角前期苟着发育，中期开始反杀，结局是建立新秩序。"
                                emptyText="先输入你的题材、故事走向或结局想法，助手会帮你整理成长期创作约束。"
                                minHeight={240}
                                maxHeight={360}
                                sendText="发送给初始化助手"
                              />
                              <div>
                                <Typography.Text strong>长期创作约束</Typography.Text>
                                <Input.TextArea
                                  rows={10}
                                  value={initAssistantBrief}
                                  onChange={(event) => setInitAssistantBrief(event.target.value)}
                                  placeholder="智能初始化整理出的长期创作约束会显示在这里，创建后也可以继续修改。"
                                  style={{ marginTop: 8 }}
                                />
                              </div>
                            </Space>
                          </Card>
                        ) : null}
                        <Button type="primary" htmlType="submit" loading={isCreatingBook}>创建</Button>
                        {createBookStep ? <Typography.Text type="secondary" style={{ marginLeft: 8 }}>{createBookStep}</Typography.Text> : null}
                      </Form>
                      {createBookResult ? <pre>{JSON.stringify(createBookResult, null, 2)}</pre> : null}
                    </Card>
                  </Col>
                  <Col xs={24} xl={8}>
                    <Card title="续写下一章">
                      <Form layout="vertical" form={writeForm} onFinish={submitWriteNext}>
                        <Form.Item label="书籍ID（bookId）" name="bookId"><Input placeholder="可留空自动检测" /></Form.Item>
                        <Form.Item label="生成章数" name="count" rules={[{ required: true }]}><InputNumber min={1} style={{ width: "100%" }} /></Form.Item>
                        <Form.Item label="覆盖字数" name="words"><InputNumber min={500} style={{ width: "100%" }} /></Form.Item>
                        <Form.Item label="补充上下文" name="context"><Input.TextArea rows={3} /></Form.Item>
                        <Button type="primary" htmlType="submit" loading={isWriting}>开始续写</Button>
                        {writeStep ? <Typography.Text type="secondary" style={{ marginLeft: 8 }}>{writeStep}</Typography.Text> : null}
                      </Form>
                      {writeNextResult ? <pre>{JSON.stringify(writeNextResult, null, 2)}</pre> : null}
                    </Card>
                  </Col>
                  <Col xs={24} xl={8}>
                    <Card title="章节审计">
                      <Form layout="vertical" form={auditForm} onFinish={submitAudit}>
                        <Form.Item label="书籍ID（bookId）" name="bookId"><Input placeholder="可留空自动检测" /></Form.Item>
                        <Form.Item label="章节号" name="chapter"><InputNumber min={1} style={{ width: "100%" }} /></Form.Item>
                        <Button type="primary" htmlType="submit" loading={isPending}>执行审计</Button>
                      </Form>
                      {auditResult ? <pre>{JSON.stringify(auditResult, null, 2)}</pre> : null}
                    </Card>
                  </Col>
                </Row>

                <Card title={`审核队列（${pendingReviews.length}）`}>
                  <Table rowKey={(row) => `${row.bookId}-${row.chapter}`} dataSource={pendingReviews.slice()} columns={reviewColumns} pagination={{ pageSize: 8 }} />
                </Card>
              </Space>
            ),
          },
          {
            key: "commands",
            label: "通用命令",
            children: (
              <Card>
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Typography.Text type="secondary">低频能力保留为通用命令执行器。</Typography.Text>
                  <Select
                    style={{ width: "100%" }}
                    className="command-picker"
                    popupClassName="command-picker-popup"
                    value={selectedCommand?.id}
                    onChange={(value) => setSelectedCommandId(value)}
                    dropdownMatchSelectWidth={false}
                    options={commands.map((command) => ({
                      label: `${command.category} / ${command.title}`,
                      value: command.id,
                    }))}
                    placeholder="选择命令"
                  />
                  <Typography.Text>{selectedCommand?.description}</Typography.Text>
                  <Divider style={{ margin: "8px 0" }} />
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    {(selectedCommand?.fields ?? []).map((field) => (
                      <div key={field.name}>
                        <Typography.Text strong>{field.label}</Typography.Text>
                        <div style={{ marginTop: 6 }}>{renderField(field, commandFormValues[field.name], setCommandFormValues)}</div>
                        {field.description ? <Typography.Text type="secondary">{field.description}</Typography.Text> : null}
                      </div>
                    ))}
                  </Space>
                  <Space>
                    <Button type="primary" loading={isPending} onClick={runCommand}>运行</Button>
                    <Button disabled={isPending} onClick={() => selectedCommand && setCommandFormValues(buildInitialValues(selectedCommand.fields))}>重置</Button>
                  </Space>
                  {isPending ? <Alert type="info" showIcon message="命令执行中，请等待返回结果，不要重复点击。" /> : null}
                  {result ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}
                </Space>
              </Card>
            ),
          },
          {
            key: "snapshot",
            label: "项目快照",
            children: (
              <Card
                title="项目快照"
                extra={<Tag color="blue">待审核：{totalPending}</Tag>}
              >
                <Typography.Paragraph type="secondary">
                  {summary?.initialized ? summary.projectRoot : "当前目录尚未完成 InkOS 初始化。"}
                </Typography.Paragraph>
                <Table
                  rowKey="id"
                  dataSource={(summary?.books ?? []).slice()}
                  columns={bookColumns}
                  pagination={{ pageSize: 8 }}
                />
              </Card>
            ),
          },
        ]}
      />

        <Card title="命令输出">
        {!result ? (
          <Typography.Text type="secondary">运行通用命令后这里显示输出。</Typography.Text>
        ) : (
          <pre style={{ margin: 0 }}>{JSON.stringify(result.parsed ?? result, null, 2)}</pre>
        )}
      </Card>
    </Space>
  );
}

function renderField(
  field: CommandField,
  value: unknown,
  setFormValues: Dispatch<SetStateAction<Record<string, unknown>>>,
) {
  const onChange = (nextValue: unknown) => setFormValues((current) => ({ ...current, [field.name]: nextValue }));

  if (field.type === "textarea") {
    return <Input.TextArea value={String(value ?? "")} placeholder={field.placeholder} rows={4} onChange={(event) => onChange(event.target.value)} />;
  }
  if (field.type === "select") {
    return (
      <Select
        value={String(value ?? "")}
        onChange={(next) => onChange(next)}
        options={(field.options ?? []).map((option) => ({ label: option.label, value: option.value }))}
        placeholder={field.placeholder ?? "请选择..."}
        allowClear
      />
    );
  }
  if (field.type === "number") {
    return <InputNumber value={typeof value === "number" ? value : Number(value || 0)} onChange={(next) => onChange(next ?? 0)} style={{ width: "100%" }} />;
  }
  if (field.type === "boolean") {
    return (
      <Select
        value={Boolean(value) ? "true" : "false"}
        onChange={(next) => onChange(next === "true")}
        options={[{ label: "是（true）", value: "true" }, { label: "否（false）", value: "false" }]}
      />
    );
  }
  return <Input value={String(value ?? "")} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />;
}
