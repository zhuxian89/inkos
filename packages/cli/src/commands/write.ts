import { Command } from "commander";
import { PipelineRunner, StateManager } from "@actalk/inkos-core";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, createClient, findProjectRoot, resolveContext, resolveBookId, log, logError } from "../utils.js";

export const writeCommand = new Command("write")
  .description("Write chapters");

writeCommand
  .command("next")
  .description("Write the next chapter for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--count <n>", "Number of chapters to write", "1")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--context <text>", "Creative guidance (natural language)")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.load_config.start\n`);
      const config = await loadConfig();
      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.load_config.done ${JSON.stringify({
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKeyConfigured: Boolean(config.llm.apiKey),
      })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.create_client.start\n`);
      const client = createClient(config);
      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.create_client.done\n`);

      const root = findProjectRoot();
      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.project_root ${JSON.stringify({ root })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.resolve_book.start ${JSON.stringify({ bookIdArg: bookIdArg ?? null })}\n`);
      const bookId = await resolveBookId(bookIdArg, root);
      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.resolve_book.done ${JSON.stringify({ bookId })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.resolve_context.start\n`);
      const context = await resolveContext(opts);
      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.resolve_context.done ${JSON.stringify({ hasContext: Boolean(context?.trim()) })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.pipeline.create.start\n`);
      const pipeline = new PipelineRunner({
        client,
        model: config.llm.model,
        projectRoot: root,
        notifyChannels: config.notify,
        ...(context ? { externalContext: context } : {}),
        logger: (event, payload) => {
          process.stderr.write(`${new Date().toISOString()} INFO ${event}${payload ? ` ${JSON.stringify(payload)}` : ""}\n`);
        },
      });
      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.pipeline.create.done\n`);

      const count = parseInt(opts.count, 10);
      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;
      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.run.start ${JSON.stringify({
        bookId,
        count,
        wordCount: wordCount ?? null,
      })}\n`);

      const results = [];
      for (let i = 0; i < count; i++) {
        process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.iteration.start ${JSON.stringify({
          bookId,
          iteration: i + 1,
          count,
          wordCount: wordCount ?? null,
        })}\n`);
        if (!opts.json) log(`[${i + 1}/${count}] Writing chapter for "${bookId}"...`);

        const result = await pipeline.writeNextChapter(bookId, wordCount);
        results.push(result);
        process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.iteration.done ${JSON.stringify({
          bookId,
          iteration: i + 1,
          count,
          chapterNumber: result.chapterNumber,
          title: result.title,
          wordCount: result.wordCount,
          passed: result.auditResult.passed,
          revised: result.revised,
          status: result.status,
          issueCount: result.auditResult.issues.length,
        })}\n`);

        if (!opts.json) {
          log(`  Chapter ${result.chapterNumber}: ${result.title}`);
          log(`  Words: ${result.wordCount}`);
          log(`  Audit: ${result.auditResult.passed ? "PASSED" : "NEEDS REVIEW"}`);
          if (result.revised) {
            log("  Auto-revised: YES (critical issues were fixed)");
          }
          log(`  Status: ${result.status}`);

          if (result.auditResult.issues.length > 0) {
            log("  Issues:");
            for (const issue of result.auditResult.issues) {
              log(`    [${issue.severity}] ${issue.category}: ${issue.description}`);
            }
          }

          log("");
        }
      }

      process.stderr.write(`${new Date().toISOString()} INFO cli.write_next.run.done ${JSON.stringify({
        bookId,
        count,
        resultCount: results.length,
      })}\n`);

      if (opts.json) {
        log(JSON.stringify(results, null, 2));
      } else {
        log("Done.");
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to write chapter: ${e}`);
      }
      process.exit(1);
    }
  });

writeCommand
  .command("rewrite")
  .description("Re-generate a specific chapter: rewrite [book-id] <chapter>")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--force", "Skip confirmation prompt")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const config = await loadConfig();
      const client = createClient(config);
      const root = findProjectRoot();

      let bookId: string;
      let chapter: number;
      if (args.length === 1) {
        chapter = parseInt(args[0]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        chapter = parseInt(args[1]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write rewrite [book-id] <chapter>");
      }

      if (!opts.force) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Rewrite chapter ${chapter} of "${bookId}"? This will delete chapter ${chapter} and all later chapters. (y/N) `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          log("Cancelled.");
          return;
        }
      }

      const state = new StateManager(root);
      const bookDir = state.bookDir(bookId);
      const chaptersDir = join(bookDir, "chapters");

      // Remove existing chapter file
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapter).padStart(4, "0");
      const existing = files.filter((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      for (const f of existing) {
        await unlink(join(chaptersDir, f));
        if (!opts.json) log(`Removed: ${f}`);
      }

      // Remove from index (and all chapters after it)
      const index = await state.loadChapterIndex(bookId);
      const trimmed = index.filter((ch) => ch.number < chapter);
      await state.saveChapterIndex(bookId, trimmed);

      // Also remove later chapter files since state will be rolled back
      const laterFiles = files.filter((f) => {
        const num = parseInt(f.slice(0, 4), 10);
        return num > chapter && f.endsWith(".md");
      });
      for (const f of laterFiles) {
        await unlink(join(chaptersDir, f));
        if (!opts.json) log(`Removed later chapter: ${f}`);
      }

      // Restore state to previous chapter's end-state
      if (chapter > 1) {
        const restored = await state.restoreState(bookId, chapter - 1);
        if (restored) {
          if (!opts.json) log(`State restored from chapter ${chapter - 1} snapshot.`);
        } else {
          if (!opts.json) log(`Warning: no snapshot for chapter ${chapter - 1}. Using current state.`);
        }
      }

      if (!opts.json) log(`Regenerating chapter ${chapter}...`);

      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;

      const pipeline = new PipelineRunner({
        client,
        model: config.llm.model,
        projectRoot: root,
        notifyChannels: config.notify,
      });

      const result = await pipeline.writeNextChapter(bookId, wordCount);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`  Chapter ${result.chapterNumber}: ${result.title}`);
        log(`  Words: ${result.wordCount}`);
        log(`  Audit: ${result.auditResult.passed ? "PASSED" : "NEEDS REVIEW"}`);
        log(`  Status: ${result.status}`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to rewrite chapter: ${e}`);
      }
      process.exit(1);
    }
  });
