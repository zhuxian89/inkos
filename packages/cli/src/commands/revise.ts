import { Command } from "commander";
import { PipelineRunner, type ReviseMode } from "@actalk/inkos-core";
import { loadConfig, createClient, findProjectRoot, resolveBookId, log, logError } from "../utils.js";

export const reviseCommand = new Command("revise")
  .description("Revise a chapter based on audit issues")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .argument("[chapter]", "Chapter number (defaults to latest)")
  .option("--mode <mode>", "Revise mode: polish, rewrite, rework, spot-fix", "rewrite")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, chapterStr: string | undefined, opts) => {
    try {
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.load_config.start\n`);
      const config = await loadConfig();
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.load_config.done ${JSON.stringify({
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKeyConfigured: Boolean(config.llm.apiKey),
      })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.create_client.start\n`);
      const client = createClient(config);
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.create_client.done\n`);

      const root = findProjectRoot();
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.project_root ${JSON.stringify({ root })}\n`);

      let bookId: string;
      let chapterNumber: number | undefined;
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.resolve_book.start ${JSON.stringify({ bookIdArg: bookIdArg ?? null, chapterArg: chapterStr ?? null })}\n`);
      if (bookIdArg && /^\d+$/.test(bookIdArg)) {
        bookId = await resolveBookId(undefined, root);
        chapterNumber = parseInt(bookIdArg, 10);
      } else {
        bookId = await resolveBookId(bookIdArg, root);
        chapterNumber = chapterStr ? parseInt(chapterStr, 10) : undefined;
      }
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.resolve_book.done ${JSON.stringify({ bookId, chapterNumber: chapterNumber ?? null })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.pipeline.create.start\n`);
      const pipeline = new PipelineRunner({
        client,
        model: config.llm.model,
        projectRoot: root,
        logger: (event, payload) => {
          process.stderr.write(`${new Date().toISOString()} INFO ${event}${payload ? ` ${JSON.stringify(payload)}` : ""}\n`);
        },
      });
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.pipeline.create.done\n`);

      const mode = opts.mode as ReviseMode;
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.run.start ${JSON.stringify({ bookId, chapterNumber: chapterNumber ?? null, mode })}\n`);
      if (!opts.json) log(`Revising "${bookId}"${chapterNumber ? ` chapter ${chapterNumber}` : " (latest)"} [mode: ${mode}]...`);

      const result = await pipeline.reviseDraft(bookId, chapterNumber, mode);
      process.stderr.write(`${new Date().toISOString()} INFO cli.revise.run.done ${JSON.stringify({
        bookId,
        chapterNumber: result.chapterNumber,
        mode,
        wordCount: result.wordCount,
        fixedIssuesCount: result.fixedIssues.length,
      })}\n`);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`  Chapter ${result.chapterNumber} revised`);
        log(`  Words: ${result.wordCount}`);
        if (result.fixedIssues.length > 0) {
          log("  Fixed:");
          for (const fix of result.fixedIssues) {
            log(`    - ${fix}`);
          }
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Revise failed: ${e}`);
      }
      process.exit(1);
    }
  });
