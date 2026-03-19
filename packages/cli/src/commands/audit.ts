import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { loadConfig, createClient, findProjectRoot, resolveBookId, log, logError } from "../utils.js";

export const auditCommand = new Command("audit")
  .description("Audit a chapter for continuity issues")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .argument("[chapter]", "Chapter number (defaults to latest)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, chapterStr: string | undefined, opts) => {
    try {
      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.load_config.start\n`);
      const config = await loadConfig();
      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.load_config.done ${JSON.stringify({
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKeyConfigured: Boolean(config.llm.apiKey),
      })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.create_client.start\n`);
      const client = createClient(config);
      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.create_client.done\n`);

      const root = findProjectRoot();
      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.project_root ${JSON.stringify({ root })}\n`);

      // If first arg looks like a number, treat it as chapter (auto-detect book)
      let bookId: string;
      let chapterNumber: number | undefined;
      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.resolve_book.start ${JSON.stringify({ bookIdArg: bookIdArg ?? null, chapterArg: chapterStr ?? null })}\n`);
      if (bookIdArg && /^\d+$/.test(bookIdArg)) {
        bookId = await resolveBookId(undefined, root);
        chapterNumber = parseInt(bookIdArg, 10);
      } else {
        bookId = await resolveBookId(bookIdArg, root);
        chapterNumber = chapterStr ? parseInt(chapterStr, 10) : undefined;
      }
      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.resolve_book.done ${JSON.stringify({ bookId, chapterNumber: chapterNumber ?? null })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.pipeline.create.start\n`);
      const pipeline = new PipelineRunner({
        client,
        model: config.llm.model,
        projectRoot: root,
        logger: (event, payload) => {
          process.stderr.write(`${new Date().toISOString()} INFO ${event}${payload ? ` ${JSON.stringify(payload)}` : ""}\n`);
        },
      });
      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.pipeline.create.done\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.run.start ${JSON.stringify({ bookId, chapterNumber: chapterNumber ?? null })}\n`);
      if (!opts.json) log(`Auditing "${bookId}"${chapterNumber ? ` chapter ${chapterNumber}` : " (latest)"}...`);

      const result = await pipeline.auditDraft(bookId, chapterNumber);
      process.stderr.write(`${new Date().toISOString()} INFO cli.audit.run.done ${JSON.stringify({
        bookId,
        chapterNumber: result.chapterNumber,
        passed: result.passed,
        issueCount: result.issues.length,
      })}\n`);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`  Chapter ${result.chapterNumber}: ${result.passed ? "PASSED" : "FAILED"}`);
        log(`  Summary: ${result.summary}`);
        if (result.issues.length > 0) {
          log("  Issues:");
          for (const issue of result.issues) {
            log(`    [${issue.severity}] ${issue.category}: ${issue.description}`);
          }
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Audit failed: ${e}`);
      }
      process.exit(1);
    }
  });
