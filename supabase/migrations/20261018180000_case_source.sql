-- Distinguish CarAI diagnosis rows from manual resolved faults.
-- Apply after 20261018170000_preserve_case_updated_at.sql.
-- Existing rows stay carai. Manual rows use source = manual and do not store AI steps.

alter table public.diagnostic_cases
  add column if not exists source text not null default 'carai';

alter table public.diagnostic_cases drop constraint if exists diagnostic_cases_source_check;
alter table public.diagnostic_cases
  add constraint diagnostic_cases_source_check
  check (source in ('carai', 'manual'));
