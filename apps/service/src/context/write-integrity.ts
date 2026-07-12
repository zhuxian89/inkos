export interface ToolTraceItem {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
  readonly error?: string;
}

export const WRITE_TOOL_NAMES = new Set(["write_text_file", "move_path", "delete_path"]);

const CLAIM_MARKERS = [
  "修改了",
  "已改",
  "写入了",
  "更新了",
  "删除了",
  "添加了",
  "创建了",
  "移动了",
  "重命名",
  "已写入",
  "写回",
  "改好了",
  "已经修改",
];

export function parseToolResultOk(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown };
    return parsed.ok === true;
  } catch {
    return false;
  }
}

export function parseToolResultError(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content.trim()) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

export function hasSuccessfulWrite(toolTrace: ReadonlyArray<ToolTraceItem>): boolean {
  return toolTrace.some((item) => WRITE_TOOL_NAMES.has(item.name) && item.ok);
}

export function replyClaimsModification(reply: string): boolean {
  return CLAIM_MARKERS.some((marker) => reply.includes(marker));
}

export function finalizeAssistantReply(input: {
  readonly reply: string;
  readonly toolTrace: ReadonlyArray<ToolTraceItem>;
  readonly reachedMaxTurns: boolean;
}): string {
  const warnings: string[] = [];
  if (input.reachedMaxTurns) {
    warnings.push("⚠️ 本轮对话工具调用轮次已达上限，部分操作可能未完成。如有遗漏，请再发一条消息继续。");
  }

  const successful = hasSuccessfulWrite(input.toolTrace);
  if (replyClaimsModification(input.reply) && !successful) {
    warnings.push(
      "⚠️ 注意：本轮回复提到了文件修改，但实际未成功写入任何文件。如需真正修改文件，请明确要求我执行写入。",
    );
  }

  const successfulWrites = input.toolTrace.filter(
    (item) => WRITE_TOOL_NAMES.has(item.name) && item.ok,
  );
  if (successfulWrites.length > 0) {
    const summary = successfulWrites
      .map((op) => `- \`${op.name}\`：${String(op.args.path ?? op.args.from ?? "")}`)
      .join("\n");
    warnings.push(`\n---\n📋 **工具执行记录**\n${summary}`);
  }

  if (warnings.length === 0) {
    return input.reply;
  }
  return `${input.reply}\n\n${warnings.join("\n\n")}`;
}

export function buildHonestChapterFallback(
  toolTrace: ReadonlyArray<ToolTraceItem>,
): string {
  if (hasSuccessfulWrite(toolTrace)) {
    const wrote = toolTrace.some((item) => item.name === "write_text_file" && item.ok);
    if (wrote) {
      return "已按你的要求完成修改，并写回相关文件。你可以继续让我解释改动点，或再提具体调整要求。";
    }
    return "已按你的要求完成文件操作。你可以继续让我解释改动点，或再提具体调整要求。";
  }

  const attemptedWrite = toolTrace.some((item) => WRITE_TOOL_NAMES.has(item.name));
  if (attemptedWrite) {
    return "本轮尝试写入文件但未成功。请根据错误信息调整路径或内容后再试，或明确要求我重新执行写入。";
  }
  if (toolTrace.some((item) => item.name === "read_text_file")) {
    return "我已经查看了相关章节/状态文件。本次没有直接输出正文答复，你可以继续告诉我要改哪里。";
  }
  if (toolTrace.length > 0) {
    return "我已经完成本次处理，但没有生成可展示的正文回复。你可以继续补充更具体的修改要求。";
  }
  return "我收到了这次请求，但没有生成可展示的回复。你可以换一种更具体的说法再试一次。";
}
