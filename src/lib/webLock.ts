/**
 * App lock on the website: the phone's or computer's own fingerprint, face or
 * PIN check, through WebAuthn. Turning the lock on registers a credential on
 * this device's built-in authenticator; unlocking asks that authenticator to
 * verify the person again.
 *
 * This is a screen lock, not encryption: it stops someone who picks up an
 * unlocked phone from opening Dayflow, but the data still sits in this
 * browser's storage. Nothing here talks to a server.
 */

const CREDENTIAL_KEY = 'dayflow_web_lock_credential_v1';
/**
 * The WebAuthn user handle for this browser. It survives turning the lock off, so
 * turning it on again replaces the saved passkey instead of adding another.
 */
const USER_HANDLE_KEY = 'dayflow_web_lock_user_v1';

/** Coming back after this long away locks the website again. */
export const WEB_RELOCK_AFTER_MS = 60_000;

export interface WebLockResult {
  ok: boolean;
  /** The person closed the prompt; show no error. */
  canceled: boolean;
  message: string;
}

const UNAVAILABLE = 'This browser cannot use your fingerprint, face or screen lock. Set one up on this device first.';

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  new Uint8Array(bytes).forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function stableUserHandle(): Uint8Array<ArrayBuffer> {
  try {
    const saved = localStorage.getItem(USER_HANDLE_KEY);
    if (saved && /^[A-Za-z0-9_-]{16,}$/.test(saved)) return fromBase64Url(saved);
    const fresh = randomBytes(16);
    localStorage.setItem(USER_HANDLE_KEY, toBase64Url(fresh.buffer));
    return fresh;
  } catch {
    return randomBytes(16);
  }
}

export function webLockCredentialId(): string | null {
  try {
    const value = localStorage.getItem(CREDENTIAL_KEY);
    return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function hasWebLockCredential(): boolean {
  return webLockCredentialId() !== null;
}

export function clearWebLockCredential(): void {
  try {
    localStorage.removeItem(CREDENTIAL_KEY);
  } catch {
    // Storage unavailable: there is nothing saved either.
  }
}

/** True when this browser has a built-in authenticator that verifies the person. */
export async function isWebLockSupported(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !window.isSecureContext) return false;
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * The authenticator data's flags byte (offset 32): bit 0 user present, bit 2
 * user verified. Unlocking requires the person to be verified, not just present.
 */
export function userWasVerified(authenticatorData: ArrayBuffer): boolean {
  const bytes = new Uint8Array(authenticatorData);
  return bytes.length > 32 && (bytes[32] & 0x04) === 0x04;
}

function describeError(error: unknown): WebLockResult {
  const name = error instanceof DOMException ? error.name : '';
  // NotAllowedError covers both "closed the prompt" and "timed out".
  if (name === 'NotAllowedError' || name === 'AbortError') return { ok: false, canceled: true, message: '' };
  if (name === 'InvalidStateError') {
    return { ok: false, canceled: false, message: 'This device already has a Dayflow lock. Try again.' };
  }
  if (name === 'NotSupportedError' || name === 'SecurityError') return { ok: false, canceled: false, message: UNAVAILABLE };
  return { ok: false, canceled: false, message: 'Could not check your fingerprint.' };
}

/** Registers this device's fingerprint/face/PIN for the lock. Shows the system prompt. */
export async function enrollWebLock(accountLabel: string): Promise<WebLockResult> {
  if (!(await isWebLockSupported())) return { ok: false, canceled: false, message: UNAVAILABLE };
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'Dayflow', id: window.location.hostname },
        user: {
          id: stableUserHandle(),
          name: accountLabel || 'Dayflow',
          displayName: accountLabel ? `Dayflow lock (${accountLabel})` : 'Dayflow lock',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'discouraged',
        },
        timeout: 60_000,
        attestation: 'none',
      },
    })) as PublicKeyCredential | null;
    if (!credential) return { ok: false, canceled: true, message: '' };
    localStorage.setItem(CREDENTIAL_KEY, toBase64Url(credential.rawId));
    return { ok: true, canceled: false, message: '' };
  } catch (error) {
    return describeError(error);
  }
}

/** Asks for the fingerprint/face/PIN registered by `enrollWebLock`. */
export async function verifyWebLock(): Promise<WebLockResult> {
  const id = webLockCredentialId();
  if (!id) return { ok: false, canceled: false, message: 'The lock is not set up on this device.' };
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: window.location.hostname,
        allowCredentials: [{ type: 'public-key', id: fromBase64Url(id), transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!assertion) return { ok: false, canceled: true, message: '' };
    const response = assertion.response as AuthenticatorAssertionResponse;
    if (toBase64Url(assertion.rawId) !== id || !userWasVerified(response.authenticatorData)) {
      return { ok: false, canceled: false, message: 'Could not confirm it was you. Try again.' };
    }
    return { ok: true, canceled: false, message: '' };
  } catch (error) {
    return describeError(error);
  }
}
