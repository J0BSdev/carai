-- Profiles and diagnostic cases. Photos and base64 are rejected.
-- Apply once in the Supabase SQL editor, or with `supabase db push`.
-- Trigger helpers live in `private` so they are not Data API endpoints.

create schema if not exists private;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create table public.diagnostic_cases (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  problem_text text not null,
  case_data jsonb not null,
  constraint diagnostic_cases_problem_text_len check (octet_length(problem_text) <= 20000),
  constraint diagnostic_cases_no_image_text check (position('data:image/' in problem_text) = 0)
);

create index diagnostic_cases_user_updated_idx
  on public.diagnostic_cases (user_id, updated_at desc);

alter table public.profiles enable row level security;
alter table public.diagnostic_cases enable row level security;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy diagnostic_cases_select_own
  on public.diagnostic_cases
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy diagnostic_cases_insert_own
  on public.diagnostic_cases
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy diagnostic_cases_update_own
  on public.diagnostic_cases
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy diagnostic_cases_delete_own
  on public.diagnostic_cases
  for delete
  to authenticated
  using (auth.uid() = user_id);

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_user();

create or replace function private.strip_media_keys(payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  entry_key text;
  entry_value jsonb;
  result jsonb;
begin
  if payload is null then
    return 'null'::jsonb;
  elsif jsonb_typeof(payload) = 'object' then
    result := '{}'::jsonb;
    for entry_key, entry_value in
      select item.key, item.value
      from jsonb_each(payload) as item
    loop
      if entry_key in (
        'image', 'images', 'photo', 'photos', 'base64',
        'image_url', 'dataUrl', 'mediaType', 'media_type'
      ) then
        continue;
      end if;
      result := result || jsonb_build_object(entry_key, private.strip_media_keys(entry_value));
    end loop;
    return result;
  elsif jsonb_typeof(payload) = 'array' then
    result := '[]'::jsonb;
    for entry_value in
      select item.value
      from jsonb_array_elements(payload) as item
    loop
      result := result || jsonb_build_array(private.strip_media_keys(entry_value));
    end loop;
    return result;
  elsif jsonb_typeof(payload) = 'string' and left(payload #>> '{}', 11) = 'data:image/' then
    raise exception 'images are not stored';
  else
    return payload;
  end if;
end;
$$;

create or replace function private.prepare_diagnostic_case()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A signed-in API request has auth.uid(). The SQL editor does not.
  if auth.uid() is not null and new.user_id is distinct from auth.uid() then
    raise exception 'case user mismatch';
  end if;
  if tg_op = 'UPDATE'
    and auth.uid() is not null
    and new.user_id is distinct from old.user_id
  then
    raise exception 'case user mismatch';
  end if;
  new.case_data := private.strip_media_keys(new.case_data);
  if tg_op = 'UPDATE'
    and new.case_data is not distinct from old.case_data
    and new.problem_text is not distinct from old.problem_text
  then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  if octet_length(new.case_data::text) > 400000 then
    raise exception 'case is too large';
  end if;
  if position('data:image/' in new.problem_text) > 0 then
    raise exception 'images are not stored';
  end if;
  return new;
end;
$$;

create trigger diagnostic_cases_prepare
  before insert or update on public.diagnostic_cases
  for each row
  execute function private.prepare_diagnostic_case();

revoke all on schema private from public, anon;
grant usage on schema private to authenticated, supabase_auth_admin;

revoke all on table public.profiles from public, anon;
revoke all on table public.diagnostic_cases from public, anon;
grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.diagnostic_cases to authenticated;

revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.strip_media_keys(jsonb) from public, anon, authenticated;
revoke all on function private.prepare_diagnostic_case() from public, anon, authenticated;
grant execute on function private.handle_new_user() to supabase_auth_admin;
grant execute on function private.strip_media_keys(jsonb) to authenticated;
grant execute on function private.prepare_diagnostic_case() to authenticated;
