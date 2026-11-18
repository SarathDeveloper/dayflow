import { argon2idAsync } from '@noble/hashes/argon2.js';

export const MIN_VAULT_PASSPHRASE = 15;
export const MAX_VAULT_FILE = 2 * 1024 * 1024;

/** What a vault item holds. Missing means `login` (every item saved before kinds existed). */
export type VaultItemKind = 'login' | 'card' | 'wifi' | 'note';
export const VAULT_ITEM_KINDS: readonly VaultItemKind[] = ['login', 'card', 'wifi', 'note'];

export interface VaultCard {
  holder: string;
  number: string;
  /** MM/YY as typed. */
  expiry: string;
  cvv: string;
}

export interface PasswordHistoryItem {
  password: string;
  /** When this password was replaced. */
  changedAt: string;
}

export const MAX_PASSWORD_HISTORY = 5;

/**
 * One vault item. The optional fields are left out when unset, so items saved
 * before they existed (and v1 backups) read back unchanged. A Wi-Fi item keeps
 * the network name in `username`.
 */
export interface VaultEntry {
  id: string;
  title: string;
  website: string;
  username: string;
  password: string;
  notes: string;
  kind?: VaultItemKind;
  category?: string;
  favorite?: boolean;
  /** 2FA secret: base32, or an otpauth:// URI. */
  totp?: string;
  card?: VaultCard;
  /** Earlier passwords, newest first. */
  history?: PasswordHistoryItem[];
  passwordChangedAt?: string;
  /** In the trash since then; deleted for good after 30 days. */
  trashedAt?: string;
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

function isText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** Kinds that must carry a password. */
export function needsPassword(kind: VaultItemKind | undefined): boolean {
  return kind === undefined || kind === 'login' || kind === 'wifi';
}

function isCard(value: unknown): value is VaultCard {
  return isObject(value) && isText(value.holder, 200) && isText(value.number, 40) &&
    isText(value.expiry, 10) && isText(value.cvv, 8);
}

function isHistory(value: unknown): value is PasswordHistoryItem[] {
  return Array.isArray(value) && value.length <= MAX_PASSWORD_HISTORY &&
    value.every((item) => isObject(item) && isText(item.password, fieldLimits.password) && Boolean(item.password) && isTime(item.changedAt));
}

function isEntry(value: unknown): value is VaultEntry {
  if (!isObject(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64) return false;
  if (!Object.entries(fieldLimits).every(([field, limit]) => isText(value[field], limit))) return false;
  if (value.kind !== undefined && !VAULT_ITEM_KINDS.includes(value.kind as VaultItemKind)) return false;
  const kind = value.kind as VaultItemKind | undefined;
  return Boolean(value.title) && (!needsPassword(kind) || Boolean(value.password)) &&
    (value.category === undefined || isText(value.category, 40)) &&
    (value.favorite === undefined || typeof value.favorite === 'boolean') &&
    (value.totp === undefined || isText(value.totp, 512)) &&
    (value.card === undefined || isCard(value.card)) &&
    (value.history === undefined || isHistory(value.history)) &&
    (value.passwordChangedAt === undefined || isTime(value.passwordChangedAt)) &&
    (value.trashedAt === undefined || isTime(value.trashedAt));
}

/** Known fields only, optional ones only when set, so stored items carry nothing extra. */
function cleanEntry(entry: VaultEntry): VaultEntry {
  const { id, title, website, username, password, notes } = entry;
  const clean: VaultEntry = { id, title, website, username, password, notes };
  if (entry.kind && entry.kind !== 'login') clean.kind = entry.kind;
  if (entry.category) clean.category = entry.category;
  if (entry.favorite) clean.favorite = true;
  if (entry.totp) clean.totp = entry.totp;
  if (entry.card) {
    const { holder, number, expiry, cvv } = entry.card;
    clean.card = { holder, number, expiry, cvv };
  }
  if (entry.history?.length) {
    clean.history = entry.history.map(({ password: old, changedAt }) => ({ password: old, changedAt }));
  }
  if (entry.passwordChangedAt) clean.passwordChangedAt = entry.passwordChangedAt;
  if (entry.trashedAt) clean.trashedAt = entry.trashedAt;
  return clean;
}

function readEntries(value: unknown): VaultEntry[] {
  if (!Array.isArray(value) || !value.every(isEntry) || new Set(value.map((entry) => entry.id)).size !== value.length) {
    throw new Error('The vault entries are damaged.');
  }
  return value.map(cleanEntry);
}

/** Validates one item before it is saved; throws a message a person can act on. */
export function checkVaultEntry(entry: VaultEntry): VaultEntry {
  if (!entry.title.trim()) throw new Error('Enter a title.');
  if (needsPassword(entry.kind) && !entry.password) {
    throw new Error(entry.kind === 'wifi' ? 'Enter the Wi-Fi password.' : 'Enter a password.');
  }
  if (!isEntry(entry)) throw new Error('One of the fields is too long.');
  return cleanEntry(entry);
}

/**
 * The item as saved after an edit: a changed password moves the old one into
 * the history (newest first, at most five) and restarts its age.
 */
export function applyEntryEdit(previous: VaultEntry | undefined, next: VaultEntry, now: string): VaultEntry {
  if (!previous) return { ...next, passwordChangedAt: next.password ? now : undefined };
  if (previous.password === next.password) return next;
  const history = previous.password
    ? [{ password: previous.password, changedAt: now }, ...(previous.history ?? [])]
      .filter((item) => item.password !== next.password)
      .slice(0, MAX_PASSWORD_HISTORY)
    : previous.history;
  return { ...next, history: history?.length ? history : undefined, passwordChangedAt: next.password ? now : undefined };
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

/**
 * The vault's key holder. Two modes:
 * - account (current): `key` is the data key itself, kept with the signed-in
 *   account. No passphrase; the server could read it (not end-to-end).
 * - passphrase (older vaults): `salt` + `wrappedKey`, the data key wrapped
 *   with an argon2id key from a passphrase. Converted to account mode once
 *   the passphrase is entered.
 */
export interface VaultHeader {
  /** Same random id as a v1 file, so a migrated vault keeps its key bindings. */
  vaultId: string;
  salt?: string;
  wrappedKey?: SealedValue;
  /** Base64 data key (account mode). */
  key?: string;
  updatedAt: string;
}

export function isAccountHeader(header: VaultHeader): header is VaultHeader & { key: string } {
  return typeof header.key === 'string';
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
  if (!isObject(value) || !isBase64(value.vaultId, 16) || !isIsoTime(value.updatedAt)) return false;
  if (value.key !== undefined) return isBase64(value.key, 32) && value.salt === undefined && value.wrappedKey === undefined;
  return isBase64(value.salt, 16) && isSealed(value.wrappedKey, 48);
}

export function isVaultRecord(value: unknown): value is VaultRecord {
  return isObject(value) && isBase64(value.nonce, 12) && isBase64(value.ciphertext) &&
    value.ciphertext.length <= MAX_VAULT_FILE && isIsoTime(value.updatedAt);
}

/** Copies only the known fields, so stored or pulled objects cannot carry extras. */
export function cleanHeader(header: VaultHeader): VaultHeader {
  if (isAccountHeader(header)) return { vaultId: header.vaultId, key: header.key, updatedAt: header.updatedAt };
  return {
    vaultId: header.vaultId,
    salt: header.salt,
    wrappedKey: header.wrappedKey && { nonce: header.wrappedKey.nonce, ciphertext: header.wrappedKey.ciphertext },
    updatedAt: header.updatedAt,
  };
}

/** A new, empty account-mode vault: a fresh random data key, no passphrase. */
export async function createAccountVault(now: string) {
  const vaultId = encode(crypto.getRandomValues(new Uint8Array(16)));
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    return { header: { vaultId, key: encode(rawKey), updatedAt: now } as VaultHeader, key: await importKey(rawKey) };
  } finally {
    rawKey.fill(0);
  }
}

/** The account-mode header for an existing vault's data key (converting a passphrase vault). */
export function accountHeader(vaultId: string, rawKey: Uint8Array, now: string): VaultHeader {
  if (rawKey.length !== 32) throw new Error('The vault key is damaged.');
  return { vaultId, key: encode(rawKey), updatedAt: now };
}

/** Raw data key bytes of an account-mode header (for fingerprint / passkey wrapping). Caller zeroes them. */
export function accountKeyBytes(header: VaultHeader): Uint8Array<ArrayBuffer> {
  if (!isAccountHeader(header)) throw new Error('This vault still needs its passphrase.');
  return decode(header.key);
}

export async function openAccountVault(header: VaultHeader): Promise<CryptoKey> {
  const raw = accountKeyBytes(header);
  try {
    return await importKey(raw);
  } finally {
    raw.fill(0);
  }
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
  if (!header.salt || !header.wrappedKey) throw new Error('This vault has no passphrase.');
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

/**
 * The raw data key, for wrapping it a second time under the fingerprint
 * (Android Keystore) or a passkey (WebAuthn PRF). Needs the passphrase. The
 * caller must `fill(0)` the bytes once wrapped.
 */
export function vaultKeyBytes(header: VaultHeader, passphrase: string): Promise<Uint8Array<ArrayBuffer>> {
  return unwrapRawKey(header, passphrase);
}

/** Imports raw key bytes released by the fingerprint or a passkey. Zeroes them. */
export async function importVaultKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  try {
    if (raw.length !== 32) throw new Error('The saved unlock key is damaged.');
    return await importKey(raw);
  } finally {
    raw.fill(0);
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
  if (!header.salt || !header.wrappedKey) throw new Error('Choose a backup password to save a backup.');
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
