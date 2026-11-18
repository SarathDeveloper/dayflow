-- Dayflow crash reports: one row per distinct client error.
--
-- Written by src/services/errorReporter.ts (rules in src/lib/errorReport.ts).
-- A row holds only the scrubbed error text and stack, the screen's path, the
-- app version and the platform: no app data. Signed-in users may insert rows
-- for themselves; nobody can read, change or delete them through the API.
-- Read them in the Supabase dashboard (SQL editor), e.g.:
--
--   select message, count(*), max(created_at), array_agg(distinct app_version)
--   from public.dayflow_client_errors
--   where created_at > now() - interval '7 days'
--   group by message order by count(*) desc;

create table if not exists public.dayflow_client_errors (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  kind text not null,
  message text not null,
  stack text,
  path text not null,
  app_version text not null,
  platform text not null,
  constraint dayflow_client_errors_kind check (kind in ('render', 'error', 'rejection')),
  -- Same limits as src/lib/errorReport.ts.
  constraint dayflow_client_errors_message_length check (char_length(message) between 1 and 500),
  constraint dayflow_client_errors_stack_length check (stack is null or char_length(stack) <= 4000),
  constraint dayflow_client_errors_path_length check (char_length(path) <= 200),
  constraint dayflow_client_errors_version_length check (char_length(app_version) <= 100),
  constraint dayflow_client_errors_platform_length check (char_length(platform) <= 50)
);

comment on table public.dayflow_client_errors is
  'Dayflow crash reports from signed-in clients. Insert-only through the API.';

create index if not exists dayflow_client_errors_created_at
  on public.dayflow_client_errors (created_at desc);
create index if not exists dayflow_client_errors_user_id
  on public.dayflow_client_errors (user_id);

alter table public.dayflow_client_errors enable row level security;

revoke all on public.dayflow_client_errors from anon, authenticated;
grant insert (kind, message, stack, path, app_version, platform)
  on public.dayflow_client_errors to authenticated;

drop policy if exists "Users report their own errors" on public.dayflow_client_errors;
create policy "Users report their own errors"
  on public.dayflow_client_errors for insert
  to authenticated
  with check (user_id = (select auth.uid()));

-- At most 50 reports per user per hour, so a crash loop or a misbehaving
-- client cannot fill the table.
create or replace function public.dayflow_client_errors_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    select count(*) from public.dayflow_client_errors
    where user_id = new.user_id and created_at > now() - interval '1 hour'
  ) >= 50 then
    return null; -- drop the row quietly
  end if;
  return new;
end;
$$;

revoke all on function public.dayflow_client_errors_rate_limit() from public, anon, authenticated;

drop trigger if exists dayflow_client_errors_rate_limit on public.dayflow_client_errors;
create trigger dayflow_client_errors_rate_limit
  before insert on public.dayflow_client_errors
  for each row execute function public.dayflow_client_errors_rate_limit();
