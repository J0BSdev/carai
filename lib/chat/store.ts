import { conversationTitleFromMessages } from "@/lib/chat/handoff";
import { parseChatConversation, parseChatMessages } from "@/lib/chat/parse";
import type { ChatConversation, ChatMessage, ChatSummary } from "@/lib/chat/types";
import { createClient } from "@/lib/supabase/server";

/** Local-dev only when there is no signed-in user. */
const ephemeral = new Map<string, ChatConversation>();

function previewOf(messages: ChatMessage[]): string | null {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  const text = lastUser.content.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}…`;
}

function toSummary(c: ChatConversation): ChatSummary {
  return {
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    preview: previewOf(c.messages),
  };
}

export async function listChatConversations(
  userId: string | null,
): Promise<ChatSummary[]> {
  if (!userId) {
    return [...ephemeral.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50)
      .map(toSummary);
  }

  const supabase = await createClient();
  if (!supabase) return [];

  // Preview needs messages; keep list capped so payload stays small.
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("id, title, messages, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(40);

  if (error) {
    console.error("[chat-store] list", error.message);
    throw new Error("Dohvat razgovora nije uspio.");
  }

  return (data ?? []).map((row) => {
    let messages: ChatMessage[] = [];
    try {
      messages = parseChatMessages(row.messages);
    } catch {
      messages = [];
    }
    return {
      id: row.id as string,
      title: (row.title as string) || "Novi razgovor",
      updatedAt: row.updated_at as string,
      preview: previewOf(messages),
    };
  });
}

export async function loadChatConversation(
  id: string,
  userId: string | null,
): Promise<ChatConversation | null> {
  if (!userId) {
    const row = ephemeral.get(id);
    return row ? { ...row, messages: [...row.messages] } : null;
  }

  const supabase = await createClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("chat_conversations")
    .select("id, title, messages, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[chat-store] load", error.message);
    throw new Error("Dohvat razgovora nije uspio.");
  }
  if (!data) return null;
  return parseChatConversation(data);
}

export async function saveChatConversation(
  conversation: ChatConversation,
  userId: string | null,
): Promise<ChatConversation> {
  const title =
    conversation.title.trim() ||
    conversationTitleFromMessages(conversation.messages);
  const updatedAt = new Date().toISOString();
  const next: ChatConversation = {
    ...conversation,
    title,
    updatedAt,
    messages: conversation.messages,
  };

  if (!userId) {
    ephemeral.set(next.id, next);
    return next;
  }

  const supabase = await createClient();
  if (!supabase) {
    throw new Error("Supabase nije dostupan za spremanje razgovora.");
  }

  const { error } = await supabase.from("chat_conversations").upsert(
    {
      id: next.id,
      user_id: userId,
      title: next.title,
      messages: next.messages,
      created_at: next.createdAt,
      updated_at: next.updatedAt,
    },
    { onConflict: "id" },
  );

  if (error) {
    console.error("[chat-store] save", error.message);
    throw new Error("Spremanje razgovora nije uspjelo.");
  }
  return next;
}

export async function deleteChatConversation(
  id: string,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    ephemeral.delete(id);
    return;
  }

  const supabase = await createClient();
  if (!supabase) return;

  const { error } = await supabase
    .from("chat_conversations")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    console.error("[chat-store] delete", error.message);
    throw new Error("Brisanje razgovora nije uspjelo.");
  }
}

export function resetEphemeralChats(): void {
  ephemeral.clear();
}
