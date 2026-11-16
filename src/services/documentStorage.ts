/**
 * IndexedDB storage for the Document Vault (device-only: never synced, not in
 * the app backup).
 *
 * Database `dayflow-documents` v2:
 *   - `vault`: key 'current' -> DocumentEnvelope (header + encrypted index)
 *   - `blobs`: key attachmentId -> StoredBlob (encrypted file bytes)
 *
 * Every change writes the new envelope, the new blobs and the deletes of
 * orphaned blobs in ONE readwrite transaction over both stores, after checking
 * that the stored envelope still has the revision the caller started from.
 * IndexedDB transactions are atomic, so a failed, aborted or interrupted commit
 * leaves the previous vault readable and complete.
 */
import {
  isDocumentId,
  readDocumentEnvelope,
  readStoredBlob,
  type DocumentEnvelope,
  type StoredBlob,
} from '../lib/documentVault';

const DB_NAME = 'dayflow-documents';
const DB_VERSION = 2;
const VAULT_STORE = 'vault';
const BLOB_STORE = 'blobs';
const CURRENT_KEY = 'current';

const CONFLICT_MESSAGE = 'The document vault was changed in another window. Nothing was saved. Lock the vault, unlock it again and retry.';
const QUOTA_MESSAGE = 'There is not enough storage space on this device to save the documents. Nothing was saved. Free up space and try again.';
const SAVE_FAILED_MESSAGE = 'The documents could not be saved. Nothing was changed: your previous vault is intact.';
const READ_FAILED_MESSAGE = 'The document vault could not be read from this device\'s storage.';
const DAMAGED_MESSAGE = 'The stored document vault is damaged and cannot be read.';

let factoryOverride: IDBFactory | null = null;

/** Tests pass a fresh `IDBFactory` (fake-indexeddb); `null` restores the browser's. */
export function setDocumentStorageFactory(factory: IDBFactory | null): void {
  factoryOverride = factory;
}

function factory(): IDBFactory {
  const resolved = factoryOverride ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  if (!resolved) {
    throw new Error('Document storage is not available in this browser (IndexedDB is turned off, for example in some private windows).');
  }
  return resolved;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory().open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(READ_FAILED_MESSAGE));
      return;
    }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Version 1 was an unreleased draft whose `vault` record had another shape;
      // no released build could read it, so it is replaced, not migrated.
      if (event.oldVersion < 2 && db.objectStoreNames.contains(VAULT_STORE)) db.deleteObjectStore(VAULT_STORE);
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema must not wait on this connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(new Error(READ_FAILED_MESSAGE));
    request.onblocked = () => reject(new Error('Close Dayflow in your other tabs, then try again.'));
  });
}

async function withDatabase<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

function isQuotaError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError';
}

function readOnly<T>(stores: string[], body: (tx: IDBTransaction, done: (value: T) => void) => void): (db: IDBDatabase) => Promise<T> {
  return (db) => new Promise<T>((resolve, reject) => {
    let result: T;
    let failure: Error | null = null;
    const tx = db.transaction(stores, 'readonly');
    tx.oncomplete = () => (failure ? reject(failure) : resolve(result));
    tx.onabort = () => reject(failure ?? new Error(READ_FAILED_MESSAGE));
    try {
      body(tx, (value) => { result = value; });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(READ_FAILED_MESSAGE);
      tx.abort();
    }
  });
}

/** The stored envelope, validated, or undefined when no vault exists yet. */
export async function readDocumentVault(): Promise<DocumentEnvelope | undefined> {
  const raw = await withDatabase(readOnly<unknown>([VAULT_STORE], (tx, done) => {
    const request = tx.objectStore(VAULT_STORE).get(CURRENT_KEY);
    request.onsuccess = () => done(request.result);
  }));
  if (raw === undefined) return undefined;
  try {
    return readDocumentEnvelope(raw);
  } catch {
    throw new Error(DAMAGED_MESSAGE);
  }
}

function checkBlob(id: string, value: unknown): StoredBlob {
  try {
    return readStoredBlob(value);
  } catch {
    throw new Error(`A stored file (${id.slice(0, 8)}) is damaged and cannot be read.`);
  }
}

export async function readBlob(attachmentId: string): Promise<StoredBlob | undefined> {
  if (!isDocumentId(attachmentId)) return undefined;
  const raw = await withDatabase(readOnly<unknown>([BLOB_STORE], (tx, done) => {
    const request = tx.objectStore(BLOB_STORE).get(attachmentId);
    request.onsuccess = () => done(request.result);
  }));
  return raw === undefined ? undefined : checkBlob(attachmentId, raw);
}

/** The requested blobs that exist (missing ids are simply absent from the map). */
export async function readBlobs(ids: string[]): Promise<Map<string, StoredBlob>> {
  const wanted = [...new Set(ids)].filter(isDocumentId);
  const raw = await withDatabase(readOnly<Map<string, unknown>>([BLOB_STORE], (tx, done) => {
    const found = new Map<string, unknown>();
    done(found);
    const store = tx.objectStore(BLOB_STORE);
    for (const id of wanted) {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result !== undefined) found.set(id, request.result);
      };
    }
  }));
  const blobs = new Map<string, StoredBlob>();
  for (const [id, value] of raw) blobs.set(id, checkBlob(id, value));
  return blobs;
}

/** Every stored blob (for a backup). */
export async function readAllBlobs(): Promise<Map<string, StoredBlob>> {
  const raw = await withDatabase(readOnly<Map<string, unknown>>([BLOB_STORE], (tx, done) => {
    const found = new Map<string, unknown>();
    done(found);
    const request = tx.objectStore(BLOB_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      found.set(String(cursor.key), cursor.value);
      cursor.continue();
    };
  }));
  const blobs = new Map<string, StoredBlob>();
  for (const [id, value] of raw) blobs.set(id, checkBlob(id, value));
  return blobs;
}

function validateBlobs(blobs: Map<string, StoredBlob> | undefined): Map<string, StoredBlob> {
  const checked = new Map<string, StoredBlob>();
  for (const [id, blob] of blobs ?? []) {
    if (!isDocumentId(id)) throw new Error('A file to save has an invalid id. Nothing was saved.');
    try {
      const stored = readStoredBlob(blob);
      // Structured clone stores a view's WHOLE buffer: keep only this blob's bytes.
      const { ciphertext } = stored;
      const compact = ciphertext.byteOffset === 0 && ciphertext.byteLength === ciphertext.buffer.byteLength
        ? ciphertext
        : ciphertext.slice();
      checked.set(id, { nonce: stored.nonce, ciphertext: compact });
    } catch {
      throw new Error('A file to save is not encrypted correctly. Nothing was saved.');
    }
  }
  return checked;
}

function validateEnvelope(envelope: DocumentEnvelope): DocumentEnvelope {
  try {
    return readDocumentEnvelope(envelope);
  } catch {
    throw new Error('The vault to save is not valid. Nothing was saved.');
  }
}

function writeTransaction(db: IDBDatabase, body: (tx: IDBTransaction, setFailure: (error: Error) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let failure: Error | null = null;
    const setFailure = (error: Error) => {
      if (!failure) failure = error;
    };
    let tx: IDBTransaction;
    try {
      tx = db.transaction([VAULT_STORE, BLOB_STORE], 'readwrite');
    } catch {
      reject(new Error(SAVE_FAILED_MESSAGE));
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => {
      if (failure) reject(failure);
      else reject(new Error(isQuotaError(tx.error) ? QUOTA_MESSAGE : SAVE_FAILED_MESSAGE));
    };
    tx.onerror = (event) => {
      const error = (event.target as IDBRequest | null)?.error ?? tx.error;
      setFailure(new Error(isQuotaError(error) ? QUOTA_MESSAGE : SAVE_FAILED_MESSAGE));
    };
    try {
      body(tx, (error) => {
        setFailure(error);
        tx.abort();
      });
    } catch (error) {
      setFailure(new Error(isQuotaError(error) ? QUOTA_MESSAGE : SAVE_FAILED_MESSAGE));
      try { tx.abort(); } catch { /* already finished */ }
    }
  });
}

/**
 * Saves a change atomically. `expectedRevision` is the revision of the envelope
 * the change was made from (null when creating the vault); if storage holds a
 * different one, nothing is written and the promise rejects.
 */
export async function commitDocumentVault(change: {
  envelope: DocumentEnvelope;
  expectedRevision: string | null;
  putBlobs?: Map<string, StoredBlob>;
  deleteBlobIds?: string[];
}): Promise<void> {
  const envelope = validateEnvelope(change.envelope);
  const putBlobs = validateBlobs(change.putBlobs);
  const deleteIds = [...new Set(change.deleteBlobIds ?? [])];
  if (deleteIds.some((id) => !isDocumentId(id))) throw new Error('A file to delete has an invalid id. Nothing was saved.');
  if (deleteIds.some((id) => putBlobs.has(id))) throw new Error('A file cannot be saved and deleted in the same change. Nothing was saved.');
  if (envelope.revision === change.expectedRevision) throw new Error('The vault to save has no new revision. Nothing was saved.');

  await withDatabase((db) => writeTransaction(db, (tx, abortWith) => {
    const vault = tx.objectStore(VAULT_STORE);
    const blobs = tx.objectStore(BLOB_STORE);
    const request = vault.get(CURRENT_KEY);
    request.onsuccess = () => {
      const stored = request.result as { revision?: unknown } | undefined;
      const storedRevision = stored === undefined ? null : stored?.revision;
      if (storedRevision !== change.expectedRevision) {
        abortWith(new Error(CONFLICT_MESSAGE));
        return;
      }
      try {
        for (const [id, blob] of putBlobs) blobs.put(blob, id);
        for (const id of deleteIds) blobs.delete(id);
        vault.put(envelope, CURRENT_KEY);
      } catch (error) {
        abortWith(new Error(isQuotaError(error) ? QUOTA_MESSAGE : SAVE_FAILED_MESSAGE));
      }
    };
  }));
}

/**
 * Restore: replaces the whole vault (envelope and every blob) in ONE transaction.
 * Call only after `verifyDocumentBackup` and the user's confirmation.
 */
export async function replaceDocumentVault(envelope: DocumentEnvelope, blobs: Map<string, StoredBlob>): Promise<void> {
  const checkedEnvelope = validateEnvelope(envelope);
  const checkedBlobs = validateBlobs(blobs);
  await withDatabase((db) => writeTransaction(db, (tx, abortWith) => {
    const vault = tx.objectStore(VAULT_STORE);
    const store = tx.objectStore(BLOB_STORE);
    const clear = store.clear();
    clear.onsuccess = () => {
      try {
        for (const [id, blob] of checkedBlobs) store.put(blob, id);
        vault.put(checkedEnvelope, CURRENT_KEY);
      } catch (error) {
        abortWith(new Error(isQuotaError(error) ? QUOTA_MESSAGE : SAVE_FAILED_MESSAGE));
      }
    };
  }));
}

/**
 * Asks the browser not to evict the vault under storage pressure. Returns
 * whether storage is persistent (false when the browser declines or cannot say).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Browser storage usage and quota for the whole site, when the browser reports them. */
export async function storageEstimate(): Promise<{ usage?: number; quota?: number }> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return {};
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return {};
  }
}
