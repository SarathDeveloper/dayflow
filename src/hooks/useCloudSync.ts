/**
 * Orchestrates Supabase cloud sync: sign-in state, automatic sync triggers and
 * the merge / restore runs. What to pull and push is decided by the pure
 * functions in `lib/cloudRecords`; the network calls live in
 * `services/cloudSyncService`. This hook owns lifecycle and UI state only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import type { Session } from '@supabase/supabase-js';
import {
  advanceCursor,
  idsToDownload,
  localVersions,
  pullStart,
  reconcile,
  restoreFromRows,
  sameSnapshot,
} from '../lib/cloudRecords';
import {
  DATA_SCHEMA_VERSION,
  getDeviceId,
  getStorageKeys,
  readSnapshot,
  readSyncMeta,
  writeSnapshot,
  writeSyncMeta,
  type SyncEnvelope,
  type SyncMeta,
} from '../lib/persistence';
import { isNative } from '../lib/platform';
import { preferRealTaskLists } from '../lib/singleProfile';
import { mergeEnvelopes } from '../lib/syncMerge';
import {
  CloudAuthError,
  accountOf,
  currentSession,
  fetchRows,
  getSupabase,
  hasStoredSession,
  isCloudConfigured,
  pullRowMeta,
  pushRows,
  signIn as signInRequest,
  signOut as signOutRequest,
  signUp as signUpRequest,
  testCloudConnection,
  type CloudAccount,
  type CloudCheckStep,
} from '../services/cloudSyncService';

export type CloudSyncStatus =
  | 'unconfigured'
  | 'disconnected'
  | 'idle'
  | 'syncing'
  | 'connecting'
  | 'needs-auth'
  | 'error';

export interface UseCloudSyncOptions {
  /** Bumped by the app whenever local data changes, so sync can debounce. */
  revision: number;
  /** Called after cloud data has been written to localStorage. */
  onDataApplied: () => void;
  /** Disable sync entirely. */
  enabled?: boolean;
}

export interface CloudSyncApi {
  status: CloudSyncStatus;
  account: CloudAccount | null;
  lastSyncedAt: string | null;
  error: string | null;
  /** Information that is not an error, e.g. "check your inbox". */
  notice: string | null;
  configured: boolean;
  hasSession: boolean;
  signIn: (email: string, password: string) => Promise<boolean>;
  signUp: (email: string, password: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  syncNow: () => Promise<void>;
  restoreFromCloud: () => Promise<void>;
  /** Walks setup, account and database access, and reports which step fails. */
  testConnection: () => Promise<CloudCheckStep[]>;
}

type SyncMode = 'merge' | 'restore' | 'switch-account';

const AUTO_SYNC_DEBOUNCE_MS = 4000;
/** How often an open browser tab checks for edits made on another device. */
const WEB_PULL_INTERVAL_MS = 60_000;
const SESSION_ENDED = 'Your session ended. Sign in again to keep syncing.';

function buildLocalEnvelope(): SyncEnvelope {
  const keys = getStorageKeys(null);
  const meta = readSyncMeta(keys);
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    deviceId: getDeviceId(),
    updatedAt: new Date().toISOString(),
    // Empty when settings were never edited here, so they never claim to be newest.
    settingsUpdatedAt: meta.settingsUpdatedAt ?? '',
    tombstones: meta.tombstones,
    data: readSnapshot(keys),
  };
}

export function useCloudSync(options: UseCloudSyncOptions): CloudSyncApi {
  const { revision, onDataApplied, enabled = true } = options;
  const configured = isCloudConfigured();

  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [status, setStatus] = useState<CloudSyncStatus>(() => {
    if (!configured) return 'unconfigured';
    return hasStoredSession() ? 'idle' : 'disconnected';
  });
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(
    () => readSyncMeta(getStorageKeys(null)).lastSyncedAt ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busyRef = useRef(false);
  const pendingModeRef = useRef<SyncMode | null>(null);
  const signedInRef = useRef(configured && hasStoredSession());
  const signingOutRef = useRef(false);
  const authFlowRef = useRef(false);
  const onDataAppliedRef = useRef(onDataApplied);
  onDataAppliedRef.current = onDataApplied;

  const writeMeta = useCallback((patch: Partial<SyncMeta>) => {
    const keys = getStorageKeys(null);
    const syncedAt = new Date().toISOString();
    writeSyncMeta(keys, { ...readSyncMeta(keys), ...patch, lastSyncedAt: syncedAt });
    setLastSyncedAt(syncedAt);
  }, []);

  const applyEnvelope = useCallback(
    (envelope: SyncEnvelope, patch: Partial<SyncMeta>) => {
      writeSnapshot(getStorageKeys(null), envelope.data);
      writeMeta({
        ...patch,
        tombstones: envelope.tombstones,
        settingsUpdatedAt: envelope.settingsUpdatedAt || undefined,
        // Record what was applied, so the settings effect in App does not
        // mistake the incoming value for a fresh local edit.
        settingsSnapshot: JSON.stringify(envelope.data.settings),
      });
      onDataAppliedRef.current();
    },
    [writeMeta],
  );

  const runSync = useCallback(
    async (mode: SyncMode, opts: { silent?: boolean } = {}): Promise<void> => {
      if (!enabled || !configured) return;
      if (busyRef.current) {
        // A restore or account switch outranks a queued merge.
        if (pendingModeRef.current === null || mode !== 'merge') pendingModeRef.current = mode;
        return;
      }
      busyRef.current = true;
      try {
        const session = await currentSession();
        if (!session) {
          setAccount(null);
          if (signedInRef.current) {
            signedInRef.current = false;
            setStatus('needs-auth');
            setError(SESSION_ENDED);
          } else {
            setStatus('disconnected');
          }
          return;
        }
        signedInRef.current = true;
        setAccount(accountOf(session));
        // A background pull must not flip the badge to "Syncing" every minute.
        if (!opts.silent) {
          setError(null);
          setStatus('syncing');
        }

        const userId = session.user.id;
        const meta = readSyncMeta(getStorageKeys(null));
        const sameUser = meta.cloudUserId === userId;
        if (meta.cloudUserId && !sameUser && mode === 'merge') {
          // Only an explicit, confirmed sign-in may move a device to another account.
          throw new Error('This device is linked to another account. Sign out, then sign in again to switch.');
        }
        const startedAt = new Date().toISOString();

        if (mode === 'restore' || mode === 'switch-account') {
          const metaRows = await pullRowMeta(userId, null);
          const rows = await fetchRows(
            userId,
            metaRows.filter((row) => !row.deleted).map((row) => row.id),
          );
          const restored = restoreFromRows(
            buildLocalEnvelope(),
            { meta: metaRows, rows },
            { allowEmpty: mode === 'switch-account' },
          );
          if (!restored) {
            throw new Error('Nothing is stored in the cloud for this account yet. Use Sync now to upload this device.');
          }
          applyEnvelope(restored, {
            cloudCursor: advanceCursor(undefined, metaRows),
            cloudPushedAt: startedAt,
            cloudUserId: userId,
          });
        } else {
          const cursor = sameUser ? meta.cloudCursor : undefined;
          const pushedAt = sameUser ? meta.cloudPushedAt : undefined;
          const local = buildLocalEnvelope();
          const metaRows = await pullRowMeta(userId, pullStart(cursor));
          const rows = await fetchRows(userId, idsToDownload(metaRows, localVersions(local)));
          const { remote, push } = reconcile(local, { meta: metaRows, rows }, pushedAt);
          await pushRows(userId, push);

          // The user may have edited while the network calls ran. Merge the
          // pulled rows into what is stored now, not into the earlier read.
          // Those edits are newer than `startedAt`, so the next run pushes them.
          const fresh = buildLocalEnvelope();
          const paired = preferRealTaskLists(fresh, remote);
          const merged = mergeEnvelopes(paired.left, paired.right);
          const patch = {
            cloudCursor: advanceCursor(cursor, metaRows),
            cloudPushedAt: startedAt,
            cloudUserId: userId,
          };
          if (sameSnapshot(fresh, merged)) writeMeta(patch);
          else applyEnvelope(merged, patch);
        }

        setStatus('idle');
        setError(null);
      } catch (e) {
        if (e instanceof CloudAuthError) {
          pendingModeRef.current = null;
          setStatus('needs-auth');
          setError(e.message);
        } else {
          setStatus('error');
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        busyRef.current = false;
        const pending = pendingModeRef.current;
        pendingModeRef.current = null;
        if (pending) void runSync(pending, { silent: true });
      }
    },
    [applyEnvelope, configured, enabled, writeMeta],
  );

  /**
   * After any sign-in: a device last synced with a different account must not
   * merge two people's data. Ask, then replace this device's data or back out.
   */
  const afterSignIn = useCallback(
    async (session: Session): Promise<boolean> => {
      const previous = readSyncMeta(getStorageKeys(null)).cloudUserId;
      const switching = Boolean(previous && previous !== session.user.id);
      if (switching) {
        const replace = window.confirm(
          'This device was last synced with a different account. Replace the data on this device with this account’s data?\n\nChanges not yet synced to the other account will be lost. Cancel signs out again.',
        );
        if (!replace) {
          signingOutRef.current = true;
          await signOutRequest();
          signingOutRef.current = false;
          signedInRef.current = false;
          setAccount(null);
          setStatus('disconnected');
          return false;
        }
      }
      signedInRef.current = true;
      setAccount(accountOf(session));
      setStatus('idle');
      setError(null);
      await runSync(switching ? 'switch-account' : 'merge');
      return true;
    },
    [runSync],
  );

  // Follow auth changes made outside this hook: the session restored on launch,
  // a sign-in from the email confirmation link (web), a refresh that failed.
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setAccount(null);
        if (signingOutRef.current || !signedInRef.current) {
          setStatus('disconnected');
        } else {
          setStatus('needs-auth');
          setError(SESSION_ENDED);
        }
        signedInRef.current = false;
        return;
      }
      if (!session) {
        if (event === 'INITIAL_SESSION') {
          signedInRef.current = false;
          setStatus((current) => (current === 'idle' ? 'disconnected' : current));
        }
        return;
      }
      setAccount(accountOf(session));
      if (event === 'SIGNED_IN' && !authFlowRef.current) {
        // Not ours (e.g. the confirmation link). Deferred: an auth callback
        // must not await other Supabase calls.
        setTimeout(() => void afterSignIn(session), 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [afterSignIn]);

  // First sync on launch.
  useEffect(() => {
    if (!configured || !enabled || !signedInRef.current) return;
    void runSync('merge', { silent: true });
    // Only on mount. Later edits go through the revision debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  // Debounced push after local edits.
  useEffect(() => {
    if (!configured || !enabled || !signedInRef.current) return;
    const timer = setTimeout(() => void runSync('merge', { silent: true }), AUTO_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, configured, enabled]);

  // Android: refresh tokens only while in the foreground, and catch up on resume.
  useEffect(() => {
    if (!configured || !isNative() || !enabled) return;
    const supabase = getSupabase();
    let remove: (() => void) | null = null;
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        void supabase?.auth.startAutoRefresh();
        if (signedInRef.current) void runSync('merge', { silent: true });
      } else {
        void supabase?.auth.stopAutoRefresh();
      }
    }).then((handle) => {
      remove = () => {
        try {
          void handle.remove();
        } catch {
          // already detached
        }
      };
    });
    return () => remove?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, enabled]);

  // Web: pull when the tab becomes visible, regains focus, comes back online,
  // and once a minute while it stays visible.
  useEffect(() => {
    if (!configured || isNative() || !enabled || typeof document === 'undefined') return;
    const pull = () => {
      if (document.visibilityState !== 'visible' || !signedInRef.current) return;
      void runSync('merge', { silent: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') pull();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', pull);
    window.addEventListener('online', pull);
    const timer = setInterval(pull, WEB_PULL_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', pull);
      window.removeEventListener('online', pull);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, enabled]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setStatus('connecting');
      setError(null);
      setNotice(null);
      authFlowRef.current = true;
      try {
        const session = await signInRequest(email, password);
        authFlowRef.current = false;
        return await afterSignIn(session);
      } catch (e) {
        setStatus('disconnected');
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        authFlowRef.current = false;
      }
    },
    [afterSignIn],
  );

  const signUp = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setStatus('connecting');
      setError(null);
      setNotice(null);
      authFlowRef.current = true;
      try {
        const session = await signUpRequest(email, password);
        authFlowRef.current = false;
        if (!session) {
          setStatus('disconnected');
          setNotice('Account created. Open the confirmation link Supabase emailed you, then sign in here.');
          return true;
        }
        return await afterSignIn(session);
      } catch (e) {
        setStatus('disconnected');
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        authFlowRef.current = false;
      }
    },
    [afterSignIn],
  );

  const disconnect = useCallback(async () => {
    signingOutRef.current = true;
    try {
      await signOutRequest();
    } finally {
      signingOutRef.current = false;
      signedInRef.current = false;
      setAccount(null);
      setStatus('disconnected');
      setError(null);
      setNotice(null);
    }
  }, []);

  const syncNow = useCallback(() => runSync('merge'), [runSync]);
  const restoreFromCloud = useCallback(() => runSync('restore'), [runSync]);
  const testConnection = useCallback(() => testCloudConnection(), []);

  return {
    status,
    account,
    lastSyncedAt,
    error,
    notice,
    configured,
    hasSession: Boolean(account),
    signIn,
    signUp,
    disconnect,
    syncNow,
    restoreFromCloud,
    testConnection,
  };
}
