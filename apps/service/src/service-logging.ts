const LOG_STRING_PREVIEW_LIMIT = 120;
export const LOG_BUFFER_LIMIT = Math.max(parseInt(process.env.INKOS_LOG_BUFFER_LIMIT ?? "1500", 10), 200);

export const REQUEST_LOG_SKIP_PREFIXES = ["/api/jobs/", "/api/logs"] as const;

export interface ServiceLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: "INFO" | "ERROR";
  readonly event: string;
  readonly meta?: Record<string, unknown>;
}

export const serviceLogs: ServiceLogEntry[] = [];

let nextServiceLogId = 1;

export function logInfo(event: string, meta?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const safeMeta = sanitizeMeta(meta);
  appendServiceLog({ id: nextServiceLogId++, timestamp, level: "INFO", event, ...(safeMeta ? { meta: safeMeta } : {}) });
  process.stdout.write(`${timestamp} INFO ${event}${formatMeta(safeMeta)}\n`);
}

export function logError(event: string, meta?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const safeMeta = sanitizeMeta(meta);
  appendServiceLog({ id: nextServiceLogId++, timestamp, level: "ERROR", event, ...(safeMeta ? { meta: safeMeta } : {}) });
  process.stderr.write(`${timestamp} ERROR ${event}${formatMeta(safeMeta)}\n`);
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  return ` ${JSON.stringify(meta)}`;
}

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta || Object.keys(meta).length === 0) return undefined;
  const sanitized = sanitizeForLog(meta);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return undefined;
  return sanitized as Record<string, unknown>;
}

function appendServiceLog(entry: ServiceLogEntry): void {
  serviceLogs.push(entry);
  if (serviceLogs.length > LOG_BUFFER_LIMIT) {
    serviceLogs.splice(0, serviceLogs.length - LOG_BUFFER_LIMIT);
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function forwardCliChunk(event: "cli.stdout" | "cli.stderr", chunk: Buffer, meta: Record<string, unknown>): void {
  const text = chunk.toString("utf-8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    logInfo(event, { ...meta, line: trimmed });
  }
}

export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

export function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A")
    .replace(/%(7C|60|5E)/g, (match) => match.toLowerCase());
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= LOG_STRING_PREVIEW_LIMIT) return value;
    return `${value.slice(0, LOG_STRING_PREVIEW_LIMIT)}…[truncated ${value.length - LOG_STRING_PREVIEW_LIMIT} chars]`;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (/key|token|secret|password/i.test(key)) {
        return [key, "<redacted>"];
      }
      return [key, sanitizeForLog(entry)];
    }),
  );
}
