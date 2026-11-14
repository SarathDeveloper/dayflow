/**
 * Decides what the app shows before anything else: the login screen, a
 * "replace this device's data?" confirmation, the set-new-password form, or
 * the app itself. Login is required whenever cloud sync is configured.
 *
 * Signed in means "Supabase still holds a saved session". Supabase removes it
 * only when the session is really over (sign-out, revoked refresh token,
 * deleted account). A refresh that fails because the phone is offline keeps
 * it, even though the startup event then reports no session; going by the
 * saved session keeps the app usable offline.
 */
import { useCallback, useEffect, useState } from 'react';
import { isAccountSwitch } from '../lib/cloudRecords';
import { getStorageKeys, readSyncMeta } from '../lib/persistence';
import {
  accountOf,
  getSupabase,
  isCloudConfigured,
  signOut,
  storedAccount,
  type CloudAccount,
} from '../services/cloudSyncService';

export type AuthGateView = 'app' | 'signed-out' | 'confirm-switch' | 'set-password' | 'loading';

export interface AuthGateState {
  view: AuthGateView;
  account: CloudAccount | null;
  /** The person agreed to replace this device's data with this account's. */
  approveSwitch: () => void;
  /** Back out of a switch or a password reset: sign out again. */
  cancel: () => Promise<void>;
  /** The new password is saved; continue into the app. */
  finishPasswordReset: () => void;
}

/** A password-reset link opens the site with `type=recovery` in the address hash. */
function isRecoveryLink(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash;
  return /(^|[#&])type=recovery(&|$)/.test(hash) && !/(^|[#&])error/.test(hash);
}

function lastSyncedUserId(): string | undefined {
  return readSyncMeta(getStorageKeys(null)).cloudUserId;
}

export function useAuthGate(): AuthGateState {
  const configured = isCloudConfigured();
  const [account, setAccount] = useState<CloudAccount | null>(() => (configured ? storedAccount() : null));
  // Set from the address at once, so neither the login screen nor the app
  // flashes while Supabase reads the link.
  const [recovering, setRecovering] = useState(() => configured && isRecoveryLink());
  const [approvedUserId, setApprovedUserId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setAccount(null);
        setRecovering(false);
        setApprovedUserId(null);
        return;
      }
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      // No session reported, but still saved: an offline refresh. Stay in.
      const next = accountOf(session) ?? storedAccount();
      setAccount(next);
      // The link was used up or invalid: no session came of it.
      if (event === 'INITIAL_SESSION' && !next) setRecovering(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const approveSwitch = useCallback(() => {
    if (account) setApprovedUserId(account.id);
  }, [account]);

  const cancel = useCallback(async () => {
    await signOut();
    setAccount(null);
    setRecovering(false);
    setApprovedUserId(null);
  }, []);

  const finishPasswordReset = useCallback(() => setRecovering(false), []);

  let view: AuthGateView = 'app';
  if (configured) {
    if (recovering) view = account ? 'set-password' : 'loading';
    else if (!account) view = 'signed-out';
    else if (isAccountSwitch(lastSyncedUserId(), account.id) && approvedUserId !== account.id) view = 'confirm-switch';
  }

  return { view, account, approveSwitch, cancel, finishPasswordReset };
}
