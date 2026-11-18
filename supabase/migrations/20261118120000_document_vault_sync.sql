-- Dayflow Document Vault sync: encrypted documents shared between a user's devices.
--
-- Titles, file names and files are AES-GCM encrypted on the device. There is no
-- passphrase: the vault's data key travels in its header (account mode, like the
-- password vault), so documents open without an unlock step on every device the
-- user signs in to. That key is stored here too, so this is not end-to-end
-- encryption: row-level security is what keeps one account's documents private.
--
--   * public.dayflow_document_vaults: one row per user. `envelope` is the vault
--     header (id + data key) and the encrypted document index, exactly as a
--     device stores it. `attachments` lists the encrypted files the envelope
--     refers to (random ids and sizes). Devices write it with compare-and-swap on
--     `revision` (UPDATE ... WHERE revision = <the one they read>), so two devices
--     can never overwrite each other's change.
--   * Storage bucket `document-vault` (private): each encrypted file as
--     `<user id>/<attachment id>.<part>`, in parts of at most 3 MB.
--
-- Run this once in the Supabase SQL editor (or with `supabase db push`).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.dayflow_document_vaults (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  -- Random per change; matches envelope->>'revision'.
  revision text not null,
  -- The vault's random id (envelope->'header'->>'id'), so a device can tell a
  -- different vault (another passphrase) from a newer copy of its own.
  vault_id text not null,
  envelope jsonb not null,
  attachments jsonb not null default '[]'::jsonb,
  -- Set by the trigger below.
  updated_at timestamptz not null default now(),
  constraint dayflow_document_vaults_revision_shape check (revision ~ '^[A-Za-z0-9_-]{8,64}$'),
  constraint dayflow_document_vaults_vault_id_length check (char_length(vault_id) between 16 and 64),
  constraint dayflow_document_vaults_envelope_shape check (
    jsonb_typeof(envelope) = 'object' and envelope->>'revision' = revision
  ),
  constraint dayflow_document_vaults_attachments_shape check (jsonb_typeof(attachments) = 'array'),
  -- The app caps the encrypted index at a few MB; refuse anything far larger.
  constraint dayflow_document_vaults_envelope_size check (pg_column_size(envelope) <= 8 * 1024 * 1024),
  constraint dayflow_document_vaults_attachments_size check (pg_column_size(attachments) <= 1024 * 1024)
);

comment on table public.dayflow_document_vaults is
  'Dayflow Document Vault sync: one vault envelope per user (header with data key + encrypted index).';

create schema if not exists private;

create or replace function private.dayflow_document_vaults_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
  end if;
  return new;
end;
$$;

revoke all on function private.dayflow_document_vaults_touch() from public;

drop trigger if exists dayflow_document_vaults_touch on public.dayflow_document_vaults;
create trigger dayflow_document_vaults_touch
  before insert or update on public.dayflow_document_vaults
  for each row execute function private.dayflow_document_vaults_touch();

-- ---------------------------------------------------------------------------
-- Access: signed-in users, their own row only
-- ---------------------------------------------------------------------------
-- New tables are not exposed to the Data API automatically: grant the
-- authenticated role explicitly. anon (signed out) gets nothing.

alter table public.dayflow_document_vaults enable row level security;

revoke all on table public.dayflow_document_vaults from anon;
revoke all on table public.dayflow_document_vaults from authenticated;
grant select, insert, update, delete on table public.dayflow_document_vaults to authenticated;

drop policy if exists "Users read their own document vault" on public.dayflow_document_vaults;
create policy "Users read their own document vault"
  on public.dayflow_document_vaults for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users add their own document vault" on public.dayflow_document_vaults;
create policy "Users add their own document vault"
  on public.dayflow_document_vaults for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update their own document vault" on public.dayflow_document_vaults;
create policy "Users update their own document vault"
  on public.dayflow_document_vaults for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete their own document vault" on public.dayflow_document_vaults;
create policy "Users delete their own document vault"
  on public.dayflow_document_vaults for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Storage: private bucket, each user only inside the folder named after them
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('document-vault', 'document-vault', false)
on conflict (id) do nothing;

-- Upload with upsert needs INSERT + SELECT + UPDATE; listing and download need SELECT.

drop policy if exists "Users read their own document files" on storage.objects;
create policy "Users read their own document files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'document-vault'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users upload their own document files" on storage.objects;
create policy "Users upload their own document files"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'document-vault'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users replace their own document files" on storage.objects;
create policy "Users replace their own document files"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'document-vault'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'document-vault'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users delete their own document files" on storage.objects;
create policy "Users delete their own document files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'document-vault'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
