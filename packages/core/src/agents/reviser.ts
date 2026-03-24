import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { AuditIssue } from "./continuity.js";
import { readGenreProfile, readBookRules } from "./rules-reader.js";
import { countNovelWords } from "../utils/text-count.js";
import { extractTag } from "../utils/tag-parser.js";
import { truncateMarkdownTable } from "../utils/truncate.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ReviseMode = "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export interface ReviseOutput {
  readonly revisedContent: string;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly updatedChapterSummaries: string;
  readonly updatedSubplots: string;
  readonly updatedEmotionalArcs: string;
  readonly updatedCharacterMatrix: string;
}

const MODE_DESCRIPTIONS: Record<ReviseMode, string> = {
  polish: "润色：只改表达、节奏、段落呼吸，不改事实与剧情结论。禁止：增删段落、改变人名/地名/物品名、增加新情节或新对话、改变因果关系。只允许：替换用词、调整句序、修改标点节奏",
  rewrite: "改写：可改叙述顺序、画面、力度，但保留核心事实与人物动机",
  rework: "重写：可重构场景推进和冲突组织，但不改主设定和大事件结果",
  "anti-detect": `反检测改写：在保持剧情不变的前提下，降低AI生成可检测性。

改写手法（附正例）：
1. 打破句式规律：连续短句 → 长短交替，句式不可预测
2. 口语化替代：✗"然而事情并没有那么简单" → ✓"哪有那么便宜的事"
3. 减少"了"字密度：✗"他走了过去，拿了杯子" → ✓"他走过去，端起杯子"
4. 转折词降频：✗"虽然…但是…" → ✓ 用角色内心吐槽或直接动作切换
5. 情绪外化：✗"他感到愤怒" → ✓"他捏碎了茶杯，滚烫的茶水流过指缝"
6. 删掉叙述者结论：✗"这一刻他终于明白了力量" → ✓ 只写行动，让读者自己感受
7. 群像反应具体化：✗"全场震惊" → ✓"老陈的烟掉在裤子上，烫得他跳起来"
8. 段落长度差异化：不再等长段落，有的段只有一句话，有的段七八行
9. 消灭"不禁""仿佛""宛如"等AI标记词：换成具体感官描写`,
  "spot-fix": "定点修复：只修改审稿意见指出的具体句子或段落，其余所有内容必须原封不动保留。修改范围限定在问题句子及其前后各一句。若问题来自正文与真相文件不一致，可最小范围同步对应真相文件；这类同步不算无关改动",
};

export class ReviserAgent extends BaseAgent {
  get name(): string {
    return "reviser";
  }

  async reviseChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    issues: ReadonlyArray<AuditIssue>,
    mode: ReviseMode = "rewrite",
    genre?: string,
    authorInstruction?: string,
  ): Promise<ReviseOutput> {
    process.stderr.write(`${new Date().toISOString()} INFO reviser.load_story_files.start ${JSON.stringify({
      bookDir,
      chapterNumber,
      mode,
      issueCount: issues.length,
      hasInstruction: Boolean(authorInstruction?.trim()),
    })}\n`);
    const [currentState, ledger, hooks, styleGuideRaw, chapterSummaries, subplotBoard, emotionalArcs, characterMatrix, parentCanon] = await Promise.all([
      this.readFileSafe(join(bookDir, "story/current_state.md")),
      this.readFileSafe(join(bookDir, "story/particle_ledger.md")),
      this.readFileSafe(join(bookDir, "story/pending_hooks.md")),
      this.readFileSafe(join(bookDir, "story/style_guide.md")),
      this.readFileSafe(join(bookDir, "story/chapter_summaries.md")),
      this.readFileSafe(join(bookDir, "story/subplot_board.md")),
      this.readFileSafe(join(bookDir, "story/emotional_arcs.md")),
      this.readFileSafe(join(bookDir, "story/character_matrix.md")),
      this.readFileSafe(join(bookDir, "story/parent_canon.md")),
    ]);
    process.stderr.write(`${new Date().toISOString()} INFO reviser.load_story_files.done ${JSON.stringify({
      chapterNumber,
      currentStateLength: currentState.length,
      ledgerLength: ledger.length,
      hooksLength: hooks.length,
      styleGuideLength: styleGuideRaw.length,
      chapterSummariesLength: chapterSummaries.length,
      subplotBoardLength: subplotBoard.length,
      emotionalArcsLength: emotionalArcs.length,
      characterMatrixLength: characterMatrix.length,
      parentCanonLength: parentCanon.length,
    })}\n`);

    // Load genre profile and book rules
    const genreId = genre ?? "other";
    process.stderr.write(`${new Date().toISOString()} INFO reviser.load_rules.start ${JSON.stringify({
      chapterNumber,
      genreId,
    })}\n`);
    const { profile: gp } = await readGenreProfile(this.ctx.projectRoot, genreId);
    const parsedRules = await readBookRules(bookDir);
    const bookRules = parsedRules?.rules ?? null;
    process.stderr.write(`${new Date().toISOString()} INFO reviser.load_rules.done ${JSON.stringify({
      chapterNumber,
      genreName: gp.name,
      numericalSystem: gp.numericalSystem,
      hasBookRules: Boolean(bookRules),
    })}\n`);

    // Fallback: use book_rules body when style_guide.md doesn't exist
    const styleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : (parsedRules?.body ?? "(无文风指南)");

    const issueList = issues
      .map((i) => `- [${i.severity}] ${i.category}: ${i.description}\n  建议: ${i.suggestion}`)
      .join("\n");

    const modeDesc = MODE_DESCRIPTIONS[mode];
    const numericalRule = gp.numericalSystem
      ? "\n3. 数值错误必须精确修正，前后对账"
      : "";
    const protagonistBlock = bookRules?.protagonist
      ? `\n\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}。修改不得违反人设。`
      : "";
    const canonBlock = parentCanon !== "(文件不存在)"
      ? `\n\n正传正典参照：\n${parentCanon}`
      : "";

    const systemPrompt = `你是一位专业的${gp.name}网络小说修稿编辑。你的任务是根据审稿意见对章节进行修正。${protagonistBlock}${canonBlock}

修稿模式：${modeDesc}

修稿原则：
1. 按模式控制修改幅度
2. 修根因，不做表面润色${numericalRule}
3. 如果审稿问题来自正文与真相文件冲突，必须同步修正受影响的真相文件（章节摘要、支线进度板、情感弧线、角色交互矩阵），且只改必要部分
4. 伏笔状态必须与伏笔池同步
5. 不改变剧情走向和核心冲突
6. 保持原文的语言风格和节奏
7. 修改后同步更新状态卡${gp.numericalSystem ? "、账本" : ""}、伏笔池，以及所有受影响的真相文件
8. 如果问题只是知识库/资料同步错误，也要优先修正真相文件，不要只改正文糊弄过去
9. 除专有名词中必须保留的外文缩写外，正文、修订说明、状态卡和真相文件都必须使用自然简体中文，不得夹杂英文单词、英文短语或中英混写

输出格式：

=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条)

=== REVISED_CONTENT ===
(修正后的完整正文)

=== UPDATED_STATE ===
(更新后的完整状态卡)
${gp.numericalSystem ? "\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本)" : ""}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池)

=== UPDATED_CHAPTER_SUMMARIES ===
(如需更新，输出更新后的完整章节摘要文件；否则留空)

=== UPDATED_SUBPLOTS ===
(如需更新，输出更新后的完整支线进度板；否则留空)

=== UPDATED_EMOTIONAL_ARCS ===
(如需更新，输出更新后的完整情感弧线；否则留空)

=== UPDATED_CHARACTER_MATRIX ===
(如需更新，输出更新后的完整角色交互矩阵；否则留空)`;

    const ledgerBlock = gp.numericalSystem
      ? `\n## 资源账本\n${ledger}`
      : "";
    const chapterSummariesBlock = chapterSummaries !== "(文件不存在)"
      ? `\n## 章节摘要\n${truncateMarkdownTable(chapterSummaries, 30)}`
      : "";
    const subplotBoardBlock = subplotBoard !== "(文件不存在)"
      ? `\n## 支线进度板\n${truncateMarkdownTable(subplotBoard, 20)}`
      : "";
    const emotionalArcsBlock = emotionalArcs !== "(文件不存在)"
      ? `\n## 情感弧线\n${truncateMarkdownTable(emotionalArcs, 30)}`
      : "";
    const characterMatrixBlock = characterMatrix !== "(文件不存在)"
      ? `\n## 角色交互矩阵\n${truncateMarkdownTable(characterMatrix, 30)}`
      : "";

    const userPrompt = `请修正第${chapterNumber}章。

## 审稿问题
${issueList}

## 作者额外修改要求
${authorInstruction?.trim() ? authorInstruction.trim() : "（无，按审稿问题和修稿模式处理）"}

## 当前状态卡
${currentState}
${ledgerBlock}
## 伏笔池
${hooks}
${chapterSummariesBlock}${subplotBoardBlock}${emotionalArcsBlock}${characterMatrixBlock}

## 文风指南
${styleGuide}

## 待修正章节
${chapterContent}`;
    process.stderr.write(`${new Date().toISOString()} INFO reviser.prompt.ready ${JSON.stringify({
      chapterNumber,
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt.length,
      chapterContentLength: chapterContent.length,
    })}\n`);

    const maxTokens = 16000;
    process.stderr.write(`${new Date().toISOString()} INFO reviser.llm.start ${JSON.stringify({
      chapterNumber,
      model: this.ctx.model,
      mode,
      maxTokens,
    })}\n`);

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.3, maxTokens },
    );
    process.stderr.write(`${new Date().toISOString()} INFO reviser.llm.done ${JSON.stringify({
      chapterNumber,
      responseLength: response.content.length,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
    })}\n`);

    process.stderr.write(`${new Date().toISOString()} INFO reviser.parse.start ${JSON.stringify({ chapterNumber })}\n`);
    let parsed = this.parseOutput(response.content, gp);

    // Retry once if critical section (REVISED_CONTENT) is empty
    if (!parsed.revisedContent) {
      process.stderr.write(`${new Date().toISOString()} WARN reviser.parse.empty_content — retrying ${JSON.stringify({ chapterNumber, mode })}\n`);
      const retryResponse = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
          { role: "assistant", content: response.content },
          { role: "user", content: "你的输出缺少 === REVISED_CONTENT === 区块。请只输出从 === FIXED_ISSUES === 到 === UPDATED_CHARACTER_MATRIX === 的完整内容，严格遵循输出格式。" },
        ],
        { temperature: 0.3, maxTokens },
      );
      parsed = this.parseOutput(retryResponse.content, gp);
    }

    process.stderr.write(`${new Date().toISOString()} INFO reviser.parse.done ${JSON.stringify({
      chapterNumber,
      revisedContentLength: parsed.revisedContent.length,
      fixedIssuesCount: parsed.fixedIssues.length,
      updatedStateLength: parsed.updatedState.length,
      updatedLedgerLength: parsed.updatedLedger.length,
      updatedHooksLength: parsed.updatedHooks.length,
      updatedChapterSummariesLength: parsed.updatedChapterSummaries.length,
      updatedSubplotsLength: parsed.updatedSubplots.length,
      updatedEmotionalArcsLength: parsed.updatedEmotionalArcs.length,
      updatedCharacterMatrixLength: parsed.updatedCharacterMatrix.length,
    })}\n`);
    return parsed;
  }

  private parseOutput(content: string, gp: GenreProfile): ReviseOutput {
    const extract = (tag: string): string => extractTag(tag, content);

    const revisedContent = extract("REVISED_CONTENT");
    const fixedRaw = extract("FIXED_ISSUES");

    return {
      revisedContent,
      wordCount: countNovelWords(revisedContent),
      fixedIssues: fixedRaw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
      updatedState: extract("UPDATED_STATE") || "(状态卡未更新)",
      updatedLedger: gp.numericalSystem
        ? (extract("UPDATED_LEDGER") || "(账本未更新)")
        : "",
      updatedHooks: extract("UPDATED_HOOKS") || "(伏笔池未更新)",
      updatedChapterSummaries: extract("UPDATED_CHAPTER_SUMMARIES") || "(章节摘要未更新)",
      updatedSubplots: extract("UPDATED_SUBPLOTS") || "(支线进度板未更新)",
      updatedEmotionalArcs: extract("UPDATED_EMOTIONAL_ARCS") || "(情感弧线未更新)",
      updatedCharacterMatrix: extract("UPDATED_CHARACTER_MATRIX") || "(角色交互矩阵未更新)",
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
