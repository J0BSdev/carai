-- Optimistic concurrency for chat saves (prevents silent message loss).
-- Apply after 20261027100000_chat_conversations.sql.

alter table public.chat_conversations
  add column if not exists revision integer not null default 0;

alter table public.chat_conversations
  drop constraint if exists chat_conversations_revision_nonneg;

alter table public.chat_conversations
  add constraint chat_conversations_revision_nonneg
  check (revision >= 0);
