"use server";

import {
  deleteChatConversation,
  listChatConversations,
  loadChatConversation,
} from "@/lib/chat/store";
import type { ChatConversation, ChatSummary } from "@/lib/chat/types";
import { createClient } from "@/lib/supabase/server";

export type ChatStoreFailure = {
  ok: false;
  code: "UNAUTHENTICATED" | "NOT_FOUND" | "FAILED";
  message: string;
};

export type ChatStoreResult<T> = { ok: true; data: T } | ChatStoreFailure;

/** Signed-in user id, or null for local ephemeral chats. */
async function chatUserId(): Promise<string | null> {
  const supabase = await createClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getClaims();
  const id = data?.claims?.sub;
  if (error || !id) return null;
  return id;
}

export async function listChats(): Promise<ChatStoreResult<ChatSummary[]>> {
  try {
    const data = await listChatConversations(await chatUserId());
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      code: "FAILED",
      message: "Dohvat razgovora nije uspio.",
    };
  }
}

export async function loadChat(
  id: string,
): Promise<ChatStoreResult<ChatConversation>> {
  try {
    const data = await loadChatConversation(id, await chatUserId());
    if (!data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Razgovor nije pronađen.",
      };
    }
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      code: "FAILED",
      message: "Dohvat razgovora nije uspio.",
    };
  }
}

export async function deleteChat(
  id: string,
): Promise<ChatStoreResult<{ id: string }>> {
  try {
    await deleteChatConversation(id, await chatUserId());
    return { ok: true, data: { id } };
  } catch {
    return {
      ok: false,
      code: "FAILED",
      message: "Brisanje razgovora nije uspjelo.",
    };
  }
}
