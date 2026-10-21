-- Optimistic concurrency + short turn lock for server-authoritative diagnose.
-- Apply after 20261018190000_diagnosis_certainty_column.sql.

alter table public.diagnostic_cases
  add column if not exists case_version integer not null default 0;

alter table public.diagnostic_cases
  add column if not exists turn_lock_step_id text;

alter table public.diagnostic_cases
  add column if not exists turn_lock_until timestamptz;

alter table public.diagnostic_cases
  drop constraint if exists diagnostic_cases_case_version_nonneg;

alter table public.diagnostic_cases
  add constraint diagnostic_cases_case_version_nonneg
  check (case_version >= 0);
