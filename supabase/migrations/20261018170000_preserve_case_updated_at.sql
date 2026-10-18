-- Keep updated_at when a row update does not change the diagnostic case.
-- Apply after 20261018160000_case_list_fields.sql.
-- List-column backfill and opening a saved case no longer stamp a new time.
-- A real change to case_data or problem_text still sets updated_at to now().

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
