/**
 * Document Vault cloud sync: the pure rules. No storage, no network.
 *
 * The server keeps:
 *   - one row per account in `dayflow_document_vaults`: the envelope (vault
 *     header with the data key + encrypted index) exactly as a device stores it, its revision, and
 *     the list of encrypted files it refers to (random ids and sizes, nothing else);
 *   - each encrypted file in the private Storage bucket `document-vault`, as
 *     `<user id>/<attachment id>.<part>`: 12-byte nonce + AES-GCM ciphertext,
 *     split into parts small enough for the site's /supabase proxy.
 *
 * A device remembers the server revision it last matched (`syncedRevision`), so
 * one sync can tell who changed: only this device (push), only the server (pull),
 * nobody, or both (merge, with the key in the vault's header). Pushes are
 * compare-and-swap on the revision, so two devices can never overwrite each other.
 */
import {
  DOCUMENT_LIMITS,
  isDocumentId,
  parseDocumentIndex,
  pruneDeletedDocuments,
  readDocumentEnvelope,
  readStoredBlob,
  type DocumentEnvelope,
  type DocumentIndex,
  type StoredBlob,
  type VaultDocument,
} from './documentVault';
import { base64ToBytes, bytesToBase64 } from './passwordVault';

export const DOCUMENT_SYNC_TABLE = 'dayflow_document_vaults';
export const DOCUMENT_SYNC_BUCKET = 'document-vault';
/** Bytes per Storage object. Kept under the 4.5 MB body limit some proxies apply. */
export const BLOB_PART_BYTES = 3 * 1024 * 1024;
/** Remote files no revision refers to are deleted only after this long (another device may be mid-push). */
export const ORPHAN_GRACE_MS = 60 * 60_000;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PACKED_BYTES = NONCE_BYTES + DOCUMENT_LIMITS.maxFileBytes + TAG_BYTES;
const MAX_ATTACHMENTS = DOCUMENT_LIMITS.maxDocuments * DOCUMENT_LIMITS.maxRevisionsPerDocument;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PART_NAME_PATTERN = /^([A-Za-z0-9_-]{1,64})\.(\d{1,3})$/;

export interface DocumentSyncMeta {
  /** The account this device's vault syncs with. */
  ownerId: string;
  /** The server revision this device last matched. */
  syncedRevision: string;
}

/** One encrypted file the server copy refers to. `bytes` is its packed size. */
export interface RemoteAttachment {
  id: string;
  bytes: number;
}

export interface RemoteDocumentVault {
  revision: string;
  envelope: DocumentEnvelope;
  attachments: RemoteAttachment[];
}

export type DocumentSyncPlan =
  /** Neither this device nor the account has a vault. */
  | 'idle'
  /** No vault here, the account has one: download it. */
  | 'adopt'
  /** A vault here, none in the account: upload it. */
  | 'create'
  /** Same revision on both sides. */
  | 'in-sync'
  /** Only the server changed. */
  | 'pull'
  /** Only this device changed. */
  | 'push'
  /** Both changed: combine them document by document. */
  | 'merge'
  /** The account holds a different vault (another id and key). */
  | 'conflict'
  /** This device's vault syncs with another account. */
  | 'other-account';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function time(iso: string | undefined): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : 0;
}

export function readDocumentSyncMeta(value: unknown): DocumentSyncMeta | undefined {
  if (!isObject(value)) return undefined;
  const { ownerId, syncedRevision } = value;
  if (typeof ownerId !== 'string' || !USER_ID_PATTERN.test(ownerId)) return undefined;
  if (typeof syncedRevision !== 'string' || syncedRevision.length < 8 || syncedRevision.length > 64) return undefined;
  return { ownerId, syncedRevision };
}

export function planDocumentSync(input: {
  userId: string;
  local: { revision: string; vaultId: string } | null;
  meta: DocumentSyncMeta | null | undefined;
  remote: { revision: string; vaultId: string } | null;
}): DocumentSyncPlan {
  const { userId, local, meta, remote } = input;
  if (!local) return remote ? 'adopt' : 'idle';
  if (meta && meta.ownerId !== userId) return 'other-account';
  if (!remote) return 'create';
  if (remote.vaultId !== local.vaultId) return 'conflict';
  if (remote.revision === local.revision) return 'in-sync';
  const base = meta?.syncedRevision;
  if (base === local.revision) return 'pull';
  if (base === remote.revision) return 'push';
  return 'merge';
}

/** Validates the server row. Throws a user-facing Error when it is damaged. */
export function readRemoteDocumentVault(row: unknown): RemoteDocumentVault {
  if (!isObject(row) || typeof row.revision !== 'string') throw new Error('The synced document vault is damaged.');
  let envelope: DocumentEnvelope;
  try {
    envelope = readDocumentEnvelope(row.envelope);
  } catch {
    throw new Error('The synced document vault is damaged.');
  }
  if (envelope.revision !== row.revision) throw new Error('The synced document vault is damaged.');
  return { revision: row.revision, envelope, attachments: readRemoteAttachments(row.attachments) };
}

export function readRemoteAttachments(value: unknown): RemoteAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error('The synced document list is damaged.');
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isObject(item) || !isDocumentId(item.id) || seen.has(item.id)) throw new Error('The synced document list is damaged.');
    const { bytes } = item;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= NONCE_BYTES + TAG_BYTES || bytes > MAX_PACKED_BYTES) {
      throw new Error('The synced document list is damaged.');
    }
    seen.add(item.id);
    return { id: item.id, bytes };
  });
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Merges two copies of the same vault's index, document by document: the newer
 * `updatedAt` wins, and a deletion wins over any edit made before it. The reminder
 * title setting follows its newer change. Throws when the result breaks a vault
 * limit (for example both devices added documents up to the size limit).
 */
export function mergeDocumentIndexes(local: DocumentIndex, remote: DocumentIndex): DocumentIndex {
  const deleted = new Map<string, string>();
  for (const source of [remote.deletedDocuments, local.deletedDocuments]) {
    for (const [id, at] of Object.entries(source ?? {})) {
      const known = deleted.get(id);
      if (!known || time(at) > time(known)) deleted.set(id, at);
    }
  }

  const remoteById = new Map(remote.documents.map((document) => [document.id, document]));
  const localIds = new Set(local.documents.map((document) => document.id));
  const ordered: VaultDocument[] = [];
  const pick = (mine: VaultDocument | undefined, theirs: VaultDocument | undefined) => {
    const winner = !mine ? theirs : !theirs ? mine : time(mine.updatedAt) > time(theirs.updatedAt) ? mine : theirs;
    if (!winner) return;
    const deletedAt = deleted.get(winner.id);
    if (deletedAt && time(deletedAt) >= time(winner.updatedAt)) return;
    ordered.push(winner);
  };
  for (const document of local.documents) pick(document, remoteById.get(document.id));
  for (const document of remote.documents) if (!localIds.has(document.id)) pick(undefined, document);

  const settingsFromLocal = time(local.settingsUpdatedAt) >= time(remote.settingsUpdatedAt);
  const settings = settingsFromLocal ? local : remote;
  const merged: Record<string, unknown> = {
    version: 1,
    showReminderTitles: settings.showReminderTitles,
    documents: ordered,
  };
  if (settings.settingsUpdatedAt) merged.settingsUpdatedAt = settings.settingsUpdatedAt;
  if (deleted.size > 0) merged.deletedDocuments = pruneDeletedDocuments(deleted);
  try {
    return parseDocumentIndex(merged);
  } catch (error) {
    throw new Error(`Your devices' document vaults could not be combined: ${(error as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Files in Storage                                                    */
/* ------------------------------------------------------------------ */

/** One stored blob as bytes: 12-byte nonce, then the ciphertext. */
export function packStoredBlob(blob: StoredBlob): Uint8Array {
  const checked = readStoredBlob(blob);
  const nonce = base64ToBytes(checked.nonce);
  const packed = new Uint8Array(NONCE_BYTES + checked.ciphertext.length);
  packed.set(nonce, 0);
  packed.set(checked.ciphertext, NONCE_BYTES);
  return packed;
}

export function unpackStoredBlob(bytes: Uint8Array): StoredBlob {
  if (bytes.length <= NONCE_BYTES + TAG_BYTES || bytes.length > MAX_PACKED_BYTES) throw new Error('A synced file is damaged.');
  return readStoredBlob({
    nonce: bytesToBase64(bytes.subarray(0, NONCE_BYTES)),
    ciphertext: bytes.slice(NONCE_BYTES),
  });
}

export function packedBlobSize(blob: StoredBlob): number {
  return NONCE_BYTES + blob.ciphertext.length;
}

export function blobPartCount(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / BLOB_PART_BYTES));
}

export function blobPartPath(userId: string, attachmentId: string, part: number): string {
  if (!USER_ID_PATTERN.test(userId) || !isDocumentId(attachmentId) || !Number.isInteger(part) || part < 0 || part > 999) {
    throw new Error('Invalid synced file path.');
  }
  return `${userId}/${attachmentId}.${part}`;
}

/** Splits packed bytes into the parts uploaded for one attachment. */
export function splitBlobParts(packed: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < packed.length; offset += BLOB_PART_BYTES) {
    parts.push(packed.subarray(offset, Math.min(packed.length, offset + BLOB_PART_BYTES)));
  }
  return parts;
}

/** Joins downloaded parts; throws when the total does not match the recorded size. */
export function joinBlobParts(parts: Uint8Array[], expectedBytes: number): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (total !== expectedBytes || parts.length !== blobPartCount(expectedBytes)) throw new Error('A synced file is incomplete.');
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * Storage object names (inside the user's folder) that no attachment in `keep`
 * owns and that are older than the grace period.
 */
export function orphanedPartNames(
  objects: { name: string; created_at?: string | null }[],
  keep: Set<string>,
  now: number,
  graceMs = ORPHAN_GRACE_MS,
): string[] {
  return objects
    .filter((object) => {
      const match = PART_NAME_PATTERN.exec(object.name);
      if (!match || keep.has(match[1])) return false;
      const created = time(object.created_at ?? undefined);
      return created > 0 && now - created >= graceMs;
    })
    .map((object) => object.name);
}
