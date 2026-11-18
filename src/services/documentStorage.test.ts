import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentEnvelope, StoredBlob } from '../lib/documentVault';
import { bytesToBase64 } from '../lib/passwordVault';
import {
  applySyncedDocumentVault,
  commitDocumentVault,
  deleteLocalDocumentVault,
  readBlobIds,
  readDocumentSyncState,
  writeDocumentSyncState,
  readAllBlobs,
  readBlob,
  readBlobs,
  readDocumentVault,
  replaceDocumentVault,
  setDocumentStorageFactory,
} from './documentStorage';

function random(length: number): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(length)));
}

/** Structurally valid envelope (storage never decrypts, so random bytes are enough). */
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

function blob(fill: number): StoredBlob {
  return { nonce: random(12), ciphertext: new Uint8Array(40).fill(fill) };
}

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  setDocumentStorageFactory(factory);
});

afterEach(() => {
  vi.restoreAllMocks();
  setDocumentStorageFactory(null);
});

async function seed(): Promise<DocumentEnvelope> {
  const first = envelope('revision-0001');
  await commitDocumentVault({
    envelope: first, expectedRevision: null, putBlobs: new Map([['blob-a', blob(1)], ['blob-b', blob(2)]]),
  });
  return first;
}

function rawPut(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open('dayflow-documents', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('vault');
      request.result.createObjectStore('blobs');
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('vault', 'readwrite');
      tx.objectStore('vault').put(value, 'current');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe('document storage', () => {
  it('starts empty and commits the first vault with its blobs', async () => {
    expect(await readDocumentVault()).toBeUndefined();
    expect(await readBlob('blob-a')).toBeUndefined();
    const first = await seed();
    expect(await readDocumentVault()).toEqual(first);
    expect((await readBlob('blob-a'))?.ciphertext).toEqual(new Uint8Array(40).fill(1));
    const some = await readBlobs(['blob-b', 'missing', 'blob-b']);
    expect([...some.keys()]).toEqual(['blob-b']);
    expect([...(await readAllBlobs()).keys()].sort()).toEqual(['blob-a', 'blob-b']);
  });

  it('writes new blobs and deletes orphaned ones in the same commit', async () => {
    const first = await seed();
    const second = envelope('revision-0002');
    await commitDocumentVault({
      envelope: second, expectedRevision: first.revision, putBlobs: new Map([['blob-c', blob(3)]]), deleteBlobIds: ['blob-a'],
    });
    expect((await readDocumentVault())?.revision).toBe('revision-0002');
    expect([...(await readAllBlobs()).keys()].sort()).toEqual(['blob-b', 'blob-c']);
  });

  it('rejects a stale expected revision and keeps the previous vault', async () => {
    const first = await seed();
    await expect(commitDocumentVault({
      envelope: envelope('revision-0003'), expectedRevision: 'revision-9999',
      putBlobs: new Map([['blob-x', blob(9)]]), deleteBlobIds: ['blob-a'],
    })).rejects.toThrow('changed meanwhile');
    // Creating over an existing vault is a conflict too.
    await expect(commitDocumentVault({ envelope: envelope('revision-0004'), expectedRevision: null })).rejects.toThrow('changed meanwhile');
    expect(await readDocumentVault()).toEqual(first);
    expect([...(await readAllBlobs()).keys()].sort()).toEqual(['blob-a', 'blob-b']);
  });

  it('keeps the previous vault when the transaction aborts part-way', async () => {
    const first = await seed();
    const put = IDBObjectStore.prototype.put;
    // Blob writes succeed, then the envelope write hits a full disk.
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'vault') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.apply(this, args);
    });
    await expect(commitDocumentVault({
      envelope: envelope('revision-0005'), expectedRevision: first.revision,
      putBlobs: new Map([['blob-new', blob(5)]]), deleteBlobIds: ['blob-a'],
    })).rejects.toThrow('not enough storage space');
    vi.restoreAllMocks();
    expect(await readDocumentVault()).toEqual(first);
    expect([...(await readAllBlobs()).keys()].sort()).toEqual(['blob-a', 'blob-b']);
  });

  it('validates input before opening a transaction', async () => {
    const first = await seed();
    await expect(commitDocumentVault({
      envelope: { ...envelope('revision-0006'), format: 'other' } as unknown as DocumentEnvelope, expectedRevision: first.revision,
    })).rejects.toThrow('not valid');
    await expect(commitDocumentVault({
      envelope: envelope('revision-0007'), expectedRevision: first.revision,
      putBlobs: new Map([['blob-z', { nonce: 'bad', ciphertext: new Uint8Array(40) }]]),
    })).rejects.toThrow('not encrypted correctly');
    await expect(commitDocumentVault({
      envelope: envelope('revision-0008'), expectedRevision: first.revision, putBlobs: new Map([['bad:id', blob(1)]]),
    })).rejects.toThrow('invalid id');
    await expect(commitDocumentVault({
      envelope: envelope('revision-0009'), expectedRevision: first.revision,
      putBlobs: new Map([['blob-a', blob(1)]]), deleteBlobIds: ['blob-a'],
    })).rejects.toThrow('saved and deleted');
    expect(await readDocumentVault()).toEqual(first);
  });

  it('stores only the bytes of a blob that is a view into a larger buffer', async () => {
    const backing = new Uint8Array(1000).fill(4);
    await commitDocumentVault({
      envelope: envelope('revision-0010'), expectedRevision: null,
      putBlobs: new Map([['blob-view', { nonce: random(12), ciphertext: backing.subarray(100, 140) }]]),
    });
    const stored = await readBlob('blob-view');
    expect(stored?.ciphertext.byteLength).toBe(40);
    expect(stored?.ciphertext.buffer.byteLength).toBe(40);
  });

  it('replaces the whole vault on restore', async () => {
    await seed();
    const restored = envelope('revision-0011');
    await replaceDocumentVault(restored, new Map([['blob-r', blob(7)]]));
    expect(await readDocumentVault()).toEqual(restored);
    expect([...(await readAllBlobs()).keys()]).toEqual(['blob-r']);
  });

  it('keeps the old vault when a restore aborts', async () => {
    const first = await seed();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'vault') throw new DOMException('Aborted', 'UnknownError');
      return put.apply(this, args);
    });
    await expect(replaceDocumentVault(envelope('revision-0012'), new Map([['blob-r', blob(7)]]))).rejects.toThrow('previous vault is intact');
    vi.restoreAllMocks();
    expect(await readDocumentVault()).toEqual(first);
    expect([...(await readAllBlobs()).keys()].sort()).toEqual(['blob-a', 'blob-b']);
  });

  it('reports a damaged stored envelope instead of returning it', async () => {
    await rawPut({ format: 'dayflow-documents', version: 1, revision: 'revision-0013', header: {}, index: {} });
    await expect(readDocumentVault()).rejects.toThrow('damaged');
  });

  it('replaces the unreleased version 1 draft store', async () => {
    await new Promise<void>((resolve) => {
      const request = factory.open('dayflow-documents', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('vault').put({ format: 'dayflow-documents', payload: {} }, 'current');
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    expect(await readDocumentVault()).toBeUndefined();
    await seed();
    expect((await readDocumentVault())?.revision).toBe('revision-0001');
  });

  describe('sync', () => {
    const owner = '11111111-2222-4333-8444-555555555555';

    it('applies a synced vault atomically: new files in, unused files out, sync state saved', async () => {
      const first = await seed();
      const next = envelope('revision-0020');
      await applySyncedDocumentVault({
        envelope: next, expectedRevision: first.revision,
        putBlobs: new Map([['blob-c', blob(3)]]), keepIds: new Set(['blob-b', 'blob-c']),
        meta: { ownerId: owner, syncedRevision: 'revision-0020' },
      });
      expect((await readDocumentVault())?.revision).toBe('revision-0020');
      expect([...(await readBlobIds())].sort()).toEqual(['blob-b', 'blob-c']);
      expect(await readDocumentSyncState()).toEqual({ ownerId: owner, syncedRevision: 'revision-0020' });
    });

    it('adopts into an empty device and refuses when a file is missing or the vault changed', async () => {
      await applySyncedDocumentVault({
        envelope: envelope('revision-0021'), expectedRevision: null,
        putBlobs: new Map([['blob-a', blob(1)]]), keepIds: new Set(['blob-a']),
        meta: { ownerId: owner, syncedRevision: 'revision-0021' },
      });
      await expect(applySyncedDocumentVault({
        envelope: envelope('revision-0022'), expectedRevision: 'revision-0021',
        putBlobs: new Map(), keepIds: new Set(['blob-a', 'blob-missing']),
        meta: { ownerId: owner, syncedRevision: 'revision-0022' },
      })).rejects.toThrow('missing');
      await expect(applySyncedDocumentVault({
        envelope: envelope('revision-0023'), expectedRevision: 'revision-9999',
        putBlobs: new Map(), keepIds: new Set(['blob-a']),
        meta: { ownerId: owner, syncedRevision: 'revision-0023' },
      })).rejects.toThrow('changed meanwhile');
      expect((await readDocumentVault())?.revision).toBe('revision-0021');
    });

    it('saves sync state only for the current revision, and deletes the local vault', async () => {
      const first = await seed();
      await expect(writeDocumentSyncState({ ownerId: owner, syncedRevision: 'revision-0001' }, 'revision-9999')).rejects.toThrow('changed meanwhile');
      await writeDocumentSyncState({ ownerId: owner, syncedRevision: 'revision-0001' }, first.revision);
      expect((await readDocumentSyncState())?.ownerId).toBe(owner);
      await expect(deleteLocalDocumentVault('revision-9999')).rejects.toThrow('changed meanwhile');
      await deleteLocalDocumentVault(first.revision);
      expect(await readDocumentVault()).toBeUndefined();
      expect(await readDocumentSyncState()).toBeUndefined();
      expect((await readBlobIds()).size).toBe(0);
    });
  });
});
