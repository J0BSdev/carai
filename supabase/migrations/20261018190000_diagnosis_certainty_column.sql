-- List column for FINISH diagnosisCertainty without loading case_data.
-- Apply after 20261018180000_case_source.sql.
-- The prepare trigger keeps the column in sync with case_data + source.
-- Backfill does not change case_data or problem_text, so updated_at stays.

alter table public.diagnostic_cases
  add column if not exists diagnosis_certainty text;

alter table public.diagnostic_cases
  drop constraint if exists diagnostic_cases_diagnosis_certainty_check;

alter table public.diagnostic_cases
  add constraint diagnostic_cases_diagnosis_certainty_check
  check (
    diagnosis_certainty is null
    or diagnosis_certainty in (
      'SUSPECTED',
      'LIKELY',
      'HIGH_CONFIDENCE',
      'CONFIRMED'
    )
  );

create or replace function private.prepare_diagnostic_case()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  last_step jsonb;
  certainty text;
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

  -- Derive list certainty from the open step. Manual and ASK/TEST stay null.
  if coalesce(new.source, 'carai') = 'manual' then
    new.diagnosis_certainty := null;
  else
    last_step := null;
    certainty := null;
    if jsonb_typeof(new.case_data -> 'steps') = 'array'
      and jsonb_array_length(new.case_data -> 'steps') > 0
    then
      last_step := new.case_data -> 'steps'
        -> (jsonb_array_length(new.case_data -> 'steps') - 1);
      if last_step ->> 'actionType' = 'FINISH' then
        certainty := last_step ->> 'diagnosisCertainty';
        if certainty in (
          'SUSPECTED',
          'LIKELY',
          'HIGH_CONFIDENCE',
          'CONFIRMED'
        ) then
          new.diagnosis_certainty := certainty;
        else
          new.diagnosis_certainty := null;
        end if;
      else
        new.diagnosis_certainty := null;
      end if;
    else
      new.diagnosis_certainty := null;
    end if;
  end if;

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

update public.diagnostic_cases as c
set diagnosis_certainty = case
  when c.source = 'manual' then null
  when last_step.step ->> 'actionType' = 'FINISH'
    and last_step.step ->> 'diagnosisCertainty' in (
      'SUSPECTED',
      'LIKELY',
      'HIGH_CONFIDENCE',
      'CONFIRMED'
    )
  then last_step.step ->> 'diagnosisCertainty'
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
