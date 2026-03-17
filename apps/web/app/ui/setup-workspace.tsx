"use client";

import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import { ChatPanel } from "./chat-panel";

const PROFILE_CHAT_STORAGE_PREFIX = "inkos.profile-chat.";
const PROFILE_CHAT_GENRE_OPTIONS = [
  { label: "穿越", value: "chuanyue" },
  { label: "玄幻", value: "xuanhuan" },
  { label: "仙侠", value: "xianxia" },
  { label: "都市", value: "urban" },
  { label: "恐怖", value: "horror" },
  { label: "其他", value: "other" },
];
const PROFILE_CHAT_PLATFORM_OPTIONS = [
  { label: "番茄", value: "tomato" },
  { label: "起点", value: "qidian" },
  { label: "飞卢", value: "feilu" },
  { label: "其他", value: "other" },
];

interface ProfileFormValues {
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
}

interface SetupSummaryResponse {
  readonly initialized?: boolean;
  readonly projectRoot?: string;
  readonly books?: ReadonlyArray<{ readonly id: string }>;
  readonly config?: {
    readonly name?: string;
    readonly llm?: {
      readonly provider?: string;
      readonly baseUrl?: string;
      readonly model?: string;
    };
    readonly modelOverrides?: {
      readonly dialogue?: string;
    };
  } | null;
  readonly globalLlm?: {
    readonly provider?: string;
    readonly baseUrl?: string;
    readonly model?: string;
    readonly apiKeyConfigured?: boolean;
  } | null;
}

interface CommandCatalogResponse {
  readonly daemon: {
    readonly running: boolean;
    readonly pid: number | null;
  };
}

interface LlmProfile {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly isActive: boolean;
  readonly apiKeyConfigured: boolean;
  readonly updatedAt: string;
}

interface LlmProfilesResponse {
  readonly ok: boolean;
  readonly profiles: ReadonlyArray<LlmProfile>;
  readonly activeProfileId: string | null;
}

interface ProfileChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
}

interface StoredProfileChatSession {
  readonly messages: ReadonlyArray<ProfileChatMessage>;
  readonly genre?: string;
  readonly platform?: string;
  readonly useStream?: boolean;
  readonly includeReasoning?: boolean;
}

export function SetupWorkspace() {
  const { message } = App.useApp();
  const [initialized, setInitialized] = useState<boolean>(false);
  const [summary, setSummary] = useState<SetupSummaryResponse | null>(null);
  const [daemon, setDaemon] = useState<CommandCatalogResponse["daemon"] | null>(null);
  const [doctorResult, setDoctorResult] = useState<unknown>(null);
  const [daemonResult, setDaemonResult] = useState<unknown>(null);
  const [profiles, setProfiles] = useState<ReadonlyArray<LlmProfile>>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [dialogueModel, setDialogueModel] = useState<string>("");
  const [savingDialogueModel, setSavingDialogueModel] = useState(false);
  const [editingProfile, setEditingProfile] = useState<LlmProfile | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [testingProfileId, setTestingProfileId] = useState<string | null>(null);
  const [profileTestResult, setProfileTestResult] = useState<unknown>(null);
  const [chatProfile, setChatProfile] = useState<LlmProfile | null>(null);
  const [profileChatInput, setProfileChatInput] = useState("");
  const [profileChatMessages, setProfileChatMessages] = useState<ReadonlyArray<ProfileChatMessage>>([]);
  const [profileChatGenre, setProfileChatGenre] = useState<string>("chuanyue");
  const [profileChatPlatform, setProfileChatPlatform] = useState<string>("tomato");
  const [profileChatUseStream, setProfileChatUseStream] = useState(true);
  const [profileChatIncludeReasoning, setProfileChatIncludeReasoning] = useState(false);
  const [chattingProfileId, setChattingProfileId] = useState<string | null>(null);
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const [isTesting, setIsTesting] = useState(false);
  const [daemonAction, setDaemonAction] = useState<"up" | "down" | null>(null);

  async function loadSettingsContext(): Promise<void> {
    const [summaryData, catalogData, profileData] = await Promise.all([
      fetch("/api/inkos/summary", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/inkos/commands", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/inkos/llm-profiles", { cache: "no-store" }).then((response) => response.json()),
    ]);
    const data = summaryData as SetupSummaryResponse;
    const profilePayload = profileData as LlmProfilesResponse;

    setSummary(data);
    setDaemon((catalogData as CommandCatalogResponse).daemon);
    setInitialized(Boolean(data.initialized));
    setProfiles(Array.isArray(profilePayload.profiles) ? profilePayload.profiles : []);
    setActiveProfileId(profilePayload.activeProfileId ?? null);
    setDialogueModel(data.config?.modelOverrides?.dialogue ?? "");
  }

  useEffect(() => {
    void loadSettingsContext();
  }, []);

  function profileChatStorageKey(profileId: string): string {
    return `${PROFILE_CHAT_STORAGE_PREFIX}${profileId}`;
  }

  function loadStoredProfileChat(profileId: string): StoredProfileChatSession | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(profileChatStorageKey(profileId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredProfileChatSession;
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        genre: typeof parsed.genre === "string" ? parsed.genre : undefined,
        platform: typeof parsed.platform === "string" ? parsed.platform : undefined,
        useStream: parsed.useStream !== false,
        includeReasoning: parsed.includeReasoning === true,
      };
    } catch {
      return null;
    }
  }

  function persistProfileChat(profileId: string, payload: StoredProfileChatSession): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(profileChatStorageKey(profileId), JSON.stringify(payload));
  }

  function runDoctor(): void {
    if (isTesting) return;
    setIsTesting(true);
    void fetch("/api/inkos/commands/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: {} }),
    })
      .then((response) => response.json())
      .then((data) => setDoctorResult(data))
      .finally(() => setIsTesting(false));
  }

  function openCreateProfile(): void {
    const activeProfile = profiles.find((item) => item.id === activeProfileId);
    setEditingProfile(null);
    profileForm.setFieldsValue({
      name: "",
      provider: activeProfile?.provider ?? summary?.globalLlm?.provider ?? summary?.config?.llm?.provider ?? "openai",
      baseUrl: activeProfile?.baseUrl ?? summary?.globalLlm?.baseUrl ?? summary?.config?.llm?.baseUrl ?? "https://api.openai.com/v1",
      model: activeProfile?.model ?? summary?.globalLlm?.model ?? summary?.config?.llm?.model ?? "gpt-4o",
      apiKey: "",
    });
    setProfileModalOpen(true);
  }

  function openEditProfile(profile: LlmProfile): void {
    setEditingProfile(profile);
    profileForm.setFieldsValue({
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: "",
    });
    setProfileModalOpen(true);
  }

  function saveProfile(values: ProfileFormValues): void {
    if (profileSaving) return;
    setProfileSaving(true);
    const method = editingProfile ? "PUT" : "POST";
    const url = editingProfile ? `/api/inkos/llm-profiles/${editingProfile.id}` : "/api/inkos/llm-profiles";
    void fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: values.name,
        provider: values.provider,
        baseUrl: values.baseUrl,
        model: values.model,
        apiKey: values.apiKey?.trim() || undefined,
        activate: false,
      }),
    })
      .then((response) => response.json())
      .then(async (data) => {
        if (!data?.ok) {
          throw new Error(data?.error ?? "保存配置失败");
        }
        setProfileModalOpen(false);
        profileForm.resetFields();
        await loadSettingsContext();
        void message.success(editingProfile ? "配置已更新" : "配置已创建");
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setProfileSaving(false));
  }

  function activateProfile(profileId: string): void {
    if (profileLoading) return;
    setProfileLoading(true);
    void fetch(`/api/inkos/llm-profiles/${profileId}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
      .then((response) => response.json())
      .then(async (data) => {
        if (!data?.ok) {
          throw new Error(data?.error ?? "激活配置失败");
        }
        await loadSettingsContext();
        void message.success("已切换到目标配置");
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setProfileLoading(false));
  }

  function deleteProfile(profileId: string): void {
    if (deletingProfileId) return;
    setDeletingProfileId(profileId);
    void fetch(`/api/inkos/llm-profiles/${profileId}`, { method: "DELETE" })
      .then((response) => response.json())
      .then(async (data) => {
        if (!data?.ok) {
          throw new Error(data?.error ?? "删除配置失败");
        }
        await loadSettingsContext();
        void message.success("配置已删除");
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setDeletingProfileId(null));
  }

  function testProfile(profileId: string): void {
    if (testingProfileId) return;
    setTestingProfileId(profileId);
    setProfileTestResult(null);
    void fetch(`/api/inkos/llm-profiles/${profileId}/test`, { method: "POST" })
      .then((response) => response.json())
      .then((data) => {
        setProfileTestResult(data);
        if (!data?.ok) {
          throw new Error(data?.error ?? "测试失败");
        }
        void message.success("LLM 测试通过");
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setTestingProfileId(null));
  }

  function openProfileChat(profile: LlmProfile): void {
    const stored = loadStoredProfileChat(profile.id);
    setChatProfile(profile);
    setProfileChatInput("");
    setProfileChatMessages(stored?.messages ?? []);
    setProfileChatGenre(stored?.genre ?? "chuanyue");
    setProfileChatPlatform(stored?.platform ?? "tomato");
    setProfileChatUseStream(stored?.useStream !== false);
    setProfileChatIncludeReasoning(stored?.includeReasoning === true);
  }

  function sendProfileChat(): void {
    if (!chatProfile || chattingProfileId) return;
    const input = profileChatInput.trim();
    if (!input) return;

    const nextMessages: ReadonlyArray<ProfileChatMessage> = [
      ...profileChatMessages,
      { role: "user", content: input },
    ];
    setProfileChatMessages(nextMessages);
    persistProfileChat(chatProfile.id, {
      messages: nextMessages,
      genre: profileChatGenre,
      platform: profileChatPlatform,
      useStream: profileChatUseStream,
      includeReasoning: profileChatIncludeReasoning,
    });
    setProfileChatInput("");
    setChattingProfileId(chatProfile.id);

    void fetch(`/api/inkos/llm-profiles/${chatProfile.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: nextMessages,
        genre: profileChatGenre,
        platform: profileChatPlatform,
        useStream: profileChatUseStream,
        includeReasoning: profileChatIncludeReasoning,
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (!data?.ok) {
          throw new Error(data?.error ?? "对话失败");
        }
        setProfileChatMessages((current) => {
          const updated = [
            ...current,
            {
              role: "assistant" as const,
              content: typeof data?.content === "string" ? data.content : "",
              reasoning: typeof data?.reasoning === "string" ? data.reasoning : undefined,
            },
          ];
          persistProfileChat(chatProfile.id, {
            messages: updated,
            genre: profileChatGenre,
            platform: profileChatPlatform,
            useStream: profileChatUseStream,
            includeReasoning: profileChatIncludeReasoning,
          });
          return updated;
        });
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setProfileChatMessages((current) => {
          const updated = [
            ...current,
            {
              role: "assistant" as const,
              content: `请求失败：${errorMessage}`,
            },
          ];
          persistProfileChat(chatProfile.id, {
            messages: updated,
            genre: profileChatGenre,
            platform: profileChatPlatform,
            useStream: profileChatUseStream,
            includeReasoning: profileChatIncludeReasoning,
          });
          return updated;
        });
        void message.error(errorMessage);
      })
      .finally(() => setChattingProfileId(null));
  }

  function toggleDaemon(action: "up" | "down"): void {
    if (daemonAction) return;
    setDaemonAction(action);
    void fetch(`/api/inkos/commands/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: {} }),
    })
      .then((response) => response.json())
      .then(async (data) => {
        setDaemonResult(data);
        await loadSettingsContext();
      })
      .finally(() => setDaemonAction(null));
  }

  function saveDialogueModel(): void {
    if (savingDialogueModel) return;
    setSavingDialogueModel(true);
    void fetch("/api/inkos/project/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelOverrides: {
          dialogue: dialogueModel.trim() || null,
        },
      }),
    })
      .then((response) => response.json())
      .then(async (data) => {
        if (!data?.ok) {
          throw new Error(data?.error ?? "保存对话模型失败");
        }
        await loadSettingsContext();
        void message.success("对话模型已保存");
      })
      .catch((error: unknown) => {
        void message.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setSavingDialogueModel(false));
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card>
        <Typography.Title level={4}>设置</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这里集中处理模型配置、项目检测和自动写作开关。原来分散在命令里的项目级功能，统一归到这一页。
        </Typography.Paragraph>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="工作区" value={initialized ? "已初始化" : "未初始化"} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="书籍数" value={summary?.books?.length ?? 0} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="自动写作" value={daemon?.running ? "运行中" : "未运行"} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card><Statistic title="项目目录" value={summary?.projectRoot ? "已配置" : "未知"} /></Card></Col>
      </Row>

      <Card
        title="多套配置切换"
        extra={(
          <Space>
            <Button onClick={() => void loadSettingsContext()} loading={profileLoading}>刷新</Button>
            <Button type="primary" onClick={openCreateProfile}>新建配置</Button>
          </Space>
        )}
      >
        <Typography.Paragraph type="secondary">
          切换后会把选中配置写入原来的 `~/.inkos/.env`，运行时读取逻辑不变。
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Select
            placeholder="选择要激活的配置"
            value={activeProfileId ?? undefined}
            loading={profileLoading}
            options={profiles.map((profile) => ({
              value: profile.id,
              label: `${profile.name} · ${profile.provider}/${profile.model}`,
            }))}
            onChange={(value) => activateProfile(String(value))}
            style={{ width: "100%" }}
          />
          <Table<LlmProfile>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={[...profiles]}
            columns={[
              { title: "名称", dataIndex: "name", key: "name" },
              { title: "模型", key: "model", render: (_v, r) => `${r.provider}/${r.model}` },
              {
                title: "状态",
                key: "status",
                width: 120,
                render: (_v, r) => (r.isActive ? <Tag color="green">已激活</Tag> : <Tag>未激活</Tag>),
              },
              {
                title: "操作",
                key: "actions",
                width: 260,
                render: (_v, record) => (
                  <Space>
                    <Button size="small" onClick={() => openEditProfile(record)}>编辑</Button>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      disabled={record.isActive}
                      onClick={() => activateProfile(record.id)}
                    >
                      激活
                    </Button>
                    <Button size="small" loading={testingProfileId === record.id} onClick={() => testProfile(record.id)}>
                      测试
                    </Button>
                    <Tooltip title="直接和这个配置绑定的模型对话，验证真实输出效果。">
                      <Button size="small" onClick={() => openProfileChat(record)}>
                        对话
                      </Button>
                    </Tooltip>
                    <Popconfirm
                      title="确认删除这个配置吗？"
                      description={record.isActive ? "当前激活配置不能删除。" : "删除后不可恢复。"}
                      onConfirm={() => deleteProfile(record.id)}
                      disabled={record.isActive}
                    >
                      <Button size="small" danger disabled={record.isActive} loading={deletingProfileId === record.id}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="模型分工">
            <Typography.Paragraph type="secondary">
              这里可以单独指定“对话”场景使用的模型。留空时默认使用当前激活配置的主模型。
            </Typography.Paragraph>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Select
                showSearch
                allowClear
                placeholder="选择或输入一个对话模型"
                value={dialogueModel || undefined}
                onChange={(value) => setDialogueModel(String(value ?? ""))}
                onClear={() => setDialogueModel("")}
                options={Array.from(new Set(profiles.map((profile) => profile.model))).map((model) => ({
                  value: model,
                  label: model,
                }))}
              />
              <Input
                value={dialogueModel}
                onChange={(event) => setDialogueModel(event.target.value)}
                placeholder="也可以直接手填，例如 moonshotai/kimi-k2.5"
              />
              <Button type="primary" onClick={saveDialogueModel} loading={savingDialogueModel}>
                保存对话模型
              </Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            title="项目检测"
            extra={<Button loading={isTesting} onClick={runDoctor}>测试连接</Button>}
          >
            <Typography.Paragraph type="secondary">
              对应 `project doctor`。用于检查当前配置和 API 连通性。
            </Typography.Paragraph>
            {!doctorResult ? (
              <Typography.Text type="secondary">点击“测试连接”后，这里显示检测结果。</Typography.Text>
            ) : (
              <pre style={{ margin: 0 }}>{JSON.stringify(doctorResult, null, 2)}</pre>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            title="自动写作"
            extra={<Tag color={daemon?.running ? "green" : "default"}>{daemon?.running ? "运行中" : "未运行"}</Tag>}
          >
            <Typography.Paragraph type="secondary">
              对应 `up / down`。启动后系统会按计划在后台自动写章；停止后回到纯手动模式。
            </Typography.Paragraph>
            <Space>
              <Button type="primary" onClick={() => toggleDaemon("up")} loading={daemonAction === "up"} disabled={daemon?.running}>
                启动自动写作
              </Button>
              <Button danger onClick={() => toggleDaemon("down")} loading={daemonAction === "down"} disabled={!daemon?.running}>
                停止自动写作
              </Button>
            </Space>
            {daemonResult ? <pre style={{ marginTop: 16, marginBottom: 0 }}>{JSON.stringify(daemonResult, null, 2)}</pre> : null}
          </Card>
        </Col>
      </Row>

      <Card title="配置测试结果">
        {!profileTestResult ? (
          <Typography.Text type="secondary">点击“测试”后，这里显示对应配置的 LLM 连通结果。</Typography.Text>
        ) : (
          <Alert
            type={(profileTestResult as { ok?: boolean }).ok ? "success" : "error"}
            showIcon
            message={(profileTestResult as { ok?: boolean }).ok ? "测试成功" : "测试失败"}
            description={<pre style={{ margin: 0 }}>{JSON.stringify(profileTestResult, null, 2)}</pre>}
          />
        )}
      </Card>

      <Modal
        open={profileModalOpen}
        onCancel={() => setProfileModalOpen(false)}
        title={editingProfile ? "编辑配置" : "新建配置"}
        footer={null}
        destroyOnClose
      >
        <Form<ProfileFormValues> layout="vertical" form={profileForm} onFinish={saveProfile}>
          <Form.Item label="配置名称" name="name" rules={[{ required: true, message: "请输入配置名称" }]}>
            <Input placeholder="例如：OpenAI-主力" />
          </Form.Item>
          <Form.Item label="服务商" name="provider" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { label: "openai", value: "openai" },
                { label: "anthropic", value: "anthropic" },
              ]}
              optionType="button"
              buttonStyle="solid"
            />
          </Form.Item>
          <Form.Item label="Base URL（接口地址）" name="baseUrl" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="API Key（密钥）" name="apiKey">
            <Input.Password placeholder={editingProfile ? "留空表示保持不变" : "首次创建建议填写"} />
          </Form.Item>
          <Form.Item label="模型" name="model" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={profileSaving}>
              {editingProfile ? "保存" : "创建并激活"}
            </Button>
            <Button onClick={() => setProfileModalOpen(false)}>取消</Button>
          </Space>
        </Form>
      </Modal>

      <Modal
        open={Boolean(chatProfile)}
        onCancel={() => {
          if (chattingProfileId) return;
          setChatProfile(null);
          setProfileChatInput("");
          setProfileChatMessages([]);
        }}
        title={chatProfile ? `模型对话测试 · ${chatProfile.name}` : "模型对话测试"}
        footer={null}
        width={980}
        style={{ top: 20 }}
        styles={{ body: { paddingTop: 12, height: "90vh", overflow: "hidden" } }}
        destroyOnClose
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%" }}>
          <Card bodyStyle={{ padding: 16 }}>
            <Space wrap size={10}>
              <Select
                value={profileChatGenre}
                options={PROFILE_CHAT_GENRE_OPTIONS}
                onChange={(value) => {
                  const next = String(value);
                  setProfileChatGenre(next);
                  if (chatProfile) {
                    persistProfileChat(chatProfile.id, {
                      messages: profileChatMessages,
                      genre: next,
                      platform: profileChatPlatform,
                    });
                  }
                }}
                style={{ minWidth: 180 }}
                placeholder="测试题材"
              />
              <Select
                value={profileChatPlatform}
                options={PROFILE_CHAT_PLATFORM_OPTIONS}
                onChange={(value) => {
                  const next = String(value);
                  setProfileChatPlatform(next);
                  if (chatProfile) {
                    persistProfileChat(chatProfile.id, {
                      messages: profileChatMessages,
                      genre: profileChatGenre,
                      platform: next,
                    });
                  }
                }}
                style={{ minWidth: 180 }}
                placeholder="测试平台"
              />
              <Checkbox
                checked={profileChatUseStream}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setProfileChatUseStream(checked);
                  if (chatProfile) {
                    persistProfileChat(chatProfile.id, {
                      messages: profileChatMessages,
                      genre: profileChatGenre,
                      platform: profileChatPlatform,
                      useStream: checked,
                      includeReasoning: profileChatIncludeReasoning,
                    });
                  }
                }}
              >
                使用流式
              </Checkbox>
              <Checkbox
                checked={profileChatIncludeReasoning}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setProfileChatIncludeReasoning(checked);
                  if (chatProfile) {
                    persistProfileChat(chatProfile.id, {
                      messages: profileChatMessages,
                      genre: profileChatGenre,
                      platform: profileChatPlatform,
                      useStream: profileChatUseStream,
                      includeReasoning: checked,
                    });
                  }
                }}
              >
                展示 reasoning
              </Checkbox>
            </Space>
          </Card>

          <ChatPanel
            messages={profileChatMessages}
            value={profileChatInput}
            onChange={setProfileChatInput}
            onSend={sendProfileChat}
            sending={chattingProfileId === chatProfile?.id}
            placeholder="输入一段话，直接测试这个模型在 InkOS 项目中的真实回复。"
            emptyText={"这里可以直接测试这个模型在 InkOS 里的表现。\n比如让它生成爽文开篇、讨论穿越设定、给审计建议，或者模拟章节修订意见。"}
            minHeight={260}
            maxHeight="100%"
            inputMinRows={3}
            inputMaxRows={5}
            footerLeft={<Typography.Text type="secondary">当前对话会保存在这个配置下。</Typography.Text>}
            footerRight={(
              <Button
                onClick={() => {
                  setProfileChatMessages([]);
                  setProfileChatInput("");
                  if (chatProfile) {
                    persistProfileChat(chatProfile.id, {
                      messages: [],
                      genre: profileChatGenre,
                      platform: profileChatPlatform,
                    });
                  }
                }}
                disabled={chattingProfileId === chatProfile?.id}
              >
                清空对话
              </Button>
            )}
            containerStyle={{ flex: 1, minHeight: 0 }}
          />
        </div>
      </Modal>
    </Space>
  );
}
