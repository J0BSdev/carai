import type { ChatMessage } from "@/lib/chat/types";

/**
 * Build intake text for structured diagnosis from the chat.
 * Only user statements are included — assistant guesses are never treated as facts.
 */
export function diagnosisHandoffText(messages: ChatMessage[]): string {
  const userParts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean);

  if (userParts.length === 0) return "";

  const body = userParts.join("\n\n");
  return [
    "Podaci koje je mehaničar naveo u razgovoru (samo korisničke izjave).",
    "AI pretpostavke iz chata nisu potvrđene činjenice.",
    "",
    body,
  ].join("\n");
}

export function conversationTitleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content.trim();
  if (!first) return "Novi razgovor";
  const oneLine = first.replace(/\s+/g, " ");
  if (oneLine.length <= 60) return oneLine;
  return `${oneLine.slice(0, 57).trimEnd()}…`;
}
