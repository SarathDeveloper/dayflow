import { describe, expect, it } from 'vitest';
import {
  createVault, createVaultHeader, entryRowId, exportVaultFile, migrateVaultFile, openVault, openVaultRecord,
  readVaultFile, rewrapVaultHeader, sealEntries, sealVaultRecord, unlockVaultHeader,
} from './passwordVault';
import type { VaultHeader, VaultRecord } from './passwordVault';
import {
  adoptRemoteVault, advanceVaultCursor, deleteVaultRecord, markVaultPushed, mergeRemoteRows, newLocalVault,
  parseStoredVault, putVaultRecord, remoteHeader, serializeVault, VAULT_COLLECTION, VAULT_HEADER_ROW,
  vaultIdsToDownload, vaultPushRows,
} from './passwordVaultSync';
import type { LocalVaultState } from './passwordVaultSync';
import type { CloudRow, CloudRowMeta } from './cloudRecords';

const passphrase = 'a strong example passphrase';
const replacement = 'a different example passphrase';
const entry = {
  id: 'entry-1',
  title: 'Bank',
  website: 'https://bank.example',
  username: 'me',
  password: 'secret password',
  notes: '',
};
const T1 = '2026-11-18T10:00:00.000Z';
const T2 = '2026-11-18T11:00:00.000Z';
const T3 = '2026-11-18T12:00:00.000Z';

function header(vaultId: string, updatedAt = T1): VaultHeader {
  return {
    vaultId,
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    wrappedKey: { nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(64) },
    updatedAt,
  };
}
const VAULT_A = 'QUFBQUFBQUFBQUFBQUFBQQ==';
const VAULT_B = 'QkJCQkJCQkJCQkJCQkJCQg==';

function record(updatedAt: string, fill = 'A'): VaultRecord {
  return { nonce: 'AAAAAAAAAAAAAAAA', ciphertext: fill.repeat(40), updatedAt };
}

function meta(id: string, updatedAt: string, deleted = false, serverAt = updatedAt): CloudRowMeta {
  return { id, collection: VAULT_COLLECTION, updated_at: updatedAt, deleted, server_updated_at: serverAt };
}

function row(id: string, data: unknown, updatedAt: string): CloudRow {
  return { id, collection: VAULT_COLLECTION, data: data as Record<string, unknown>, updated_at: updatedAt, deleted: false };
}

function synced(state: LocalVaultState): LocalVaultState {
  return { ...state, dirty: [], ownerId: 'user-1' };
}

describe('synced password vault crypto', () => {
  it('seals one login per record, bound to its row, vault and time', async () => {
    const { header: made, key } = await createVaultHeader(passphrase, T1);
    const sealed = await sealVaultRecord(made.vaultId, key, entry, T2);
    const rowId = entryRowId(entry.id);
    expect(JSON.stringify(sealed)).not.toContain(entry.password);
    await expect(openVaultRecord(made.vaultId, key, rowId, sealed)).resolves.toEqual(entry);
    // Moved to another row, re-dated by the server, or put in another vault: rejected.
    await expect(openVaultRecord(made.vaultId, key, entryRowId('other'), sealed)).rejects.toThrow('could not be decrypted');
    await expect(openVaultRecord(made.vaultId, key, rowId, { ...sealed, updatedAt: T3 })).rejects.toThrow('could not be decrypted');
    await expect(openVaultRecord(VAULT_B, key, rowId, sealed)).rejects.toThrow('could not be decrypted');

    // A passphrase change keeps the data key, so existing records still open.
    const rewrapped = await rewrapVaultHeader(made, passphrase, replacement, T3);
    expect(rewrapped.vaultId).toBe(made.vaultId);
    expect(rewrapped.salt).not.toBe(made.salt);
    await expect(unlockVaultHeader(rewrapped, passphrase)).rejects.toThrow('incorrect');
    const newKey = await unlockVaultHeader(rewrapped, replacement);
    await expect(openVaultRecord(made.vaultId, newKey, rowId, sealed)).resolves.toEqual(entry);
    await expect(rewrapVaultHeader(made, replacement, 'another long passphrase', T3)).rejects.toThrow('incorrect');
  }, 60_000);

  it('migrates a v1 file with the same key and exports a v1 backup any version restores', async () => {
    const { file, key } = await createVault(passphrase);
    file.entries = await sealEntries(file.id, key, [entry]);
    const migrated = await migrateVaultFile(readVaultFile(JSON.stringify(file)), passphrase, T2);
    expect(migrated.header).toMatchObject({ vaultId: file.id, salt: file.salt, wrappedKey: file.wrappedKey, updatedAt: T2 });
    expect(migrated.entries).toEqual([entry]);
    await expect(unlockVaultHeader(migrated.header, passphrase)).resolves.toBeTruthy();

    const exported = await exportVaultFile(migrated.header, migrated.key, [entry]);
    const reopened = await openVault(readVaultFile(JSON.stringify(exported)), passphrase);
    expect(reopened.entries).toEqual([entry]);
  }, 60_000);
});

describe('synced password vault state', () => {
  it('parses what it serializes and tells a v1 file apart', () => {
    const state = putVaultRecord(newLocalVault(header(VAULT_A)), 'vault-a', record(T2));
    expect(parseStoredVault(serializeVault(state))).toEqual({ kind: 'synced', state });
    expect(parseStoredVault(null)).toEqual({ kind: 'none' });
    expect(parseStoredVault('{"format":"dayflow-password-vault","version":1}').kind).toBe('legacy');
    expect(() => parseStoredVault('{"format":"dayflow-password-vault-local","version":3}')).toThrow('damaged');
    expect(() => parseStoredVault('not json')).toThrow('damaged');
  });

  it('drops malformed records and ids instead of trusting them', () => {
    const text = JSON.stringify({
      ...newLocalVault(header(VAULT_A)),
      entries: { 'vault-ok': record(T1), 'not-a-vault-row': record(T1), 'vault-bad': { nonce: 'x' } },
      tombstones: { 'vault-gone': T2, 'vault-bad-time': 'never' },
      dirty: ['vault-ok', 'tasks-1', 7],
    });
    const parsed = parseStoredVault(text);
    if (parsed.kind !== 'synced') throw new Error('expected synced');
    expect(Object.keys(parsed.state.entries)).toEqual(['vault-ok']);
    expect(parsed.state.tombstones).toEqual({ 'vault-gone': T2 });
    expect(parsed.state.dirty).toEqual(['vault-ok']);
  });

  it('pushes only unconfirmed changes, deletes as tombstones', () => {
    let state = synced(newLocalVault(header(VAULT_A)));
    state = putVaultRecord(state, 'vault-a', record(T2));
    state = deleteVaultRecord(state, 'vault-b', T3);
    const rows = vaultPushRows(state);
    expect(rows).toEqual([
      { id: 'vault-a', collection: VAULT_COLLECTION, data: record(T2), updated_at: T2, deleted: false },
      { id: 'vault-b', collection: VAULT_COLLECTION, data: null, updated_at: T3, deleted: true },
    ]);
    expect(markVaultPushed(state, rows).dirty).toEqual([]);
  });

  it('keeps a row dirty when it was edited again while the push ran', () => {
    let state = synced(newLocalVault(header(VAULT_A)));
    state = putVaultRecord(state, 'vault-a', record(T1));
    const pushed = vaultPushRows(state);
    state = putVaultRecord(state, 'vault-a', record(T2, 'B'));
    expect(markVaultPushed(state, pushed).dirty).toEqual(['vault-a']);
  });

  it('merges per login: the newer side wins and both devices’ edits survive', () => {
    let local = synced(newLocalVault(header(VAULT_A)));
    local = putVaultRecord(local, 'vault-mine', record(T2, 'M'));
    local = { ...local, entries: { ...local.entries, 'vault-shared': record(T3, 'L') } };
    const pulled = [
      meta('vault-theirs', T2),
      meta('vault-shared', T2),
    ];
    const rows = [row('vault-theirs', record(T2, 'T'), T2), row('vault-shared', record(T2, 'R'), T2)];
    expect(vaultIdsToDownload(local, pulled)).toEqual(['vault-theirs']);
    const { state, changed } = mergeRemoteRows(local, pulled, rows);
    expect(changed).toBe(true);
    expect(state.entries['vault-theirs']).toEqual(record(T2, 'T'));
    expect(state.entries['vault-shared']).toEqual(record(T3, 'L'));
    expect(state.entries['vault-mine']).toEqual(record(T2, 'M'));
    expect(state.dirty).toEqual(['vault-mine']);
  });

  it('applies a newer remote delete and ignores an older one', () => {
    let local = synced(newLocalVault(header(VAULT_A)));
    local = { ...local, entries: { 'vault-old': record(T1), 'vault-new': record(T3) } };
    const { state } = mergeRemoteRows(local, [meta('vault-old', T2, true), meta('vault-new', T2, true)], []);
    expect(state.entries['vault-old']).toBeUndefined();
    expect(state.tombstones['vault-old']).toBe(T2);
    expect(state.entries['vault-new']).toEqual(record(T3));
  });

  it('a local delete beats an older remote edit and clears once the server has it', () => {
    let local = synced(newLocalVault(header(VAULT_A)));
    local = deleteVaultRecord({ ...local, entries: { 'vault-x': record(T1) } }, 'vault-x', T3);
    const older = mergeRemoteRows(local, [meta('vault-x', T2)], [row('vault-x', record(T2), T2)]);
    expect(older.state.entries['vault-x']).toBeUndefined();
    expect(older.state.dirty).toEqual(['vault-x']);
    const confirmed = mergeRemoteRows(local, [meta('vault-x', T3, true)], []);
    expect(confirmed.state.dirty).toEqual([]);
  });

  it('rejects a remote record whose column time differs from its sealed time', () => {
    const local = synced(newLocalVault(header(VAULT_A)));
    const { state } = mergeRemoteRows(local, [meta('vault-x', T3)], [row('vault-x', record(T2), T3)]);
    expect(state.entries['vault-x']).toBeUndefined();
  });

  it('takes a newer header of the same vault only', () => {
    const local = synced(newLocalVault(header(VAULT_A, T1)));
    const newer = mergeRemoteRows(local, [meta(VAULT_HEADER_ROW, T2)], [row(VAULT_HEADER_ROW, header(VAULT_A, T2), T2)]);
    expect(newer.state.header.updatedAt).toBe(T2);
    const other = mergeRemoteRows(local, [meta(VAULT_HEADER_ROW, T3)], [row(VAULT_HEADER_ROW, header(VAULT_B, T3), T3)]);
    expect(other.state.header.vaultId).toBe(VAULT_A);
    expect(other.changed).toBe(false);
  });

  it('adopts an account vault from a full pull', () => {
    const pulled = [meta(VAULT_HEADER_ROW, T1, false, T1), meta('vault-a', T2, false, T2), meta('vault-b', T2, true, T3)];
    const rows = [row(VAULT_HEADER_ROW, header(VAULT_A), T1), row('vault-a', record(T2), T2)];
    const head = remoteHeader(rows);
    expect(head?.vaultId).toBe(VAULT_A);
    const adopted = adoptRemoteVault(head!, pulled, rows, 'user-1', advanceVaultCursor(undefined, pulled));
    expect(adopted).toMatchObject({ ownerId: 'user-1', cursor: T3, dirty: [] });
    expect(Object.keys(adopted.entries)).toEqual(['vault-a']);
    expect(adopted.tombstones).toEqual({ 'vault-b': T2 });
  });
});
