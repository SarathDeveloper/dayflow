/**
 * Unlocking the password vault without typing the passphrase.
 *
 * - Android: the vault's data key is encrypted with a Keystore key that only a
 *   strong fingerprint check releases (PasswordVaultPlugin.enableBiometric).
 * - Website: a passkey on this device (Windows Hello, Touch ID, phone screen
 *   lock) with the WebAuthn PRF extension. The passkey derives a secret that
 *   never leaves the authenticator unverified; it wraps the data key here.
 *
 * It is the "ask for fingerprint / passkey to open" check of an account-key
 * vault (no passphrase). What it saves stays on this device
 * and is never synced or backed up. A passphrase change keeps working (the
 * data key does not change); a different vault id makes the saved copy unused.
 */
import { importVaultKey } from '../lib/passwordVault';
import type { VaultHeader } from '../lib/passwordVault';
import { hasNativePasswordVault, PasswordVault } from './passwordVault';

export type QuickUnlockMethod = 'fingerprint' | 'passkey';

export interface QuickUnlockStatus {
  method: QuickUnlockMethod;
  /** This device can do it. */
  available: boolean;
  /** It is set up for this vault on this device. */
  enabled: boolean;
}

interface BiometricPlugin {
  biometricStatus(): Promise<{ available: boolean; vaultId?: string | null }>;
  enableBiometric(options: { secret: string; vaultId: string }): Promise<void>;
  unlockBiometric(options: { vaultId: string }): Promise<{ secret: string }>;
  disableBiometric(): Promise<void>;
}

const biometric = PasswordVault as unknown as BiometricPlugin;
const PASSKEY_KEY = 'dayflow_vault_passkey_v1';
const PRF_INFO = new TextEncoder().encode('dayflow-vault-passkey-v1');

/** Thrown when the person closed the prompt: show no error. */
export class QuickUnlockCanceled extends Error {
  constructor() {
    super('Canceled.');
    this.name = 'QuickUnlockCanceled';
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function random(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

interface SavedPasskey {
  vaultId: string;
  credentialId: string;
  salt: string;
  nonce: string;
  ciphertext: string;
}

function readPasskey(): SavedPasskey | null {
  try {
    const value = JSON.parse(localStorage.getItem(PASSKEY_KEY) ?? 'null') as Partial<SavedPasskey> | null;
    if (!value || typeof value !== 'object') return null;
    const fields = ['vaultId', 'credentialId', 'salt', 'nonce', 'ciphertext'] as const;
    return fields.every((field) => typeof value[field] === 'string') ? (value as SavedPasskey) : null;
  } catch {
    return null;
  }
}

async function passkeySupported(): Promise<boolean> {
  try {
    if (!window.isSecureContext || typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function quickUnlockStatus(vaultId: string | undefined): Promise<QuickUnlockStatus> {
  if (hasNativePasswordVault()) {
    try {
      const status = await biometric.biometricStatus();
      return { method: 'fingerprint', available: status.available, enabled: Boolean(vaultId) && status.vaultId === vaultId };
    } catch {
      // An app build without the fingerprint methods.
      return { method: 'fingerprint', available: false, enabled: false };
    }
  }
  const saved = readPasskey();
  return { method: 'passkey', available: await passkeySupported(), enabled: Boolean(vaultId) && saved?.vaultId === vaultId };
}

function isCancel(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'NotAllowedError' || error.name === 'AbortError';
  const code = (error as { code?: string } | null)?.code;
  return code === 'CANCELED';
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

async function prfKey(secret: ArrayBuffer, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: PRF_INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Asks the passkey for its PRF output for `salt`. */
async function passkeySecret(credentialId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      rpId: window.location.hostname,
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new QuickUnlockCanceled();
  const first = (assertion.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!first) throw new Error('This browser or passkey cannot unlock the vault. Use the passphrase.');
  return first;
}

function additionalData(vaultId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`dayflow-vault-passkey:${vaultId}`));
}

/**
 * Turns "require fingerprint / passkey" on for this vault on this device.
 * Takes the raw data key (`accountKeyBytes`) and zeroes it.
 */
export async function enableQuickUnlock(header: VaultHeader, raw: Uint8Array<ArrayBuffer>, label: string): Promise<void> {
  try {
    if (hasNativePasswordVault()) {
      try {
        await biometric.enableBiometric({ secret: toBase64(raw), vaultId: header.vaultId });
      } catch (error) {
        if (isCancel(error)) throw new QuickUnlockCanceled();
        throw error;
      }
      return;
    }
    if (!(await passkeySupported())) throw new Error('This browser has no fingerprint, face or screen lock to use.');
    try {
      const credential = (await navigator.credentials.create({
        publicKey: {
          challenge: random(32),
          rp: { name: 'Dayflow', id: window.location.hostname },
          user: { id: random(16), name: label || 'Dayflow vault', displayName: 'Dayflow Password Vault' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
          timeout: 60_000,
          attestation: 'none',
          extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!credential) throw new QuickUnlockCanceled();
      if ((credential.getClientExtensionResults() as PrfResults).prf?.enabled === false) {
        throw new Error('This browser’s passkeys cannot unlock the vault (no PRF support). Use the passphrase.');
      }
      const credentialId = new Uint8Array(credential.rawId);
      const salt = random(32);
      const key = await prfKey(await passkeySecret(credentialId, salt), salt);
      const nonce = random(12);
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: additionalData(header.vaultId) }, key, raw);
      const saved: SavedPasskey = {
        vaultId: header.vaultId,
        credentialId: toBase64(credentialId),
        salt: toBase64(salt),
        nonce: toBase64(nonce),
        ciphertext: toBase64(new Uint8Array(sealed)),
      };
      localStorage.setItem(PASSKEY_KEY, JSON.stringify(saved));
    } catch (error) {
      if (isCancel(error)) throw new QuickUnlockCanceled();
      throw error;
    }
  } finally {
    raw.fill(0);
  }
}

/** The vault key from the fingerprint or passkey. */
export async function quickUnlock(vaultId: string): Promise<CryptoKey> {
  if (hasNativePasswordVault()) {
    try {
      const { secret } = await biometric.unlockBiometric({ vaultId });
      return await importVaultKey(fromBase64(secret));
    } catch (error) {
      if (isCancel(error)) throw new QuickUnlockCanceled();
      throw error;
    }
  }
  const saved = readPasskey();
  if (!saved || saved.vaultId !== vaultId) throw new Error('Passkey unlock is not set up for this vault.');
  try {
    const salt = fromBase64(saved.salt);
    const key = await prfKey(await passkeySecret(fromBase64(saved.credentialId), salt), salt);
    const raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(saved.nonce), additionalData: additionalData(vaultId) },
      key,
      fromBase64(saved.ciphertext),
    ));
    return await importVaultKey(raw);
  } catch (error) {
    if (isCancel(error)) throw new QuickUnlockCanceled();
    if (error instanceof Error && /PRF|passkey/i.test(error.message)) throw error;
    throw new Error('Could not unlock with the passkey. Use the passphrase.');
  }
}

export async function disableQuickUnlock(): Promise<void> {
  if (hasNativePasswordVault()) {
    await biometric.disableBiometric().catch(() => undefined);
    return;
  }
  try {
    localStorage.removeItem(PASSKEY_KEY);
  } catch {
    // Nothing saved.
  }
}
