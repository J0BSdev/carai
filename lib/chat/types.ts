export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

export type ChatConversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  /** Optimistic-concurrency counter; bumped on every successful save. */
  revision: number;
};

export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: string;
  preview: string | null;
};
