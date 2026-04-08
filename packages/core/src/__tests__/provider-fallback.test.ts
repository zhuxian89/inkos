import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetNonStreamToolChatFallbackCacheForTests,
  chatCompletion,
  chatWithTools,
  type LLMClient,
  type LLMMessage,
  type ToolDefinition,
} from "../llm/provider.js";

const messages: ReadonlyArray<LLMMessage> = [
  { role: "system", content: "You are a test assistant." },
  { role: "user", content: "Say hi." },
];

let cacheDir = "";

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "inkos-provider-fallback-"));
  process.env.INKOS_NON_STREAM_TOOL_CHAT_CACHE_PATH = join(cacheDir, "non-stream-tool-chat-fallback.json");
  __resetNonStreamToolChatFallbackCacheForTests();
});

afterEach(() => {
  __resetNonStreamToolChatFallbackCacheForTests();
  delete process.env.INKOS_NON_STREAM_TOOL_CHAT_CACHE_PATH;
  if (cacheDir) {
    rmSync(cacheDir, { recursive: true, force: true });
    cacheDir = "";
  }
});

describe("chatCompletion stream fallback", () => {
  it("falls back to non-streaming OpenAI chat completion on retryable stream errors", async () => {
    const calls: boolean[] = [];
    const client = {
      provider: "openai",
      apiFormat: "chat",
      defaults: {
        temperature: 0.7,
        maxTokens: 16000,
        thinkingBudget: 0,
      },
      _openai: {
        chat: {
          completions: {
            create: async (params: { stream?: boolean }) => {
              calls.push(Boolean(params.stream));
              if (params.stream) {
                throw new Error("stream error: stream ID 3; INTERNAL_ERROR; received from peer");
              }
              return {
                choices: [
                  {
                    message: {
                      content: "fallback chat response",
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 12,
                  completion_tokens: 8,
                  total_tokens: 20,
                },
              };
            },
          },
        },
      },
    } as unknown as LLMClient;

    const result = await chatCompletion(client, "gpt-5.4", messages, { temperature: 0.3, maxTokens: 16000 });

    expect(result.content).toBe("fallback chat response");
    expect(result.usage.totalTokens).toBe(20);
    expect(calls).toEqual([true, false]);
  });

  it("falls back to non-streaming OpenAI responses completion on retryable stream errors", async () => {
    const calls: boolean[] = [];
    const client = {
      provider: "openai",
      apiFormat: "responses",
      defaults: {
        temperature: 0.7,
        maxTokens: 16000,
        thinkingBudget: 0,
      },
      _openai: {
        responses: {
          create: async (params: { stream?: boolean }) => {
            calls.push(Boolean(params.stream));
            if (params.stream) {
              throw new Error("socket hang up");
            }
            return {
              output_text: "fallback responses output",
              usage: {
                input_tokens: 10,
                output_tokens: 6,
                total_tokens: 16,
              },
            };
          },
        },
      },
    } as unknown as LLMClient;

    const result = await chatCompletion(client, "gpt-5.4", messages, { temperature: 0.3, maxTokens: 16000 });

    expect(result.content).toBe("fallback responses output");
    expect(result.usage.totalTokens).toBe(16);
    expect(calls).toEqual([true, false]);
  });
});

describe("chatWithTools non-stream fallback", () => {
  it("falls back to streaming OpenAI chat tools when non-stream payload is incompatible", async () => {
    const calls: boolean[] = [];
    const tools: ReadonlyArray<ToolDefinition> = [
      {
        name: "read_text_file",
        description: "Read a text file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ];
    const client = {
      provider: "openai",
      apiFormat: "chat",
      defaults: {
        temperature: 0.7,
        maxTokens: 16000,
        thinkingBudget: 0,
      },
      _openai: {
        chat: {
          completions: {
            create: async (params: { stream?: boolean }) => {
              calls.push(Boolean(params.stream));
              if (!params.stream) {
                throw new Error("LLM response missing choices array (provider=openai-chat-tools, mode=non-stream, model=gpt-5.3-codex)");
              }
              return {
                async *[Symbol.asyncIterator]() {
                  yield {
                    choices: [
                      {
                        delta: {
                          content: "fallback content",
                        },
                      },
                    ],
                  };
                },
              };
            },
          },
        },
      },
    } as unknown as LLMClient;

    const result = await chatWithTools(client, "gpt-5.3-codex", [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: "Say hi." },
    ], tools, {
      useStream: false,
      includeReasoning: false,
      maxTokens: 16000,
      temperature: 0.3,
    });

    expect(result.content).toBe("fallback content");
    expect(result.toolCalls).toEqual([]);
    expect(calls).toEqual([false, true]);
  });

  it("remembers incompatible non-stream tool chat providers and skips the failing attempt", async () => {
    const calls: boolean[] = [];
    const tools: ReadonlyArray<ToolDefinition> = [
      {
        name: "read_text_file",
        description: "Read a text file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ];
    const client = {
      provider: "openai",
      apiFormat: "chat",
      defaults: {
        temperature: 0.7,
        maxTokens: 16000,
        thinkingBudget: 0,
      },
      _openai: {
        baseURL: "https://compat.example.test/v1",
        chat: {
          completions: {
            create: async (params: { stream?: boolean }) => {
              calls.push(Boolean(params.stream));
              if (!params.stream) {
                throw new Error("LLM response missing choices array (provider=openai-chat-tools, mode=non-stream, model=gpt-5.3-codex)");
              }
              return {
                async *[Symbol.asyncIterator]() {
                  yield {
                    choices: [
                      {
                        delta: {
                          content: "cached fallback content",
                        },
                      },
                    ],
                  };
                },
              };
            },
          },
        },
      },
    } as unknown as LLMClient;

    const request = () => chatWithTools(client, "gpt-5.3-codex", [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: "Say hi." },
    ], tools, {
      useStream: false,
      includeReasoning: false,
      maxTokens: 16000,
      temperature: 0.3,
    });

    const first = await request();
    __resetNonStreamToolChatFallbackCacheForTests();
    const second = await request();

    expect(first.content).toBe("cached fallback content");
    expect(second.content).toBe("cached fallback content");
    expect(calls).toEqual([false, true, true]);
  });
});
