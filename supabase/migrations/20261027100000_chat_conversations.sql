-- Free-form CarAI chat conversations. RLS by owner.
-- Apply after 20261021200000_turn_lock_token.sql.

create table if not exists public.chat_conversations (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Novi razgovor',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_conversations_title_len
    check (octet_length(title) <= 200),
  constraint chat_conversations_messages_size
    check (octet_length(messages::text) <= 400000)
);

create index if not exists chat_conversations_user_updated_idx
  on public.chat_conversations (user_id, updated_at desc);

alter table public.chat_conversations enable row level security;

create policy chat_conversations_select_own
  on public.chat_conversations
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy chat_conversations_insert_own
  on public.chat_conversations
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy chat_conversations_update_own
  on public.chat_conversations
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy chat_conversations_delete_own
  on public.chat_conversations
  for delete
  to authenticated
  using (auth.uid() = user_id);

revoke all on table public.chat_conversations from public, anon;
grant select, insert, update, delete on table public.chat_conversations to authenticated;
