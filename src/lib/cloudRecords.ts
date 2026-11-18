/**
 * Pure translation between the app's sync envelope and rows of the Supabase
 * table `public.dayflow_records` (see supabase/migrations). No network here.
 *
 * One row per record, keyed by record id. A deleted record is a row with
 * `deleted = true` (a tombstone). Notification settings ride along as one row
 * with id `__settings`. Last write wins on `updated_at`, both in the app merge
 * and in the server trigger, so the two always agree.
 */
import type { NotificationSettings } from '../types';
import { DATA_SCHEMA_VERSION, type SyncData, type SyncEnvelope } from './persistence';
import { isStarterOnlyTaskList, preferRealTaskLists } from './singleProfile';
import { mergeEnvelopes, recordTimestamp } from './syncMerge';

export type RecordCollection = Exclude<keyof SyncData, 'settings'>;

/** Every synced collection. A new one must be added here and to SyncData. */
export const RECORD_COLLECTIONS: readonly RecordCollection[] = [
  'tasks',
  'categories',
  'transactions',
  'accounts',
  'ledgerSettings',
  'budgets',
  'categoryBudgets',
  'financeCategories',
  'debts',
  'savingsGoals',
  'savingsEntries',
  'goals',
  'habits',
  'habitCheckIns',
  'alarms',
  'diaryEntries',
  'focusSessions',
  'maintenanceItems',
  'billTemplates',
  'billPayments',
];

export const SETTINGS_COLLECTION = 'settings';
export const SETTINGS_ROW_ID = '__settings';

/** Look back this far on each pull, so a row committed late is not skipped. */
export const PULL_OVERLAP_MS = 60_000;

/** A row as the app writes it. `user_id` and `server_updated_at` belong to the server. */
export interface CloudRow {
  id: string;
  collection: string | null;
  data: Record<string, unknown> | null;
  updated_at: string;
  deleted: boolean;
}

/** The small part of a row a pull reads first, to decide what to download. */
export interface CloudRowMeta {
  id: string;
  collection: string | null;
  updated_at: string;
  deleted: boolean;
  server_updated_at: string;
}

const KNOWN_COLLECTIONS = new Set<string>(RECORD_COLLECTIONS);

/**
 * A row of a collection this envelope does not carry, such as the password
 * vault, which syncs its encrypted rows itself (lib/passwordVaultSync.ts).
 * A tombstone pushed without a collection (null) is still the envelope's.
 */
function isForeignRow(row: { id: string; collection: string | null }): boolean {
  return row.id !== SETTINGS_ROW_ID && row.collection !== null && !KNOWN_COLLECTIONS.has(row.collection);
}

function toTime(iso: string | undefined | null): number {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(time) ? time : 0;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** Newest version this device holds for each id: records, tombstones and settings. */
export function localVersions(envelope: SyncEnvelope): Map<string, number> {
  const versions = new Map<string, number>();
  const note = (id: string, time: number) => {
    const existing = versions.get(id);
    if (existing === undefined || time > existing) versions.set(id, time);
  };
  for (const collection of RECORD_COLLECTIONS) {
    for (const record of envelope.data[collection] ?? []) {
      note(record.id, recordTimestamp(record));
    }
  }
  for (const [id, deletedAt] of Object.entries(envelope.tombstones)) {
    note(id, toTime(deletedAt));
  }
  note(SETTINGS_ROW_ID, toTime(envelope.settingsUpdatedAt));
  return versions;
}

/**
 * Ids whose full row must be downloaded: live rows newer than what this device
 * holds. Tombstones need no download (the metadata is the whole tombstone), and
 * rows of a collection this app version does not know are left alone.
 */
export function idsToDownload(rows: CloudRowMeta[], local: Map<string, number>): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.deleted) continue;
    const known = row.id === SETTINGS_ROW_ID || (row.collection !== null && KNOWN_COLLECTIONS.has(row.collection));
    if (!known) continue;
    const localTime = local.get(row.id);
    if (localTime === undefined || toTime(row.updated_at) > localTime) ids.push(row.id);
  }
  return ids;
}

/** Server version of each id seen in a pull, so a push can skip what the server already has. */
export function serverVersions(rows: CloudRowMeta[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const row of rows) versions.set(row.id, toTime(row.updated_at));
  return versions;
}

function emptyData(settings: NotificationSettings): SyncData {
  const data = { settings } as SyncData;
  for (const collection of RECORD_COLLECTIONS) {
    (data as unknown as Record<string, unknown[]>)[collection] = [];
  }
  return data;
}

/**
 * Turn pulled rows into a (usually partial) remote envelope for `mergeEnvelopes`.
 * Collections and records absent from `rows` stay as they are locally. Without
 * a settings row, the local settings win (remote settings time is empty).
 */
export function rowsToEnvelope(rows: Array<CloudRow | CloudRowMeta>, local: SyncEnvelope): SyncEnvelope {
  const data = emptyData(local.data.settings);
  const tombstones: Record<string, string> = {};
  let settingsUpdatedAt = '';

  for (const row of rows) {
    if (row.deleted) {
      // Collections synced on their own (the password vault) keep their tombstones.
      if (row.id !== SETTINGS_ROW_ID && !isForeignRow(row)) tombstones[row.id] = iso(toTime(row.updated_at));
      continue;
    }
    const value = 'data' in row ? row.data : null;
    if (!value || typeof value !== 'object') continue;
    if (row.id === SETTINGS_ROW_ID) {
      data.settings = { ...local.data.settings, ...(value as Partial<NotificationSettings>) };
      settingsUpdatedAt = iso(toTime(row.updated_at));
      continue;
    }
    if (row.collection === null || !KNOWN_COLLECTIONS.has(row.collection)) continue;
    const list = (data as unknown as Record<string, unknown[]>)[row.collection];
    // The row id is the key the server enforces; trust it over the payload.
    list.push({ ...value, id: row.id });
  }

  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    deviceId: 'cloud',
    updatedAt: new Date().toISOString(),
    settingsUpdatedAt,
    tombstones,
    data,
  };
}

/**
 * Rows this device should upload: everything saved after the last push (or
 * everything, on the first push), minus versions the server already has.
 *
 * - An untouched sample day (only `task-1..5`) is never uploaded, so a fresh
 *   install cannot push the starter tasks into an account that has real ones.
 * - A tombstone is skipped when the same id lives on with a newer save.
 * - Settings that were never edited (no timestamp) are not uploaded.
 */
export function buildPushRows(
  envelope: SyncEnvelope,
  pushedSince: string | undefined,
  server: Map<string, number>,
): CloudRow[] {
  const since = pushedSince ? toTime(pushedSince) : Number.NEGATIVE_INFINITY;
  const rows = new Map<string, CloudRow>();
  const liveTimes = new Map<string, number>();
  const skipTasks = isStarterOnlyTaskList(envelope.data.tasks ?? []);

  for (const collection of RECORD_COLLECTIONS) {
    if (collection === 'tasks' && skipTasks) continue;
    for (const record of envelope.data[collection] ?? []) {
      const time = recordTimestamp(record);
      liveTimes.set(record.id, Math.max(time, liveTimes.get(record.id) ?? time));
      if (time <= since || server.get(record.id) === time) continue;
      const previous = rows.get(record.id);
      if (previous && toTime(previous.updated_at) >= time) continue;
      rows.set(record.id, {
        id: record.id,
        collection,
        data: record as unknown as Record<string, unknown>,
        updated_at: iso(time),
        deleted: false,
      });
    }
  }

  for (const [id, deletedAt] of Object.entries(envelope.tombstones)) {
    const time = Date.parse(deletedAt);
    if (!Number.isFinite(time) || time <= since || server.get(id) === time) continue;
    const live = liveTimes.get(id);
    if (live !== undefined && live >= time) continue;
    rows.set(id, { id, collection: null, data: null, updated_at: iso(time), deleted: true });
  }

  const settingsTime = toTime(envelope.settingsUpdatedAt);
  if (settingsTime > 0 && settingsTime > since && server.get(SETTINGS_ROW_ID) !== settingsTime) {
    rows.set(SETTINGS_ROW_ID, {
      id: SETTINGS_ROW_ID,
      collection: SETTINGS_COLLECTION,
      data: envelope.data.settings as unknown as Record<string, unknown>,
      updated_at: iso(settingsTime),
      deleted: false,
    });
  }

  return [...rows.values()];
}

/**
 * Split rows into upload batches of roughly `maxChars` of JSON. A single large
 * row (a diary note with photos) still goes alone rather than being dropped.
 */
export function chunkRows(rows: CloudRow[], maxChars = 900_000, maxRows = 500): CloudRow[][] {
  const chunks: CloudRow[][] = [];
  let current: CloudRow[] = [];
  let size = 0;
  for (const row of rows) {
    const rowSize = JSON.stringify(row).length;
    if (current.length > 0 && (size + rowSize > maxChars || current.length >= maxRows)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += rowSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Where the next pull starts: a little before the newest row seen, or everything. */
export function pullStart(cursor: string | undefined, overlapMs = PULL_OVERLAP_MS): string | null {
  if (!cursor) return null;
  const time = Date.parse(cursor);
  return Number.isFinite(time) ? iso(time - overlapMs) : null;
}

/** The newest `server_updated_at` among the cursor and the pulled rows. */
export function advanceCursor(cursor: string | undefined, rows: CloudRowMeta[]): string | undefined {
  let best = cursor;
  let bestTime = cursor ? toTime(cursor) : Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const time = toTime(row.server_updated_at);
    if (time > bestTime) {
      best = row.server_updated_at;
      bestTime = time;
    }
  }
  return best;
}

function sortedEntries(record: Record<string, string>): string {
  return JSON.stringify(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** True when applying `next` would not change what this device stores. */
export function sameSnapshot(current: SyncEnvelope, next: SyncEnvelope): boolean {
  return (
    current.settingsUpdatedAt === next.settingsUpdatedAt &&
    sortedEntries(current.tombstones) === sortedEntries(next.tombstones) &&
    JSON.stringify(current.data) === JSON.stringify(next.data)
  );
}

/**
 * First sync after the app opens for `userId`. A device last synced with a
 * different account is only opened by that account after the person confirmed
 * replacing this device's data at sign-in, so the cloud copy replaces it.
 */
export function initialSyncMode(lastUserId: string | undefined, userId: string): 'merge' | 'switch-account' {
  return lastUserId && lastUserId !== userId ? 'switch-account' : 'merge';
}

/** True when signing in as `userId` would replace another account's data on this device. */
export function isAccountSwitch(lastUserId: string | undefined, userId: string): boolean {
  return initialSyncMode(lastUserId, userId) === 'switch-account';
}

/**
 * One merge sync, minus the network: fold what was pulled into the local
 * envelope and work out what to upload. `rows` are the full rows downloaded
 * for `idsToDownload(meta, ...)`; tombstones come straight from `meta`.
 */
export function reconcile(
  local: SyncEnvelope,
  pulled: { meta: CloudRowMeta[]; rows: CloudRow[] },
  pushedSince: string | undefined,
): { merged: SyncEnvelope; remote: SyncEnvelope; push: CloudRow[] } {
  const remote = rowsToEnvelope([...pulled.meta.filter((row) => row.deleted), ...pulled.rows], local);
  // Drop this device's untouched sample day when the account has real tasks.
  const paired = preferRealTaskLists(local, remote);
  const merged = mergeEnvelopes(paired.left, paired.right);
  const push = buildPushRows(merged, pushedSince, serverVersions(pulled.meta));
  return { merged, remote, push };
}

/**
 * Restore: the cloud copy replaces this device. Local records and deletions
 * that never reached the cloud are dropped. Settings stay local only when the
 * cloud has none. Returns null when the cloud holds nothing to restore, unless
 * `allowEmpty` (switching to an account that has no data yet).
 */
export function restoreFromRows(
  local: SyncEnvelope,
  pulled: { meta: CloudRowMeta[]; rows: CloudRow[] },
  options: { allowEmpty?: boolean } = {},
): SyncEnvelope | null {
  if (!options.allowEmpty && !pulled.meta.some((row) => !row.deleted && !isForeignRow(row))) return null;
  const remote = rowsToEnvelope([...pulled.meta.filter((row) => row.deleted), ...pulled.rows], local);
  return {
    ...remote,
    deviceId: local.deviceId,
    settingsUpdatedAt: remote.settingsUpdatedAt || local.settingsUpdatedAt,
  };
}
