import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { LLMConfig } from "../models/project.js";

const DEFAULT_LLM_HEADERS = {
  "User-Agent": "curl/8.0",
} as const;

function summarizeBaseUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value;
  }
}

function summarizeError(error: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (error && typeof error === "object") {
    const maybe = error as Record<string, unknown>;
    if ("status" in maybe) record.status = maybe.status;
    if ("name" in maybe) record.name = maybe.name;
    if ("type" in maybe) record.type = maybe.type;
    if ("code" in maybe) record.code = maybe.code;
    if ("error" in maybe) record.error = maybe.error;
    if ("response" in maybe) record.response = maybe.response;
    if ("headers" in maybe) record.headers = maybe.headers;
    if ("request_id" in maybe) record.requestId = maybe.request_id;
  }
  return record;
}

function logLLMDiagnostic(event: string, meta: Record<string, unknown>): void {
  process.stderr.write(`${new Date().toISOString()} INFO ${event} ${JSON.stringify(meta)}\n`);
}

// === Shared Types ===

export interface LLMResponse {
  readonly content: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LLMClient {
  readonly provider: "openai" | "anthropic";
  readonly apiFormat: "chat" | "responses";
  readonly _openai?: OpenAI;
  readonly _anthropic?: Anthropic;
  readonly defaults: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly thinkingBudget: number;
  };
}

// === Tool-calling Types ===

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export type AgentMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly toolCalls?: ReadonlyArray<ToolCall> }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface ChatWithToolsResult {
  readonly content: string;
  readonly toolCalls: ReadonlyArray<ToolCall>;
  readonly reasoning?: string;
}

function isMoonshotModel(model: string, client: OpenAI): boolean {
  const normalizedModel = model.toLowerCase();
  const normalizedBaseUrl = client.baseURL?.toLowerCase() ?? "";
  return normalizedModel.includes("moonshot")
    || normalizedModel.includes("kimi")
    || normalizedBaseUrl.includes("moonshot");
}

function extractTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractTextValue(item)).join("");
  }
  if (value && typeof value === "object") {
    if ("text" in value && typeof value.text === "string") {
      return value.text;
    }
    if ("content" in value) {
      return extractTextValue((value as { content?: unknown }).content);
    }
  }
  return "";
}

// === Factory ===

export function createLLMClient(config: LLMConfig): LLMClient {
  const defaults = {
    temperature: config.temperature ?? 0.7,
    maxTokens: config.maxTokens ?? 16000,
    thinkingBudget: config.thinkingBudget ?? 0,
  };

  const apiFormat = config.apiFormat ?? "chat";

  if (config.provider === "anthropic") {
    // Anthropic SDK appends /v1/ internally — strip if user included it
    const baseURL = config.baseUrl.replace(/\/v1\/?$/, "");
    return {
      provider: "anthropic",
      apiFormat,
      _anthropic: new Anthropic({
        apiKey: config.apiKey,
        baseURL,
        defaultHeaders: DEFAULT_LLM_HEADERS,
      }),
      defaults,
    };
  }
  // openai or custom — both use OpenAI SDK
  return {
    provider: "openai",
    apiFormat,
    _openai: new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      defaultHeaders: DEFAULT_LLM_HEADERS,
    }),
    defaults,
  };
}

// === Error Wrapping ===

function wrapLLMError(error: unknown): Error {
  const msg = String(error);
  if (msg.includes("403")) {
    return new Error(
      `API 返回 403 (请求被拒绝)。可能原因：\n` +
      `  1. API Key 无效或过期\n` +
      `  2. API 提供方的内容审查拦截了请求（公益/免费 API 常见）\n` +
      `  3. 账户余额不足\n` +
      `  建议：用 inkos doctor 测试 API 连通性，或换一个不限制内容的 API 提供方`,
    );
  }
  if (msg.includes("401")) {
    return new Error(
      `API 返回 401 (未授权)。请检查 .env 中的 INKOS_LLM_API_KEY 是否正确。`,
    );
  }
  if (msg.includes("429")) {
    return new Error(
      `API 返回 429 (请求过多)。请稍后重试，或检查 API 配额。`,
    );
  }
  return error instanceof Error ? error : new Error(msg);
}

function isRetryableStreamError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("stream error")
    || msg.includes("internal_error")
    || msg.includes("http/2")
    || msg.includes("http2")
    || msg.includes("econnreset")
    || msg.includes("socket hang up")
    || msg.includes("terminated")
    || msg.includes("unexpected end of json input");
}

function isRetryableNonStreamToolChatError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("missing choices array")
    || msg.includes("missing choices")
    || msg.includes("cannot read properties of undefined")
    || msg.includes("cannot read properties of null");
}

function logStreamFallback(provider: "openai-chat" | "openai-responses", model: string, error: unknown): void {
  process.stderr.write(`${new Date().toISOString()} WARN llm.stream_fallback ${JSON.stringify({
    provider,
    model,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
}

function logNonStreamFallback(provider: "openai-chat-tools", model: string, error: unknown): void {
  process.stderr.write(`${new Date().toISOString()} WARN llm.non_stream_fallback ${JSON.stringify({
    provider,
    model,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
}

// === Simple Chat (used by all agents via BaseAgent.chat()) ===

export async function chatCompletion(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly webSearch?: boolean;
    readonly abortSignal?: AbortSignal;
  },
): Promise<LLMResponse> {
  const resolved = {
    temperature: options?.temperature ?? client.defaults.temperature,
    maxTokens: options?.maxTokens ?? client.defaults.maxTokens,
  };
  logLLMDiagnostic("llm.request.start", {
    kind: "chat_completion",
    provider: client.provider,
    apiFormat: client.apiFormat,
    model,
    messageCount: messages.length,
    maxTokens: resolved.maxTokens,
    temperature: resolved.temperature,
    webSearch: options?.webSearch === true,
    abortSignal: options?.abortSignal ? "provided" : "none",
    baseUrl: summarizeBaseUrl(client._openai?.baseURL ?? client._anthropic?.baseURL),
    hasAnthropicClient: Boolean(client._anthropic),
    hasOpenAIClient: Boolean(client._openai),
  });
  try {
    if (client.provider === "anthropic") {
      return await chatCompletionAnthropic(client._anthropic!, model, messages, resolved, client.defaults.thinkingBudget, options?.abortSignal);
    }
    if (client.apiFormat === "responses") {
      return await chatCompletionOpenAIResponses(client._openai!, model, messages, resolved, options?.webSearch, options?.abortSignal);
    }
    return await chatCompletionOpenAIChat(client._openai!, model, messages, resolved, options?.webSearch, options?.abortSignal);
  } catch (error) {
    logLLMDiagnostic("llm.request.error", {
      kind: "chat_completion",
      provider: client.provider,
      apiFormat: client.apiFormat,
      model,
      messageCount: messages.length,
      maxTokens: resolved.maxTokens,
      temperature: resolved.temperature,
      webSearch: options?.webSearch === true,
      abortSignal: options?.abortSignal ? "provided" : "none",
      baseUrl: summarizeBaseUrl(client._openai?.baseURL ?? client._anthropic?.baseURL),
      error: summarizeError(error),
    });
    throw wrapLLMError(error);
  }
}

// === Tool-calling Chat (used by agent loop) ===

export async function chatWithTools(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly useStream?: boolean;
    readonly includeReasoning?: boolean;
    readonly onTextDelta?: (delta: string) => void;
    readonly onReasoningDelta?: (delta: string) => void;
    readonly abortSignal?: AbortSignal;
  },
): Promise<ChatWithToolsResult> {
  const resolved = {
    temperature: options?.temperature ?? client.defaults.temperature,
    maxTokens: options?.maxTokens ?? client.defaults.maxTokens,
    useStream: options?.useStream ?? true,
    includeReasoning: options?.includeReasoning ?? false,
  };
  logLLMDiagnostic("llm.request.start", {
    kind: "chat_with_tools",
    provider: client.provider,
    apiFormat: client.apiFormat,
    model,
    messageCount: messages.length,
    toolCount: tools.length,
    maxTokens: resolved.maxTokens,
    temperature: resolved.temperature,
    useStream: resolved.useStream,
      includeReasoning: resolved.includeReasoning,
      abortSignal: options?.abortSignal ? "provided" : "none",
      baseUrl: summarizeBaseUrl(client._openai?.baseURL ?? client._anthropic?.baseURL),
      hasAnthropicClient: Boolean(client._anthropic),
      hasOpenAIClient: Boolean(client._openai),
  });
  try {
    if (client.provider === "anthropic") {
      return await chatWithToolsAnthropic(client._anthropic!, model, messages, tools, resolved, client.defaults.thinkingBudget, options?.abortSignal);
    }
    if (client.apiFormat === "responses") {
      return await chatWithToolsOpenAIResponses(client._openai!, model, messages, tools, resolved, options?.abortSignal);
    }
    return await chatWithToolsOpenAIChat(client._openai!, model, messages, tools, resolved, options?.abortSignal);
  } catch (error) {
    logLLMDiagnostic("llm.request.error", {
      kind: "chat_with_tools",
      provider: client.provider,
      apiFormat: client.apiFormat,
      model,
      messageCount: messages.length,
      toolCount: tools.length,
      maxTokens: resolved.maxTokens,
      temperature: resolved.temperature,
      useStream: resolved.useStream,
      includeReasoning: resolved.includeReasoning,
      baseUrl: summarizeBaseUrl(client._openai?.baseURL ?? client._anthropic?.baseURL),
      error: summarizeError(error),
    });
    throw wrapLLMError(error);
  }
}

// === OpenAI Chat Completions API Implementation (default) ===

async function chatCompletionOpenAIChat(
  client: OpenAI,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options: { readonly temperature: number; readonly maxTokens: number },
  webSearch?: boolean,
  abortSignal?: AbortSignal,
): Promise<LLMResponse> {
  const moonshotCompat = isMoonshotModel(model, client);
  const request = {
    model,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    ...(webSearch ? { web_search_options: { search_context_size: "medium" as const } } : {}),
  };

  try {
    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    const stream = await client.chat.completions.create({
      ...request,
      stream: true,
    }, { signal: abortSignal });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as {
        content?: string | null;
        reasoning_content?: string | null;
      } | undefined;
      const textDelta = delta?.content
        ?? (moonshotCompat ? delta?.reasoning_content : undefined)
        ?? "";
      if (textDelta) {
        chunks.push(textDelta);
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    const content = chunks.join("");
    if (!content.trim()) {
      throw new Error("LLM returned empty response");
    }

    return {
      content,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  } catch (error) {
    if (!isRetryableStreamError(error)) {
      throw error;
    }

    logStreamFallback("openai-chat", model, error);
    const completion = await client.chat.completions.create({
      ...request,
      stream: false,
    }, { signal: abortSignal });

    const message = completion.choices[0]?.message as {
      content?: string | null;
      reasoning_content?: string | null;
    } | undefined;
    const content = message?.content
      ?? (moonshotCompat ? message?.reasoning_content : undefined)
      ?? "";
    if (!content.trim()) {
      throw new Error("LLM returned empty response");
    }

    const promptTokens = completion.usage?.prompt_tokens ?? 0;
    const completionTokens = completion.usage?.completion_tokens ?? 0;
    const totalTokens = completion.usage?.total_tokens ?? (promptTokens + completionTokens);
    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
    };
  }
}

async function chatWithToolsOpenAIChat(
  client: OpenAI,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  options: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly useStream: boolean;
    readonly includeReasoning: boolean;
    readonly onTextDelta?: (delta: string) => void;
    readonly onReasoningDelta?: (delta: string) => void;
  },
  abortSignal?: AbortSignal,
): Promise<ChatWithToolsResult> {
  const openaiMessages = agentMessagesToOpenAIChat(messages);
  const openaiTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const moonshotCompat = isMoonshotModel(model, client);

  if (options.useStream) {
    return streamChatWithToolsOpenAIChat(
      client,
      model,
      openaiMessages,
      openaiTools,
      options,
      abortSignal,
      moonshotCompat,
    );
  }

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: openaiMessages,
      tools: openaiTools,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: false,
    }, { signal: abortSignal });

    const message = completion.choices[0]?.message as {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    } | undefined;

    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((toolCall) => ({
      id: toolCall.id ?? "",
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? "",
    }));

    const reasoning = options.includeReasoning
      ? extractTextValue(moonshotCompat ? (message?.reasoning_content ?? message?.reasoning) : message?.reasoning).trim()
      : "";

    return {
      content: extractTextValue(message?.content).trim(),
      toolCalls,
      reasoning: reasoning || undefined,
    };
  } catch (error) {
    if (!isRetryableNonStreamToolChatError(error)) {
      throw error;
    }

    logNonStreamFallback("openai-chat-tools", model, error);
    return streamChatWithToolsOpenAIChat(
      client,
      model,
      openaiMessages,
      openaiTools,
      {
        ...options,
        onTextDelta: undefined,
        onReasoningDelta: undefined,
      },
      abortSignal,
      moonshotCompat,
    );
  }
}

async function streamChatWithToolsOpenAIChat(
  client: OpenAI,
  model: string,
  openaiMessages: ReadonlyArray<OpenAI.Chat.Completions.ChatCompletionMessageParam>,
  openaiTools: ReadonlyArray<OpenAI.Chat.Completions.ChatCompletionTool>,
  options: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly includeReasoning: boolean;
    readonly onTextDelta?: (delta: string) => void;
    readonly onReasoningDelta?: (delta: string) => void;
  },
  abortSignal: AbortSignal | undefined,
  moonshotCompat: boolean,
): Promise<ChatWithToolsResult> {
  const stream = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    tools: openaiTools,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stream: true,
  }, { signal: abortSignal });

  let content = "";
  let reasoning = "";
  const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    } | undefined;
    const contentDelta = extractTextValue(delta?.content);
    if (contentDelta) {
      content += contentDelta;
      options.onTextDelta?.(contentDelta);
    }

    if (options.includeReasoning) {
      const reasoningDelta = extractTextValue(
        moonshotCompat ? (delta?.reasoning_content ?? delta?.reasoning) : delta?.reasoning,
      );
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        options.onReasoningDelta?.(reasoningDelta);
      }
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCallMap.get(tc.index);
        if (existing) {
          existing.arguments += tc.function?.arguments ?? "";
        } else {
          toolCallMap.set(tc.index, {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          });
        }
      }
    }
  }

  const toolCalls: ToolCall[] = [...toolCallMap.values()];
  return { content, toolCalls, reasoning: reasoning.trim() || undefined };
}

function agentMessagesToOpenAIChat(
  messages: ReadonlyArray<AgentMessage>,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content });
      continue;
    }
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: msg.content ?? null,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      result.push(assistantMsg);
      continue;
    }
    if (msg.role === "tool") {
      result.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }

  return result;
}

// === OpenAI Responses API Implementation (optional) ===

async function chatCompletionOpenAIResponses(
  client: OpenAI,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options: { readonly temperature: number; readonly maxTokens: number },
  webSearch?: boolean,
  abortSignal?: AbortSignal,
): Promise<LLMResponse> {
  const input: OpenAI.Responses.ResponseInputItem[] = messages.map((m) => ({
    role: m.role as "system" | "user" | "assistant",
    content: m.content,
  }));

  const tools: OpenAI.Responses.Tool[] | undefined = webSearch
    ? [{ type: "web_search_preview" as const }]
    : undefined;
  const request = {
    model,
    input,
    temperature: options.temperature,
    max_output_tokens: options.maxTokens,
    ...(tools ? { tools } : {}),
  };

  try {
    const stream = await client.responses.create({
      ...request,
      stream: true,
    }, { signal: abortSignal });

    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        chunks.push(event.delta);
      }
      if (event.type === "response.completed") {
        inputTokens = event.response.usage?.input_tokens ?? 0;
        outputTokens = event.response.usage?.output_tokens ?? 0;
      }
    }

    const content = chunks.join("");
    if (!content) throw new Error("LLM returned empty response");

    return {
      content,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  } catch (error) {
    if (!isRetryableStreamError(error)) {
      throw error;
    }

    logStreamFallback("openai-responses", model, error);
    const response = await client.responses.create({
      ...request,
      stream: false,
    }, { signal: abortSignal });
    if (!response.output_text) {
      throw new Error("LLM returned empty response");
    }
    const promptTokens = response.usage?.input_tokens ?? 0;
    const completionTokens = response.usage?.output_tokens ?? 0;
    const totalTokens = response.usage?.total_tokens ?? (promptTokens + completionTokens);
    return {
      content: response.output_text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
    };
  }
}

async function chatWithToolsOpenAIResponses(
  client: OpenAI,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  options: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly useStream: boolean;
    readonly includeReasoning: boolean;
    readonly onTextDelta?: (delta: string) => void;
    readonly onReasoningDelta?: (delta: string) => void;
  },
  abortSignal?: AbortSignal,
): Promise<ChatWithToolsResult> {
  const input = agentMessagesToResponsesInput(messages);
  const responsesTools: OpenAI.Responses.Tool[] = tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters as OpenAI.Responses.FunctionTool["parameters"],
    strict: false,
  }));

  const stream = await client.responses.create({
    model,
    input,
    tools: responsesTools,
    temperature: options.temperature,
    max_output_tokens: options.maxTokens,
    stream: true,
  }, { signal: abortSignal });

  let content = "";
  const toolCalls: ToolCall[] = [];

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      content += event.delta;
      options.onTextDelta?.(event.delta);
    }
    if (event.type === "response.output_item.done" && event.item.type === "function_call") {
      toolCalls.push({
        id: event.item.call_id,
        name: event.item.name,
        arguments: event.item.arguments,
      });
    }
  }

  return { content, toolCalls };
}

function agentMessagesToResponsesInput(
  messages: ReadonlyArray<AgentMessage>,
): OpenAI.Responses.ResponseInputItem[] {
  const result: OpenAI.Responses.ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content });
      continue;
    }
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      if (msg.content) {
        result.push({ role: "assistant", content: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          result.push({
            type: "function_call" as const,
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
      }
      continue;
    }
    if (msg.role === "tool") {
      result.push({
        type: "function_call_output" as const,
        call_id: msg.toolCallId,
        output: msg.content,
      });
    }
  }

  return result;
}

// === Anthropic Implementation ===

async function chatCompletionAnthropic(
  client: Anthropic,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options: { readonly temperature: number; readonly maxTokens: number },
  thinkingBudget: number = 0,
  abortSignal?: AbortSignal,
): Promise<LLMResponse> {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const stream = await client.messages.create({
    model,
    ...(systemText ? { system: systemText } : {}),
    messages: nonSystem.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    ...(thinkingBudget > 0
      ? { thinking: { type: "enabled" as const, budget_tokens: thinkingBudget } }
      : { temperature: options.temperature }),
    max_tokens: options.maxTokens,
    stream: true,
  }, { signal: abortSignal });

  const chunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      chunks.push(event.delta.text);
    }
    if (event.type === "message_start") {
      inputTokens = event.message.usage?.input_tokens ?? 0;
    }
    if (event.type === "message_delta") {
      outputTokens = ((event as unknown as { usage?: { output_tokens?: number } }).usage?.output_tokens) ?? 0;
    }
  }

  const content = chunks.join("");
  if (!content) throw new Error("LLM returned empty response");

  return {
    content,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

async function chatWithToolsAnthropic(
  client: Anthropic,
  model: string,
  messages: ReadonlyArray<AgentMessage>,
  tools: ReadonlyArray<ToolDefinition>,
  options: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly onTextDelta?: (delta: string) => void;
    readonly onReasoningDelta?: (delta: string) => void;
  },
  thinkingBudget: number = 0,
  abortSignal?: AbortSignal,
): Promise<ChatWithToolsResult> {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => (m as { content: string }).content)
    .join("\n\n");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const anthropicMessages = agentMessagesToAnthropic(nonSystem);
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
  }));

  const stream = await client.messages.create({
    model,
    ...(systemText ? { system: systemText } : {}),
    messages: anthropicMessages,
    tools: anthropicTools,
    ...(thinkingBudget > 0
      ? { thinking: { type: "enabled" as const, budget_tokens: thinkingBudget } }
      : { temperature: options.temperature }),
    max_tokens: options.maxTokens,
    stream: true,
  }, { signal: abortSignal });

  let content = "";
  const toolCalls: ToolCall[] = [];
  let currentBlock: { id: string; name: string; input: string } | null = null;

  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      currentBlock = {
        id: event.content_block.id,
        name: event.content_block.name,
        input: "",
      };
    }
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        content += event.delta.text;
        options.onTextDelta?.(event.delta.text);
      }
      if (event.delta.type === "input_json_delta" && currentBlock) {
        currentBlock.input += event.delta.partial_json;
      }
    }
    if (event.type === "content_block_stop" && currentBlock) {
      toolCalls.push({
        id: currentBlock.id,
        name: currentBlock.name,
        arguments: currentBlock.input,
      });
      currentBlock = null;
    }
  }

  return { content, toolCalls };
}

function agentMessagesToAnthropic(
  messages: ReadonlyArray<AgentMessage>,
): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments),
          });
        }
      }
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
      }
      result.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool") {
      const toolResult: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: msg.content,
      };
      // Merge consecutive tool results into one user message (Anthropic requires alternating roles)
      const prev = result[result.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as Anthropic.Messages.ToolResultBlockParam[]).push(toolResult);
      } else {
        result.push({ role: "user", content: [toolResult] });
      }
    }
  }

  return result;
}
