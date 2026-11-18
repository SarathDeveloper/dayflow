/**
 * Orchestrates Supabase cloud sync while the app is open: automatic sync
 * triggers and the merge / restore runs. Sign-in itself happens before the app
 * mounts (`components/auth/AuthGate`), so this hook always starts with a saved
 * session. What to pull and push is decided by the pure functions in
 * `lib/cloudRecords`; the network calls live in `services/cloudSyncService`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import {
  advanceCursor,
  idsToDownload,
  initialSyncMode,
  localVersions,
  pullStart,
  reconcile,
  restoreFromRows,
  sameSnapshot,
  type CloudRowMeta,
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
  isCloudConfigured,
  pullRowMeta,
  pushRows,
  signOut as signOutRequest,
  storedAccount,
  testCloudConnection,
  type CloudAccount,
  type CloudCheckStep,
} from '../services/cloudSyncService';
import { clearHomeWidgets } from '../services/homeWidgets';
import { forgetSyncedVault, hasPasswordVault, syncPasswordVault } from '../services/passwordVault';

export type CloudSyncStatus = 'unconfigured' | 'disconnected' | 'idle' | 'syncing' | 'error';

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
  configured: boolean;
  /** Sync once more, then sign out. The login screen takes over. */
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
const OFFLINE = 'Offline. Changes are saved on this device and sync when you are back online.';

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

  const [account, setAccount] = useState<CloudAccount | null>(() => (configured ? storedAccount() : null));
  const [status, setStatus] = useState<CloudSyncStatus>(() => {
    if (!configured) return 'unconfigured';
    return storedAccount() ? 'idle' : 'disconnected';
  });
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(
    () => readSyncMeta(getStorageKeys(null)).lastSyncedAt ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  const busyRef = useRef(false);
  const activeRunRef = useRef<Promise<void> | null>(null);
  const pendingModeRef = useRef<SyncMode | null>(null);
  const signingOutRef = useRef(false);
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

  /**
   * Pull rows changed since `cursor` (or use `preloaded`), merge them into this
   * device, push what the server lacks, and store the new cursor.
   */
  const mergeWithCloud = useCallback(
    async (
      userId: string,
      startedAt: string,
      position: { cursor?: string; pushedAt?: string },
      preloaded?: CloudRowMeta[],
    ) => {
      const local = buildLocalEnvelope();
      const metaRows = preloaded ?? (await pullRowMeta(userId, pullStart(position.cursor)));
      const rows = await fetchRows(userId, idsToDownload(metaRows, localVersions(local)));
      const { remote, push } = reconcile(local, { meta: metaRows, rows }, position.pushedAt);
      await pushRows(userId, push);

      // The user may have edited while the network calls ran. Merge the pulled
      // rows into what is stored now, not into the earlier read. Those edits
      // are newer than `startedAt`, so the next run pushes them.
      const fresh = buildLocalEnvelope();
      const paired = preferRealTaskLists(fresh, remote);
      const merged = mergeEnvelopes(paired.left, paired.right);
      const patch = {
        cloudCursor: advanceCursor(position.cursor, metaRows),
        cloudPushedAt: startedAt,
        cloudUserId: userId,
      };
      if (sameSnapshot(fresh, merged)) writeMeta(patch);
      else applyEnvelope(merged, patch);
    },
    [applyEnvelope, writeMeta],
  );

  const runSync = useCallback(
    (mode: SyncMode, opts: { silent?: boolean } = {}): Promise<void> => {
      if (!enabled || !configured) return Promise.resolve();
      if (busyRef.current) {
        // A restore or account switch outranks a queued merge.
        if (pendingModeRef.current === null || mode !== 'merge') pendingModeRef.current = mode;
        return activeRunRef.current ?? Promise.resolve();
      }
      busyRef.current = true;

      const run = (async () => {
        try {
          const session = await currentSession();
          if (!session) {
            // Still saved means the token could not be refreshed for lack of
            // network: stay signed in and try again later.
            if (storedAccount()) {
              setStatus('error');
              setError(OFFLINE);
            } else {
              setAccount(null);
              setStatus('disconnected');
            }
            return;
          }
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
            // Only a switch confirmed on the login screen may move a device to another account.
            throw new Error('This device is linked to another account. Sign out and sign in again to switch.');
          }
          const startedAt = new Date().toISOString();

          if (mode === 'merge') {
            await mergeWithCloud(userId, startedAt, {
              cursor: sameUser ? meta.cloudCursor : undefined,
              pushedAt: sameUser ? meta.cloudPushedAt : undefined,
            });
          } else {
            const metaRows = await pullRowMeta(userId, null);
            const rows = await fetchRows(
              userId,
              metaRows.filter((row) => !row.deleted).map((row) => row.id),
            );
            const restored = restoreFromRows(buildLocalEnvelope(), { meta: metaRows, rows });
            if (restored) {
              applyEnvelope(restored, {
                cloudCursor: advanceCursor(undefined, metaRows),
                cloudPushedAt: startedAt,
                cloudUserId: userId,
              });
            } else if (mode === 'switch-account') {
              // The account holds nothing yet. Replacing this device with
              // nothing could erase the only copy, so upload it instead.
              await mergeWithCloud(userId, startedAt, {}, metaRows);
            } else {
              throw new Error('Nothing is stored in the cloud for this account yet. Use Sync now to upload this device.');
            }
          }

          setStatus('idle');
          setError(null);
          // The password vault syncs its encrypted rows on its own; it never blocks this sync.
          if (hasPasswordVault()) void syncPasswordVault();
        } catch (e) {
          if (e instanceof CloudAuthError) {
            // The server rejected the session. Sign out so the login screen
            // takes over; the data stays on this device.
            pendingModeRef.current = null;
            setError(e.message);
            void signOutRequest();
          } else {
            setStatus('error');
            setError(e instanceof Error ? e.message : String(e));
          }
        } finally {
          busyRef.current = false;
          activeRunRef.current = null;
          const pending = pendingModeRef.current;
          pendingModeRef.current = null;
          if (pending && !signingOutRef.current) void runSync(pending, { silent: true });
        }
      })();
      activeRunRef.current = run;
      return run;
    },
    [applyEnvelope, configured, enabled, mergeWithCloud],
  );

  // Keep the account shown in Settings current.
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setAccount(null);
        setStatus('disconnected');
        return;
      }
      const next = accountOf(session);
      if (next) setAccount(next);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // First sync on mount. A different account than last time only gets this
  // far after the switch was confirmed on the login screen.
  useEffect(() => {
    if (!configured || !enabled) return;
    const signedIn = storedAccount();
    if (!signedIn) return;
    const mode = initialSyncMode(readSyncMeta(getStorageKeys(null)).cloudUserId, signedIn.id);
    void runSync(mode, { silent: mode === 'merge' });
    // Only on mount. Later edits go through the revision debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  // Debounced push after local edits.
  useEffect(() => {
    if (!configured || !enabled || !storedAccount()) return;
    const timer = setTimeout(() => void runSync('merge', { silent: true }), AUTO_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, configured, enabled]);

  // Android: refresh tokens only while in the foreground, and catch up on resume.
  useEffect(() => {
    if (!configured || !isNative() || !enabled) return;
    const supabase = getSupabase();
    let disposed = false;
    let remove: (() => void) | null = null;
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        void supabase?.auth.startAutoRefresh();
        if (storedAccount()) void runSync('merge', { silent: true });
      } else {
        void supabase?.auth.stopAutoRefresh();
      }
    }).then((handle) => {
      // The app can unmount (sign-out) before the listener is attached.
      if (disposed) {
        void handle.remove();
        return;
      }
      remove = () => void handle.remove();
    });
    return () => {
      disposed = true;
      remove?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, enabled]);

  // Web: pull when the tab becomes visible, regains focus, comes back online,
  // and once a minute while it stays visible.
  useEffect(() => {
    if (!configured || isNative() || !enabled || typeof document === 'undefined') return;
    const pull = () => {
      if (document.visibilityState !== 'visible' || !storedAccount()) return;
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

  const disconnect = useCallback(async () => {
    // Let a running sync finish, then upload anything left, then sign out.
    // A failed final sync (offline) still signs out; the data stays here.
    while (activeRunRef.current) await activeRunRef.current;
    await runSync('merge');
    while (activeRunRef.current) await activeRunRef.current;
    signingOutRef.current = true;
    try {
      // Home-screen widgets would keep showing tasks and spending.
      await clearHomeWidgets().catch(() => {});
      // The vault's key sits with its copy on this device: remove both once synced.
      await forgetSyncedVault().catch(() => {});
      await signOutRequest();
    } finally {
      signingOutRef.current = false;
    }
  }, [runSync]);

  const syncNow = useCallback(() => runSync('merge'), [runSync]);
  const restoreFromCloud = useCallback(() => runSync('restore'), [runSync]);
  const testConnection = useCallback(() => testCloudConnection(), []);

  return {
    status,
    account,
    lastSyncedAt,
    error,
    configured,
    disconnect,
    syncNow,
    restoreFromCloud,
    testConnection,
  };
}
