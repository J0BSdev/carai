-- Unique token per turn lock so only the holder can commit or release.
-- Apply after 20261021100000_case_version_turn_lock.sql.

alter table public.diagnostic_cases
  add column if not exists turn_lock_token text;
