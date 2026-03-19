import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { loadConfig, createClient, findProjectRoot, resolveContext, resolveBookId, log, logError } from "../utils.js";

export const draftCommand = new Command("draft")
  .description("Write a draft chapter (no audit/revise)")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--context <text>", "Creative guidance (natural language)")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.load_config.start\n`);
      const config = await loadConfig();
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.load_config.done ${JSON.stringify({
        provider: config.llm.provider,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKeyConfigured: Boolean(config.llm.apiKey),
      })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.create_client.start\n`);
      const client = createClient(config);
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.create_client.done\n`);

      const root = findProjectRoot();
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.project_root ${JSON.stringify({ root })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.resolve_book.start ${JSON.stringify({ bookIdArg: bookIdArg ?? null })}\n`);
      const bookId = await resolveBookId(bookIdArg, root);
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.resolve_book.done ${JSON.stringify({ bookId })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.resolve_context.start\n`);
      const context = await resolveContext(opts);
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.resolve_context.done ${JSON.stringify({ hasContext: Boolean(context?.trim()) })}\n`);

      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.pipeline.create.start\n`);
      const pipeline = new PipelineRunner({
        client,
        model: config.llm.model,
        projectRoot: root,
        logger: (event, payload) => {
          process.stderr.write(`${new Date().toISOString()} INFO ${event}${payload ? ` ${JSON.stringify(payload)}` : ""}\n`);
        },
      });
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.pipeline.create.done\n`);

      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.write.start ${JSON.stringify({ bookId, wordCount: wordCount ?? null })}\n`);

      if (!opts.json) log(`Writing draft for "${bookId}"...`);

      const result = await pipeline.writeDraft(bookId, context, wordCount);
      process.stderr.write(`${new Date().toISOString()} INFO cli.draft.write.done ${JSON.stringify({
        bookId,
        chapterNumber: result.chapterNumber,
        title: result.title,
        wordCount: result.wordCount,
      })}\n`);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`  Chapter ${result.chapterNumber}: ${result.title}`);
        log(`  Words: ${result.wordCount}`);
        log(`  File: ${result.filePath}`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to write draft: ${e}`);
      }
      process.exit(1);
    }
  });
