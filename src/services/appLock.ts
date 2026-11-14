import {
  BiometricAuth,
  BiometryError,
  BiometryErrorType,
} from '@aparajita/capacitor-biometric-auth';
import { isPromptOpen, markPromptFinished, markPromptStarted } from '../lib/appLockSession';
import { isAppLockEnabled } from '../lib/appLock';
import { isNativeAndroid } from '../lib/platform';
import { isCloudConfigured, storedAccount } from './cloudSyncService';
import {
  clearWebLockCredential,
  enrollWebLock,
  hasWebLockCredential,
  isWebLockSupported,
  verifyWebLock,
} from '../lib/webLock';

export { shouldIgnoreAppPause, shouldIgnoreAppResume } from '../lib/appLockSession';

export interface UnlockResult {
  ok: boolean;
  canceled: boolean;
  message: string;
}

const PROMPT = {
  reason: 'Unlock Dayflow',
  cancelTitle: 'Cancel',
  allowDeviceCredential: true,
  androidTitle: 'Unlock Dayflow',
  androidSubtitle: 'Use face, fingerprint, or your PIN',
  androidConfirmationRequired: false,
};

const UNAVAILABLE = 'Set a face unlock, fingerprint, or PIN on this phone first.';

export function isUnlockPromptOpen(): boolean {
  return isPromptOpen();
}

/**
 * True when Dayflow should lock on this device: the switch is on and, on the
 * website, this browser holds the registered fingerprint credential.
 */
export function isAppLockActive(): boolean {
  if (!isAppLockEnabled()) return false;
  return isNativeAndroid() || (hasWebLockCredential() && canUsePasswordUnlock());
}

/**
 * The website lock always has the account password as a way back in, so it is
 * only offered (and only enforced) when a signed-in cloud account exists.
 */
export function canUsePasswordUnlock(): boolean {
  return !isNativeAndroid() && isCloudConfigured() && Boolean(storedAccount()?.email);
}

/** Whether Settings can offer the lock here at all. */
export async function isAppLockSupported(): Promise<boolean> {
  return isNativeAndroid() || (canUsePasswordUnlock() && (await isWebLockSupported()));
}

/**
 * Sets the lock up: on Android a check that the phone has a screen lock and
 * one unlock; on the website, registers this device's fingerprint/face/PIN.
 */
export async function setUpAppLock(accountLabel: string): Promise<UnlockResult> {
  if (!isNativeAndroid()) {
    if (isPromptOpen()) return { ok: false, canceled: true, message: '' };
    markPromptStarted();
    try {
      return await enrollWebLock(accountLabel);
    } finally {
      markPromptFinished();
    }
  }
  const check = await canUseAppLock();
  if (!check.available) return { ok: false, canceled: false, message: check.message };
  return promptAppUnlock();
}

/** Forgets this device's lock credential (website). */
export function forgetAppLockCredential(): void {
  if (!isNativeAndroid()) clearWebLockCredential();
}

export async function canUseAppLock(): Promise<{ available: boolean; message: string }> {
  if (!isNativeAndroid()) {
    return (await isWebLockSupported())
      ? { available: true, message: '' }
      : { available: false, message: UNAVAILABLE };
  }
  try {
    const info = await BiometricAuth.checkBiometry();
    if (info.isAvailable || info.deviceIsSecure) return { available: true, message: '' };
    return { available: false, message: UNAVAILABLE };
  } catch {
    return { available: false, message: UNAVAILABLE };
  }
}

export async function promptAppUnlock(): Promise<UnlockResult> {
  if (isPromptOpen()) return { ok: false, canceled: true, message: '' };
  markPromptStarted();
  if (!isNativeAndroid()) {
    try {
      return await verifyWebLock();
    } finally {
      markPromptFinished();
    }
  }
  try {
    await BiometricAuth.authenticate(PROMPT);
    return { ok: true, canceled: false, message: '' };
  } catch (error) {
    if (error instanceof BiometryError) {
      const canceled =
        error.code === BiometryErrorType.userCancel ||
        error.code === BiometryErrorType.systemCancel ||
        error.code === BiometryErrorType.appCancel;
      return { ok: false, canceled, message: canceled ? '' : unlockMessage(error.code) };
    }
    return { ok: false, canceled: false, message: 'Could not unlock Dayflow.' };
  } finally {
    markPromptFinished();
  }
}

function unlockMessage(code: BiometryErrorType): string {
  switch (code) {
    case BiometryErrorType.biometryLockout:
      return 'Too many tries. Use your PIN, or wait and try again.';
    case BiometryErrorType.biometryNotEnrolled:
    case BiometryErrorType.biometryNotAvailable:
    case BiometryErrorType.passcodeNotSet:
    case BiometryErrorType.noDeviceCredential:
      return UNAVAILABLE;
    default:
      return 'Could not unlock Dayflow.';
  }
}
