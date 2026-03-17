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
  Row,
  Select,
  Space,
  Statistic,
  Tabs,
  Tag,
  Typography,
  Upload,
} from "antd";
import { UploadOutlined } from "@ant-design/icons";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookChapters } from "./book-chapters";
import { ChatPanel } from "./chat-panel";
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
}

interface InitAssistantResult {
  readonly ok: boolean;
  readonly reply?: string;
  readonly brief?: string;
  readonly error?: string;
}

export function BookWorkspace({ bookId }: Readonly<{ bookId: string }>) {
  const { message } = App.useApp();
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
  const [styleFile, setStyleFile] = useState<File | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [writeForm] = Form.useForm<WriteValues>();
  const [settingsForm] = Form.useForm<BookSettingsValues>();
  const [exportForm] = Form.useForm<ExportValues>();
  const [styleForm] = Form.useForm<StyleImportValues>();
  const [canonForm] = Form.useForm<CanonValues>();

  async function loadBookPanels(): Promise<void> {
    setIsRefreshing(true);
    try {
      const [statusResponse, briefResponse, configResponse] = await Promise.all([
        fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/status`, { cache: "no-store" }).then((response) => response.json()),
        fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/init-brief`, { cache: "no-store" }).then((response) => response.json()),
        fetch(`/api/inkos/books/${encodeURIComponent(bookId)}/config`, { cache: "no-store" }).then((response) => response.json()),
      ]);
      setStatusData(statusResponse as BookStatusResponse);
      setAuthorBrief(typeof briefResponse?.content === "string" ? briefResponse.content : "");

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
    setAssistantDraft("");
    setChatting(true);

    void fetch("/api/inkos/init-assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: bookConfigData.book.title,
        genre: currentSettings.genre ?? bookConfigData.book.genre,
        platform: currentSettings.platform ?? bookConfigData.book.platform,
        targetChapters: currentSettings.targetChapters ?? bookConfigData.book.targetChapters,
        chapterWords: currentSettings.chapterWordCount ?? bookConfigData.book.chapterWordCount,
        context: contextLines.join("\n"),
        currentBrief: authorBrief || undefined,
        messages: nextMessages,
      }),
    })
      .then(async (response) => {
        const data = (await response.json()) as InitAssistantResult;
        if (!response.ok || !data.ok) {
          throw new Error(data.error ?? "智能初始化对话失败");
        }
        setAssistantMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.reply?.trim() || "我已经根据当前书籍设定整理了修改方向。",
          },
        ]);
        if (typeof data.brief === "string") {
          setAuthorBrief(data.brief);
        }
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setChatting(false));
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
              <Space align="center" size={12}>
                <Button type="primary" htmlType="submit" size="large" loading={isWriting}>开始续写</Button>
                {writeStep ? <Typography.Text type="secondary">{writeStep}</Typography.Text> : null}
              </Space>
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
                <Button type="primary" htmlType="submit" loading={toolAction === "export"}>导出</Button>
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
                  这里可以继续像编辑一样和系统对话，补强书名、主线、角色、阶段高潮和结局。助手会自动读取当前书籍设定和已保存的长期创作约束，并把它们当作这本书的长期上下文。
                </Typography.Text>
                <ChatPanel
                  messages={assistantMessages}
                  value={assistantDraft}
                  onChange={setAssistantDraft}
                  onSend={sendInitAssistantMessage}
                  sending={chatting}
                  placeholder="例如：现在这本书的开篇还不够狠，帮我把前三章改成更强冲突的穿越翻盘局，同时给出两个更抓人的书名。"
                  emptyText="先说一句你要怎么改这本书，比如“把男主目标改得更强”“给我三个更狠的书名”“结局想更爽一点”。"
                  minHeight={360}
                  maxHeight={480}
                  footerRight={(
                    <Button onClick={saveAuthorBrief} loading={isSavingBrief}>
                      保存长期创作约束
                    </Button>
                  )}
                />
                <div>
                  <Typography.Text strong>当前长期创作约束</Typography.Text>
                  <Input.TextArea
                    rows={10}
                    value={authorBrief}
                    onChange={(event) => setAuthorBrief(event.target.value)}
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
        title={`书籍工作台 · ${bookId}`}
        extra={(
          <Space>
            <Link href={`/books/${encodeURIComponent(bookId)}/audit`}><Button>专项审计</Button></Link>
            <Button loading={isRefreshing} onClick={() => void loadBookPanels()}>刷新</Button>
          </Space>
        )}
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}><Card><Statistic title="状态" value={statusData?.status?.status ? labelBookStatus(statusData.status.status) : "-"} /></Card></Col>
          <Col xs={24} sm={12} lg={6}><Card><Statistic title="已写章节" value={statusData?.status?.chaptersWritten ?? 0} /></Card></Col>
          <Col xs={24} sm={12} lg={6}><Card><Statistic title="总字数" value={statusData?.status?.totalWords ?? 0} /></Card></Col>
          <Col xs={24} sm={12} lg={6}><Card><Statistic title="下一章" value={statusData?.status?.nextChapter ?? 1} prefix="Ch." /></Card></Col>
        </Row>
      </Card>

      <Tabs defaultActiveKey="write" items={tabs} />

      <Card title="最近结果">
        {!result ? (
          <Typography.Text type="secondary">执行“续写 / 保存设定 / 保存简报 / 书籍工具”后这里显示结果。</Typography.Text>
        ) : (
          <Alert type="info" showIcon message={<pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>} />
        )}
      </Card>
    </Space>
  );
}
