-- Separate list columns for a saved diagnostic case.
-- Apply after 20261018120000_profiles_and_diagnostic_cases.sql.
-- Replaces the row trigger so this script can update rows without a user JWT.
-- RLS and the signed-in user_id checks stay in place.

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

alter table public.diagnostic_cases
  add column if not exists vehicle_make text,
  add column if not exists vehicle_model text,
  add column if not exists vehicle_year integer,
  add column if not exists vehicle_engine text,
  add column if not exists confirmed_fault text,
  add column if not exists status text not null default 'active';

alter table public.diagnostic_cases drop constraint if exists diagnostic_cases_status_check;
alter table public.diagnostic_cases
  add constraint diagnostic_cases_status_check
  check (status in ('active', 'finished'));

alter table public.diagnostic_cases drop constraint if exists diagnostic_cases_vehicle_year_check;
alter table public.diagnostic_cases
  add constraint diagnostic_cases_vehicle_year_check
  check (vehicle_year is null or vehicle_year between 1900 and 2100);

alter table public.diagnostic_cases drop constraint if exists diagnostic_cases_vehicle_make_len;
alter table public.diagnostic_cases
  add constraint diagnostic_cases_vehicle_make_len
  check (vehicle_make is null or octet_length(vehicle_make) <= 200);

alter table public.diagnostic_cases drop constraint if exists diagnostic_cases_vehicle_model_len;
alter table public.diagnostic_cases
  add constraint diagnostic_cases_vehicle_model_len
  check (vehicle_model is null or octet_length(vehicle_model) <= 200);

alter table public.diagnostic_cases drop constraint if exists diagnostic_cases_vehicle_engine_len;
alter table public.diagnostic_cases
  add constraint diagnostic_cases_vehicle_engine_len
  check (vehicle_engine is null or octet_length(vehicle_engine) <= 200);

alter table public.diagnostic_cases drop constraint if exists diagnostic_cases_confirmed_fault_len;
alter table public.diagnostic_cases
  add constraint diagnostic_cases_confirmed_fault_len
  check (confirmed_fault is null or octet_length(confirmed_fault) <= 4000);

alter table public.diagnostic_cases drop constraint if exists diagnostic_cases_no_image_fields;
alter table public.diagnostic_cases
  add constraint diagnostic_cases_no_image_fields
  check (
    position('data:image/' in coalesce(vehicle_make, '')) = 0
    and position('data:image/' in coalesce(vehicle_model, '')) = 0
    and position('data:image/' in coalesce(vehicle_engine, '')) = 0
    and position('data:image/' in coalesce(confirmed_fault, '')) = 0
  );

update public.diagnostic_cases as c
set
  vehicle_make = nullif(btrim(c.case_data #>> '{extracted,vehicle,make}'), ''),
  vehicle_model = nullif(btrim(c.case_data #>> '{extracted,vehicle,model}'), ''),
  vehicle_engine = nullif(btrim(c.case_data #>> '{extracted,vehicle,engine}'), ''),
  vehicle_year = case
    when (c.case_data #>> '{extracted,vehicle,year}') ~ '^[0-9]{4}$'
      and (c.case_data #>> '{extracted,vehicle,year}')::integer between 1900 and 2100
    then (c.case_data #>> '{extracted,vehicle,year}')::integer
    else null
  end,
  status = case
    when last_step.step ->> 'actionType' = 'FINISH' then 'finished'
    else 'active'
  end,
  confirmed_fault = case
    when last_step.step ->> 'actionType' = 'FINISH'
    then nullif(btrim(last_step.step ->> 'confirmedFault'), '')
    else null
  end
from (
  select
    id,
    case
      when jsonb_typeof(case_data -> 'steps') = 'array'
        and jsonb_array_length(case_data -> 'steps') > 0
      then case_data -> 'steps' -> (jsonb_array_length(case_data -> 'steps') - 1)
      else null
    end as step
  from public.diagnostic_cases
) as last_step
where c.id = last_step.id;
