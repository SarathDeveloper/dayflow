-- Dayflow cloud sync: one row per synced record, per user.
--
-- The app is local-first. Each device keeps every collection in localStorage
-- and merges record by record: the newer `updated_at` wins, and a deleted
-- record is a row with `deleted = true` (a tombstone). This table is the
-- shared copy the devices merge through.
--
-- Run this once in the Supabase SQL editor (or with `supabase db push`).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.dayflow_records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Record id from the app. Ids are unique across collections, which is what
  -- lets a tombstone (id only) delete a record without knowing its collection.
  id text not null,
  -- Which app collection the record belongs to ('tasks', 'transactions', ...,
  -- 'settings'). Null only for a tombstone of a record this server never saw.
  collection text,
  -- The record exactly as the app stores it. Null for a tombstone.
  data jsonb,
  -- The record's own updatedAt (or the deletion time for a tombstone), set by
  -- the device. This is what last-write-wins compares.
  updated_at timestamptz not null,
  deleted boolean not null default false,
  -- Set by the trigger below on every accepted write. Devices pull rows whose
  -- server_updated_at is newer than the last one they saw.
  server_updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id),
  constraint dayflow_records_id_length check (char_length(id) between 1 and 200),
  -- A live row carries the record object; a tombstone carries nothing.
  -- coalesce: a CHECK that evaluates to NULL passes, and jsonb_typeof(NULL) is NULL.
  constraint dayflow_records_tombstone_shape
    check (deleted or coalesce(jsonb_typeof(data) = 'object', false))
);

comment on table public.dayflow_records is
  'Dayflow sync: one row per app record per user, last write wins on updated_at.';

create index if not exists dayflow_records_pull_idx
  on public.dayflow_records (user_id, server_updated_at);

-- ---------------------------------------------------------------------------
-- Last write wins, enforced by the server
-- ---------------------------------------------------------------------------
-- Two devices can upsert the same record at once. Without this, whichever
-- request lands last would win even if it carried the older edit.

create schema if not exists private;

create or replace function private.dayflow_records_before_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- An older copy never replaces a newer one. Returning null skips the row.
    if new.updated_at < old.updated_at then
      return null;
    end if;
    -- Re-sending the same version is a no-op, so it does not move
    -- server_updated_at and make every device download it again.
    if new.updated_at = old.updated_at
      and new.deleted = old.deleted
      and new.data is not distinct from old.data then
      return null;
    end if;
    -- A tombstone pushed without a collection keeps the one already known.
    new.collection := coalesce(new.collection, old.collection);
    new.user_id := old.user_id;
  end if;
  if new.deleted then
    new.data := null;
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function private.dayflow_records_before_write() from public;

drop trigger if exists dayflow_records_before_write on public.dayflow_records;
create trigger dayflow_records_before_write
  before insert or update on public.dayflow_records
  for each row execute function private.dayflow_records_before_write();

-- ---------------------------------------------------------------------------
-- Access: signed-in users, their own rows only
-- ---------------------------------------------------------------------------
-- New tables are no longer exposed to the Data API automatically, so grant
-- the authenticated role explicitly. anon (signed out) gets nothing.

alter table public.dayflow_records enable row level security;

revoke all on table public.dayflow_records from anon;
grant select, insert, update, delete on table public.dayflow_records to authenticated;

drop policy if exists "Users read their own records" on public.dayflow_records;
create policy "Users read their own records"
  on public.dayflow_records for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users add their own records" on public.dayflow_records;
create policy "Users add their own records"
  on public.dayflow_records for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update their own records" on public.dayflow_records;
create policy "Users update their own records"
  on public.dayflow_records for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete their own records" on public.dayflow_records;
create policy "Users delete their own records"
  on public.dayflow_records for delete
  to authenticated
  using ((select auth.uid()) = user_id);
