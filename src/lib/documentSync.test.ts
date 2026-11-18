import { describe, expect, it } from 'vitest';
import {
  BLOB_PART_BYTES,
  blobPartCount,
  blobPartPath,
  joinBlobParts,
  mergeDocumentIndexes,
  orphanedPartNames,
  ORPHAN_GRACE_MS,
  packStoredBlob,
  planDocumentSync,
  readDocumentSyncMeta,
  readRemoteAttachments,
  readRemoteDocumentVault,
  splitBlobParts,
  unpackStoredBlob,
} from './documentSync';
import type { DocumentEnvelope, DocumentIndex, VaultDocument } from './documentVault';
import { bytesToBase64 } from './passwordVault';

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const T1 = '2026-11-10T10:00:00.000Z';
const T2 = '2026-11-11T10:00:00.000Z';
const T3 = '2026-11-12T10:00:00.000Z';

function random(length: number): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(length)));
}

function envelope(revision: string): DocumentEnvelope {
  return {
    format: 'dayflow-documents',
    version: 1,
    revision,
    header: {
      format: 'dayflow-password-vault',
      version: 1,
      id: random(16),
      salt: random(16),
      wrappedKey: { nonce: random(12), ciphertext: random(48) },
      entries: { nonce: random(12), ciphertext: random(18) },
    },
    index: { nonce: random(12), ciphertext: random(64) },
  };
}

function doc(id: string, updatedAt: string, title = id): VaultDocument {
  return {
    id,
    title,
    category: 'Identity',
    reminderDays: [30],
    reminderKey: `key-${id}`.padEnd(16, '0'),
    currentRevisionId: `rev-${id}`,
    revisions: [{
      id: `rev-${id}`, filename: `${id}.pdf`, mimeType: 'application/pdf', size: 100, attachmentId: `att-${id}`, addedAt: T1,
    }],
    createdAt: T1,
    updatedAt,
  };
}

function index(documents: VaultDocument[], extra: Partial<DocumentIndex> = {}): DocumentIndex {
  return { version: 1, showReminderTitles: false, documents, ...extra };
}

describe('planDocumentSync', () => {
  const local = { revision: 'local-rev-1', vaultId: 'vault-a' };
  const remote = (revision: string, vaultId = 'vault-a') => ({ revision, vaultId });

  it('adopts, creates or idles when one side is missing', () => {
    expect(planDocumentSync({ userId: USER, local: null, meta: null, remote: null })).toBe('idle');
    expect(planDocumentSync({ userId: USER, local: null, meta: null, remote: remote('r1') })).toBe('adopt');
    expect(planDocumentSync({ userId: USER, local, meta: null, remote: null })).toBe('create');
  });

  it('tells who changed from the last matched revision', () => {
    const meta = { ownerId: USER, syncedRevision: 'base-rev-1' };
    expect(planDocumentSync({ userId: USER, local, meta, remote: remote('local-rev-1') })).toBe('in-sync');
    expect(planDocumentSync({ userId: USER, local: { ...local, revision: 'base-rev-1' }, meta, remote: remote('remote-rev') })).toBe('pull');
    expect(planDocumentSync({ userId: USER, local, meta, remote: remote('base-rev-1') })).toBe('push');
    expect(planDocumentSync({ userId: USER, local, meta, remote: remote('remote-rev') })).toBe('merge');
    // Never synced before but both have the same vault: combine them.
    expect(planDocumentSync({ userId: USER, local, meta: null, remote: remote('remote-rev') })).toBe('merge');
  });

  it('refuses another vault or another account', () => {
    expect(planDocumentSync({ userId: USER, local, meta: null, remote: remote('r1', 'vault-b') })).toBe('conflict');
    expect(planDocumentSync({ userId: USER, local, meta: { ownerId: OTHER, syncedRevision: 'base-rev-1' }, remote: remote('r1') })).toBe('other-account');
  });
});

describe('mergeDocumentIndexes', () => {
  it('keeps the newer copy of each document and documents from both sides', () => {
    const merged = mergeDocumentIndexes(
      index([doc('a', T2, 'A local'), doc('b', T1)]),
      index([doc('a', T1, 'A remote'), doc('c', T1)]),
    );
    expect(merged.documents.map((item) => [item.id, item.title])).toEqual([['a', 'A local'], ['b', 'b'], ['c', 'c']]);
    const remoteWins = mergeDocumentIndexes(index([doc('a', T1, 'old')]), index([doc('a', T3, 'new')]));
    expect(remoteWins.documents[0].title).toBe('new');
  });

  it('does not bring a deleted document back, unless it was edited after the deletion', () => {
    const deletedHere = mergeDocumentIndexes(index([], { deletedDocuments: { a: T2 } }), index([doc('a', T1)]));
    expect(deletedHere.documents).toEqual([]);
    expect(deletedHere.deletedDocuments).toEqual({ a: T2 });
    const editedLater = mergeDocumentIndexes(index([], { deletedDocuments: { a: T2 } }), index([doc('a', T3)]));
    expect(editedLater.documents.map((item) => item.id)).toEqual(['a']);
  });

  it('takes the reminder-title setting from its newer change', () => {
    const merged = mergeDocumentIndexes(
      index([], { showReminderTitles: true, settingsUpdatedAt: T1 }),
      index([], { showReminderTitles: false, settingsUpdatedAt: T2 }),
    );
    expect(merged.showReminderTitles).toBe(false);
    expect(merged.settingsUpdatedAt).toBe(T2);
  });

  it('explains when the combined vault would break a limit', () => {
    const many = (prefix: string) => Array.from({ length: 150 }, (_, n) => doc(`${prefix}${n}`, T1));
    expect(() => mergeDocumentIndexes(index(many('l')), index(many('r')))).toThrow('could not be combined');
  });
});

describe('remote row', () => {
  it('validates the envelope, revision and attachment list', () => {
    const value = envelope('remote-rev-1');
    const row = { revision: 'remote-rev-1', envelope: value, attachments: [{ id: 'att-1', bytes: 100 }] };
    expect(readRemoteDocumentVault(row).attachments).toEqual([{ id: 'att-1', bytes: 100 }]);
    expect(() => readRemoteDocumentVault({ ...row, revision: 'other-rev-1' })).toThrow('damaged');
    expect(() => readRemoteAttachments([{ id: 'att-1', bytes: 100 }, { id: 'att-1', bytes: 100 }])).toThrow('damaged');
    expect(() => readRemoteAttachments([{ id: 'bad/id', bytes: 100 }])).toThrow('damaged');
    expect(() => readRemoteAttachments([{ id: 'att-1', bytes: 5 }])).toThrow('damaged');
  });

  it('reads only well-formed sync state', () => {
    expect(readDocumentSyncMeta({ ownerId: USER, syncedRevision: 'abcdefgh' })).toEqual({ ownerId: USER, syncedRevision: 'abcdefgh' });
    expect(readDocumentSyncMeta({ ownerId: 'nope', syncedRevision: 'abcdefgh' })).toBeUndefined();
    expect(readDocumentSyncMeta(null)).toBeUndefined();
  });
});

describe('files in storage', () => {
  it('packs nonce + ciphertext and unpacks it again', () => {
    const blob = { nonce: random(12), ciphertext: crypto.getRandomValues(new Uint8Array(500)) };
    const packed = packStoredBlob(blob);
    expect(packed.length).toBe(512);
    const back = unpackStoredBlob(packed);
    expect(back.nonce).toBe(blob.nonce);
    expect(Array.from(back.ciphertext)).toEqual(Array.from(blob.ciphertext));
    expect(() => unpackStoredBlob(new Uint8Array(20))).toThrow('damaged');
  });

  it('splits large files into parts and checks the joined size', () => {
    const packed = new Uint8Array(BLOB_PART_BYTES * 2 + 10).fill(7);
    const parts = splitBlobParts(packed);
    expect(parts.map((part) => part.length)).toEqual([BLOB_PART_BYTES, BLOB_PART_BYTES, 10]);
    expect(blobPartCount(packed.length)).toBe(3);
    expect(joinBlobParts(parts, packed.length).length).toBe(packed.length);
    expect(() => joinBlobParts(parts.slice(0, 2), packed.length)).toThrow('incomplete');
    expect(blobPartPath(USER, 'att-1', 2)).toBe(`${USER}/att-1.2`);
    expect(() => blobPartPath(USER, '../x', 0)).toThrow();
  });

  it('deletes only old files that no attachment uses', () => {
    const now = Date.parse(T3);
    const old = new Date(now - ORPHAN_GRACE_MS - 1).toISOString();
    const fresh = new Date(now - 1000).toISOString();
    const names = orphanedPartNames([
      { name: 'keep.0', created_at: old },
      { name: 'gone.0', created_at: old },
      { name: 'gone.1', created_at: old },
      { name: 'new.0', created_at: fresh },
      { name: 'not-a-part', created_at: old },
    ], new Set(['keep']), now);
    expect(names).toEqual(['gone.0', 'gone.1']);
  });
});
