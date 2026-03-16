"use client";

import {
  App,
  Alert,
  Button,
  Card,
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
  Typography,
} from "antd";
import { useEffect, useState, useTransition } from "react";

interface SetupValues {
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

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

export function SetupWorkspace() {
  const { message } = App.useApp();
  const [initialized, setInitialized] = useState<boolean>(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean>(false);
  const [summary, setSummary] = useState<SetupSummaryResponse | null>(null);
  const [daemon, setDaemon] = useState<CommandCatalogResponse["daemon"] | null>(null);
  const [doctorResult, setDoctorResult] = useState<unknown>(null);
  const [daemonResult, setDaemonResult] = useState<unknown>(null);
  const [profiles, setProfiles] = useState<ReadonlyArray<LlmProfile>>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [editingProfile, setEditingProfile] = useState<LlmProfile | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [form] = Form.useForm<SetupValues>();
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const [result, setResult] = useState<unknown>(null);
  const [resultType, setResultType] = useState<"success" | "error" | null>(null);
  const [isPending, startTransition] = useTransition();
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

    const activeProfile = profilePayload.profiles?.find((item) => item.id === profilePayload.activeProfileId);
    const provider = activeProfile?.provider ?? data.globalLlm?.provider ?? data.config?.llm?.provider ?? "openai";
    const baseUrl = activeProfile?.baseUrl ?? data.globalLlm?.baseUrl ?? data.config?.llm?.baseUrl ?? "https://api.openai.com/v1";
    const model = activeProfile?.model ?? data.globalLlm?.model ?? data.config?.llm?.model ?? "gpt-4o";
    const hasApiKey = Boolean(data.globalLlm?.apiKeyConfigured);
    setApiKeyConfigured(hasApiKey);
    form.setFieldsValue({
      name: data.config?.name ?? "",
      provider,
      baseUrl,
      model,
      apiKey: "",
    });
  }

  useEffect(() => {
    void loadSettingsContext();
  }, [form]);

  function submit(values: SetupValues): void {
    startTransition(() => {
      void fetch("/api/inkos/project/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: values.name || undefined,
          provider: values.provider,
          baseUrl: values.baseUrl,
          apiKey: values.apiKey?.trim() ? values.apiKey : undefined,
          model: values.model,
        }),
      })
        .then((response) => response.json())
        .then((data) => {
          setResult(data);
          if (data?.ok) {
            setInitialized(true);
            setApiKeyConfigured(true);
            form.setFieldValue("apiKey", "");
            setResultType("success");
            void message.success("配置保存成功");
            void loadSettingsContext();
          } else {
            setResultType("error");
            void message.error(data?.error ?? "配置保存失败");
          }
        })
        .catch((error: unknown) => {
          const errorText = error instanceof Error ? error.message : String(error);
          setResult({ ok: false, error: errorText });
          setResultType("error");
          void message.error(errorText);
        });
    });
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
    const current = form.getFieldsValue();
    setEditingProfile(null);
    profileForm.setFieldsValue({
      name: "",
      provider: current.provider ?? "openai",
      baseUrl: current.baseUrl ?? "https://api.openai.com/v1",
      model: current.model ?? "gpt-4o",
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
        activate: !editingProfile,
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
        void message.success(editingProfile ? "配置已更新" : "配置已创建并激活");
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
        title="模型配置"
        extra={<Tag color={initialized ? "green" : "orange"}>{initialized ? "已初始化" : "待初始化"}</Tag>}
      >
        <Typography.Paragraph type="secondary">
          {initialized ? "已初始化，可重新提交更新全局 LLM 默认配置。" : "初始化项目并配置本次部署使用的 LLM。"}
        </Typography.Paragraph>

        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item label="项目名称" name="name">
            <Input placeholder="可选，例如 wuxia-project" />
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
            <Input.Password placeholder={apiKeyConfigured ? "已配置，留空则保持不变" : "首次配置必须填写"} />
          </Form.Item>
          <Form.Item label="模型" name="model" rules={[{ required: true }]}>
            <Input placeholder="如 gpt-4o / gpt-5" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={isPending}>
            初始化 / 更新
          </Button>
        </Form>
      </Card>

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

      <Card title="配置结果">
        {!result ? (
          <Typography.Text type="secondary">提交后这里显示响应结果。</Typography.Text>
        ) : (
          <Alert
            type={resultType === "success" ? "success" : "error"}
            showIcon
            message={resultType === "success" ? "保存成功" : "保存失败"}
            description={<pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>}
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
    </Space>
  );
}
