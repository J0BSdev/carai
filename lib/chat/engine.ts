import { getClaudeApiKey, getDiagnosticModel } from "@/lib/diagnosis/config";
import { callAnthropicChat } from "@/lib/diagnosis/providers";
import { CHAT_SYSTEM_PROMPT } from "@/lib/chat/prompts";
import type { ChatMessage } from "@/lib/chat/types";

/** Keep API context bounded; full history stays in storage. */
const MAX_API_MESSAGES = 40;

/**
 * Anthropic Messages API requires alternating user/assistant, starting with user.
 * Merge consecutive same-role turns so a partial save cannot break the call.
 */
function forAnthropicApi(
  history: ChatMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const slice = history.slice(-MAX_API_MESSAGES);
  const merged: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of slice) {
    const content = message.content.trim();
    if (!content) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === message.role) {
      prev.content = `${prev.content}\n\n${content}`;
      continue;
    }
    merged.push({ role: message.role, content });
  }

  while (merged.length > 0 && merged[0]?.role !== "user") {
    merged.shift();
  }

  return merged;
}

export async function generateChatReply(
  history: ChatMessage[],
): Promise<string> {
  const apiKey = getClaudeApiKey();
  if (!apiKey) {
    throw new Error("Claude API ključ nije konfiguriran.");
  }

  const messages = forAnthropicApi(history);
  if (messages.length === 0 || messages[messages.length - 1]?.role !== "user") {
    throw new Error("Nema korisničke poruke za odgovor.");
  }

  const text = await callAnthropicChat({
    apiKey,
    model: getDiagnosticModel(),
    system: CHAT_SYSTEM_PROMPT,
    messages,
    maxTokens: 4096,
  });

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Claude nije vratio odgovor.");
  }
  return trimmed;
}
