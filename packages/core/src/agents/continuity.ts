import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import { readGenreProfile, readBookRules } from "./rules-reader.js";
import { truncateMarkdownTable } from "../utils/truncate.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AuditResult {
  readonly passed: boolean;
  readonly issues: ReadonlyArray<AuditIssue>;
  readonly summary: string;
}

export interface AuditIssue {
  readonly severity: "critical" | "warning" | "info";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
}

interface ResearchResult {
  readonly findings: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<string>;
  readonly openQuestions: ReadonlyArray<string>;
  readonly error?: string;
}

// Dimension ID → name mapping
const DIMENSION_MAP: Record<number, string> = {
  1: "OOC检查",
  2: "时间线检查",
  3: "设定冲突",
  4: "战力崩坏",
  5: "数值检查",
  6: "伏笔检查",
  7: "节奏检查",
  8: "文风检查",
  9: "信息越界",
  10: "词汇疲劳",
  11: "利益链断裂",
  12: "年代考据",
  13: "配角降智",
  14: "配角工具人化",
  15: "爽点虚化",
  16: "台词失真",
  17: "流水账",
  18: "知识库污染",
  19: "视角一致性",
  20: "段落等长",
  21: "套话密度",
  22: "公式化转折",
  23: "列表式结构",
  24: "支线停滞",
  25: "弧线平坦",
  26: "节奏单调",
  27: "敏感词检查",
  28: "正传事件冲突",
  29: "未来信息泄露",
  30: "世界规则跨书一致性",
  31: "番外伏笔隔离",
  32: "读者期待管理",
};

function extractJsonObjects(content: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function isAuditResultPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, "passed")
    || Object.hasOwn(record, "issues")
    || Object.hasOwn(record, "summary");
}

function isResearchResultPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, "findings")
    || Object.hasOwn(record, "sources")
    || Object.hasOwn(record, "openQuestions");
}

function buildDimensionList(
  gp: GenreProfile,
  bookRules: BookRules | null,
  hasParentCanon = false,
): ReadonlyArray<{ readonly id: number; readonly name: string; readonly note: string }> {
  const activeIds = new Set(gp.auditDimensions);

  // Add book-level additional dimensions (supports both numeric IDs and name strings)
  if (bookRules?.additionalAuditDimensions) {
    // Build reverse lookup: name → id
    const nameToId = new Map<string, number>();
    for (const [id, name] of Object.entries(DIMENSION_MAP)) {
      nameToId.set(name, Number(id));
    }

    for (const d of bookRules.additionalAuditDimensions) {
      if (typeof d === "number") {
        activeIds.add(d);
      } else if (typeof d === "string") {
        // Try exact match first, then substring match
        const exactId = nameToId.get(d);
        if (exactId !== undefined) {
          activeIds.add(exactId);
        } else {
          // Fuzzy: find dimension whose name contains the string
          for (const [name, id] of nameToId) {
            if (name.includes(d) || d.includes(name)) {
              activeIds.add(id);
              break;
            }
          }
        }
      }
    }
  }

  // Always-active dimensions
  activeIds.add(32); // 读者期待管理 — universal

  // Conditional overrides
  if (gp.eraResearch || bookRules?.eraConstraints?.enabled) {
    activeIds.add(12);
  }

  // Spinoff dimensions — activated when parent_canon.md exists
  if (hasParentCanon) {
    activeIds.add(28); // 正传事件冲突
    activeIds.add(29); // 未来信息泄露
    activeIds.add(30); // 世界规则跨书一致性
    activeIds.add(31); // 番外伏笔隔离
  }

  const dims: Array<{ id: number; name: string; note: string }> = [];

  for (const id of [...activeIds].sort((a, b) => a - b)) {
    const name = DIMENSION_MAP[id];
    if (!name) continue;

    let note = "";
    if (id === 10 && gp.fatigueWords.length > 0) {
      const words = bookRules?.fatigueWordsOverride && bookRules.fatigueWordsOverride.length > 0
        ? bookRules.fatigueWordsOverride
        : gp.fatigueWords;
      note = `高疲劳词：${words.join("、")}。同时检查AI标记词（仿佛/不禁/宛如/竟然/忽然/猛地）密度，每3000字超过1次即warning`;
    }
    if (id === 15 && gp.satisfactionTypes.length > 0) {
      note = `爽点类型：${gp.satisfactionTypes.join("、")}`;
    }
    if (id === 12 && bookRules?.eraConstraints) {
      const era = bookRules.eraConstraints;
      const parts = [era.period, era.region].filter(Boolean);
      if (parts.length > 0) note = `年代：${parts.join("，")}`;
    }
    if (id === 19) {
      note = "检查视角切换是否有过渡、是否与设定视角一致";
    }
    if (id === 24) {
      note = "对照 subplot_board 和 chapter_summaries：如果任何支线超过5章未被提及或推进→warning。如果存在支线但近3章完全没有任何支线推进→warning";
    }
    if (id === 25) {
      note = "对照 emotional_arcs 和 chapter_summaries：如果主要角色连续3章情绪状态无变化（没有新的压力、释放、转变）→warning。注意区分'角色处境未变'和'角色内心未变'";
    }
    if (id === 26) {
      note = "对照 chapter_summaries 的章节类型分布：连续≥3章相同类型（如连续3个事件章/战斗章/布局章）→warning。≥5章没有出现回收章或高潮章→warning。请明确列出最近章节的类型序列";
    }
    if (id === 28) {
      note = "检查番外事件是否与正典约束表矛盾";
    }
    if (id === 29) {
      note = "检查角色是否引用了分歧点之后才揭示的信息（参照信息边界表）";
    }
    if (id === 30) {
      note = "检查番外是否违反正传世界规则（力量体系、地理、阵营）";
    }
    if (id === 31) {
      note = "检查番外是否越权回收正传伏笔（warning级别）";
    }
    if (id === 32) {
      note = "检查：章尾是否有钩子？最近3-5章内是否有爽点落地？是否存在超过3章的情绪压制无释放？读者的情绪缺口是否在积累或被满足？";
    }

    dims.push({ id, name, note });
  }

  return dims;
}

export class ContinuityAuditor extends BaseAgent {
  get name(): string {
    return "continuity-auditor";
  }

  async auditChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    genre?: string,
    options?: { temperature?: number },
  ): Promise<AuditResult> {
    process.stderr.write(`${new Date().toISOString()} INFO auditor.load_story_files.start ${JSON.stringify({
      bookDir,
      chapterNumber,
      genre: genre ?? "other",
      temperature: options?.temperature ?? 0.3,
    })}\n`);
    const [currentState, ledger, hooks, styleGuideRaw, subplotBoard, emotionalArcs, characterMatrix, chapterSummaries, parentCanon] =
      await Promise.all([
        this.readFileSafe(join(bookDir, "story/current_state.md")),
        this.readFileSafe(join(bookDir, "story/particle_ledger.md")),
        this.readFileSafe(join(bookDir, "story/pending_hooks.md")),
        this.readFileSafe(join(bookDir, "story/style_guide.md")),
        this.readFileSafe(join(bookDir, "story/subplot_board.md")),
        this.readFileSafe(join(bookDir, "story/emotional_arcs.md")),
        this.readFileSafe(join(bookDir, "story/character_matrix.md")),
        this.readFileSafe(join(bookDir, "story/chapter_summaries.md")),
        this.readFileSafe(join(bookDir, "story/parent_canon.md")),
      ]);
    process.stderr.write(`${new Date().toISOString()} INFO auditor.load_story_files.done ${JSON.stringify({
      chapterNumber,
      currentStateLength: currentState.length,
      ledgerLength: ledger.length,
      hooksLength: hooks.length,
      styleGuideLength: styleGuideRaw.length,
      subplotBoardLength: subplotBoard.length,
      emotionalArcsLength: emotionalArcs.length,
      characterMatrixLength: characterMatrix.length,
      chapterSummariesLength: chapterSummaries.length,
      parentCanonLength: parentCanon.length,
    })}\n`);

    const hasParentCanon = parentCanon !== "(文件不存在)";

    // Load genre profile and book rules
    const genreId = genre ?? "other";
    process.stderr.write(`${new Date().toISOString()} INFO auditor.load_rules.start ${JSON.stringify({
      chapterNumber,
      genreId,
    })}\n`);
    const { profile: gp } = await readGenreProfile(this.ctx.projectRoot, genreId);
    const parsedRules = await readBookRules(bookDir);
    const bookRules = parsedRules?.rules ?? null;
    process.stderr.write(`${new Date().toISOString()} INFO auditor.load_rules.done ${JSON.stringify({
      chapterNumber,
      genreName: gp.name,
      numericalSystem: gp.numericalSystem,
      eraResearch: gp.eraResearch,
      hasBookRules: Boolean(bookRules),
      hasParentCanon,
    })}\n`);

    // Fallback: use book_rules body when style_guide.md doesn't exist
    const styleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : (parsedRules?.body ?? "(无文风指南)");

    const dimensions = buildDimensionList(gp, bookRules, hasParentCanon);
    const dimList = dimensions
      .map((d) => `${d.id}. ${d.name}${d.note ? `（${d.note}）` : ""}`)
      .join("\n");

    const protagonistBlock = bookRules?.protagonist
      ? `\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}，行为约束：${bookRules.protagonist.behavioralConstraints.join("、")}`
      : "";

    const searchNote = gp.eraResearch
      ? "\n\n你有联网搜索能力（search_web / fetch_url）。对于涉及真实年代、人物、事件、地理、政策的内容，你必须用search_web核实，不可凭记忆判断。至少对比2个来源交叉验证。"
      : "";

    const researchPrompt = gp.eraResearch
      ? `你是${gp.name}小说的事实核验研究员。你的任务是只做考据，不做最终审稿结论。${protagonistBlock}${searchNote}

输出格式必须为 JSON：
{
  "findings": ["事实核验结论1", "事实核验结论2"],
  "sources": ["来源摘要1", "来源摘要2"],
  "openQuestions": ["仍不确定的问题1"]
}

要求：
1. 只输出 JSON，不要输出搜索动作、工具痕迹、解释性前缀或额外说明
2. findings 只写与本章审稿相关的事实结论
3. sources 只写简短来源摘要，不要长段复制
4. 若未发现需要核验的问题，也返回空数组 JSON`
      : "";

    const systemPrompt = `你是一位严格的${gp.name}网络小说审稿编辑。你的任务是对章节进行连续性、一致性和质量审查。${protagonistBlock}${searchNote}

审查维度：
${dimList}

输出格式必须为 JSON：
{
  "passed": true/false,
  "issues": [
    {
      "severity": "critical|warning|info",
      "category": "审查维度名称",
      "description": "具体问题描述",
      "suggestion": "修改建议"
    }
  ],
  "summary": "一句话总结审查结论"
}

只有当存在 critical 级别问题时，passed 才为 false。`;

    const ledgerBlock = gp.numericalSystem
      ? `\n## 资源账本\n${ledger}`
      : "";

    const subplotBlock = subplotBoard !== "(文件不存在)"
      ? `\n## 支线进度板\n${truncateMarkdownTable(subplotBoard, 20)}\n`
      : "";
    const emotionalBlock = emotionalArcs !== "(文件不存在)"
      ? `\n## 情感弧线\n${truncateMarkdownTable(emotionalArcs, 30)}\n`
      : "";
    const matrixBlock = characterMatrix !== "(文件不存在)"
      ? `\n## 角色交互矩阵\n${truncateMarkdownTable(characterMatrix, 30)}\n`
      : "";
    const summariesBlock = chapterSummaries !== "(文件不存在)"
      ? `\n## 章节摘要（用于节奏检查）\n${truncateMarkdownTable(chapterSummaries, 30)}\n`
      : "";

    const canonBlock = hasParentCanon
      ? `\n## 正传正典参照（番外审查专用）\n${parentCanon}\n`
      : "";

    const userPrompt = `请审查第${chapterNumber}章。

## 当前状态卡
${currentState}
${ledgerBlock}
## 伏笔池
${hooks}
${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}
## 文风指南
${styleGuide}

## 待审章节内容
${chapterContent}`;

    const researchUserPrompt = gp.eraResearch
      ? `请先对第${chapterNumber}章做事实核验研究，仅输出研究结论 JSON。

## 当前状态卡
${currentState}
${ledgerBlock}
## 伏笔池
${hooks}
${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}
## 文风指南
${styleGuide}

## 待核验章节内容
${chapterContent}`
      : "";
    process.stderr.write(`${new Date().toISOString()} INFO auditor.prompt.ready ${JSON.stringify({
      chapterNumber,
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      dimensionCount: dimensions.length,
      chapterContentLength: chapterContent.length,
      usesSearch: gp.eraResearch,
    })}\n`);

    const chatOptions = { temperature: options?.temperature ?? 0.3, maxTokens: 16000 };
    let researchResult: ResearchResult | null = null;

    if (gp.eraResearch) {
      process.stderr.write(`${new Date().toISOString()} INFO auditor.research.llm.start ${JSON.stringify({
        chapterNumber,
        model: this.ctx.model,
        usesSearch: true,
        temperature: chatOptions.temperature,
        maxTokens: chatOptions.maxTokens,
      })}\n`);
      const researchResponse = await this.chatWithSearch([
        { role: "system" as const, content: researchPrompt },
        { role: "user" as const, content: researchUserPrompt },
      ], chatOptions);
      process.stderr.write(`${new Date().toISOString()} INFO auditor.research.llm.done ${JSON.stringify({
        chapterNumber,
        responseLength: researchResponse.content.length,
        promptTokens: researchResponse.usage.promptTokens,
        completionTokens: researchResponse.usage.completionTokens,
        totalTokens: researchResponse.usage.totalTokens,
      })}\n`);
      researchResult = this.parseResearchResult(researchResponse.content);
    }

    const researchBlock = researchResult
      ? `\n## 联网考据研究结果\n${JSON.stringify(researchResult, null, 2)}`
      : "";
    const finalMessages = [
      { role: "system" as const, content: `${systemPrompt}\n\n你现在处于最终审稿阶段。禁止输出搜索动作、工具调用痕迹、解释性前缀；只能输出最终审稿 JSON。` },
      { role: "user" as const, content: `${userPrompt}${researchBlock}` },
    ];

    process.stderr.write(`${new Date().toISOString()} INFO auditor.final.llm.start ${JSON.stringify({
      chapterNumber,
      model: this.ctx.model,
      usesSearch: false,
      temperature: chatOptions.temperature,
      maxTokens: chatOptions.maxTokens,
      hasResearch: Boolean(researchResult),
      researchError: researchResult?.error ?? null,
    })}\n`);
    const response = await this.chat(finalMessages, chatOptions);
    process.stderr.write(`${new Date().toISOString()} INFO auditor.final.llm.done ${JSON.stringify({
      chapterNumber,
      responseLength: response.content.length,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
    })}\n`);

    process.stderr.write(`${new Date().toISOString()} INFO auditor.parse.start ${JSON.stringify({
      chapterNumber,
      stage: "final",
    })}\n`);
    const parsed = this.parseAuditResult(response.content, "final");
    process.stderr.write(`${new Date().toISOString()} INFO auditor.parse.done ${JSON.stringify({
      chapterNumber,
      passed: parsed.passed,
      issueCount: parsed.issues.length,
      summary: parsed.summary,
    })}\n`);
    return parsed;
  }

  private parseResearchResult(content: string): ResearchResult {
    process.stderr.write(`${new Date().toISOString()} INFO auditor.raw.preview ${JSON.stringify({
      stage: "research",
      preview: content.slice(0, 1200),
      length: content.length,
    })}\n`);
    const jsonObjects = extractJsonObjects(content);
    if (jsonObjects.length === 0) {
      process.stderr.write(`${new Date().toISOString()} INFO auditor.parse.json_error ${JSON.stringify({
        stage: "research",
        error: "未找到研究结果 JSON 对象",
        extractedPreview: "",
        extractedLength: 0,
        candidateCount: 0,
      })}\n`);
      return {
        findings: [],
        sources: [],
        openQuestions: [],
        error: "研究阶段输出异常",
      };
    }

    let lastError = "未找到符合研究结果结构的 JSON 对象";
    for (let index = jsonObjects.length - 1; index >= 0; index -= 1) {
      const candidate = jsonObjects[index];
      try {
        const parsed = JSON.parse(candidate);
        if (!isResearchResultPayload(parsed)) {
          continue;
        }
        return {
          findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
          sources: Array.isArray(parsed.sources) ? parsed.sources.map(String) : [],
          openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map(String) : [],
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const fallback = jsonObjects[jsonObjects.length - 1] ?? "";
    process.stderr.write(`${new Date().toISOString()} INFO auditor.parse.json_error ${JSON.stringify({
      stage: "research",
      error: lastError,
      extractedPreview: fallback.slice(0, 1200),
      extractedLength: fallback.length,
      candidateCount: jsonObjects.length,
    })}\n`);
    return {
      findings: [],
      sources: [],
      openQuestions: [],
      error: "研究阶段输出异常",
    };
  }

  private parseAuditResult(content: string, stage: "final" | "single" = "single"): AuditResult {
    process.stderr.write(`${new Date().toISOString()} INFO auditor.raw.preview ${JSON.stringify({
      stage,
      preview: content.slice(0, 1200),
      length: content.length,
    })}\n`);
    const jsonObjects = extractJsonObjects(content);
    if (jsonObjects.length === 0) {
      process.stderr.write(`${new Date().toISOString()} INFO auditor.parse.no_json_object ${JSON.stringify({ stage })}\n`);
      return {
        passed: false,
        issues: [
          {
            severity: "critical",
            category: "系统错误",
            description: stage === "final" ? "最终审稿 JSON 缺失" : "审稿输出格式异常，无法解析",
            suggestion: "重新运行审稿",
          },
        ],
        summary: stage === "final" ? "最终审稿输出异常" : "审稿输出解析失败",
      };
    }

    let lastError = "未找到符合审稿结果结构的 JSON 对象";
    for (let index = jsonObjects.length - 1; index >= 0; index -= 1) {
      const candidate = jsonObjects[index];
      try {
        const parsed = JSON.parse(candidate);
        if (!isAuditResultPayload(parsed)) {
          continue;
        }

        return {
          passed: Boolean(parsed.passed),
          issues: Array.isArray(parsed.issues) ? parsed.issues : [],
          summary: String(parsed.summary ?? ""),
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const fallback = jsonObjects[jsonObjects.length - 1] ?? "";
    process.stderr.write(`${new Date().toISOString()} INFO auditor.parse.json_error ${JSON.stringify({
      stage,
      error: lastError,
      extractedPreview: fallback.slice(0, 1200),
      extractedLength: fallback.length,
      candidateCount: jsonObjects.length,
    })}\n`);
    return {
      passed: false,
      issues: [
        {
          severity: "critical",
          category: "系统错误",
          description: stage === "final" ? "最终审稿 JSON 结构非法" : "审稿 JSON 解析失败",
          suggestion: "重新运行审稿",
        },
      ],
      summary: stage === "final" ? "最终审稿输出异常" : "审稿 JSON 解析失败",
    };
  }

  private async readFileSafe(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件不存在)";
    }
  }
}
