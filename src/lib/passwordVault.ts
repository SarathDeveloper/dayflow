import { argon2idAsync } from '@noble/hashes/argon2.js';

export const MIN_VAULT_PASSPHRASE = 15;
export const MAX_VAULT_FILE = 2 * 1024 * 1024;

export interface VaultEntry {
  id: string;
  title: string;
  website: string;
  username: string;
  password: string;
  notes: string;
}

interface SealedValue {
  nonce: string;
  ciphertext: string;
}

export interface VaultFile {
  format: 'dayflow-password-vault';
  version: 1;
  id: string;
  salt: string;
  wrappedKey: SealedValue;
  entries: SealedValue;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fieldLimits = { title: 200, website: 2048, username: 512, password: 1024, notes: 4000 } as const;

function encodeText(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length * 3);
  const { written } = encoder.encodeInto(value, bytes);
  return bytes.subarray(0, written);
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBase64(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string') return false;
  try {
    const decoded = decode(value);
    return bytes === undefined ? decoded.length >= 16 : decoded.length === bytes;
  } catch {
    return false;
  }
}

function isSealed(value: unknown, bytes?: number): value is SealedValue {
  return isObject(value) && isBase64(value.nonce, 12) && isBase64(value.ciphertext, bytes);
}

export function readVaultFile(text: string): VaultFile {
  if (text.length > MAX_VAULT_FILE) throw new Error('The vault file exceeds 2 MB.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Choose a Dayflow encrypted vault backup.');
  }
  if (
    !isObject(value) || value.format !== 'dayflow-password-vault' || value.version !== 1 ||
    !isBase64(value.id, 16) || !isBase64(value.salt, 16) ||
    !isSealed(value.wrappedKey, 48) || !isSealed(value.entries)
  ) {
    throw new Error('This vault file is damaged or uses an unsupported format.');
  }
  // Reconstruct the envelope so imported files cannot persist extra fields.
  return {
    format: value.format,
    version: value.version,
    id: value.id,
    salt: value.salt,
    wrappedKey: { nonce: value.wrappedKey.nonce, ciphertext: value.wrappedKey.ciphertext },
    entries: { nonce: value.entries.nonce, ciphertext: value.entries.ciphertext },
  };
}

function isEntry(value: unknown): value is VaultEntry {
  return isObject(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 64 &&
    Object.entries(fieldLimits).every(([field, limit]) =>
      typeof value[field] === 'string' && value[field].length <= limit,
    ) && Boolean(value.title) && Boolean(value.password);
}

function readEntries(value: unknown): VaultEntry[] {
  if (!Array.isArray(value) || !value.every(isEntry) || new Set(value.map((entry) => entry.id)).size !== value.length) {
    throw new Error('The vault entries are damaged.');
  }
  return value.map(({ id, title, website, username, password, notes }) =>
    ({ id, title, website, username, password, notes }),
  );
}

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (passphrase.length > 256) throw new Error('Use a passphrase of up to 256 characters.');
  // Parameters belong to format version 1. A backup cannot supply its own work factor.
  const input = encodeText(passphrase);
  let derived: Uint8Array<ArrayBuffer> | undefined;
  try {
    derived = await argon2idAsync(input, salt, { m: 65536, t: 3, p: 4, dkLen: 32 });
    return await importKey(derived);
  } finally {
    input.fill(0);
    derived?.fill(0);
  }
}

function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function context(id: string, purpose: 'key' | 'entries'): Uint8Array<ArrayBuffer> {
  return encodeText(`dayflow-password-vault:v1:${id}:${purpose}`);
}

async function seal(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>, additionalData: Uint8Array<ArrayBuffer>): Promise<SealedValue> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData }, key, bytes);
  return { nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
}

async function unseal(key: CryptoKey, value: SealedValue, additionalData: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(value.nonce), additionalData }, key, decode(value.ciphertext),
  );
  return new Uint8Array(data);
}

// Creating a new envelope also rotates the data key when changing passphrases.
export async function createVault(passphrase: string, entries: VaultEntry[] = []) {
  if (passphrase.trim().length < MIN_VAULT_PASSPHRASE) {
    throw new Error(`Use a vault passphrase of at least ${MIN_VAULT_PASSPHRASE} characters.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const id = encode(crypto.getRandomValues(new Uint8Array(16)));
  const wrappingKey = await passphraseKey(passphrase, salt);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const key = await importKey(rawKey);
    const file: VaultFile = {
      format: 'dayflow-password-vault',
      version: 1,
      id,
      salt: encode(salt),
      wrappedKey: await seal(wrappingKey, rawKey, context(id, 'key')),
      entries: await sealEntries(id, key, entries),
    };
    return { key, file, entries };
  } finally {
    rawKey.fill(0);
  }
}

export async function openVault(file: VaultFile, passphrase: string) {
  const wrappingKey = await passphraseKey(passphrase, decode(file.salt));
  let rawKey: Uint8Array<ArrayBuffer> | undefined;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    rawKey = await unseal(wrappingKey, file.wrappedKey, context(file.id, 'key'));
    const key = await importKey(rawKey);
    bytes = await unseal(key, file.entries, context(file.id, 'entries'));
    return { key, file, entries: readEntries(JSON.parse(decoder.decode(bytes))) };
  } catch {
    throw new Error('The passphrase is incorrect or the vault data has been altered.');
  } finally {
    rawKey?.fill(0);
    bytes?.fill(0);
  }
}

export async function sealEntries(id: string, key: CryptoKey, entries: VaultEntry[]): Promise<SealedValue> {
  const bytes = encodeText(JSON.stringify(readEntries(entries)));
  try {
    if (bytes.length > MAX_VAULT_FILE * 0.7) throw new Error('The vault is full. Remove an entry and try again.');
    return await seal(key, bytes, context(id, 'entries'));
  } finally {
    bytes.fill(0);
  }
}

/*
 * Synced format (v2). The vault is split so two devices can edit different
 * logins at once: one header (salt + wrapped data key, same wrapping as v1) and
 * one encrypted record per login. A passphrase change only re-wraps the data
 * key, so the login records stay valid on every device.
 */

export interface VaultHeader {
  /** Same random id as a v1 file, so a migrated vault keeps its key bindings. */
  vaultId: string;
  salt: string;
  wrappedKey: SealedValue;
  updatedAt: string;
}

/** One login, encrypted. The row id and `updatedAt` are bound as AES-GCM additional data. */
export interface VaultRecord {
  nonce: string;
  ciphertext: string;
  updatedAt: string;
}

export const VAULT_ENTRY_PREFIX = 'vault-';

export function entryRowId(entryId: string): string {
  return `${VAULT_ENTRY_PREFIX}${entryId}`;
}

function recordContext(vaultId: string, rowId: string, updatedAt: string): Uint8Array<ArrayBuffer> {
  return encodeText(`dayflow-password-vault:v2:${vaultId}:entry:${rowId}:${updatedAt}`);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export function isVaultHeader(value: unknown): value is VaultHeader {
  return isObject(value) && isBase64(value.vaultId, 16) && isBase64(value.salt, 16) &&
    isSealed(value.wrappedKey, 48) && isIsoTime(value.updatedAt);
}

export function isVaultRecord(value: unknown): value is VaultRecord {
  return isObject(value) && isBase64(value.nonce, 12) && isBase64(value.ciphertext) &&
    value.ciphertext.length <= MAX_VAULT_FILE && isIsoTime(value.updatedAt);
}

/** Copies only the known fields, so stored or pulled objects cannot carry extras. */
export function cleanHeader(header: VaultHeader): VaultHeader {
  return {
    vaultId: header.vaultId,
    salt: header.salt,
    wrappedKey: { nonce: header.wrappedKey.nonce, ciphertext: header.wrappedKey.ciphertext },
    updatedAt: header.updatedAt,
  };
}

export function cleanRecord(record: VaultRecord): VaultRecord {
  return { nonce: record.nonce, ciphertext: record.ciphertext, updatedAt: record.updatedAt };
}

async function wrapNewKey(passphrase: string, vaultId: string, rawKey: Uint8Array<ArrayBuffer>) {
  if (passphrase.trim().length < MIN_VAULT_PASSPHRASE) {
    throw new Error(`Use a vault passphrase of at least ${MIN_VAULT_PASSPHRASE} characters.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await passphraseKey(passphrase, salt);
  return { salt: encode(salt), wrappedKey: await seal(wrappingKey, rawKey, context(vaultId, 'key')) };
}

async function unwrapRawKey(header: Pick<VaultHeader, 'vaultId' | 'salt' | 'wrappedKey'>, passphrase: string) {
  const wrappingKey = await passphraseKey(passphrase, decode(header.salt));
  try {
    return await unseal(wrappingKey, header.wrappedKey, context(header.vaultId, 'key'));
  } catch {
    throw new Error('The passphrase is incorrect.');
  }
}

/** A new, empty synced vault with a fresh data key. */
export async function createVaultHeader(passphrase: string, now: string) {
  const vaultId = encode(crypto.getRandomValues(new Uint8Array(16)));
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wrapped = await wrapNewKey(passphrase, vaultId, rawKey);
    return { header: { vaultId, ...wrapped, updatedAt: now }, key: await importKey(rawKey) };
  } finally {
    rawKey.fill(0);
  }
}

export async function unlockVaultHeader(header: VaultHeader, passphrase: string): Promise<CryptoKey> {
  const rawKey = await unwrapRawKey(header, passphrase);
  try {
    return await importKey(rawKey);
  } finally {
    rawKey.fill(0);
  }
}

/** Re-wraps the same data key under a new passphrase (the logins need no re-encryption). */
export async function rewrapVaultHeader(header: VaultHeader, current: string, next: string, now: string): Promise<VaultHeader> {
  const rawKey = await unwrapRawKey(header, current);
  try {
    return { vaultId: header.vaultId, ...(await wrapNewKey(next, header.vaultId, rawKey)), updatedAt: now };
  } finally {
    rawKey.fill(0);
  }
}

export async function sealVaultRecord(vaultId: string, key: CryptoKey, entry: VaultEntry, updatedAt: string): Promise<VaultRecord> {
  const [clean] = readEntries([entry]);
  const bytes = encodeText(JSON.stringify(clean));
  try {
    if (bytes.length > MAX_VAULT_FILE * 0.1) throw new Error('This login is too large.');
    const sealed = await seal(key, bytes, recordContext(vaultId, entryRowId(clean.id), updatedAt));
    return { ...sealed, updatedAt };
  } finally {
    bytes.fill(0);
  }
}

/** Throws when the record was altered, moved to another row or vault, or re-dated. */
export async function openVaultRecord(vaultId: string, key: CryptoKey, rowId: string, record: VaultRecord): Promise<VaultEntry> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    bytes = await unseal(key, record, recordContext(vaultId, rowId, record.updatedAt));
    const [entry] = readEntries([JSON.parse(decoder.decode(bytes))]);
    if (entryRowId(entry.id) !== rowId) throw new Error('mismatch');
    return entry;
  } catch {
    throw new Error('A vault login could not be decrypted.');
  } finally {
    bytes?.fill(0);
  }
}

/** The v1 file's key wrapping becomes the v2 header unchanged; only the logins are re-sealed. */
export async function migrateVaultFile(file: VaultFile, passphrase: string, now: string) {
  const opened = await openVault(file, passphrase);
  const header: VaultHeader = { vaultId: file.id, salt: file.salt, wrappedKey: file.wrappedKey, updatedAt: now };
  return { header, key: opened.key, entries: opened.entries };
}

/** A v1 backup file (the format every app version restores) from an unlocked v2 vault. */
export async function exportVaultFile(header: VaultHeader, key: CryptoKey, entries: VaultEntry[]): Promise<VaultFile> {
  return {
    format: 'dayflow-password-vault',
    version: 1,
    id: header.vaultId,
    salt: header.salt,
    wrappedKey: header.wrappedKey,
    entries: await sealEntries(header.vaultId, key, entries),
  };
}

function randomIndex(size: number): number {
  const value = new Uint32Array(1);
  const limit = 2 ** 32 - (2 ** 32 % size);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % size;
}

export function generateVaultPassword(length: number, digits: boolean, symbols: boolean): string {
  if (!Number.isInteger(length) || length < 8 || length > 64) throw new Error('Choose a length from 8 to 64.');
  const groups = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  if (digits) groups.push('0123456789');
  if (symbols) groups.push('!@#$%^&*()-_=+?');
  const alphabet = groups.join('');
  const password = groups.map((group) => group[randomIndex(group.length)]);
  while (password.length < length) password.push(alphabet[randomIndex(alphabet.length)]);
  for (let index = password.length - 1; index > 0; index--) {
    const swap = randomIndex(index + 1);
    [password[index], password[swap]] = [password[swap], password[index]];
  }
  return password.join('');
}

/*
 * Byte-level helpers for other encrypted stores (the document vault) that reuse this
 * module's key hierarchy. They never touch the password-vault format above.
 */

/** AES-GCM output whose ciphertext stays binary (for IndexedDB). */
export interface SealedBytes {
  nonce: string;
  ciphertext: Uint8Array;
}

function isBase64Char(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
}

/**
 * Canonical padded base64. A linear scan instead of a regex: V8's backtracking
 * regex overflows the stack on multi-megabyte strings (encrypted files).
 */
function isCanonicalBase64(value: string): boolean {
  const length = value.length;
  if (length % 4 !== 0) return false;
  let padding = 0;
  if (length > 0 && value.charCodeAt(length - 1) === 61) padding = value.charCodeAt(length - 2) === 61 ? 2 : 1;
  for (let index = 0; index < length - padding; index++) {
    if (!isBase64Char(value.charCodeAt(index))) return false;
  }
  return true;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return encode(bytes);
}

/** Canonical (padded, no whitespace) base64 only; throws on anything else. */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !isCanonicalBase64(value)) throw new Error('The data is not valid base64.');
  // An index loop is ~25x faster than Uint8Array.from on multi-megabyte files.
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function isStrictBase64(value: unknown): value is string {
  return typeof value === 'string' && isCanonicalBase64(value);
}

function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

/**
 * Encrypts `bytes` with a fresh 96-bit nonce. `purpose` is bound as AES-GCM
 * additional data, so ciphertext moved to another purpose fails to decrypt.
 */
export async function encryptVaultBytes(key: CryptoKey, bytes: Uint8Array, purpose: string): Promise<SealedBytes> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encodeText(purpose) }, key, ownBuffer(bytes),
  );
  return { nonce: encode(nonce), ciphertext: new Uint8Array(ciphertext) };
}

/** Rejects (DOMException / Error) when the key, nonce, purpose or ciphertext do not match. */
export async function decryptVaultBytes(key: CryptoKey, sealed: SealedBytes, purpose: string): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = base64ToBytes(sealed.nonce);
  if (nonce.length !== 12) throw new Error('The encrypted data has an invalid nonce.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encodeText(purpose) }, key, ownBuffer(sealed.ciphertext),
  );
  return new Uint8Array(plaintext);
}
