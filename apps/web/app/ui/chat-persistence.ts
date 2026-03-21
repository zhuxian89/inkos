export type ChatPersistenceMode = "browser" | "postgres";

let cachedMode: ChatPersistenceMode | null = null;

export async function resolveChatPersistenceMode(): Promise<ChatPersistenceMode> {
  if (cachedMode) return cachedMode;
  try {
    const response = await fetch("/api/inkos/project/config", { cache: "no-store" });
    const data = await response.json();
    cachedMode = data?.config?.chatPersistence?.mode === "postgres" ? "postgres" : "browser";
    return cachedMode;
  } catch {
    cachedMode = "browser";
    return cachedMode;
  }
}

export async function loadPersistedChatSession(scope: string, sessionKey: string): Promise<any[] | null> {
  const mode = await resolveChatPersistenceMode();
  if (mode !== "postgres") return null;
  const response = await fetch(`/api/inkos/chat-sessions/${encodeURIComponent(scope)}/${encodeURIComponent(sessionKey)}`, { cache: "no-store" });
  const data = await response.json();
  return Array.isArray(data?.session?.messages) ? data.session.messages : [];
}

export async function savePersistedChatSession(scope: string, sessionKey: string, payload: Record<string, unknown>): Promise<void> {
  const mode = await resolveChatPersistenceMode();
  if (mode !== "postgres") return;
  await fetch(`/api/inkos/chat-sessions/${encodeURIComponent(scope)}/${encodeURIComponent(sessionKey)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function clearPersistedChatSession(scope: string, sessionKey: string): Promise<void> {
  const mode = await resolveChatPersistenceMode();
  if (mode !== "postgres") return;
  await fetch(`/api/inkos/chat-sessions/${encodeURIComponent(scope)}/${encodeURIComponent(sessionKey)}`, {
    method: "DELETE",
  });
}
