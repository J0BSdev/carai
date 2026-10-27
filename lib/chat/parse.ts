import type { ChatConversation, ChatMessage, ChatRole } from "@/lib/chat/types";

const ROLES = new Set<ChatRole>(["user", "assistant"]);

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Poruka nije valjana.");
  }
  return value as Record<string, unknown>;
}

export function parseChatMessage(value: unknown): ChatMessage {
  const raw = asObject(value);
  const role = raw.role;
  if (typeof role !== "string" || !ROLES.has(role as ChatRole)) {
    throw new Error("Uloga poruke nije valjana.");
  }
  const content = raw.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Sadržaj poruke nije valjan.");
  }
  const id = raw.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("ID poruke nije valjan.");
  }
  const createdAt = raw.createdAt;
  if (typeof createdAt !== "string" || !createdAt.trim()) {
    throw new Error("Vrijeme poruke nije valjano.");
  }
  return {
    id,
    role: role as ChatRole,
    content: content.trim(),
    createdAt,
  };
}

export function parseChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) throw new Error("Poruke nisu valjane.");
  return value.map(parseChatMessage);
}

export function parseChatConversation(row: {
  id: string;
  title: string;
  messages: unknown;
  created_at: string;
  updated_at: string;
  revision?: number | null;
}): ChatConversation {
  const revision =
    typeof row.revision === "number" && Number.isInteger(row.revision)
      ? row.revision
      : 0;
  return {
    id: row.id,
    title: row.title?.trim() || "Novi razgovor",
    messages: parseChatMessages(row.messages),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision,
  };
}
