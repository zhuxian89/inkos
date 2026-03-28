import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeError, forwardCliChunk, logError, logInfo } from "./service-logging.js";

interface GlobalLlmEnv {
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
}

export function createCliService(input: {
  readonly projectRoot: string;
  readonly repoRoot: string;
  readonly readGlobalLlmEnv: () => Promise<GlobalLlmEnv>;
}) {
  function daemonPidPath(): string {
    return resolve(input.projectRoot, "inkos.pid");
  }

  async function cliEntry(): Promise<{ command: string; args: string[] }> {
    const distEntry = resolve(input.repoRoot, "packages/cli/dist/index.js");
    try {
      await access(distEntry, fsConstants.F_OK);
      return { command: "node", args: [distEntry] };
    } catch {
      const srcEntry = resolve(input.repoRoot, "packages/cli/src/index.ts");
      return { command: "node", args: ["--import", "tsx", srcEntry] };
    }
  }

  async function spawnCli(
    args: string[],
    options?: {
      readonly expectJson?: boolean;
      readonly detached?: boolean;
      readonly timeoutMs?: number;
      readonly retries?: number;
      readonly retryDelayMs?: number;
    },
  ): Promise<{ stdout: string; stderr: string; code: number | null; parsed?: unknown }> {
    const launch = await cliEntry();
    const latestGlobalLlmEnv = await input.readGlobalLlmEnv();
    const env = {
      ...process.env,
      ...(latestGlobalLlmEnv.provider ? { INKOS_LLM_PROVIDER: latestGlobalLlmEnv.provider } : {}),
      ...(latestGlobalLlmEnv.baseUrl ? { INKOS_LLM_BASE_URL: latestGlobalLlmEnv.baseUrl } : {}),
      ...(latestGlobalLlmEnv.apiKey ? { INKOS_LLM_API_KEY: latestGlobalLlmEnv.apiKey } : {}),
      ...(latestGlobalLlmEnv.model ? { INKOS_LLM_MODEL: latestGlobalLlmEnv.model } : {}),
    };
    const retries = Math.max(1, options?.retries ?? (parseInt(process.env.INKOS_WEB_COMMAND_RETRIES ?? "3", 10) || 3));
    const retryDelayMs = Math.max(0, options?.retryDelayMs ?? (parseInt(process.env.INKOS_WEB_COMMAND_RETRY_DELAY_MS ?? "1500", 10) || 1500));

    async function runOnce(attempt: number): Promise<{ stdout: string; stderr: string; code: number | null; parsed?: unknown }> {
      const startedAt = Date.now();
      logInfo("cli.start", {
        command: launch.command,
        args: [...launch.args, ...args],
        detached: options?.detached ?? false,
        timeoutMs: options?.timeoutMs ?? 0,
        attempt,
        retries,
        llmProvider: env.INKOS_LLM_PROVIDER ?? null,
        llmBaseUrl: env.INKOS_LLM_BASE_URL ?? null,
        llmModel: env.INKOS_LLM_MODEL ?? null,
        llmApiKeyConfigured: Boolean(env.INKOS_LLM_API_KEY),
      });
      const child = spawn(launch.command, [...launch.args, ...args], {
        cwd: input.projectRoot,
        env,
        detached: options?.detached ?? false,
        stdio: options?.detached ? "ignore" : ["ignore", "pipe", "pipe"],
      });

      if (options?.detached) {
        child.unref();
        logInfo("cli.detached", {
          pid: child.pid ?? null,
          command: launch.command,
          args: [...launch.args, ...args],
          attempt,
        });
        return { stdout: "", stderr: "", code: 0 };
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killedByTimeout = false;
      let forceKilledByTimeout = false;
      const timeoutMs = options?.timeoutMs ?? 0;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            killedByTimeout = true;
            child.kill("SIGTERM");
            forceKillTimer = setTimeout(() => {
              forceKilledByTimeout = true;
              child.kill("SIGKILL");
            }, 5_000);
          }, timeoutMs)
        : null;

      child.stdout?.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stdoutChunks.push(buffer);
        if (!options?.expectJson) {
          forwardCliChunk("cli.stdout", buffer, { args, attempt });
        }
      });
      child.stderr?.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        stderrChunks.push(buffer);
        forwardCliChunk("cli.stderr", buffer, { args, attempt });
      });

      const code = await new Promise<number | null>((resolveCode, reject) => {
        child.once("error", reject);
        child.once("close", resolveCode);
      });
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      const finalStderr = killedByTimeout
        ? `${stderr ? `${stderr}\n` : ""}Command timed out after ${timeoutMs}ms and was terminated${forceKilledByTimeout ? " with SIGKILL" : ""}.`
        : stderr;
      const parsed = options?.expectJson && stdout ? safeParseJson(stdout) : undefined;

      const cliMeta = {
        pid: child.pid ?? null,
        code: killedByTimeout ? 124 : code,
        durationMs: Date.now() - startedAt,
        stdoutBytes: stdout.length,
        stderrBytes: finalStderr.length,
        attempt,
        retries,
      };
      if (killedByTimeout || code !== 0) {
        logError("cli.finish", cliMeta);
      } else {
        logInfo("cli.finish", cliMeta);
      }

      return { stdout, stderr: finalStderr, code: killedByTimeout ? 124 : code, parsed };
    }

    let lastResult: { stdout: string; stderr: string; code: number | null; parsed?: unknown } | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await runOnce(attempt);
        lastResult = result;
        if ((result.code ?? 1) === 0) {
          return result;
        }
        if (attempt < retries) {
          logInfo("cli.retry.scheduled", {
            args,
            attempt,
            nextAttempt: attempt + 1,
            retryDelayMs,
            code: result.code,
          });
          await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
        }
      } catch (error) {
        lastError = error;
        logError("cli.retry.error", {
          args,
          attempt,
          retries,
          error: describeError(error),
        });
        if (attempt < retries) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
          continue;
        }
      }
    }

    if (lastResult) return lastResult;
    throw lastError instanceof Error ? lastError : new Error(describeError(lastError));
  }

  async function daemonStatus(): Promise<{ running: boolean; pid: number | null }> {
    try {
      const pid = parseInt((await readFile(daemonPidPath(), "utf-8")).trim(), 10);
      return {
        running: Number.isFinite(pid),
        pid: Number.isFinite(pid) ? pid : null,
      };
    } catch {
      return { running: false, pid: null };
    }
  }

  return {
    daemonStatus,
    spawnCli,
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
