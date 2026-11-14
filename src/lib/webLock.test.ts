import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearWebLockCredential, hasWebLockCredential, userWasVerified, webLockCredentialId } from './webLock';

function authenticatorData(flags: number): ArrayBuffer {
  const bytes = new Uint8Array(37);
  bytes[32] = flags;
  return bytes.buffer;
}

describe('userWasVerified', () => {
  it('needs the user-verified flag, not just user presence', () => {
    expect(userWasVerified(authenticatorData(0x05))).toBe(true); // present + verified
    expect(userWasVerified(authenticatorData(0x01))).toBe(false); // present only (a tap, no fingerprint)
    expect(userWasVerified(new Uint8Array(10).buffer)).toBe(false); // truncated
  });
});

describe('web lock credential storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage(initial: Record<string, string>) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    return store;
  }

  it('reads a saved credential id and ignores a malformed one', () => {
    stubStorage({ dayflow_web_lock_credential_v1: 'AbC-_12' });
    expect(webLockCredentialId()).toBe('AbC-_12');
    stubStorage({ dayflow_web_lock_credential_v1: 'not base64url!' });
    expect(hasWebLockCredential()).toBe(false);
  });

  it('forgets the credential', () => {
    const store = stubStorage({ dayflow_web_lock_credential_v1: 'AbC' });
    clearWebLockCredential();
    expect(store.size).toBe(0);
  });

  it('treats unavailable storage as no lock', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(hasWebLockCredential()).toBe(false);
  });
});
