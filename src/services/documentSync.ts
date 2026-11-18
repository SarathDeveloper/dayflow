/**
 * Document Vault cloud sync: network and storage orchestration. The rules are in
 * lib/documentSync.ts; this file moves ciphertext between IndexedDB and Supabase.
 *
 * Push, pull, first upload and first download copy encrypted bytes. A merge
 * (both sides changed) opens both copies with the data key in the vault's own
 * header (version 2, no passphrase). After the stored vault changes, the device's
 * plaintext reminder schedule is rebuilt so reminders follow other devices' edits.
 * A version 1 (passphrase) vault does not sync until it is converted once.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  attachmentIds,
  decryptDocumentIndex,
  documentReminderEntries,
  openDocumentVault,
  sealDocumentIndex,
  type DocumentEnvelope,
  type StoredBlob,
} from '../lib/documentVault';
import { writeDocumentReminders } from './documentReminderStore';
import {
  blobPartCount,
  blobPartPath,
  DOCUMENT_SYNC_BUCKET,
  DOCUMENT_SYNC_TABLE,
  joinBlobParts,
  mergeDocumentIndexes,
  orphanedPartNames,
  packStoredBlob,
  planDocumentSync,
  readRemoteDocumentVault,
  splitBlobParts,
  unpackStoredBlob,
  type RemoteAttachment,
  type RemoteDocumentVault,
} from '../lib/documentSync';
import {
  applySyncedDocumentVault,
  CONFLICT_MESSAGE,
  deleteLocalDocumentVault,
  readAllBlobs,
  readBlobIds,
  readBlobs,
  readDocumentSyncState,
  readDocumentVault,
  writeDocumentSyncState,
} from './documentStorage';
import { getSupabase, isCloudConfigured, storedAccount } from './cloudSyncService';

export type DocumentSyncStatus =
  | 'synced'
  /** Signed out or no cloud in this build: documents stay on this device. */
  | 'local-only'
  /** Neither this device nor the account has a document vault. */
  | 'no-vault'
  /** The account holds a different document vault. */
  | 'conflict'
  /** This device's vault syncs with another account. */
  | 'other-account'
  /** This device's vault still uses a passphrase: enter it once to convert it. */
  | 'needs-upgrade'
  /** Network or server failure; changes stay here and sync later. */
  | 'offline';

export interface DocumentSyncResult {
  status: DocumentSyncStatus;
  /** True when this sync changed the vault stored on this device. */
  changed: boolean;
  message?: string;
}

/** Fired on `window` after a sync changed the vault stored on this device. */
export const DOCUMENT_VAULT_CHANGED_EVENT = 'dayflow:document-vault-changed';

const MAX_ROUNDS = 4;
const LIST_PAGE = 1000;

let running: Promise<DocumentSyncResult> | null = null;
let again = false;

class RetrySync extends Error {}

function requireClient(): SupabaseClient {
  const client = getSupabase();
  if (!client) throw new Error('Cloud sync is not configured in this build.');
  return client;
}

const NOT_SET_UP_MESSAGE = 'Document sync is not set up on the server yet.';

/** True when the server lacks the table or bucket (the migration has not been run). */
function isNotSetUp(error: unknown): boolean {
  const value = error as { message?: unknown; code?: unknown } | null;
  const message = typeof value?.message === 'string' ? value.message : '';
  return value?.code === 'PGRST205' || /dayflow_document_vaults/.test(message) || /bucket not found/i.test(message);
}

function describe(error: unknown): string {
  if (isNotSetUp(error)) return NOT_SET_UP_MESSAGE;
  const value = error as { message?: unknown } | null;
  return typeof value?.message === 'string' ? value.message : String(error);
}

function notifyChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DOCUMENT_VAULT_CHANGED_EVENT));
}

/**
 * Syncs the document vault with the signed-in account. Safe to call often: calls
 * made while one runs share a single follow-up run.
 */
export function syncDocumentVault(): Promise<DocumentSyncResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let result: DocumentSyncResult;
    let changed = false;
    do {
      again = false;
      result = await syncRounds();
      changed ||= result.changed;
    } while (again);
    if (changed) notifyChanged();
    return { ...result, changed };
  })().finally(() => {
    running = null;
  });
  return running;
}

async function syncRounds(): Promise<DocumentSyncResult> {
  let changed = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      const result = await syncOnce();
      return { ...result, changed: changed || result.changed };
    } catch (error) {
      if (error instanceof RetrySync) {
        changed ||= error.message === 'changed';
        continue;
      }
      // This device saved a change while the sync ran: start over from the new copy.
      if (error instanceof Error && error.message === CONFLICT_MESSAGE) continue;
      // Without the server side, documents simply stay on this device.
      if (isNotSetUp(error)) return { status: 'local-only', changed, message: NOT_SET_UP_MESSAGE };
      return { status: 'offline', changed, message: describe(error) };
    }
  }
  return { status: 'offline', changed, message: 'The document vault kept changing during sync. It will try again.' };
}

async function syncOnce(): Promise<DocumentSyncResult> {
  const userId = storedAccount()?.id;
  if (!isCloudConfigured() || !userId) return { status: 'local-only', changed: false };
  const client = requireClient();

  const [local, meta] = await Promise.all([readDocumentVault(), readDocumentSyncState()]);
  if (local?.version === 1) {
    return { status: 'needs-upgrade', changed: false, message: "Enter the vault's old passphrase once to start syncing it." };
  }
  const remote = await fetchRemote(client, userId);
  const plan = planDocumentSync({
    userId,
    local: local ? { revision: local.revision, vaultId: local.header.id } : null,
    meta,
    remote: remote ? { revision: remote.revision, vaultId: remote.envelope.header.id } : null,
  });

  switch (plan) {
    case 'idle':
      return { status: 'no-vault', changed: false };
    case 'other-account':
      return { status: 'other-account', changed: false };
    case 'conflict':
      return { status: 'conflict', changed: false, message: 'Your account already has a different document vault.' };
    case 'in-sync':
      if (meta?.ownerId !== userId || meta.syncedRevision !== local!.revision) {
        await writeDocumentSyncState({ ownerId: userId, syncedRevision: local!.revision }, local!.revision);
      }
      return { status: 'synced', changed: false };
    case 'adopt':
    case 'pull': {
      const have = plan === 'adopt' ? new Set<string>() : await readBlobIds();
      const missing = remote!.attachments.filter((item) => !have.has(item.id));
      const putBlobs = await downloadBlobs(client, userId, missing);
      await applySyncedDocumentVault({
        envelope: remote!.envelope,
        expectedRevision: plan === 'adopt' ? null : local!.revision,
        putBlobs,
        keepIds: new Set(remote!.attachments.map((item) => item.id)),
        meta: { ownerId: userId, syncedRevision: remote!.revision },
      });
      await refreshReminders(remote!.envelope);
      return { status: 'synced', changed: true };
    }
    case 'create':
    case 'push': {
      const manifest = await manifestOf(local!);
      await uploadMissing(client, userId, manifest, remote?.attachments ?? []);
      const pushed = await writeRemote(client, userId, local!, manifest, plan === 'create' ? null : remote!.revision);
      if (!pushed) throw new RetrySync();
      await writeDocumentSyncState({ ownerId: userId, syncedRevision: local!.revision }, local!.revision);
      void deleteOrphans(client, userId, new Set(manifest.map((item) => item.id))).catch(() => undefined);
      return { status: 'synced', changed: false };
    }
    case 'merge': {
      await mergeIntoLocal(client, userId, local!, remote!);
      // The merged vault is now stored here with the server's revision as base: the next round pushes it.
      throw new RetrySync('changed');
    }
  }
}

async function mergeIntoLocal(client: SupabaseClient, userId: string, local: DocumentEnvelope, remote: RemoteDocumentVault): Promise<void> {
  const { key, index: localIndex } = await openDocumentVault(local);
  const remoteIndex = await decryptDocumentIndex(key, remote.envelope);
  const merged = mergeDocumentIndexes(localIndex, remoteIndex);
  const sealed = await sealDocumentIndex({ key, envelope: local, index: localIndex }, merged);
  const keepIds = attachmentIds(merged);
  const have = await readBlobIds();
  const needed = remote.attachments.filter((item) => keepIds.has(item.id) && !have.has(item.id));
  const putBlobs = await downloadBlobs(client, userId, needed);
  await applySyncedDocumentVault({
    envelope: sealed,
    expectedRevision: local.revision,
    putBlobs,
    keepIds,
    meta: { ownerId: userId, syncedRevision: remote.revision },
  });
  writeReminders(merged);
}

/** Rebuilds this device's reminder schedule from a vault that just arrived. Best effort. */
async function refreshReminders(envelope: DocumentEnvelope): Promise<void> {
  if (envelope.version !== 2) return;
  try {
    writeReminders((await openDocumentVault(envelope)).index);
  } catch {
    // The schedule is rebuilt again the next time the Documents screen opens the vault.
  }
}

function writeReminders(index: Parameters<typeof documentReminderEntries>[0]): void {
  try {
    writeDocumentReminders({ version: 1, showTitles: index.showReminderTitles, entries: documentReminderEntries(index) });
  } catch {
    // Same as above.
  }
}

/* ------------------------------------------------------------------ */
/* Conflict resolution                                                 */
/* ------------------------------------------------------------------ */

/** Drops this device's vault and downloads the account's. Make a backup first. */
export async function switchToAccountDocumentVault(expectedRevision: string): Promise<DocumentSyncResult> {
  await deleteLocalDocumentVault(expectedRevision);
  notifyChanged();
  return syncDocumentVault();
}

/** Replaces the account's vault with this device's (other devices then switch to it). */
export async function replaceAccountDocumentVault(): Promise<DocumentSyncResult> {
  const userId = storedAccount()?.id;
  if (!isCloudConfigured() || !userId) return { status: 'local-only', changed: false };
  try {
    const client = requireClient();
    const local = await readDocumentVault();
    if (!local) return { status: 'no-vault', changed: false };
    const remote = await fetchRemote(client, userId);
    const manifest = await manifestOf(local);
    await uploadMissing(client, userId, manifest, []);
    const pushed = await writeRemote(client, userId, local, manifest, remote ? remote.revision : null);
    if (!pushed) return { status: 'offline', changed: false, message: 'The account vault changed meanwhile. Try again.' };
    await writeDocumentSyncState({ ownerId: userId, syncedRevision: local.revision }, local.revision);
    void deleteOrphans(client, userId, new Set(manifest.map((item) => item.id))).catch(() => undefined);
    return { status: 'synced', changed: false };
  } catch (error) {
    return { status: 'offline', changed: false, message: describe(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

async function fetchRemote(client: SupabaseClient, userId: string): Promise<RemoteDocumentVault | null> {
  const { data, error } = await client
    .from(DOCUMENT_SYNC_TABLE)
    .select('revision, envelope, attachments')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? readRemoteDocumentVault(data) : null;
}

/** Writes the envelope; compare-and-swap on `expectedRevision` (null: no row yet). False when another device won. */
async function writeRemote(
  client: SupabaseClient,
  userId: string,
  envelope: DocumentEnvelope,
  attachments: RemoteAttachment[],
  expectedRevision: string | null,
): Promise<boolean> {
  const values = {
    revision: envelope.revision,
    vault_id: envelope.header.id,
    envelope,
    attachments,
  };
  if (expectedRevision === null) {
    const { error } = await client.from(DOCUMENT_SYNC_TABLE).insert({ user_id: userId, ...values });
    if (!error) return true;
    if (error.code === '23505') return false;
    throw error;
  }
  const { data, error } = await client
    .from(DOCUMENT_SYNC_TABLE)
    .update(values)
    .eq('user_id', userId)
    .eq('revision', expectedRevision)
    .select('revision');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

/**
 * The files `envelope` refers to: the stored files, read while the stored vault is
 * still `envelope` (the store holds exactly the current envelope's files).
 */
async function manifestOf(envelope: DocumentEnvelope): Promise<RemoteAttachment[]> {
  const blobs = await readAllBlobs();
  const latest = await readDocumentVault();
  if (latest?.revision !== envelope.revision) throw new RetrySync();
  return [...blobs].map(([id, blob]) => ({ id, bytes: 12 + blob.ciphertext.length })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Uploads every file of `manifest` the server copy does not list yet. */
async function uploadMissing(client: SupabaseClient, userId: string, manifest: RemoteAttachment[], remote: RemoteAttachment[]): Promise<void> {
  const known = new Set(remote.map((item) => item.id));
  for (const { id } of manifest.filter((item) => !known.has(item.id))) {
    const blob = (await readBlobs([id])).get(id);
    // Deleted by a save made meanwhile: that save changed the vault, so start over.
    if (!blob) throw new RetrySync();
    const parts = splitBlobParts(packStoredBlob(blob));
    for (let part = 0; part < parts.length; part++) {
      const { error } = await client.storage
        .from(DOCUMENT_SYNC_BUCKET)
        .upload(blobPartPath(userId, id, part), parts[part], { upsert: true, contentType: 'application/octet-stream' });
      if (error) throw error;
    }
  }
}

async function downloadBlobs(client: SupabaseClient, userId: string, items: RemoteAttachment[]): Promise<Map<string, StoredBlob>> {
  const blobs = new Map<string, StoredBlob>();
  for (const item of items) {
    const parts: Uint8Array[] = [];
    for (let part = 0; part < blobPartCount(item.bytes); part++) {
      const { data, error } = await client.storage.from(DOCUMENT_SYNC_BUCKET).download(blobPartPath(userId, item.id, part));
      if (error) throw error;
      parts.push(new Uint8Array(await data.arrayBuffer()));
    }
    blobs.set(item.id, unpackStoredBlob(joinBlobParts(parts, item.bytes)));
  }
  return blobs;
}

/** Best effort: removes files no current revision uses (after a grace period). */
async function deleteOrphans(client: SupabaseClient, userId: string, keep: Set<string>): Promise<void> {
  const objects: { name: string; created_at?: string | null }[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await client.storage
      .from(DOCUMENT_SYNC_BUCKET)
      .list(userId, { limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    objects.push(...data.filter((item) => item.id !== null));
    if (data.length < LIST_PAGE) break;
  }
  const names = orphanedPartNames(objects, keep, Date.now());
  for (let index = 0; index < names.length; index += 100) {
    const batch = names.slice(index, index + 100).map((name) => `${userId}/${name}`);
    const { error } = await client.storage.from(DOCUMENT_SYNC_BUCKET).remove(batch);
    if (error) throw error;
  }
}
