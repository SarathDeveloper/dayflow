/**
 * The synced Password Vault's local state and its merge with the cloud. Pure:
 * no storage, no network. The server only ever sees the encrypted header and
 * encrypted login records (see lib/passwordVault.ts), in rows of
 * `dayflow_records` with collection `passwordVault`.
 *
 * Rows: `__vault` holds the header, `vault-<entry id>` one login each, and a
 * deleted login is a tombstone row. Last write wins per row on `updatedAt`,
 * like the rest of the app's sync.
 */
import {
  cleanHeader, cleanRecord, isVaultHeader, isVaultRecord, MAX_VAULT_FILE, VAULT_ENTRY_PREFIX,
} from './passwordVault';
import type { VaultHeader, VaultRecord } from './passwordVault';
import type { CloudRow, CloudRowMeta } from './cloudRecords';

export const VAULT_COLLECTION = 'passwordVault';
export const VAULT_HEADER_ROW = '__vault';
export const LOCAL_VAULT_FORMAT = 'dayflow-password-vault-local';

export interface LocalVaultState {
  format: typeof LOCAL_VAULT_FORMAT;
  version: 2;
  header: VaultHeader;
  /** Encrypted logins by row id (`vault-<entry id>`). */
  entries: Record<string, VaultRecord>;
  /** Deleted logins by row id, with the deletion time. */
  tombstones: Record<string, string>;
  /** Row ids changed on this device and not yet confirmed by the server. */
  dirty: string[];
  /** The account this vault syncs with. Unset until the first sync. */
  ownerId?: string;
  /** Newest `server_updated_at` seen, for incremental pulls. */
  cursor?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function time(iso: string | undefined | null): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : 0;
}

export function isEntryRowId(id: string): boolean {
  return id.startsWith(VAULT_ENTRY_PREFIX) && id.length > VAULT_ENTRY_PREFIX.length && id.length <= 64 + VAULT_ENTRY_PREFIX.length;
}

export function newLocalVault(header: VaultHeader): LocalVaultState {
  return {
    format: LOCAL_VAULT_FORMAT,
    version: 2,
    header: cleanHeader(header),
    entries: {},
    tombstones: {},
    dirty: [VAULT_HEADER_ROW],
  };
}

/** What the vault store holds: nothing, a pre-sync (v1) Android file, or the synced state. */
export type StoredVault =
  | { kind: 'none' }
  | { kind: 'legacy'; text: string }
  | { kind: 'synced'; state: LocalVaultState };

export function parseStoredVault(text: string | null | undefined): StoredVault {
  if (!text) return { kind: 'none' };
  if (text.length > MAX_VAULT_FILE * 2) throw new Error('The vault on this device is too large to open.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The vault on this device is damaged.');
  }
  if (isObject(value) && value.format === 'dayflow-password-vault') return { kind: 'legacy', text };
  if (!isObject(value) || value.format !== LOCAL_VAULT_FORMAT || value.version !== 2 || !isVaultHeader(value.header)) {
    throw new Error('The vault on this device is damaged or from a newer app version.');
  }
  const entries: Record<string, VaultRecord> = {};
  if (isObject(value.entries)) {
    for (const [id, record] of Object.entries(value.entries)) {
      if (isEntryRowId(id) && isVaultRecord(record)) entries[id] = cleanRecord(record);
    }
  }
  const tombstones: Record<string, string> = {};
  if (isObject(value.tombstones)) {
    for (const [id, deletedAt] of Object.entries(value.tombstones)) {
      if (isEntryRowId(id) && typeof deletedAt === 'string' && time(deletedAt) > 0) tombstones[id] = deletedAt;
    }
  }
  const dirty = Array.isArray(value.dirty)
    ? [...new Set(value.dirty.filter((id): id is string => typeof id === 'string' && (id === VAULT_HEADER_ROW || isEntryRowId(id))))]
    : [];
  return {
    kind: 'synced',
    state: {
      format: LOCAL_VAULT_FORMAT,
      version: 2,
      header: cleanHeader(value.header),
      entries,
      tombstones,
      dirty,
      ownerId: typeof value.ownerId === 'string' ? value.ownerId : undefined,
      cursor: typeof value.cursor === 'string' ? value.cursor : undefined,
    },
  };
}

export function serializeVault(state: LocalVaultState): string {
  return JSON.stringify(state);
}

function markDirty(dirty: string[], id: string): string[] {
  return dirty.includes(id) ? dirty : [...dirty, id];
}

/** Stores an edited or new login. `record.updatedAt` must be now. */
export function putVaultRecord(state: LocalVaultState, rowId: string, record: VaultRecord): LocalVaultState {
  const tombstones = { ...state.tombstones };
  delete tombstones[rowId];
  return {
    ...state,
    entries: { ...state.entries, [rowId]: cleanRecord(record) },
    tombstones,
    dirty: markDirty(state.dirty, rowId),
  };
}

export function deleteVaultRecord(state: LocalVaultState, rowId: string, deletedAt: string): LocalVaultState {
  const entries = { ...state.entries };
  delete entries[rowId];
  return {
    ...state,
    entries,
    tombstones: { ...state.tombstones, [rowId]: deletedAt },
    dirty: markDirty(state.dirty, rowId),
  };
}

export function replaceVaultHeader(state: LocalVaultState, header: VaultHeader): LocalVaultState {
  return { ...state, header: cleanHeader(header), dirty: markDirty(state.dirty, VAULT_HEADER_ROW) };
}

/** Local version of a row: the record, header or tombstone time (0 when unknown). */
export function localRowTime(state: LocalVaultState, id: string): number {
  if (id === VAULT_HEADER_ROW) return time(state.header.updatedAt);
  return Math.max(time(state.entries[id]?.updatedAt), time(state.tombstones[id]));
}

/** Rows whose data must be downloaded: live rows newer than this device's copy. */
export function vaultIdsToDownload(state: LocalVaultState | null, meta: CloudRowMeta[]): string[] {
  return meta
    .filter((row) => !row.deleted && (row.id === VAULT_HEADER_ROW || isEntryRowId(row.id)))
    .filter((row) => !state || time(row.updated_at) > localRowTime(state, row.id))
    .map((row) => row.id);
}

/** The vault header the cloud holds, if any (from downloaded rows). */
export function remoteHeader(rows: CloudRow[]): VaultHeader | null {
  const row = rows.find((item) => item.id === VAULT_HEADER_ROW && !item.deleted);
  return row && isVaultHeader(row.data) ? cleanHeader(row.data) : null;
}

/** A fresh local state made from a full pull of an account's vault. */
export function adoptRemoteVault(header: VaultHeader, meta: CloudRowMeta[], rows: CloudRow[], ownerId: string, cursor: string | undefined): LocalVaultState {
  const state: LocalVaultState = { ...newLocalVault(header), dirty: [], ownerId, cursor };
  return mergeRemoteRows(state, meta, rows).state;
}

/**
 * Applies pulled rows: per row, the newer `updatedAt` wins. A row of another
 * vault (different vault id in the header) is a conflict the caller handles,
 * so this assumes the header rows agree on the vault id. Rows this device wins
 * stay dirty; rows the server wins (or ties) are no longer dirty.
 */
export function mergeRemoteRows(
  state: LocalVaultState,
  meta: CloudRowMeta[],
  rows: CloudRow[],
): { state: LocalVaultState; changed: boolean } {
  let next = state;
  let changed = false;
  const settle = (id: string) => {
    if (next.dirty.includes(id)) next = { ...next, dirty: next.dirty.filter((item) => item !== id) };
  };

  for (const row of meta) {
    if (!row.deleted || !isEntryRowId(row.id)) continue;
    const remoteTime = time(row.updated_at);
    const localTime = localRowTime(next, row.id);
    if (remoteTime > localTime) {
      const entries = { ...next.entries };
      delete entries[row.id];
      next = { ...next, entries, tombstones: { ...next.tombstones, [row.id]: new Date(remoteTime).toISOString() } };
      changed = true;
      settle(row.id);
    } else if (remoteTime === localTime && !next.entries[row.id]) {
      settle(row.id);
    }
  }

  for (const row of rows) {
    if (row.deleted) continue;
    const remoteTime = time(row.updated_at);
    const localTime = localRowTime(next, row.id);
    if (row.id === VAULT_HEADER_ROW) {
      if (!isVaultHeader(row.data) || row.data.vaultId !== next.header.vaultId) continue;
      if (time(row.data.updatedAt) > localTime) {
        next = { ...next, header: cleanHeader(row.data) };
        changed = true;
      }
      if (time(row.data.updatedAt) >= localTime) settle(row.id);
      continue;
    }
    if (!isEntryRowId(row.id) || !isVaultRecord(row.data)) continue;
    // The row's own updatedAt is authenticated by the record's encryption; trust it over the column.
    const recordTime = time(row.data.updatedAt);
    if (recordTime !== remoteTime) continue;
    if (recordTime > localTime) {
      const tombstones = { ...next.tombstones };
      delete tombstones[row.id];
      next = { ...next, entries: { ...next.entries, [row.id]: cleanRecord(row.data) }, tombstones };
      changed = true;
    }
    if (recordTime >= localTime) settle(row.id);
  }
  return { state: next, changed };
}

/** Rows to upload for this device's unconfirmed changes. */
export function vaultPushRows(state: LocalVaultState): CloudRow[] {
  const rows: CloudRow[] = [];
  for (const id of state.dirty) {
    if (id === VAULT_HEADER_ROW) {
      rows.push({
        id,
        collection: VAULT_COLLECTION,
        data: cleanHeader(state.header) as unknown as Record<string, unknown>,
        updated_at: new Date(time(state.header.updatedAt)).toISOString(),
        deleted: false,
      });
      continue;
    }
    const record = state.entries[id];
    if (record) {
      rows.push({
        id,
        collection: VAULT_COLLECTION,
        data: cleanRecord(record) as unknown as Record<string, unknown>,
        updated_at: new Date(time(record.updatedAt)).toISOString(),
        deleted: false,
      });
    } else if (state.tombstones[id]) {
      rows.push({
        id,
        collection: VAULT_COLLECTION,
        data: null,
        updated_at: new Date(time(state.tombstones[id])).toISOString(),
        deleted: true,
      });
    }
  }
  return rows;
}

/**
 * After a push: clears dirty marks for rows whose version is still the one
 * pushed. A row edited again while the push ran stays dirty for the next sync.
 */
export function markVaultPushed(state: LocalVaultState, pushed: CloudRow[]): LocalVaultState {
  const done = new Set(
    pushed.filter((row) => localRowTime(state, row.id) === time(row.updated_at)).map((row) => row.id),
  );
  return done.size ? { ...state, dirty: state.dirty.filter((id) => !done.has(id)) } : state;
}

/** Newest `server_updated_at` among the cursor and the pulled rows. */
export function advanceVaultCursor(cursor: string | undefined, meta: CloudRowMeta[]): string | undefined {
  let best = cursor;
  for (const row of meta) {
    if (time(row.server_updated_at) > time(best)) best = row.server_updated_at;
  }
  return best;
}
