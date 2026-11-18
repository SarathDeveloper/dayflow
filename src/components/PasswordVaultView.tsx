import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Fingerprint, KeyRound, LockKeyhole } from 'lucide-react';
import {
  accountHeader, accountKeyBytes, applyEntryEdit, checkVaultEntry, createAccountVault, createVault, entryRowId,
  isAccountHeader, MAX_VAULT_FILE, openAccountVault, openVault, openVaultRecord, readVaultFile, sealVaultRecord,
  vaultKeyBytes,
} from '../lib/passwordVault';
import type { VaultEntry, VaultHeader } from '../lib/passwordVault';
import {
  deleteVaultRecord, newLocalVault, parseStoredVault, putVaultRecord, replaceVaultHeader,
} from '../lib/passwordVaultSync';
import type { LocalVaultState, StoredVault } from '../lib/passwordVaultSync';
import { vaultHealth } from '../lib/vaultHealth';
import { importPasswordCsv, MAX_IMPORT_BYTES } from '../lib/vaultImport';
import {
  copyVaultSecret, discardLocalVault, exportVaultBackup, hasNativePasswordVault, readVaultStore, saveVaultState,
  setVaultScreenProtected, syncPasswordVault,
} from '../services/passwordVault';
import type { VaultSyncResult } from '../services/passwordVault';
import {
  disableQuickUnlock, enableQuickUnlock, quickUnlock, QuickUnlockCanceled, quickUnlockStatus,
} from '../services/vaultQuickUnlock';
import type { QuickUnlockStatus } from '../services/vaultQuickUnlock';
import { backupIsDue, markBackupSaved, readVaultPrefs, setAutoLockMinutes } from '../services/vaultPrefs';
import type { AutoLockMinutes } from '../services/vaultPrefs';
import { isCloudConfigured, storedAccount } from '../services/cloudSyncService';
import {
  beginExternalActivity, consumeExternalResume, endExternalActivity, shouldIgnorePauseForExternal,
} from '../lib/externalActivity';
import { todayString } from '../lib/ledger';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { inputClass, labelClass, SyncPill } from './vault/VaultParts';
import { VaultEditor } from './vault/VaultEditor';
import { VaultDetails } from './vault/VaultDetails';
import { TRASH_DAYS, VaultHealthPanel, VaultList, VaultSettingsPanel, VaultTrashPanel } from './vault/VaultPanels';

const SYNC_EVERY_MS = 60_000;
const DAY_MS = 86_400_000;
const blankEntry: VaultEntry = { id: '', title: '', website: '', username: '', password: '', notes: '' };

interface Session {
  key: CryptoKey;
  vaultId: string;
}
type Screen =
  | { name: 'list' }
  | { name: 'details'; id: string }
  | { name: 'edit'; draft: VaultEntry; isNew: boolean; from: 'list' | 'details' }
  | { name: 'health' }
  | { name: 'trash' }
  | { name: 'settings' };

const now = () => new Date().toISOString();

function parseSafely(text: string | null | undefined): { stored: StoredVault | null; problem?: string } {
  try {
    return { stored: parseStoredVault(text) };
  } catch (cause) {
    return { stored: null, problem: cause instanceof Error ? cause.message : 'The vault on this device is damaged.' };
  }
}

/** `entries` sealed into `base` (or a new vault), each stamped now. */
async function stateWithEntries(header: VaultHeader, key: CryptoKey, entries: VaultEntry[], base?: LocalVaultState) {
  let state = base ?? newLocalVault(header);
  for (const entry of entries) {
    state = putVaultRecord(state, entryRowId(entry.id), await sealVaultRecord(header.vaultId, key, entry, now()));
  }
  return state;
}

async function decryptEntries(state: LocalVaultState, key: CryptoKey) {
  const entries: VaultEntry[] = [];
  let failed = 0;
  for (const [rowId, record] of Object.entries(state.entries)) {
    try {
      entries.push(await openVaultRecord(state.header.vaultId, key, rowId, record));
    } catch {
      failed++;
    }
  }
  return { entries, failed };
}

/** A key from the fingerprint or passkey must open this vault's records. */
async function keyOpensVault(state: LocalVaultState, key: CryptoKey): Promise<boolean> {
  const first = Object.entries(state.entries)[0];
  if (!first) return true;
  try {
    await openVaultRecord(state.header.vaultId, key, first[0], first[1]);
    return true;
  } catch {
    return false;
  }
}

export default function PasswordVaultView() {
  const native = hasNativePasswordVault();
  const [storedText, setStoredText] = useState<string | null>();
  const [protectedScreen, setProtectedScreen] = useState(!native);
  const [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [failedCount, setFailedCount] = useState(0);
  const [screen, setScreen] = useState<Screen>({ name: 'list' });
  const [backup, setBackup] = useState<string>();
  const [passphrase, setPassphrase] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [sync, setSync] = useState<VaultSyncResult | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [quick, setQuick] = useState<QuickUnlockStatus | null>(null);
  const [autoLock, setAutoLock] = useState<AutoLockMinutes>(() => readVaultPrefs().autoLockMinutes);
  const [prefsVersion, setPrefsVersion] = useState(0);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const pausedUnderGrace = useRef(false);
  const purgedFor = useRef<string | null>(null);
  const creating = useRef(false);

  const { stored, problem } = useMemo(() => parseSafely(storedText), [storedText]);
  const state = stored?.kind === 'synced' ? stored.state : null;
  const vaultId = state?.header.vaultId;
  const accountMode = Boolean(state && isAccountHeader(state.header));
  const signedIn = isCloudConfigured() && Boolean(storedAccount());
  /** Fingerprint / passkey is required to open the vault on this device. */
  const guarded = Boolean(quick?.enabled && quick.available);

  const lock = useCallback(() => {
    epoch.current++;
    setSession(null);
    setEntries([]);
    setFailedCount(0);
    setScreen({ name: 'list' });
    setPassphrase('');
    setBackup(undefined);
  }, []);

  const readStore = useCallback(async () => {
    const text = await readVaultStore();
    if (mounted.current) setStoredText(text);
    return text;
  }, []);

  /** Syncs the encrypted rows, then re-reads the device copy if the sync changed it. */
  const runSync = useCallback(async () => {
    if (mounted.current) setSyncing(true);
    try {
      const result = await syncPasswordVault();
      if (!mounted.current) return result;
      setSync(result);
      if (result.status === 'synced') setSyncedAt(now());
      if (result.changed) await readStore().catch(() => undefined);
      return result;
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }, [readStore]);

  // Lifecycle. With fingerprint / passkey required, the Android app locks when
  // it goes to the background (a file picker or save screen excepted).
  useEffect(() => {
    mounted.current = true;
    if (native) {
      void setVaultScreenProtected(true).then(() => {
        if (mounted.current) setProtectedScreen(true);
      }).catch(() => {
        if (mounted.current) setError('Screen protection is unavailable. Update the Android app to use the vault.');
      });
    }
    return () => {
      mounted.current = false;
      epoch.current++;
      void setVaultScreenProtected(false).catch(() => {});
    };
  }, [native]);

  useEffect(() => {
    if (!native || !guarded) return;
    const onPause = () => {
      if (shouldIgnorePauseForExternal()) {
        pausedUnderGrace.current = true;
        return;
      }
      lock();
    };
    const onResume = () => {
      if (!pausedUnderGrace.current) return;
      pausedUnderGrace.current = false;
      if (!consumeExternalResume()) lock();
    };
    const onVisibility = () => (document.hidden ? onPause() : onResume());
    document.addEventListener('visibilitychange', onVisibility);
    const listener = CapApp.addListener('appStateChange', ({ isActive }) => (isActive ? onResume() : onPause()));
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void listener.then((handle) => handle.remove()).catch(() => {});
    };
  }, [native, guarded, lock]);

  // Load the device copy, then sync (signed in only) and keep syncing while open.
  useEffect(() => {
    if (!protectedScreen) return;
    let current = true;
    void readStore().then(() => {
      if (current && signedIn) void runSync();
    }).catch(() => {
      if (current) setError('Could not read the vault on this device.');
    });
    if (!signedIn) return () => { current = false; };
    const timer = window.setInterval(() => { if (!document.hidden) void runSync(); }, SYNC_EVERY_MS);
    const onOnline = () => void runSync();
    window.addEventListener('online', onOnline);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [protectedScreen, reload, readStore, runSync, signedIn]);

  // Whether fingerprint / passkey is required for this vault on this device.
  useEffect(() => {
    let current = true;
    void quickUnlockStatus(vaultId).then((status) => { if (current) setQuick(status); });
    return () => { current = false; };
  }, [vaultId, prefsVersion]);

  // No vault yet: make one for the account (after checking the account has none).
  useEffect(() => {
    // storedText === null: read and empty (undefined is still loading).
    if (storedText !== null || stored?.kind !== 'none' || creating.current) return;
    const accountChecked = !signedIn || sync?.status === 'no-vault';
    if (!accountChecked || (signedIn && sync === null)) return;
    creating.current = true;
    void (async () => {
      try {
        const created = await createAccountVault(now());
        const contents = await saveVaultState(newLocalVault(created.header), null);
        if (!mounted.current) return;
        setStoredText(contents);
        if (signedIn) void runSync();
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not set up the vault.');
      } finally {
        creating.current = false;
      }
    })();
  }, [storedText, stored?.kind, signedIn, sync, runSync]);

  // Open an account-mode vault on its own, unless fingerprint / passkey is required.
  useEffect(() => {
    if (session || !state || !accountMode || quick === null || guarded) return;
    let current = true;
    void openAccountVault(state.header).then((key) => {
      if (current && mounted.current) setSession({ key, vaultId: state.header.vaultId });
    }).catch(() => {
      if (current && mounted.current) setError('The vault key on this device is damaged.');
    });
    return () => { current = false; };
  }, [session, state, accountMode, quick, guarded]);

  // Keep the decrypted items in step with the device copy (own saves and synced changes).
  useEffect(() => {
    if (!session) return;
    if (!state || state.header.vaultId !== session.vaultId) {
      lock();
      return;
    }
    let current = true;
    const started = epoch.current;
    void decryptEntries(state, session.key).then((result) => {
      if (!current || started !== epoch.current || !mounted.current) return;
      setEntries(result.entries);
      setFailedCount(result.failed);
    });
    return () => { current = false; };
  }, [session, state, lock]);

  // Idle auto-lock, only when fingerprint / passkey is required to open it again.
  useEffect(() => {
    if (!session || !guarded) return;
    let timer: number;
    const renew = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, autoLock * 60_000);
    };
    renew();
    const events = ['pointerdown', 'keydown', 'input', 'scroll'] as const;
    events.forEach((name) => window.addEventListener(name, renew, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, renew));
    };
  }, [session, guarded, lock, autoLock]);

  const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    if (pending.current || (native && document.hidden)) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const started = epoch.current;
    const isCurrent = () => mounted.current && started === epoch.current && !(native && document.hidden);
    try {
      await action(isCurrent);
    } catch (cause) {
      if (mounted.current && !(cause instanceof QuickUnlockCanceled)) {
        setError(cause instanceof Error ? cause.message : 'The vault action failed. Try again.');
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /** Writes `next` over the copy this screen last read, then syncs it in the background. */
  const save = async (next: LocalVaultState, isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    const contents = await saveVaultState(next, storedText ?? null);
    if (!mounted.current) return;
    setStoredText(contents);
    if (signedIn) void runSync();
  };

  const saveItems = async (items: VaultEntry[], isCurrent: () => boolean) => {
    if (!state || !session) return;
    await save(await stateWithEntries(state.header, session.key, items, state), isCurrent);
  };

  // Trash older than 30 days is deleted for good once per opening.
  useEffect(() => {
    if (!session || !state || purgedFor.current === `${session.vaultId}:${epoch.current}`) return;
    const cutoff = Date.now() - TRASH_DAYS * DAY_MS;
    const expired = entries.filter((entry) => entry.trashedAt && Date.parse(entry.trashedAt) < cutoff);
    if (!expired.length) return;
    purgedFor.current = `${session.vaultId}:${epoch.current}`;
    void run(async (isCurrent) => {
      let next = state;
      for (const entry of expired) next = deleteVaultRecord(next, entryRowId(entry.id), now());
      await save(next, isCurrent);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, session]);

  /** An older vault protected by a passphrase: enter it once, then it opens on its own. */
  const convertVault = (event: FormEvent) => {
    event.preventDefault();
    const secret = passphrase;
    setPassphrase('');
    void run(async (isCurrent) => {
      if (stored?.kind === 'legacy') {
        const file = readVaultFile(stored.text);
        const opened = await openVault(file, secret);
        const raw = await vaultKeyBytes({ vaultId: file.id, salt: file.salt, wrappedKey: file.wrappedKey, updatedAt: now() }, secret);
        const header = accountHeader(file.id, raw, now());
        raw.fill(0);
        const key = await openAccountVault(header);
        await save(await stateWithEntries(header, key, opened.entries), isCurrent);
        if (isCurrent()) setSession({ key, vaultId: header.vaultId });
      } else if (state) {
        const raw = await vaultKeyBytes(state.header, secret);
        const header = accountHeader(state.header.vaultId, raw, now());
        raw.fill(0);
        await save(replaceVaultHeader(state, header), isCurrent);
        if (isCurrent()) setSession({ key: await openAccountVault(header), vaultId: header.vaultId });
      }
      if (isCurrent()) setNotice('Done. The vault now opens on its own on all your signed-in devices.');
    });
  };

  const unlockQuick = () => {
    if (!state) return;
    void run(async (isCurrent) => {
      let key: CryptoKey;
      try {
        key = await quickUnlock(state.header.vaultId);
      } catch (cause) {
        setPrefsVersion((value) => value + 1);
        throw cause;
      }
      if (!(await keyOpensVault(state, key))) {
        await disableQuickUnlock();
        setPrefsVersion((value) => value + 1);
        throw new Error('That unlock no longer matches this vault. It was turned off.');
      }
      if (isCurrent()) setSession({ key, vaultId: state.header.vaultId });
    });
  };

  const copy = useCallback(async (text: string) => {
    try {
      await copyVaultSecret(text);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not copy.');
      throw cause;
    }
  }, []);

  const submitEntry = (event: FormEvent) => {
    event.preventDefault();
    if (screen.name !== 'edit' || !session || !state) return;
    const { draft, isNew } = screen;
    void run(async (isCurrent) => {
      const id = draft.id || crypto.randomUUID();
      const previous = isNew ? undefined : entries.find((item) => item.id === id);
      const clean = checkVaultEntry({ ...draft, id, title: draft.title.trim() });
      await saveItems([applyEntryEdit(previous, clean, now())], isCurrent);
      if (isCurrent()) setScreen({ name: 'details', id });
    });
  };

  const updateItem = (entry: VaultEntry, patch: Partial<VaultEntry>, after?: Screen) => {
    void run(async (isCurrent) => {
      await saveItems([checkVaultEntry({ ...entry, ...patch })], isCurrent);
      if (isCurrent() && after) setScreen(after);
    });
  };

  const deleteForever = (entry: VaultEntry) => {
    if (!state) return;
    void run(async (isCurrent) => {
      await save(deleteVaultRecord(state, entryRowId(entry.id), now()), isCurrent);
    });
  };

  /** A backup file encrypted with a password chosen now (the vault itself has none). */
  const exportBackup = (backupPassword: string) => {
    if (!state || !session) return;
    void run(async () => {
      const { file } = await createVault(backupPassword, entries);
      const filename = `dayflow-vault-${todayString()}.json`;
      beginExternalActivity();
      try {
        const { saved } = await exportVaultBackup(JSON.stringify(file), filename);
        if (saved) {
          markBackupSaved(state.header.vaultId, now());
          setPrefsVersion((value) => value + 1);
          if (mounted.current) setNotice('Encrypted backup saved. It opens with the backup password you just chose.');
        }
      } finally {
        endExternalActivity();
      }
    });
  };

  const loadBackup = async (file: File) => {
    endExternalActivity();
    setError('');
    try {
      if (file.size > MAX_VAULT_FILE) throw new Error('The vault file exceeds 2 MB.');
      const selected = readVaultFile(await file.text());
      if (!mounted.current) return;
      setBackup(JSON.stringify(selected));
      setPassphrase('');
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not open the backup.');
    }
  };

  const importBackup = (event: FormEvent) => {
    event.preventDefault();
    const secret = passphrase;
    setPassphrase('');
    if (!backup || !state || !session) return;
    void run(async (isCurrent) => {
      const opened = await openVault(readVaultFile(backup), secret);
      const known = new Set(Object.keys(state.entries));
      const added = opened.entries.filter((entry) => !known.has(entryRowId(entry.id)));
      await saveItems(added, isCurrent);
      if (isCurrent()) {
        setBackup(undefined);
        const kept = opened.entries.length - added.length;
        setNotice(`Imported ${added.length} ${added.length === 1 ? 'item' : 'items'}.${kept ? ` ${kept} already in the vault ${kept === 1 ? 'was' : 'were'} kept as they are.` : ''}`);
        setScreen({ name: 'list' });
      }
    });
  };

  const importCsv = (file: File) => {
    endExternalActivity();
    void run(async (isCurrent) => {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('The file is larger than 5 MB.');
      const result = importPasswordCsv(await file.text());
      await saveItems(result.entries, isCurrent);
      if (isCurrent()) {
        setNotice(`Imported ${result.entries.length} ${result.entries.length === 1 ? 'item' : 'items'} from ${result.format === 'chrome' ? 'Chrome' : 'Bitwarden'}.${result.skipped ? ` ${result.skipped} skipped (empty or unsupported).` : ''} Delete the CSV file now: it is not encrypted.`);
        setScreen({ name: 'list' });
      }
    });
  };

  const enableQuick = () => {
    if (!state) return;
    void run(async (isCurrent) => {
      await enableQuickUnlock(state.header, accountKeyBytes(state.header), storedAccount()?.email ?? '');
      setPrefsVersion((value) => value + 1);
      if (isCurrent()) setNotice(quick?.method === 'fingerprint' ? 'The vault now asks for your fingerprint.' : 'The vault now asks for your passkey in this browser.');
    });
  };

  const discard = () => {
    void run(async () => {
      const result = await discardLocalVault(storedText ?? null);
      lock();
      setConfirmDiscard(false);
      setSync(result);
      await readStore();
      setNotice('This device now uses your account’s vault. Import your backup in Vault settings if you saved one.');
    });
  };

  const active = useMemo(() => entries.filter((entry) => !entry.trashedAt), [entries]);
  const trashed = useMemo(() => entries.filter((entry) => entry.trashedAt)
    .sort((a, b) => (b.trashedAt ?? '').localeCompare(a.trashedAt ?? '')), [entries]);
  const health = useMemo(() => vaultHealth(active), [active]);
  const categories = useMemo(() => [...new Set(active.map((entry) => entry.category).filter(Boolean) as string[])], [active]);
  const blocked = sync?.status === 'conflict' || sync?.status === 'other-account';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const backupDue = useMemo(() => Boolean(vaultId) && backupIsDue(vaultId!), [vaultId, prefsVersion]);
  const lastBackup = vaultId ? readVaultPrefs().lastBackup[vaultId] : undefined;
  const detailsEntry = screen.name === 'details' ? entries.find((entry) => entry.id === screen.id) : undefined;
  const needsConversion = stored?.kind === 'legacy' || (state !== null && !accountMode);

  let body: ReactNode;
  if (storedText === undefined || (stored?.kind === 'none' && !problem)) {
    body = (
      <Card className="p-4">
        {error ? <Button variant="secondary" onClick={() => {
          setError('');
          setReload((value) => value + 1);
          if (!protectedScreen) void setVaultScreenProtected(true).then(() => setProtectedScreen(true))
            .catch(() => setError('Screen protection is unavailable. Update the Android app to use the vault.'));
        }}>Retry</Button> : stored?.kind === 'none' && sync?.status === 'offline' ? (
          <div className="space-y-2">
            <p className="text-sm">Can’t reach your account to open the vault. Check your connection.</p>
            <Button variant="secondary" disabled={syncing} onClick={() => void runSync()}>Try again</Button>
          </div>
        ) : <p role="status">{stored?.kind === 'none' ? 'Setting up your vault…' : 'Loading vault…'}</p>}
      </Card>
    );
  } else if (problem) {
    body = null;
  } else if (needsConversion) {
    body = (
      <Card className="space-y-3 p-5">
        <h3 className="font-bold">One last time: your old vault passphrase</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          This vault was made with a passphrase. Enter it once and the vault opens on its own from now on, on all your signed-in devices.
        </p>
        <form className="space-y-3" onSubmit={convertVault} autoComplete="off">
          <PassphraseField label="Old vault passphrase" value={passphrase} onChange={setPassphrase} disabled={busy} />
          <Button type="submit" disabled={busy}>{busy ? 'Working…' : 'Continue'}</Button>
        </form>
      </Card>
    );
  } else if (!session) {
    body = guarded ? (
      <Card className="flex flex-col items-center gap-3 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"><LockKeyhole className="size-7" /></div>
        <h3 className="text-lg font-bold">Vault locked</h3>
        {state && <p className="text-sm text-slate-500 dark:text-slate-400">{Object.keys(state.entries).length} items</p>}
        <Button disabled={busy} onClick={unlockQuick} className="w-full sm:w-auto">
          <Fingerprint className="size-4" /> {quick?.method === 'fingerprint' ? 'Unlock with fingerprint' : 'Unlock with passkey'}
        </Button>
      </Card>
    ) : <Card className="p-4"><p role="status">Opening vault…</p></Card>;
  } else if (backup) {
    body = (
      <Card className="space-y-3 p-5">
        <h3 className="font-bold">Import backup</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">Items from the backup are added. Items already in the vault stay as they are.</p>
        <form className="space-y-3" onSubmit={importBackup} autoComplete="off">
          <PassphraseField label="Backup password" value={passphrase} onChange={setPassphrase} disabled={busy} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Working…' : 'Import items'}</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { setBackup(undefined); setPassphrase(''); }}>Cancel</Button>
          </div>
        </form>
      </Card>
    );
  } else if (screen.name === 'edit') {
    body = (
      <VaultEditor entry={screen.draft} isNew={screen.isNew} categories={categories} busy={busy}
        onChange={(draft) => setScreen({ ...screen, draft })} onSave={submitEntry}
        onCancel={() => setScreen(screen.from === 'details' && screen.draft.id ? { name: 'details', id: screen.draft.id } : { name: 'list' })} />
    );
  } else if (screen.name === 'details' && detailsEntry && !detailsEntry.trashedAt) {
    body = (
      <VaultDetails entry={detailsEntry} busy={busy} reused={health.reused.includes(detailsEntry.id)}
        onBack={() => setScreen({ name: 'list' })}
        onEdit={() => setScreen({ name: 'edit', draft: detailsEntry, isNew: false, from: 'details' })}
        onToggleFavorite={() => updateItem(detailsEntry, { favorite: !detailsEntry.favorite || undefined })}
        onTrash={() => updateItem(detailsEntry, { trashedAt: now() }, { name: 'list' })}
        onCopy={copy} />
    );
  } else if (screen.name === 'health') {
    body = <VaultHealthPanel entries={active} health={health} onBack={() => setScreen({ name: 'list' })}
      onOpen={(entry) => setScreen({ name: 'details', id: entry.id })} />;
  } else if (screen.name === 'trash') {
    body = <VaultTrashPanel entries={trashed} busy={busy} now={Date.now()} onBack={() => setScreen({ name: 'list' })}
      onRestore={(entry) => updateItem(entry, { trashedAt: undefined })} onDelete={deleteForever} />;
  } else if (screen.name === 'settings') {
    body = (
      <VaultSettingsPanel busy={busy} autoLock={autoLock} quick={quick} lastBackup={lastBackup}
        onBack={() => setScreen({ name: 'list' })}
        onAutoLock={(minutes) => { setAutoLockMinutes(minutes); setAutoLock(minutes); }}
        onEnableQuick={enableQuick}
        onDisableQuick={() => void run(async () => {
          await disableQuickUnlock();
          setPrefsVersion((value) => value + 1);
          setNotice('Turned off. The vault opens without a check on this device.');
        })}
        onBackup={exportBackup}
        onImportBackup={(file) => void loadBackup(file)}
        onImportCsv={importCsv} />
    );
  } else {
    body = (
      <>
        {failedCount > 0 && (
          <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {failedCount} {failedCount === 1 ? 'item' : 'items'} could not be decrypted and {failedCount === 1 ? 'is' : 'are'} hidden. {failedCount === 1 ? 'It was' : 'They were'} changed outside Dayflow or made with another vault.
          </p>
        )}
        <VaultList entries={active} health={health} trashCount={trashed.length} backupDue={backupDue} busy={busy}
          onOpen={(entry) => setScreen({ name: 'details', id: entry.id })}
          onAdd={() => setScreen({ name: 'edit', draft: { ...blankEntry }, isNew: true, from: 'list' })}
          onCopy={copy}
          onHealth={() => setScreen({ name: 'health' })}
          onTrash={() => setScreen({ name: 'trash' })}
          onSettings={() => setScreen({ name: 'settings' })}
          onBackup={() => setScreen({ name: 'settings' })} />
      </>
    );
  }

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-xl font-bold"><KeyRound className="size-5" /> Password Vault</h2>
          <SyncPill configured={isCloudConfigured()} signedIn={signedIn} sync={sync} syncedAt={syncedAt} syncing={syncing}
            onSync={() => void runSync()} />
        </div>
        {session && guarded && <Button variant="secondary" onClick={lock}><LockKeyhole className="size-4" /> Lock</Button>}
      </div>
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-indigo-50 p-3 text-sm text-indigo-800 dark:bg-indigo-950 dark:text-indigo-100">{notice}</p>}
      {problem && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{problem}</p>}

      {blocked && (
        <Card className="space-y-3 p-4">
          <p className="text-sm">
            {sync?.status === 'conflict'
              ? 'Your account already has a password vault from another device, so this device’s vault cannot sync.'
              : 'This device’s vault belongs to a different Dayflow account.'}
            {' '}Save a backup of this device’s vault first (Vault settings), then switch to your account’s vault and import the backup.
          </p>
          {confirmDiscard ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">Remove this device’s vault copy? Items not in a backup are lost.</p>
              <Button size="sm" variant="destructive" disabled={busy} onClick={discard}>Remove and use account vault</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDiscard(false)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmDiscard(true)}>Use my account’s vault on this device</Button>
          )}
        </Card>
      )}

      {body}
    </section>
  );
}

function PassphraseField({ label, value, onChange, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className={labelClass}>
      <span>{label}</span>
      <input className={inputClass} type="password" required maxLength={256} autoComplete="off"
        value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
