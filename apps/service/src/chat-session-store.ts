import { Pool } from "pg";
import { loadProjectConfig } from "./runtime.js";

export interface ChatSessionRecord {
  readonly scope: "chapter-chat" | "book-chat" | "profile-chat";
  readonly sessionKey: string;
  readonly bookId?: string;
  readonly chapterNumber?: number;
  readonly profileId?: string;
  readonly title?: string;
  readonly messages: unknown;
  readonly meta?: Record<string, unknown>;
}

export function createChatSessionStore(projectRoot: string): {
  loadChatSession: (scope: ChatSessionRecord["scope"], sessionKey: string) => Promise<ChatSessionRecord | null>;
  saveChatSession: (record: ChatSessionRecord) => Promise<void>;
  deleteChatSession: (scope: ChatSessionRecord["scope"], sessionKey: string) => Promise<void>;
} {
  let chatPersistencePool: Pool | null = null;

  async function getChatPersistencePool(): Promise<Pool | null> {
    const config = await loadProjectConfig(projectRoot);
    if (config.chatPersistence?.mode !== "postgres" || !config.chatPersistence.postgres?.connectionString?.trim()) {
      return null;
    }
    if (!chatPersistencePool) {
      chatPersistencePool = new Pool({ connectionString: config.chatPersistence.postgres.connectionString.trim() });
    }
    return chatPersistencePool;
  }

  async function ensureChatSessionsTable(pool: Pool, tableName: string): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id BIGSERIAL PRIMARY KEY,
        scope TEXT NOT NULL,
        session_key TEXT NOT NULL,
        book_id TEXT,
        chapter_number INTEGER,
        profile_id TEXT,
        title TEXT,
        messages_json JSONB NOT NULL,
        meta_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(scope, session_key)
      )
    `);
  }

  async function resolveChatSessionsTable(): Promise<{ pool: Pool; tableName: string } | null> {
    const config = await loadProjectConfig(projectRoot);
    if (config.chatPersistence?.mode !== "postgres" || !config.chatPersistence.postgres?.connectionString?.trim()) {
      return null;
    }
    const pool = await getChatPersistencePool();
    if (!pool) return null;
    const rawPrefix = config.chatPersistence.postgres.tablePrefix?.trim() ?? "";
    const safePrefix = rawPrefix.replace(/[^a-zA-Z0-9_]/g, "");
    const tableName = `${safePrefix}chat_sessions`;
    await ensureChatSessionsTable(pool, tableName);
    return { pool, tableName };
  }

  async function loadChatSession(scope: ChatSessionRecord["scope"], sessionKey: string): Promise<ChatSessionRecord | null> {
    const resolved = await resolveChatSessionsTable();
    if (!resolved) return null;
    const { pool, tableName } = resolved;
    const result = await pool.query(`SELECT * FROM ${tableName} WHERE scope = $1 AND session_key = $2 LIMIT 1`, [scope, sessionKey]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      scope: row.scope,
      sessionKey: row.session_key,
      bookId: row.book_id ?? undefined,
      chapterNumber: row.chapter_number ?? undefined,
      profileId: row.profile_id ?? undefined,
      title: row.title ?? undefined,
      messages: row.messages_json,
      meta: row.meta_json ?? undefined,
    };
  }

  async function saveChatSession(record: ChatSessionRecord): Promise<void> {
    const resolved = await resolveChatSessionsTable();
    if (!resolved) return;
    const { pool, tableName } = resolved;
    await pool.query(
      `INSERT INTO ${tableName} (scope, session_key, book_id, chapter_number, profile_id, title, messages_json, meta_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
       ON CONFLICT (scope, session_key)
       DO UPDATE SET book_id = EXCLUDED.book_id,
                     chapter_number = EXCLUDED.chapter_number,
                     profile_id = EXCLUDED.profile_id,
                     title = EXCLUDED.title,
                     messages_json = EXCLUDED.messages_json,
                     meta_json = EXCLUDED.meta_json,
                     updated_at = NOW()`,
      [
        record.scope,
        record.sessionKey,
        record.bookId ?? null,
        record.chapterNumber ?? null,
        record.profileId ?? null,
        record.title ?? null,
        JSON.stringify(record.messages ?? []),
        JSON.stringify(record.meta ?? {}),
      ],
    );
  }

  async function deleteChatSession(scope: ChatSessionRecord["scope"], sessionKey: string): Promise<void> {
    const resolved = await resolveChatSessionsTable();
    if (!resolved) return;
    const { pool, tableName } = resolved;
    await pool.query(`DELETE FROM ${tableName} WHERE scope = $1 AND session_key = $2`, [scope, sessionKey]);
  }

  return {
    loadChatSession,
    saveChatSession,
    deleteChatSession,
  };
}
