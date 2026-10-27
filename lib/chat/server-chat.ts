import { generateChatReply } from "@/lib/chat/engine";
import { conversationTitleFromMessages } from "@/lib/chat/handoff";
import {
  ChatConflictError,
  loadChatConversation,
  saveChatConversation,
} from "@/lib/chat/store";
import type { ChatConversation, ChatMessage } from "@/lib/chat/types";
import type { UsageAccess } from "@/lib/access";

const MAX_MESSAGE_CHARS = 8000;
const MAX_MESSAGES = 200;

export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatError";
  }
}

/** Claude failed after the user turn was saved — client should keep conversationId. */
export class ChatAiError extends Error {
  conversation: ChatConversation;
  constructor(message: string, conversation: ChatConversation) {
    super(message);
    this.name = "ChatAiError";
    this.conversation = conversation;
  }
}

export { ChatConflictError };

function userIdOf(access: UsageAccess & { ok: true }): string | null {
  return access.user?.id ?? null;
}

function newMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Ensure history ends ready for a new user turn.
 * If the last message is a lone user (Claude failed last time), replace it
 * instead of appending a second user message (Anthropic rejects that).
 */
function withUserTurn(
  conversation: ChatConversation,
  text: string,
): ChatConversation {
  const last = conversation.messages[conversation.messages.length - 1];
  const userMessage = newMessage("user", text);

  if (last?.role === "user") {
    return {
      ...conversation,
      messages: [...conversation.messages.slice(0, -1), userMessage],
      title:
        conversation.messages.length <= 1
          ? conversationTitleFromMessages([userMessage])
          : conversation.title,
    };
  }

  if (conversation.messages.length >= MAX_MESSAGES) {
    throw new ChatError("Razgovor je dosegnuo maksimalan broj poruka.");
  }

  return {
    ...conversation,
    messages: [...conversation.messages, userMessage],
    title:
      conversation.messages.length === 0
        ? conversationTitleFromMessages([userMessage])
        : conversation.title,
  };
}

export async function chatSend(input: {
  conversationId?: string;
  message: string;
  access: UsageAccess & { ok: true };
}): Promise<ChatConversation> {
  const text = input.message.trim();
  if (!text) {
    throw new ChatError("Poruka ne smije biti prazna.");
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new ChatError("Poruka je predugačka.");
  }

  const userId = userIdOf(input.access);
  const now = new Date().toISOString();

  let base: ChatConversation;
  let claimExpected: number | null;

  if (input.conversationId) {
    const existing = await loadChatConversation(input.conversationId, userId);
    if (!existing) {
      throw new ChatError("Razgovor nije pronađen.");
    }
    base = existing;
    claimExpected = existing.revision;
  } else {
    base = {
      id: crypto.randomUUID(),
      title: "Novi razgovor",
      messages: [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
    claimExpected = null;
  }

  const withUser = withUserTurn(base, text);

  // Claim the next turn before Claude so a concurrent request cannot overwrite.
  let claimed: ChatConversation;
  try {
    claimed = await saveChatConversation(withUser, userId, claimExpected);
  } catch (error) {
    if (error instanceof ChatConflictError) throw error;
    throw error;
  }

  let reply: string;
  try {
    reply = await generateChatReply(claimed.messages);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "AI odgovor nije uspio.";
    throw new ChatAiError(detail, claimed);
  }

  const assistantMessage = newMessage("assistant", reply);
  const completed: ChatConversation = {
    ...claimed,
    messages: [...claimed.messages, assistantMessage],
  };

  // Second CAS: attach assistant reply. Conflict here means another writer won —
  // user turn is already durable; do not pretend the assistant message was saved.
  return saveChatConversation(completed, userId, claimed.revision);
}
