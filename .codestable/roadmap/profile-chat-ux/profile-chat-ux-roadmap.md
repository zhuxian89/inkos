---
doc_type: roadmap
slug: profile-chat-ux
status: completed
created: 2026-07-12
last_reviewed: 2026-07-12
tags: [chat, stream, sse, mindfs, profile, ux]
related_requirements: []
related_architecture: []
---

# 添加模型对话 UX（mindfs 1:1 首波）

## 1. 背景

InkOS「添加 / 测试模型」对话（`setup-workspace` 的 profile chat）虽已有 SSE，但前端仍是粗粒度气泡 + 简陋 Reasoning 折叠，流式过程中看不清思考与工具节奏，和 mindfs 会话体验差距大。

用户要求：**前端视觉与交互对齐 mindfs 1:1**；后端按需同步改。为避免影响章节 / 书本业务，**本 roadmap 只覆盖 profile（添加模型）对话**；其它入口后续另开或 update。

参考实现：`/Users/hongweizhang/java_project/mindfs`（`ThinkingBlock`、`ToolCallCard`、时间线、`thought_chunk` / `message_chunk` / `tool_call*`）。

## 2. 范围与明确不做

### 本 roadmap 覆盖

- profile chat 前端：思考折叠、流式正文、工具卡、生成中状态，外观/交互对齐 mindfs
- profile chat 后端：在现有 **SSE** 通道上输出 mindfs 兼容的事件子集（必要时改 `runProfileChatWithTools` 的流式回调）
- 仅挂到「添加模型」工作区；不改章节 / init / 书本对话入口

### 明确不做

- **不做**章节对话、书本 / init 对话的 poll→流式改造（避免业务面）
- **不引入** mindfs 整包 WebSocket / SessionHub / 队列系统（本波继续 SSE）
- **不嵌入** mindfs 服务端 Go 代码
- **不引入** mindfs 的 Tailwind / Lexical 等整套前端栈（会与 InkOS antd 主题冲突）
- **不改**小说生产 pipeline（write/audit/revise）
- **不强制**非流式 JSON `/chat` 路径具备同等时间线（可保留作降级）

### UI 落地原则（已拍板）

1. **Ant Design 是主题底座**——页面壳、表单、按钮、输入框跟 InkOS 其余界面一致。  
2. **mindfs 块不冲突 → 直接抄代码**（如 `ThinkingBlock`、流式状态点、简化工具卡自绘）——最快且 1:1。  
3. **有冲突才 antd 改版**——例如不能整页换 mindfs 设计系统 / 不能并行再引一套组件库。

## 3. 模块拆分（概设）

```
profile-chat-ux
├── ChatKitUI：mindfs 风格时间线组件（思考折叠 / 工具卡 / 状态条）
├── ProfileStreamProtocol：SSE 事件契约（对齐 mindfs StreamEvent 子集）
└── ProfileChatBridge：setup-workspace 接线 + service 发事件
```

### ChatKitUI

- **职责**：在 `apps/web` 提供可复用的对话时间线；默认折叠思考；工具卡 running→complete；交互对齐 mindfs
- **实现策略**：不冲突的自绘块直接抄 mindfs；输入区等与全局表单相关的继续用 antd
- **承载的子 feature**：`chat-kit-thinking`、`chat-kit-tool-card`、`chat-kit-status`
- **触碰的现有代码**：新建 `apps/web/app/ui/chat-kit/`；profile 入口用 ChatKit，其它入口仍用旧 `ChatPanel`

### ProfileStreamProtocol

- **职责**：定义 profile SSE 事件类型、字段、顺序；兼容旧 `delta` / `reasoning_delta` 的迁移策略（一波切到新类型，或双发一期——见契约）
- **承载的子 feature**：`profile-sse-events`
- **触碰的现有代码**：`apps/service/src/llm-routes.ts`（chat-stream）；必要时 `llm-service.ts` 增加 tool 开始/结束回调

### ProfileChatBridge

- **职责**：`setup-workspace` 消费新协议、驱动 ChatKit 时间线；保证 `includeReasoning` / `useStream` 默认打开时体验完整
- **承载的子 feature**：`profile-chat-wire`（**最小闭环**）
- **触碰的现有代码**：`apps/web/app/ui/setup-workspace.tsx`；Next 代理 `chat-stream` 路由（透传即可）

## 4. 模块间接口契约 / 共享协议（架构层详设）

### 4.1 Profile SSE 事件（服务端 → 浏览器）

**方向**：ProfileStreamProtocol → ChatKitUI（经 ProfileChatBridge）  
**形式**：已有 `POST /api/llm-profiles/:id/chat-stream`，`Content-Type: text/event-stream`；每帧 `data: {json}\n\n`

**契约（本波标准事件；feature 不得私自改名）**：

```ts
type ProfileStreamEvent =
  | { type: "start"; ok: true; profileId: string; model: string }
  | { type: "message_chunk"; data: { content: string } }       // 正文增量
  | { type: "thought_chunk"; data: { content: string } }       // 思考增量（可多次）
  | { type: "tool_call"; data: {
      id: string;
      name: string;
      arguments?: string;
      status: "running";
    }}
  | { type: "tool_call_update"; data: {
      id: string;
      status: "complete" | "error";
      resultPreview?: string;   // 截断预览，建议 ≤ 2k chars
      error?: string;
    }}
  | { type: "final"; ok: true; content: string; reasoning?: string; toolCalls: number }
  | { type: "error"; ok: false; error: string }
  | { type: "done" };
```

**约束**：

1. **默认开启流式时**必须发 `message_chunk` / `thought_chunk`（有 reasoning 时），不得只在 `final` 一次性丢全文（`final` 仍可校正终态）。
2. 每个 tool 调用：先 `tool_call`（running）→ 结束后 `tool_call_update`；`id` 与 provider `toolCallId` 一致。
3. **兼容期（仅 `profile-sse-events` 实现期内允许）**：可同时发送旧字段 `delta`≡`message_chunk.data.content`、`reasoning_delta`≡`thought_chunk.data.content`；`profile-chat-wire` 验收后旧字段标记废弃，新 UI 只认新类型。
4. `error` 后必须结束流；客户端停止追加。
5. 本波 **不**发 mindfs 的 `todo_update` / `plan_update` / `compact_notice` / `recovery`（需要时另开 update）。

### 4.2 ChatKit 时间线模型（前端共享）

**方向**：ProfileChatBridge → ChatKitUI  
**形式**：TS 类型 + React props

```ts
type ChatKitItem =
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant_text"; id: string; content: string; streaming?: boolean }
  | { kind: "thought"; id: string; content: string }          // ThinkingBlock，默认折叠
  | { kind: "tool"; id: string; name: string; status: "running" | "complete" | "error";
      argsPreview?: string; resultPreview?: string; error?: string }
  | { kind: "status"; id: string; text: string };             // 「正在生成…」

type ChatKitProps = {
  items: ReadonlyArray<ChatKitItem>;
  composer: { value: string; onChange: (v: string) => void; onSend: () => void; disabled?: boolean };
  // 视觉：对齐 mindfs SessionViewer 消息区节奏；不强制 Lexical 编辑器
};
```

**约束**：

- `thought` 必须用独立 `ThinkingBlock` 组件；**默认 `defaultExpanded=false`**；标题文案「思考过程」+ 字符数（对齐 mindfs）。
- 同一轮 assistant 回复中，`thought` / `tool` / `assistant_text` 按事件到达顺序交错展示（时间线，不是「全文底部挂一块 Reasoning」）。
- ChatKit **仅**被 profile 入口引用本波；禁止改章节 / init 去依赖它（防业务耦合）。

### 4.3 服务端流式回调扩展

**方向**：`runProfileChatWithTools` → llm-routes SSE  
**形式**：函数选项回调

```ts
// 在现有 onTextDelta / onReasoningDelta 之外新增（可空）
onToolStart?: (info: { id: string; name: string; arguments: string }) => void;
onToolEnd?: (info: { id: string; name: string; ok: boolean; resultPreview: string; error?: string }) => void;
```

**约束**：

- 仅 profile chat-stream 路径接线发 SSE；不改 chapter/init job 契约。
- `resultPreview` 服务端截断，避免 SSE 帧过大。

### 4.4 无跨模块持久化变更

本 roadmap **不改** chat-sessions 表结构；会话仍按现有 profile 消息 `{role,content,reasoning?}` 落盘。工具时间线为**当轮展示态**，落盘是否保留 tool 轨迹由 `profile-chat-wire` design 二选一（默认：落盘仍只存最终 content+reasoning，刷新后工具卡不回放——写进该 feature 明确不做即可）。

## 5. 子 feature 清单

1. **chat-kit-thinking** — 移植 mindfs `ThinkingBlock` + assistant 文本区样式，可脱离协议单测/故事书展示  
   - 所属模块：ChatKitUI  
   - 依赖：无  
   - 状态：done  
   - 对应 feature：`2026-07-12-chat-kit-thinking`  

2. **chat-kit-tool-card** — 移植简化版 `ToolCallCard`（running/complete/error + 名称/预览），对齐 mindfs 信息密度  
   - 所属模块：ChatKitUI  
   - 依赖：无（可与 1 并行）  
   - 状态：done  
   - 对应 feature：`2026-07-12-chat-kit-tool-card`  

3. **chat-kit-status** — 「正在生成…」脉冲状态条（对齐 mindfs 流式状态）  
   - 所属模块：ChatKitUI  
   - 依赖：无  
   - 状态：done  
   - 对应 feature：`2026-07-12-chat-kit-status`  

4. **profile-sse-events** — service `chat-stream` 发出 §4.1 事件；补齐 tool start/end 回调  
   - 所属模块：ProfileStreamProtocol  
   - 依赖：无（可与 UI 并行）  
   - 状态：done  
   - 对应 feature：`2026-07-12-profile-sse-events`  

5. **profile-chat-wire** — `setup-workspace` 改用 ChatKit + 消费新 SSE；默认流式+reasoning 体验闭环  
   - 所属模块：ProfileChatBridge  
   - 依赖：`chat-kit-thinking`, `chat-kit-tool-card`, `chat-kit-status`, `profile-sse-events`  
   - 状态：done  
   - 对应 feature：`2026-07-12-profile-chat-wire`  
   - 备注：**最小闭环**——添加模型页发一条带 thinking 的对话，可见折叠思考 + 流式正文 +（若调工具）工具卡，且不影响章节/书本页

**最小闭环**：第 5 条 `profile-chat-wire` 做完后，仅在添加模型对话演示 mindfs 级体验。

## 6. 排期思路

先 UI 零件（1–3）与 SSE 协议（4）可并行，最后接线（5）。选 profile 作首波：已有 SSE、无 job/poll、与写作业务隔离。卡点：tool 多轮时中间 delta 与 final 替换的现有行为，需在 `profile-sse-events` / `wire` 明确「每轮 tool 后的正文是否新开 assistant_text 段」。

## 7. 观察项

- 章节 / 书本仍为 poll：本 roadmap 完成后若要推广，建议 **另开** `chapter-chat-ux` / update 本 roadmap，勿在本波偷改。
- 若日后要 1:1 mindfs 的 WS 重连 / ReplayPending，再评估是否值得上 StreamHub；本波 SSE 足够。
- `ChatPanel` 仍被多入口使用：本波不要大改其 API，避免牵连书本 UI。
- mindfs `ToolCallCard` 体量大（diff/详情 API）：InkOS profile 工具以 JSON 预览为主即可，feature-design 控制「简化版」边界。

## 8. 变更日志

- 2026-07-12：澄清 UI 原则——antd 为主题底座；mindfs 无冲突块直接抄；有冲突才 antd 改版。已按此恢复 ThinkingBlock 等自绘抄写，输入区保留 antd。
