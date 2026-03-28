import { describeError, logError, logInfo } from "./service-logging.js";

export interface Job {
  readonly id: string;
  readonly type: "write-next" | "create-book" | "command" | "audit" | "revise" | "chapter-chat" | "init-assistant-chat";
  status: "running" | "done" | "error" | "cancelled";
  step: string;
  bookId?: string;
  result?: unknown;
  error?: string;
  cancelRequested?: boolean;
  abortController?: AbortController;
  createdAt: number;
}

export const jobs = new Map<string, Job>();

let cleanupInitialized = false;

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function initializeJobCleanup(): void {
  if (cleanupInitialized) return;
  cleanupInitialized = true;

  // Auto-clean jobs older than 1 hour
  setInterval(() => {
    const cutoff = Date.now() - 3600_000;
    for (const [id, job] of jobs) {
      if (job.status !== "running" && job.createdAt < cutoff) {
        logInfo("job.cleanup", { jobId: id, type: job.type, status: job.status });
        jobs.delete(id);
      }
    }
  }, 600_000);
}

export function startJob(job: Job, meta?: Record<string, unknown>): void {
  logInfo("job.start", { jobId: job.id, type: job.type, bookId: job.bookId, ...meta });
}

export function updateJobStep(job: Job, step: string, meta?: Record<string, unknown>): void {
  if (job.status !== "running") return;
  job.step = step;
  logInfo("job.step", { jobId: job.id, type: job.type, bookId: job.bookId, step, ...meta });
}

export function finishJob(job: Job, result?: Record<string, unknown>): void {
  if (job.status !== "running") return;
  job.status = "done";
  job.step = "已完成";
  logInfo("job.done", {
    jobId: job.id,
    type: job.type,
    bookId: job.bookId,
    durationMs: Date.now() - job.createdAt,
    ...result,
  });
}

export function failJob(job: Job, error: unknown): void {
  if (job.status !== "running") return;
  job.status = "error";
  job.error = describeError(error);
  job.step = "失败";
  logError("job.error", {
    jobId: job.id,
    type: job.type,
    bookId: job.bookId,
    durationMs: Date.now() - job.createdAt,
    error: job.error,
  });
}

export function cancelJob(job: Job, reason = "用户取消"): void {
  if (job.status !== "running") return;
  job.status = "cancelled";
  job.error = reason;
  job.step = "已取消";
  logInfo("job.cancelled", {
    jobId: job.id,
    type: job.type,
    bookId: job.bookId,
    durationMs: Date.now() - job.createdAt,
    reason,
  });
}

export function ensureJobAbortController(job: Job): AbortController {
  if (!job.abortController) {
    job.abortController = new AbortController();
  }
  return job.abortController;
}

export function requestJobCancellation(job: Job, reason = "用户取消"): void {
  if (job.status !== "running") return;
  job.cancelRequested = true;
  const controller = ensureJobAbortController(job);
  if (!controller.signal.aborted) {
    controller.abort(reason);
  }
  cancelJob(job, reason);
}

export function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const maybe = error as { name?: unknown; message?: unknown; code?: unknown };
    if (maybe.name === "AbortError") return true;
    if (maybe.code === "ABORT_ERR") return true;
    const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
    if (message.includes("abort")) return true;
    if (message.includes("cancel")) return true;
  }
  const text = String(error).toLowerCase();
  return text.includes("abort") || text.includes("cancel");
}

export function createJob(params: {
  readonly type: Job["type"];
  readonly step: string;
  readonly bookId?: string;
}): Job {
  const job: Job = {
    id: generateJobId(),
    type: params.type,
    status: "running",
    step: params.step,
    bookId: params.bookId,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}
