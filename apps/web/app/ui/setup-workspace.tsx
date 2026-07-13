"use client";

import {
  App,
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChatKitPanel,
  consumeChatKitStream,
  messagesToChatKitItems,
  type ChatKitItem,
} from "./chat-kit";
import { clearPersistedChatSession, loadPersistedChatSession, savePersistedChatSession } from "./chat-persistence";
import { CHAT_MODAL_BODY_HEIGHT, CHAT_MODAL_DESKTOP_BODY_HEIGHT, CHAT_MODAL_DESKTOP_WIDTH } from "./chat-modal";

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
  readonly provider: "openai";
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinkingBudget?: number;
  readonly apiFormat?: "chat" | "responses";
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
  readonly provider: "openai";
  readonly baseUrl: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinkingBudget?: number;
  readonly apiFormat?: "chat" | "responses";
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
  readonly items?: ReadonlyArray<ChatKitItem>;
}

interface StoredProfileChatSession {
  readonly messages: ReadonlyArray<ProfileChatMessage>;
  readonly genre?: string;
  readonly platform?: string;
}

export function SetupWorkspace() {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
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
  const [profileDraftTestResult, setProfileDraftTestResult] = useState<unknown>(null);
  const [profileDraftTesting, setProfileDraftTesting] = useState(false);
  const [profileModelsLoading, setProfileModelsLoading] = useState(false);
  const [profileModelOptions, setProfileModelOptions] = useState<ReadonlyArray<string>>([]);
  const [chatProfile, setChatProfile] = useState<LlmProfile | null>(null);
  const [profileChatInput, setProfileChatInput] = useState("");
  const [profileChatMessages, setProfileChatMessages] = useState<ReadonlyArray<ProfileChatMessage>>([]);
  const [profileChatGenre, setProfileChatGenre] = useState<string>("chuanyue");
  const [profileChatPlatform, setProfileChatPlatform] = useState<string>("tomato");
  const [chattingProfileId, setChattingProfileId] = useState<string | null>(null);
  const [profileLiveItems, setProfileLiveItems] = useState<ChatKitItem[] | null>(null);
  const profileChatAbortRef = useRef<AbortController | null>(null);
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const [isTesting, setIsTesting] = useState(false);
  const [daemonAction, setDaemonAction] = useState<"up" | "down" | null>(null);

  const profileChatKitItems = useMemo(() => {
    if (profileLiveItems) return profileLiveItems;
    return messagesToChatKitItems(profileChatMessages);
  }, [profileLiveItems, profileChatMessages]);

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
      };
    } catch {
      return null;
    }
  }

  function persistProfileChat(profileId: string, payload: StoredProfileChatSession): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(profileChatStorageKey(profileId), JSON.stringify(payload));
    void savePersistedChatSession("profile-chat", `profile:${profileId}`, {
      profileId,
      title: `profile:${profileId}`,
      messages: payload.messages,
      meta: {
        genre: payload.genre,
        platform: payload.platform,
      },
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

  function knownProfileModels(seed?: string): ReadonlyArray<string> {
    return Array.from(new Set([
      seed,
      ...profiles.map((profile) => profile.model),
      summary?.globalLlm?.model,
      summary?.config?.llm?.model,
    ].filter((item): item is string => Boolean(item?.trim()))));
  }

  function profileDraftPayload(values: Partial<ProfileFormValues>): Record<string, unknown> {
    return {
      profileId: editingProfile?.id,
      name: values.name,
      provider: "openai",
      baseUrl: values.baseUrl,
      model: values.model,
      apiKey: values.apiKey?.trim() || undefined,
      temperature: values.temperature ?? 0.7,
      maxTokens: values.maxTokens ?? 16000,
      thinkingBudget: values.thinkingBudget ?? 0,
      apiFormat: values.apiFormat ?? "chat",
    };
  }

  function profileProviderDefaultBaseUrl(): string {
    return "https://api.openai.com/v1";
  }

  async function loadProfileModelsFromDraft(): Promise<void> {
    if (profileModelsLoading) return;
    try {
      const values = await profileForm.validateFields(["baseUrl", "apiKey"]);
      setProfileModelsLoading(true);
      const response = await fetch("/api/inkos/llm-profiles/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profileDraftPayload(values)),
      });
      const data = await response.json() as { ok?: boolean; models?: ReadonlyArray<string>; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? "模型列表读取失败");
      }
      const models = Array.isArray(data.models) ? data.models : [];
      setProfileModelOptions(models);
      const currentModel = String(profileForm.getFieldValue("model") ?? "").trim();
      if (!currentModel && models[0]) {
        profileForm.setFieldValue("model", models[0]);
      }
      void message.success(models.length > 0 ? `已获取 ${models.length} 个模型` : "接口返回了空模型列表");
    } catch (error: unknown) {
      void message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileModelsLoading(false);
    }
  }

  async function testDraftProfile(): Promise<void> {
    if (profileDraftTesting) return;
    try {
      const values = await profileForm.validateFields([
        "baseUrl",
        "apiKey",
        "model",
        "apiFormat",
        "temperature",
        "maxTokens",
        "thinkingBudget",
      ]);
      setProfileDraftTesting(true);
      setProfileDraftTestResult(null);
      const response = await fetch("/api/inkos/llm-profiles/test-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profileDraftPayload(values)),
      });
      const data = await response.json();
      setProfileDraftTestResult(data);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error ?? "模型文本测试失败");
      }
      void message.success("模型配置测试完成");
    } catch (error: unknown) {
      void message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileDraftTesting(false);
    }
  }

  function renderProfileCapabilityResult(result: unknown) {
    const data = result && typeof result === "object" ? result as {
      ok?: boolean;
      available?: boolean;
      checks?: {
        text?: { ok?: boolean };
        tools?: { ok?: boolean };
        thinking?: { ok?: boolean; reasoningReturned?: boolean };
      };
    } : {};
    const checks = data.checks ?? {};
    const statusTag = (label: string, ok?: boolean) => (
      <Tag color={ok ? "green" : "red"}>{label}{ok ? "可用" : "失败"}</Tag>
    );
    return (
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Space wrap>
          {statusTag("文本", checks.text?.ok)}
          {statusTag("工具", checks.tools?.ok)}
          {statusTag("思考", checks.thinking?.ok)}
          {checks.thinking?.reasoningReturned ? <Tag color="blue">已返回 reasoning</Tag> : null}
        </Space>
        <pre style={{ margin: 0, maxHeight: 260, overflow: "auto" }}>{JSON.stringify(result, null, 2)}</pre>
      </Space>
    );
  }

  function openCreateProfile(): void {
    const activeProfile = profiles.find((item) => item.id === activeProfileId);
    setEditingProfile(null);
    setProfileDraftTestResult(null);
    setProfileModelOptions(knownProfileModels(activeProfile?.model));
    profileForm.setFieldsValue({
      name: "",
      provider: "openai",
      baseUrl: activeProfile?.baseUrl ?? summary?.globalLlm?.baseUrl ?? summary?.config?.llm?.baseUrl ?? profileProviderDefaultBaseUrl(),
      model: activeProfile?.model ?? summary?.globalLlm?.model ?? summary?.config?.llm?.model ?? "gpt-4o",
      apiKey: "",
      temperature: activeProfile?.temperature ?? 0.7,
      maxTokens: activeProfile?.maxTokens ?? 16000,
      thinkingBudget: activeProfile?.thinkingBudget ?? 0,
      apiFormat: activeProfile?.apiFormat ?? "chat",
    });
    setProfileModalOpen(true);
  }

  function openEditProfile(profile: LlmProfile): void {
    setEditingProfile(profile);
    setProfileDraftTestResult(null);
    setProfileModelOptions(knownProfileModels(profile.model));
    profileForm.setFieldsValue({
      name: profile.name,
      provider: "openai",
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: "",
      temperature: profile.temperature ?? 0.7,
      maxTokens: profile.maxTokens ?? 16000,
      thinkingBudget: profile.thinkingBudget ?? 0,
      apiFormat: profile.apiFormat ?? "chat",
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
        provider: "openai",
        baseUrl: values.baseUrl,
        model: values.model,
        apiKey: values.apiKey?.trim() || undefined,
        temperature: values.temperature ?? 0.7,
        maxTokens: values.maxTokens ?? 16000,
        thinkingBudget: values.thinkingBudget ?? 0,
        apiFormat: values.apiFormat ?? "chat",
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
    setProfileLiveItems(null);
    setProfileChatMessages(stored?.messages ?? []);
    setProfileChatGenre(stored?.genre ?? "chuanyue");
    setProfileChatPlatform(stored?.platform ?? "tomato");
    void loadPersistedChatSession("profile-chat", `profile:${profile.id}`).then((messages) => {
      if (Array.isArray(messages) && messages.length > 0) {
        setProfileChatMessages(messages as ReadonlyArray<ProfileChatMessage>);
      }
    });
  }

  function profileModelMessages(messages: ReadonlyArray<ProfileChatMessage>): ReadonlyArray<Pick<ProfileChatMessage, "role" | "content" | "reasoning">> {
    return messages.map((item) => ({
      role: item.role,
      content: item.content,
      ...(item.reasoning ? { reasoning: item.reasoning } : {}),
    }));
  }

  function abortProfileChatStream(): void {
    profileChatAbortRef.current?.abort();
    profileChatAbortRef.current = null;
  }

  function sendProfileChat(): void {
    if (!chatProfile || chattingProfileId) return;
    const activeProfile = chatProfile;
    const activeProfileId = activeProfile.id;
    const input = profileChatInput.trim();
    if (!input) return;
    const chatOptionsSnapshot = {
      genre: profileChatGenre,
      platform: profileChatPlatform,
    };

    const nextMessages: ReadonlyArray<ProfileChatMessage> = [
      ...profileChatMessages,
      { role: "user", content: input },
    ];
    setProfileChatMessages(nextMessages);
    setProfileLiveItems(messagesToChatKitItems(nextMessages));
    persistProfileChat(activeProfileId, {
      messages: nextMessages,
      ...chatOptionsSnapshot,
    });
    setProfileChatInput("");
    setChattingProfileId(activeProfileId);

    abortProfileChatStream();
    const abortController = new AbortController();
    profileChatAbortRef.current = abortController;

    void (async () => {
      try {
        const response = await fetch(`/api/inkos/llm-profiles/${activeProfileId}/chat-stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: profileModelMessages(nextMessages),
            genre: chatOptionsSnapshot.genre,
            platform: chatOptionsSnapshot.platform,
          }),
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) return;

        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || "对话失败");
        }

        if (!contentType.includes("text/event-stream")) {
          throw new Error("期望 SSE 流式响应，但服务端返回了非流式内容");
        }

        const streamed = await consumeChatKitStream(response, nextMessages, {
          signal: abortController.signal,
          onFrame: (items) => {
            if (!abortController.signal.aborted) {
              setProfileLiveItems(items);
            }
          },
        });
        if (abortController.signal.aborted) return;
        const updated = [
          ...nextMessages,
          {
            role: "assistant" as const,
            content: streamed.content.trim() || "（模型未返回正文内容）",
            reasoning: typeof streamed.reasoning === "string" && streamed.reasoning.trim()
              ? streamed.reasoning
              : undefined,
            items: streamed.items,
          },
        ];
        setProfileChatMessages(updated);
        setProfileLiveItems(null);
        persistProfileChat(activeProfileId, {
          messages: updated,
          ...chatOptionsSnapshot,
        });
      } catch (error: unknown) {
        if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          return;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        const updated = [
          ...nextMessages,
          {
            role: "assistant" as const,
            content: `请求失败：${errorMessage}`,
          },
        ];
        setProfileChatMessages(updated);
        setProfileLiveItems(null);
        persistProfileChat(activeProfileId, {
          messages: updated,
          ...chatOptionsSnapshot,
        });
        void message.error(errorMessage);
      } finally {
        if (profileChatAbortRef.current === abortController) {
          profileChatAbortRef.current = null;
        }
        if (!abortController.signal.aborted) {
          setProfileLiveItems(null);
          setChattingProfileId(null);
        } else {
          setChattingProfileId(null);
        }
      }
    })();
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
      <Card
        style={{
          borderRadius: 24,
          overflow: "hidden",
          background: "linear-gradient(135deg, rgba(16,29,35,0.96) 0%, rgba(34,56,60,0.92) 54%, rgba(104,130,122,0.84) 100%)",
        }}
      >
        <Typography.Text style={{ color: "rgba(214, 227, 223, 0.72)", letterSpacing: "0.16em", textTransform: "uppercase", fontSize: 11 }}>
          灵枢 · 阵眼设定
        </Typography.Text>
        <Typography.Title level={4} style={{ marginTop: 8, marginBottom: 8, color: "#f2f7f6" }}>设置</Typography.Title>
        <Typography.Paragraph style={{ marginBottom: 0, color: "rgba(227, 236, 234, 0.8)" }}>
          这里集中处理模型配置、项目检测和自动写作开关。原来分散在命令里的项目级功能，统一归到这一页。
        </Typography.Paragraph>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}><Card style={{ borderRadius: 20, background: "rgba(255,255,255,0.92)" }}><Statistic title="工作区" value={initialized ? "已初始化" : "未初始化"} valueStyle={{ color: "#214047" }} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card style={{ borderRadius: 20, background: "rgba(255,255,255,0.92)" }}><Statistic title="书籍数" value={summary?.books?.length ?? 0} valueStyle={{ color: "#214047" }} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card style={{ borderRadius: 20, background: "rgba(255,255,255,0.92)" }}><Statistic title="自动写作" value={daemon?.running ? "运行中" : "未运行"} valueStyle={{ color: "#214047" }} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card style={{ borderRadius: 20, background: "rgba(255,255,255,0.92)" }}><Statistic title="项目目录" value={summary?.projectRoot ? "已配置" : "未知"} valueStyle={{ color: "#214047" }} /></Card></Col>
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
              label: `${profile.name} · ${profile.model}`,
            }))}
            onChange={(value) => activateProfile(String(value))}
            style={{ width: "100%" }}
          />
          {isMobile ? (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              {profiles.map((record) => (
                <Card key={record.id} size="small" style={{ borderRadius: 16, background: "rgba(255,255,255,0.94)" }} bodyStyle={{ padding: 14 }}>
                  <Space direction="vertical" size={10} style={{ width: "100%" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <Typography.Text strong>{record.name}</Typography.Text>
                      <Typography.Text type="secondary" style={{ wordBreak: "break-all" }}>{record.model}</Typography.Text>
                    </div>
                    <div>
                      {record.isActive ? <Tag color="green">已激活</Tag> : <Tag>未激活</Tag>}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                      <Button size="small" onClick={() => openEditProfile(record)}>编辑</Button>
                      <Button size="small" type="primary" ghost disabled={record.isActive} onClick={() => activateProfile(record.id)}>激活</Button>
                      <Button size="small" loading={testingProfileId === record.id} onClick={() => testProfile(record.id)}>测试</Button>
                      <Tooltip title="直接和这个配置绑定的模型对话，验证真实输出效果。">
                        <Button size="small" onClick={() => openProfileChat(record)}>对话</Button>
                      </Tooltip>
                    </div>
                    <Popconfirm
                      title="确认删除这个配置吗？"
                      description={record.isActive ? "当前激活配置不能删除。" : "删除后不可恢复。"}
                      onConfirm={() => deleteProfile(record.id)}
                      disabled={record.isActive}
                    >
                      <Button size="small" danger block disabled={record.isActive} loading={deletingProfileId === record.id}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                </Card>
              ))}
            </Space>
          ) : (
            <Table<LlmProfile>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={[...profiles]}
              columns={[
                { title: "名称", dataIndex: "name", key: "name" },
                { title: "模型", key: "model", render: (_v, r) => r.model },
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
          )}
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
            description={renderProfileCapabilityResult(profileTestResult)}
          />
        )}
      </Card>

      <Modal
        open={profileModalOpen}
        onCancel={() => setProfileModalOpen(false)}
        title={editingProfile ? "编辑配置" : "新建配置"}
        footer={null}
        maskClosable={false}
        keyboard
        destroyOnHidden
      >
        <Form<ProfileFormValues> layout="vertical" form={profileForm} onFinish={saveProfile}>
          <Form.Item label="配置名称" name="name" rules={[{ required: true, message: "请输入配置名称" }]}>
            <Input placeholder="例如：OpenAI-主力" />
          </Form.Item>
          <Form.Item label="Base URL（接口地址）" name="baseUrl" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="API Key（密钥）" name="apiKey">
            <Input.Password placeholder={editingProfile ? "留空表示保持不变" : "首次创建建议填写"} />
          </Form.Item>
          <Form.Item label="模型" required>
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item name="model" noStyle rules={[{ required: true, message: "请选择或输入模型" }]}>
                <AutoComplete
                  options={profileModelOptions.map((model) => ({ value: model, label: model }))}
                  filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
                  placeholder="先获取模型列表，也可以直接输入模型名"
                />
              </Form.Item>
              <Button onClick={() => void loadProfileModelsFromDraft()} loading={profileModelsLoading}>
                获取模型
              </Button>
            </Space.Compact>
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item label="API 格式" name="apiFormat">
                <Select
                  options={[
                    { label: "chat", value: "chat" },
                    { label: "responses", value: "responses" },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="Temperature" name="temperature">
                <InputNumber min={0} max={2} step={0.1} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="Max Tokens" name="maxTokens">
                <InputNumber min={1} step={1024} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="Thinking Budget" name="thinkingBudget" extra="0 表示不主动开启；测试思考能力时会临时用至少 1024。">
                <InputNumber min={0} step={1024} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          {profileDraftTestResult ? (
            <Alert
              type={(profileDraftTestResult as { ok?: boolean }).ok ? "success" : "warning"}
              showIcon
              message={(profileDraftTestResult as { ok?: boolean }).ok ? "当前配置文本可用" : "当前配置测试未完全通过"}
              description={renderProfileCapabilityResult(profileDraftTestResult)}
              style={{ marginBottom: 16 }}
            />
          ) : null}
          <Space wrap>
            <Button onClick={() => void loadProfileModelsFromDraft()} loading={profileModelsLoading}>
              获取模型列表
            </Button>
            <Button onClick={() => void testDraftProfile()} loading={profileDraftTesting}>
              测试当前配置
            </Button>
            <Button type="primary" htmlType="submit" loading={profileSaving}>
              {editingProfile ? "保存" : "创建"}
            </Button>
            <Button onClick={() => setProfileModalOpen(false)}>取消</Button>
          </Space>
        </Form>
      </Modal>

      <Modal
        open={Boolean(chatProfile)}
        onCancel={() => {
          abortProfileChatStream();
          setChattingProfileId(null);
          setProfileLiveItems(null);
          setChatProfile(null);
          setProfileChatInput("");
        }}
        title={chatProfile ? `模型对话测试 · ${chatProfile.name}` : "模型对话测试"}
        footer={null}
        maskClosable={false}
        keyboard
        width={isMobile ? "94vw" : CHAT_MODAL_DESKTOP_WIDTH}
        style={{ top: isMobile ? 20 : 12 }}
        styles={{ body: { paddingTop: 12, height: isMobile ? CHAT_MODAL_BODY_HEIGHT : CHAT_MODAL_DESKTOP_BODY_HEIGHT, overflow: "hidden" } }}
        destroyOnHidden
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
            </Space>
          </Card>

          <ChatKitPanel
            items={profileChatKitItems}
            value={profileChatInput}
            onChange={setProfileChatInput}
            onSend={sendProfileChat}
            sending={chattingProfileId === chatProfile?.id}
            placeholder="输入一段话，直接测试这个模型在 InkOS 项目中的真实回复。"
            emptyText={"这里可以直接测试这个模型在 InkOS 里的表现。\n比如让它生成爽文开篇、讨论穿越设定、给审计建议，或者模拟章节修订意见。"}
            maxHeight="100%"
            footerLeft={(
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, width: "100%" }}>
                <Typography.Text type="secondary">当前对话会保存在这个配置下。</Typography.Text>
                <Button
                  onClick={() => {
                    setProfileChatMessages([]);
                    setProfileLiveItems(null);
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
              </div>
            )}
            containerStyle={{ flex: 1, minHeight: 0 }}
          />
        </div>
      </Modal>
    </Space>
  );
}
