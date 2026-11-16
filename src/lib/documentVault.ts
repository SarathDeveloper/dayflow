/**
 * Document Vault: encrypted copies of important documents (PDF, JPEG, PNG) with
 * expiry dates and reminders.
 *
 * Key hierarchy: the vault HEADER is a password-vault `VaultFile` with zero entries.
 * It holds the Argon2id salt and the data key wrapped by the passphrase, so the
 * proven `createVault` / `openVault` code does the key work. The data key then
 * encrypts, with AES-GCM and authenticated context (AAD):
 *   - the index (titles, categories, links, revisions, filenames, expiry dates,
 *     reminder offsets) under `dayflow-documents:v1:<vaultId>:index`
 *   - each attachment's bytes under `dayflow-documents:v1:<vaultId>:blob:<attachmentId>`
 * so a ciphertext moved to another attachment id, another vault or the index fails.
 *
 * Everything here is pure (no storage, no DOM) and tested in documentVault.test.ts.
 */
import type { DocumentReminderEntry } from './extraReminders';
import {
  base64ToBytes,
  bytesToBase64,
  createVault,
  decryptVaultBytes,
  encryptVaultBytes,
  isStrictBase64,
  openVault,
  readVaultFile,
  type VaultFile,
} from './passwordVault';

const MB = 1024 * 1024;

export const DOCUMENT_LIMITS = {
  /** Largest single file. */
  maxFileBytes: 10 * MB,
  /** Total size of every revision's file in the vault. */
  maxVaultBytes: 60 * MB,
  maxDocuments: 200,
  maxRevisionsPerDocument: 20,
  maxTitle: 200,
  maxCategory: 60,
  maxFilename: 200,
  /** Largest backup file accepted (base64 of 60 MB of ciphertext plus the index). */
  maxBackupBytes: 96 * MB,
} as const;

/** Largest encrypted index (plaintext JSON bytes). */
const MAX_INDEX_BYTES = 4 * MB;
const MAX_NOTE = 1000;
const MAX_REMINDER_OFFSETS = 5;
const MAX_REMINDER_DAY = 365;
/** AES-GCM authentication tag appended to every ciphertext. */
const TAG_BYTES = 16;
const MAX_ATTACHMENTS = DOCUMENT_LIMITS.maxDocuments * DOCUMENT_LIMITS.maxRevisionsPerDocument;

export const DEFAULT_DOCUMENT_REMINDER_DAYS: number[] = [30, 7];

export type DocumentMime = 'application/pdf' | 'image/jpeg' | 'image/png';
export const DOCUMENT_MIME_TYPES: readonly DocumentMime[] = ['application/pdf', 'image/jpeg', 'image/png'];

export interface DocumentRevision {
  id: string;
  filename: string;
  mimeType: DocumentMime;
  /** Plaintext size in bytes. */
  size: number;
  attachmentId: string;
  addedAt: string;
  expiresOn?: string;
  note?: string;
}

export interface VaultDocument {
  id: string;
  title: string;
  category: string;
  /** Linked maintenance item id. */
  assetId?: string;
  /** Linked service record id (inside the `assetId` item). */
  serviceRecordId?: string;
  reminderDays: number[];
  /** Random opaque key used in the plaintext reminder schedule instead of the id. */
  reminderKey: string;
  currentRevisionId: string;
  revisions: DocumentRevision[];
  createdAt: string;
  updatedAt: string;
}

export interface DocumentIndex {
  version: 1;
  showReminderTitles: boolean;
  documents: VaultDocument[];
}

export interface DocumentEnvelope {
  format: 'dayflow-documents';
  version: 1;
  /** Random per commit; storage refuses a commit whose expected revision is stale. */
  revision: string;
  header: VaultFile;
  index: { nonce: string; ciphertext: string };
}

export interface StoredBlob {
  nonce: string;
  ciphertext: Uint8Array;
}

export interface DocumentSession {
  key: CryptoKey;
  envelope: DocumentEnvelope;
  index: DocumentIndex;
}

export const WRONG_PASSPHRASE_MESSAGE = 'The passphrase is incorrect or the vault data has been altered.';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/* ------------------------------------------------------------------ */
/* Small validators                                                    */
/* ------------------------------------------------------------------ */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REMINDER_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const REVISION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Opaque id made of URL-safe characters (used inside AAD strings, so no ':'). */
export function isDocumentId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** A real calendar date in YYYY-MM-DD form (rejects 2027-02-29, 2026-13-01, ...). */
export function isValidLocalDate(value: unknown): value is string {
  return typeof value === 'string' && parseLocalDate(value) !== null;
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  // Local noon: calendar arithmetic there never crosses a daylight-saving boundary.
  const date = new Date(year, month - 1, day, 12);
  date.setFullYear(year);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function formatLocalDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fail(message: string): never {
  throw new Error(message);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** New id for a document, revision or attachment (unique, URL-safe). */
export function newDocumentId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : randomHex(16);
}

/** New opaque key for the plaintext reminder schedule. */
export function newReminderKey(): string {
  return randomHex(16);
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/** Detects the type from the file's first bytes (never from its name or MIME type). */
export function sniffDocumentType(bytes: Uint8Array): DocumentMime | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  return null;
}

const EXTENSIONS: Record<DocumentMime, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** Strips path parts and control characters, keeps the extension when shortening. */
function cleanFilename(name: string, mimeType: DocumentMime): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const fallback = `document.${EXTENSIONS[mimeType]}`;
  if (!base) return fallback;
  const max = DOCUMENT_LIMITS.maxFilename;
  if (base.length <= max) return base;
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
  return base.slice(0, max - extension.length).trimEnd() + extension;
}

/** Checks a picked file. Throws a user-facing Error when it cannot be added. */
export function validateDocumentFile(file: { name: string; size: number; bytes: Uint8Array }): { filename: string; mimeType: DocumentMime } {
  const length = file.bytes.length;
  if (length === 0 || file.size === 0) fail('This file is empty. Choose another file.');
  if (length > DOCUMENT_LIMITS.maxFileBytes || file.size > DOCUMENT_LIMITS.maxFileBytes) {
    fail(`Files can be up to ${formatFileSize(DOCUMENT_LIMITS.maxFileBytes)}. This file is ${formatFileSize(Math.max(length, file.size))}.`);
  }
  if (length !== file.size) fail('The whole file could not be read. Try choosing it again.');
  const mimeType = sniffDocumentType(file.bytes);
  if (!mimeType) {
    fail('Only PDF, JPEG and PNG files can be added. This file is not one of them (its contents are checked, not its name).');
  }
  return { filename: cleanFilename(String(file.name ?? ''), mimeType), mimeType };
}

/* ------------------------------------------------------------------ */
/* Index                                                               */
/* ------------------------------------------------------------------ */

/** Validates reminder offsets (days before expiry): unique integers 0..365, at most 5, largest first. */
export function normalizeReminderDays(value: unknown): number[] {
  if (!Array.isArray(value)) fail('Reminder days must be a list of numbers.');
  if (value.length > MAX_REMINDER_OFFSETS) fail(`Choose at most ${MAX_REMINDER_OFFSETS} reminders per document.`);
  for (const days of value) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_REMINDER_DAY) {
      fail(`Choose reminders between 0 and ${MAX_REMINDER_DAY} days before expiry.`);
    }
  }
  if (new Set(value).size !== value.length) fail('Each reminder day can be used only once.');
  return [...(value as number[])].sort((a, b) => b - a);
}

function readText(value: unknown, label: string, max: number, required: boolean): string {
  if (typeof value !== 'string' || CONTROL_CHARS.test(value.replace(/[\t\n\r]/g, ' '))) fail(`${label} is not valid text.`);
  const text = cleanText(value);
  if (required && !text) fail(`${label} cannot be empty.`);
  if (text.length > max) fail(`${label} can be up to ${max} characters.`);
  return text;
}

function readLinkId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || CONTROL_CHARS.test(value)) {
    fail(`The ${label} link is not valid.`);
  }
  return value;
}

function readRevision(value: unknown): DocumentRevision {
  if (!isObject(value)) fail('A document revision is damaged.');
  if (!isDocumentId(value.id) || !isDocumentId(value.attachmentId)) fail('A document revision has an invalid id.');
  if (typeof value.mimeType !== 'string' || !DOCUMENT_MIME_TYPES.includes(value.mimeType as DocumentMime)) {
    fail('A document revision has an unsupported file type.');
  }
  const mimeType = value.mimeType as DocumentMime;
  const filename = readText(value.filename, 'The file name', DOCUMENT_LIMITS.maxFilename, true);
  if (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 1 || value.size > DOCUMENT_LIMITS.maxFileBytes) {
    fail(`A file must be between 1 byte and ${formatFileSize(DOCUMENT_LIMITS.maxFileBytes)}.`);
  }
  if (!isTimestamp(value.addedAt)) fail('A document revision has an invalid date.');
  if (value.expiresOn !== undefined && !isValidLocalDate(value.expiresOn)) fail('Choose a valid expiry date.');
  const note = value.note === undefined ? undefined : readText(value.note, 'The revision note', MAX_NOTE, false);
  const revision: DocumentRevision = {
    id: value.id, filename, mimeType, size: value.size, attachmentId: value.attachmentId, addedAt: value.addedAt,
  };
  if (value.expiresOn !== undefined) revision.expiresOn = value.expiresOn as string;
  if (note) revision.note = note;
  return revision;
}

function readDocument(value: unknown): VaultDocument {
  if (!isObject(value)) fail('A document entry is damaged.');
  if (!isDocumentId(value.id)) fail('A document has an invalid id.');
  const title = readText(value.title, 'The title', DOCUMENT_LIMITS.maxTitle, true);
  const category = readText(value.category, 'The category', DOCUMENT_LIMITS.maxCategory, false);
  const assetId = readLinkId(value.assetId, 'vehicle or home');
  const serviceRecordId = readLinkId(value.serviceRecordId, 'service record');
  if (serviceRecordId && !assetId) fail('A service record link needs its vehicle or home link too.');
  const reminderDays = normalizeReminderDays(value.reminderDays);
  if (typeof value.reminderKey !== 'string' || !REMINDER_KEY_PATTERN.test(value.reminderKey)) {
    fail('A document has an invalid reminder key.');
  }
  if (!Array.isArray(value.revisions) || value.revisions.length === 0) fail(`"${title}" has no file.`);
  if (value.revisions.length > DOCUMENT_LIMITS.maxRevisionsPerDocument) {
    fail(`A document can keep up to ${DOCUMENT_LIMITS.maxRevisionsPerDocument} revisions. Delete an old revision of "${title}" first.`);
  }
  const revisions = value.revisions.map(readRevision);
  if (!revisions.some((revision) => revision.id === value.currentRevisionId)) fail(`"${title}" has no current revision.`);
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) fail(`"${title}" has an invalid date.`);
  const document: VaultDocument = {
    id: value.id,
    title,
    category,
    reminderDays,
    reminderKey: value.reminderKey,
    currentRevisionId: value.currentRevisionId as string,
    revisions,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (assetId) document.assetId = assetId;
  if (serviceRecordId) document.serviceRecordId = serviceRecordId;
  return document;
}

/**
 * Strict validation of a decrypted (or about-to-be-encrypted) index. Rebuilds every
 * object so unknown fields are dropped. Throws a user-facing Error.
 */
export function parseDocumentIndex(value: unknown): DocumentIndex {
  if (!isObject(value) || value.version !== 1) fail('The document index is damaged or uses an unsupported format.');
  if (typeof value.showReminderTitles !== 'boolean') fail('The document index is damaged.');
  if (!Array.isArray(value.documents)) fail('The document index is damaged.');
  if (value.documents.length > DOCUMENT_LIMITS.maxDocuments) {
    fail(`The vault can hold up to ${DOCUMENT_LIMITS.maxDocuments} documents.`);
  }
  const documents = value.documents.map(readDocument);
  // Ids (documents, revisions, attachments) and reminder keys are unique across the whole vault.
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const document of documents) {
    for (const id of [document.id, ...document.revisions.flatMap((revision) => [revision.id, revision.attachmentId])]) {
      if (ids.has(id)) fail('The document index contains a duplicate id.');
      ids.add(id);
    }
    if (keys.has(document.reminderKey)) fail('The document index contains a duplicate reminder key.');
    keys.add(document.reminderKey);
  }
  const index: DocumentIndex = { version: 1, showReminderTitles: value.showReminderTitles, documents };
  checkVaultLimits(index);
  return index;
}

export function currentRevision(doc: VaultDocument): DocumentRevision {
  const revision = doc.revisions.find((candidate) => candidate.id === doc.currentRevisionId);
  if (!revision) throw new Error(`"${doc.title}" has no current revision.`);
  return revision;
}

/** Total plaintext bytes of every stored revision. */
export function vaultUsageBytes(index: DocumentIndex): number {
  return index.documents.reduce(
    (total, document) => total + document.revisions.reduce((sum, revision) => sum + revision.size, 0), 0,
  );
}

/** Throws a user-facing Error when the index exceeds a vault limit. */
export function checkVaultLimits(index: DocumentIndex): void {
  if (index.documents.length > DOCUMENT_LIMITS.maxDocuments) {
    fail(`The vault can hold up to ${DOCUMENT_LIMITS.maxDocuments} documents. Delete a document first.`);
  }
  for (const document of index.documents) {
    if (document.revisions.length > DOCUMENT_LIMITS.maxRevisionsPerDocument) {
      fail(`A document can keep up to ${DOCUMENT_LIMITS.maxRevisionsPerDocument} revisions. Delete an old revision of "${document.title}" first.`);
    }
    for (const revision of document.revisions) {
      if (revision.size > DOCUMENT_LIMITS.maxFileBytes) {
        fail(`Files can be up to ${formatFileSize(DOCUMENT_LIMITS.maxFileBytes)}.`);
      }
    }
  }
  const usage = vaultUsageBytes(index);
  if (usage > DOCUMENT_LIMITS.maxVaultBytes) {
    fail(`The vault can hold up to ${formatFileSize(DOCUMENT_LIMITS.maxVaultBytes)} of files (this change needs ${formatFileSize(usage)}). Delete a document or an old revision first.`);
  }
}

/** Every attachment id the index refers to. */
export function attachmentIds(index: DocumentIndex): Set<string> {
  return new Set(index.documents.flatMap((document) => document.revisions.map((revision) => revision.attachmentId)));
}

/* ------------------------------------------------------------------ */
/* Index edits (pure; seal + commit the result)                         */
/* ------------------------------------------------------------------ */

export interface NewRevisionInput {
  attachmentId: string;
  file: { filename: string; mimeType: DocumentMime; size: number };
  expiresOn?: string;
  note?: string;
}

export interface DocumentDetailsInput {
  title: string;
  category: string;
  assetId?: string | null;
  serviceRecordId?: string | null;
  reminderDays?: number[];
}

function buildRevision(input: NewRevisionInput, now: string): DocumentRevision {
  const revision: DocumentRevision = {
    id: newDocumentId(),
    filename: input.file.filename,
    mimeType: input.file.mimeType,
    size: input.file.size,
    attachmentId: input.attachmentId,
    addedAt: now,
  };
  if (input.expiresOn) revision.expiresOn = input.expiresOn;
  if (input.note && input.note.trim()) revision.note = input.note.trim();
  return readRevision(revision);
}

function findDocument(index: DocumentIndex, documentId: string): VaultDocument {
  const document = index.documents.find((candidate) => candidate.id === documentId);
  if (!document) fail('This document no longer exists. It may have been deleted.');
  return document;
}

function replaceDocument(index: DocumentIndex, document: VaultDocument): DocumentIndex {
  return parseDocumentIndex({
    ...index,
    documents: index.documents.map((candidate) => (candidate.id === document.id ? document : candidate)),
  });
}

/** Adds a document with its first revision. `now` is an ISO timestamp. */
export function addDocument(
  index: DocumentIndex,
  input: DocumentDetailsInput & NewRevisionInput,
  now: string,
): { index: DocumentIndex; document: VaultDocument } {
  if (index.documents.length >= DOCUMENT_LIMITS.maxDocuments) {
    fail(`The vault can hold up to ${DOCUMENT_LIMITS.maxDocuments} documents. Delete a document first.`);
  }
  const revision = buildRevision(input, now);
  const draft = {
    id: newDocumentId(),
    title: input.title,
    category: input.category,
    assetId: input.assetId ?? undefined,
    serviceRecordId: input.serviceRecordId ?? undefined,
    reminderDays: input.reminderDays ?? DEFAULT_DOCUMENT_REMINDER_DAYS,
    reminderKey: newReminderKey(),
    currentRevisionId: revision.id,
    revisions: [revision],
    createdAt: now,
    updatedAt: now,
  };
  const document = readDocument(draft);
  return { index: parseDocumentIndex({ ...index, documents: [...index.documents, document] }), document };
}

/** Renewal: a new file (and expiry) becomes the current revision; old ones are kept. */
export function addDocumentRevision(index: DocumentIndex, documentId: string, input: NewRevisionInput, now: string): DocumentIndex {
  const document = findDocument(index, documentId);
  if (document.revisions.length >= DOCUMENT_LIMITS.maxRevisionsPerDocument) {
    fail(`A document can keep up to ${DOCUMENT_LIMITS.maxRevisionsPerDocument} revisions. Delete an old revision first.`);
  }
  const revision = buildRevision(input, now);
  return replaceDocument(index, {
    ...document, revisions: [...document.revisions, revision], currentRevisionId: revision.id, updatedAt: now,
  });
}

/** Edits title, category, links and reminder days. */
export function updateDocumentDetails(
  index: DocumentIndex,
  documentId: string,
  patch: Partial<DocumentDetailsInput>,
  now: string,
): DocumentIndex {
  const document = findDocument(index, documentId);
  const next: Record<string, unknown> = { ...document, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.category !== undefined) next.category = patch.category;
  if (patch.reminderDays !== undefined) next.reminderDays = patch.reminderDays;
  if (patch.assetId !== undefined) {
    next.assetId = patch.assetId || undefined;
    if (!patch.assetId) next.serviceRecordId = undefined;
  }
  if (patch.serviceRecordId !== undefined) next.serviceRecordId = patch.serviceRecordId || undefined;
  return replaceDocument(index, readDocument(next));
}

/** Edits a revision's expiry date or note. */
export function updateRevisionDetails(
  index: DocumentIndex,
  documentId: string,
  revisionId: string,
  patch: { expiresOn?: string | null; note?: string | null },
  now: string,
): DocumentIndex {
  const document = findDocument(index, documentId);
  if (!document.revisions.some((revision) => revision.id === revisionId)) fail('This revision no longer exists.');
  const revisions = document.revisions.map((revision) => {
    if (revision.id !== revisionId) return revision;
    const next: Record<string, unknown> = { ...revision };
    if (patch.expiresOn !== undefined) next.expiresOn = patch.expiresOn || undefined;
    if (patch.note !== undefined) next.note = patch.note?.trim() || undefined;
    return readRevision(next);
  });
  return replaceDocument(index, { ...document, revisions, updatedAt: now });
}

/** Deletes an old (non-current) revision. Delete its attachment in the same commit. */
export function deleteDocumentRevision(
  index: DocumentIndex,
  documentId: string,
  revisionId: string,
  now: string,
): { index: DocumentIndex; removedAttachmentIds: string[] } {
  const document = findDocument(index, documentId);
  const revision = document.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision) fail('This revision no longer exists.');
  if (revision.id === document.currentRevisionId) fail('The current revision cannot be deleted. Delete the document instead.');
  const next = replaceDocument(index, {
    ...document, revisions: document.revisions.filter((candidate) => candidate.id !== revisionId), updatedAt: now,
  });
  return { index: next, removedAttachmentIds: [revision.attachmentId] };
}

/** Deletes a document with every revision. Delete the returned attachments in the same commit. */
export function removeDocument(index: DocumentIndex, documentId: string): { index: DocumentIndex; removedAttachmentIds: string[] } {
  const document = findDocument(index, documentId);
  return {
    index: parseDocumentIndex({ ...index, documents: index.documents.filter((candidate) => candidate.id !== documentId) }),
    removedAttachmentIds: document.revisions.map((revision) => revision.attachmentId),
  };
}

export function setShowReminderTitles(index: DocumentIndex, show: boolean): DocumentIndex {
  return parseDocumentIndex({ ...index, showReminderTitles: show });
}

/* ------------------------------------------------------------------ */
/* Expiry and reminders                                                */
/* ------------------------------------------------------------------ */

/** Local reminder dates for an expiry, ascending. Calendar arithmetic at local noon. */
export function documentReminderDates(expiresOn: string, reminderDays: number[]): string[] {
  const expiry = parseLocalDate(expiresOn);
  if (!expiry) throw new Error('Choose a valid expiry date.');
  return normalizeReminderDays([...new Set(reminderDays)]).map((days) => {
    const date = new Date(expiry);
    date.setDate(date.getDate() - days);
    return formatLocalDate(date);
  }).sort();
}

/** Whole days from `today` to `expiresOn` (negative once expired). Both local YYYY-MM-DD. */
export function daysUntilExpiry(expiresOn: string, today: string): number {
  const expiry = parseLocalDate(expiresOn);
  const start = parseLocalDate(today);
  if (!expiry || !start) throw new Error('Choose a valid expiry date.');
  return Math.round((expiry.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Plaintext reminder schedule: one entry per reminder date of each document's
 * CURRENT revision that has an expiry. Titles only when the user opted in.
 */
export function documentReminderEntries(index: DocumentIndex): DocumentReminderEntry[] {
  const entries: DocumentReminderEntry[] = [];
  for (const document of index.documents) {
    const revision = currentRevision(document);
    if (!revision.expiresOn) continue;
    for (const date of documentReminderDates(revision.expiresOn, document.reminderDays)) {
      const entry: DocumentReminderEntry = { key: document.reminderKey, date, expiresOn: revision.expiresOn };
      if (index.showReminderTitles) entry.label = document.title;
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ */
/* Encryption                                                          */
/* ------------------------------------------------------------------ */

function indexPurpose(vaultId: string): string {
  return `dayflow-documents:v1:${vaultId}:index`;
}

function blobPurpose(vaultId: string, attachmentId: string): string {
  return `dayflow-documents:v1:${vaultId}:blob:${attachmentId}`;
}

function newRevisionId(): string {
  return randomHex(16);
}

/** Structural validation of an envelope (from storage or a backup). Rebuilds it. */
export function readDocumentEnvelope(value: unknown): DocumentEnvelope {
  if (!isObject(value) || value.format !== 'dayflow-documents') fail('This is not a Dayflow document vault.');
  if (value.version !== 1) fail('This document vault was made by a newer version of Dayflow. Update the app and try again.');
  if (typeof value.revision !== 'string' || !REVISION_PATTERN.test(value.revision)) fail('The document vault is damaged.');
  let header: VaultFile;
  try {
    header = readVaultFile(JSON.stringify(value.header ?? null));
  } catch {
    fail('The document vault is damaged.');
  }
  const index = value.index;
  if (!isObject(index) || !isStrictBase64(index.nonce) || !isStrictBase64(index.ciphertext)) {
    fail('The document vault is damaged.');
  }
  const nonceLength = base64ToBytes(index.nonce).length;
  // Base64 length bounds the ciphertext without decoding it.
  const cipherChars = index.ciphertext.length;
  if (nonceLength !== 12 || cipherChars < 24 || cipherChars > Math.ceil((MAX_INDEX_BYTES + TAG_BYTES) / 3) * 4) {
    fail('The document vault is damaged.');
  }
  return {
    format: 'dayflow-documents',
    version: 1,
    revision: value.revision,
    header,
    index: { nonce: index.nonce, ciphertext: index.ciphertext },
  };
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

/** Structural validation of one stored blob. Returns a rebuilt copy. */
export function readStoredBlob(value: unknown): StoredBlob {
  if (!isObject(value) || !isStrictBase64(value.nonce) || base64ToBytes(value.nonce).length !== 12 || !isUint8Array(value.ciphertext)) {
    fail('A stored file is damaged.');
  }
  const length = value.ciphertext.length;
  if (length <= TAG_BYTES || length > DOCUMENT_LIMITS.maxFileBytes + TAG_BYTES) fail('A stored file is damaged.');
  return { nonce: value.nonce, ciphertext: value.ciphertext };
}

/** New, empty vault (not stored yet: commit it with `expectedRevision: null`). */
export async function createDocumentVault(passphrase: string): Promise<DocumentSession> {
  const { key, file } = await createVault(passphrase, []);
  const index: DocumentIndex = { version: 1, showReminderTitles: false, documents: [] };
  const draft: DocumentEnvelope = {
    format: 'dayflow-documents',
    version: 1,
    revision: newRevisionId(),
    header: file,
    index: { nonce: '', ciphertext: '' },
  };
  const envelope = await sealDocumentIndex({ key, envelope: draft, index }, index);
  return { key, envelope, index };
}

/** Opens a vault. A wrong passphrase and altered data give the same message. */
export async function unlockDocumentVault(envelope: DocumentEnvelope, passphrase: string): Promise<DocumentSession> {
  const checked = readDocumentEnvelope(envelope);
  let key: CryptoKey;
  let bytes: Uint8Array | undefined;
  let decoded: unknown;
  try {
    const opened = await openVault(checked.header, passphrase);
    if (opened.entries.length !== 0) throw new Error('not a document vault header');
    key = opened.key;
    bytes = await decryptVaultBytes(
      key, { nonce: checked.index.nonce, ciphertext: base64ToBytes(checked.index.ciphertext) }, indexPurpose(checked.header.id),
    );
    decoded = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(WRONG_PASSPHRASE_MESSAGE);
  } finally {
    bytes?.fill(0);
  }
  let index: DocumentIndex;
  try {
    index = parseDocumentIndex(decoded);
  } catch (error) {
    throw new Error(`The document vault is damaged and cannot be opened: ${(error as Error).message}`);
  }
  return { key, envelope: checked, index };
}

/**
 * Validates the index (structure and limits) and encrypts it into a new envelope
 * with a fresh random revision. The session is not changed; after the commit
 * succeeds use `{ ...session, envelope, index: parseDocumentIndex(index) }`.
 */
export async function sealDocumentIndex(session: DocumentSession, index: DocumentIndex): Promise<DocumentEnvelope> {
  const checked = parseDocumentIndex(index);
  const bytes = encoder.encode(JSON.stringify(checked));
  try {
    if (bytes.length > MAX_INDEX_BYTES) fail('The document list is too large to save. Delete some documents or revisions.');
    const sealed = await encryptVaultBytes(session.key, bytes, indexPurpose(session.envelope.header.id));
    return {
      format: 'dayflow-documents',
      version: 1,
      revision: newRevisionId(),
      header: session.envelope.header,
      index: { nonce: sealed.nonce, ciphertext: bytesToBase64(sealed.ciphertext) },
    };
  } finally {
    bytes.fill(0);
  }
}

export async function encryptAttachment(session: DocumentSession, attachmentId: string, bytes: Uint8Array): Promise<StoredBlob> {
  if (!isDocumentId(attachmentId)) fail('The file id is not valid.');
  if (bytes.length === 0) fail('This file is empty. Choose another file.');
  if (bytes.length > DOCUMENT_LIMITS.maxFileBytes) {
    fail(`Files can be up to ${formatFileSize(DOCUMENT_LIMITS.maxFileBytes)}.`);
  }
  return encryptVaultBytes(session.key, bytes, blobPurpose(session.envelope.header.id, attachmentId));
}

export async function decryptAttachment(session: DocumentSession, attachmentId: string, blob: StoredBlob): Promise<Uint8Array> {
  try {
    const checked = readStoredBlob(blob);
    return await decryptVaultBytes(session.key, checked, blobPurpose(session.envelope.header.id, attachmentId));
  } catch {
    throw new Error('This file could not be decrypted. It is damaged or has been altered.');
  }
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

export const DOCUMENT_BACKUP_FORMAT = 'dayflow-documents-backup';

/** Ciphertext-only backup file (JSON). Blobs are written in id order. */
export function buildDocumentBackup(envelope: DocumentEnvelope, blobs: Map<string, StoredBlob>, createdAt: string): string {
  const checked = readDocumentEnvelope(envelope);
  if (!isTimestamp(createdAt)) fail('The backup date is not valid.');
  if (blobs.size > MAX_ATTACHMENTS) fail('The vault has more files than a backup can hold.');
  const entries = [...blobs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, blob]) => {
    if (!isDocumentId(id)) fail('A stored file has an invalid id.');
    const stored = readStoredBlob(blob);
    return { id, nonce: stored.nonce, ciphertext: bytesToBase64(stored.ciphertext) };
  });
  const text = JSON.stringify({ format: DOCUMENT_BACKUP_FORMAT, version: 1, createdAt, envelope: checked, blobs: entries });
  if (text.length > DOCUMENT_LIMITS.maxBackupBytes) {
    fail(`The backup would be larger than ${formatFileSize(DOCUMENT_LIMITS.maxBackupBytes)}. Delete some documents and try again.`);
  }
  return text;
}

/**
 * Structural validation of a backup file (no passphrase needed). Throws a
 * user-facing Error. Use `verifyDocumentBackup` before writing anything.
 */
export function parseDocumentBackup(text: string): { envelope: DocumentEnvelope; blobs: Map<string, StoredBlob> } {
  if (typeof text !== 'string' || text.length === 0) fail('This backup file is empty.');
  if (text.length > DOCUMENT_LIMITS.maxBackupBytes) {
    fail(`This file is larger than ${formatFileSize(DOCUMENT_LIMITS.maxBackupBytes)}, so it cannot be a Dayflow document backup.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('Choose a Dayflow document vault backup file (.json). This file could not be read.');
  }
  if (!isObject(value) || value.format !== DOCUMENT_BACKUP_FORMAT) fail('This file is not a Dayflow document vault backup.');
  if (value.version !== 1) fail('This backup was made by a newer version of Dayflow. Update the app and try again.');
  if (!isTimestamp(value.createdAt)) fail('This backup is damaged (invalid date).');
  let envelope: DocumentEnvelope;
  try {
    envelope = readDocumentEnvelope(value.envelope);
  } catch {
    fail('This backup is damaged (the vault header is invalid).');
  }
  if (!Array.isArray(value.blobs)) fail('This backup is damaged (the file list is missing).');
  if (value.blobs.length > MAX_ATTACHMENTS) fail('This backup has more files than a vault can hold.');
  const blobs = new Map<string, StoredBlob>();
  let total = 0;
  for (const item of value.blobs) {
    if (!isObject(item) || !isDocumentId(item.id)) fail('This backup is damaged (a file has an invalid id).');
    if (blobs.has(item.id)) fail('This backup is damaged (a file appears twice).');
    if (!isStrictBase64(item.nonce) || !isStrictBase64(item.ciphertext)) fail('This backup is damaged (a file is not valid base64).');
    const nonce = base64ToBytes(item.nonce);
    if (nonce.length !== 12) fail('This backup is damaged (a file has an invalid nonce).');
    if (item.ciphertext.length > Math.ceil((DOCUMENT_LIMITS.maxFileBytes + TAG_BYTES) / 3) * 4) {
      fail(`This backup contains a file larger than ${formatFileSize(DOCUMENT_LIMITS.maxFileBytes)}.`);
    }
    const ciphertext = base64ToBytes(item.ciphertext);
    if (ciphertext.length <= TAG_BYTES) fail('This backup is damaged (a file is truncated).');
    if (ciphertext.length > DOCUMENT_LIMITS.maxFileBytes + TAG_BYTES) {
      fail(`This backup contains a file larger than ${formatFileSize(DOCUMENT_LIMITS.maxFileBytes)}.`);
    }
    total += ciphertext.length - TAG_BYTES;
    if (total > DOCUMENT_LIMITS.maxVaultBytes) {
      fail(`This backup holds more than ${formatFileSize(DOCUMENT_LIMITS.maxVaultBytes)} of files.`);
    }
    blobs.set(item.id, { nonce: item.nonce, ciphertext });
  }
  return { envelope, blobs };
}

/**
 * Opens the backup with its passphrase and checks EVERYTHING before a restore
 * writes anything: the index decrypts and validates, every referenced file is
 * present (and nothing else), and every file decrypts under its own id with the
 * recorded size and type.
 */
export async function verifyDocumentBackup(
  parsed: { envelope: DocumentEnvelope; blobs: Map<string, StoredBlob> },
  passphrase: string,
): Promise<DocumentSession> {
  const session = await unlockDocumentVault(parsed.envelope, passphrase);
  const revisions = new Map<string, DocumentRevision>();
  for (const document of session.index.documents) {
    for (const revision of document.revisions) revisions.set(revision.attachmentId, revision);
  }
  const missing = [...revisions.keys()].filter((id) => !parsed.blobs.has(id)).length;
  if (missing > 0) fail(`This backup is incomplete: ${missing} file${missing === 1 ? ' is' : 's are'} missing. Nothing was restored.`);
  const extra = [...parsed.blobs.keys()].filter((id) => !revisions.has(id)).length;
  if (extra > 0) fail(`This backup is damaged: it contains ${extra} file${extra === 1 ? '' : 's'} that no document uses. Nothing was restored.`);
  for (const [id, blob] of parsed.blobs) {
    const revision = revisions.get(id)!;
    let bytes: Uint8Array | undefined;
    try {
      try {
        bytes = await decryptVaultBytes(session.key, blob, blobPurpose(session.envelope.header.id, id));
      } catch {
        fail(`"${revision.filename}" in this backup is damaged or has been altered. Nothing was restored.`);
      }
      if (bytes.length !== revision.size || sniffDocumentType(bytes) !== revision.mimeType) {
        fail(`"${revision.filename}" in this backup does not match its record. Nothing was restored.`);
      }
    } finally {
      bytes?.fill(0);
    }
  }
  return session;
}
