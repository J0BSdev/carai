import { generateChatReply } from "@/lib/chat/engine";
import { conversationTitleFromMessages } from "@/lib/chat/handoff";
import {
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

  let conversation: ChatConversation;
  if (input.conversationId) {
    const existing = await loadChatConversation(input.conversationId, userId);
    if (!existing) {
      throw new ChatError("Razgovor nije pronađen.");
    }
    conversation = existing;
  } else {
    conversation = {
      id: crypto.randomUUID(),
      title: "Novi razgovor",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  const withUser = withUserTurn(conversation, text);

  let reply: string;
  try {
    reply = await generateChatReply(withUser.messages);
  } catch (error) {
    const saved = await saveChatConversation(withUser, userId);
    const detail =
      error instanceof Error ? error.message : "AI odgovor nije uspio.";
    throw new ChatAiError(detail, saved);
  }

  const assistantMessage = newMessage("assistant", reply);
  const completed: ChatConversation = {
    ...withUser,
    messages: [...withUser.messages, assistantMessage],
  };

  return saveChatConversation(completed, userId);
}
