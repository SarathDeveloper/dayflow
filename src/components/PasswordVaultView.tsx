import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Cloud, CloudOff, Copy, Download, KeyRound, LockKeyhole, Plus, Upload } from 'lucide-react';
import {
  createVaultHeader, entryRowId, exportVaultFile, generateVaultPassword, MAX_VAULT_FILE, migrateVaultFile,
  MIN_VAULT_PASSPHRASE, openVault, openVaultRecord, readVaultFile, rewrapVaultHeader, sealVaultRecord,
  unlockVaultHeader,
} from '../lib/passwordVault';
import type { VaultEntry, VaultHeader } from '../lib/passwordVault';
import {
  deleteVaultRecord, newLocalVault, parseStoredVault, putVaultRecord, replaceVaultHeader,
} from '../lib/passwordVaultSync';
import type { LocalVaultState, StoredVault } from '../lib/passwordVaultSync';
import {
  copyVaultSecret, discardLocalVault, exportVaultBackup, hasNativePasswordVault, readVaultStore, saveVaultState,
  setVaultScreenProtected, syncPasswordVault,
} from '../services/passwordVault';
import type { VaultSyncResult } from '../services/passwordVault';
import { isCloudConfigured, storedAccount } from '../services/cloudSyncService';
import {
  beginExternalActivity, consumeExternalResume, endExternalActivity, shouldIgnorePauseForExternal,
} from '../lib/externalActivity';
import { todayString } from '../lib/ledger';
import { Button } from './ui/Button';
import { Card } from './ui/Card';

const IDLE_MS = 60_000;
const SYNC_EVERY_MS = 60_000;
const inputClass = 'w-full min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white';
const blankEntry = { id: '', title: '', website: '', username: '', password: '', notes: '' };

interface Session {
  key: CryptoKey;
  vaultId: string;
}
type Mode = 'unlock' | 'create' | 'restore' | 'change' | 'import';

const now = () => new Date().toISOString();

function parseSafely(text: string | null | undefined): { stored: StoredVault | null; problem?: string } {
  try {
    return { stored: parseStoredVault(text) };
  } catch (cause) {
    return { stored: null, problem: cause instanceof Error ? cause.message : 'The vault on this device is damaged.' };
  }
}

/** A synced state holding `entries`, each sealed with the current time. */
async function stateWithEntries(header: VaultHeader, key: CryptoKey, entries: VaultEntry[], base?: LocalVaultState) {
  let state = base ?? newLocalVault(header);
  for (const entry of entries) {
    const updatedAt = now();
    state = putVaultRecord(state, entryRowId(entry.id), await sealVaultRecord(header.vaultId, key, entry, updatedAt));
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
  entries.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return { entries, failed };
}

export default function PasswordVaultView({ onExit }: { onExit?: () => void }) {
  const [storedText, setStoredText] = useState<string | null>();
  const [protectedScreen, setProtectedScreen] = useState(!hasNativePasswordVault());
  const [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [failedCount, setFailedCount] = useState(0);
  const [mode, setMode] = useState<Mode>('unlock');
  const [backup, setBackup] = useState<string>();
  const [passphrase, setPassphrase] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<VaultEntry>();
  const [revealed, setRevealed] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [sync, setSync] = useState<VaultSyncResult | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const pausedUnderGrace = useRef(false);

  const { stored, problem } = useMemo(() => parseSafely(storedText), [storedText]);
  const state = stored?.kind === 'synced' ? stored.state : null;
  const signedIn = isCloudConfigured() && Boolean(storedAccount());

  const clearPassphrases = useCallback(() => {
    setPassphrase('');
    setNewPassphrase('');
    setRepeat('');
  }, []);

  const lock = useCallback(() => {
    epoch.current++;
    setSession(null);
    setEntries([]);
    setFailedCount(0);
    setDraft(undefined);
    setRevealed(undefined);
    setDeleting(undefined);
    setQuery('');
    clearPassphrases();
    setMode((current) => current === 'change' || current === 'import' ? 'unlock' : current);
  }, [clearPassphrases]);

  const readStore = useCallback(async () => {
    const text = await readVaultStore();
    if (mounted.current) setStoredText(text);
    return text;
  }, []);

  /** Syncs the encrypted rows, then re-reads the device copy if the sync changed it. */
  const runSync = useCallback(async () => {
    const result = await syncPasswordVault();
    if (!mounted.current) return result;
    setSync(result);
    if (result.changed) await readStore().catch(() => undefined);
    return result;
  }, [readStore]);

  useEffect(() => {
    mounted.current = true;
    if (hasNativePasswordVault()) {
      void setVaultScreenProtected(true).then(() => {
        if (mounted.current) setProtectedScreen(true);
      }).catch(() => {
        if (mounted.current) setError('Screen protection is unavailable. Update the Android app to use the vault.');
      });
    }
    // A file picker or save screen backgrounds the app: it does not lock inside
    // its time window (lib/externalActivity), but coming back too late does.
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
    const listener = hasNativePasswordVault()
      ? CapApp.addListener('appStateChange', ({ isActive }) => (isActive ? onResume() : onPause()))
      : null;
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      epoch.current++;
      document.removeEventListener('visibilitychange', onVisibility);
      void listener?.then((handle) => handle.remove()).catch(() => {});
      void setVaultScreenProtected(false).catch(() => {});
    };
  }, [lock]);

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

  // Keep the decrypted list in step with the device copy (own saves and synced changes).
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

  useEffect(() => {
    if (!session) return;
    let timer: number;
    const renew = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, IDLE_MS);
    };
    renew();
    window.addEventListener('pointerdown', renew);
    window.addEventListener('keydown', renew);
    window.addEventListener('input', renew);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', renew);
      window.removeEventListener('keydown', renew);
      window.removeEventListener('input', renew);
    };
  }, [session, lock]);

  const run = async (action: (stillUnlocked: () => boolean) => Promise<void>) => {
    if (pending.current || document.hidden) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const started = epoch.current;
    const isCurrent = () => mounted.current && started === epoch.current && !document.hidden;
    try {
      await action(isCurrent);
    } catch (cause) {
      if (mounted.current && !document.hidden) {
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

  /**
   * Before making a vault on a signed-in device, make sure the account has none:
   * a second vault could not sync. Offline, creating locally is still allowed.
   */
  const accountHasVault = async (): Promise<boolean> => {
    if (!signedIn) return false;
    const result = await runSync();
    if (result.status === 'synced' && result.changed) {
      const text = await readStore();
      return parseSafely(text).stored?.kind === 'synced';
    }
    return false;
  };

  const submitPassphrase = (event: FormEvent) => {
    event.preventDefault();
    void run(async (isCurrent) => {
      clearPassphrases();
      if (mode === 'create') {
        if (newPassphrase !== repeat) throw new Error('The two passphrases do not match.');
        if (await accountHasVault()) {
          setMode('unlock');
          throw new Error('Your account already has a vault from another device. Unlock it with that vault’s passphrase.');
        }
        const created = await createVaultHeader(newPassphrase, now());
        await save(newLocalVault(created.header), isCurrent);
        if (isCurrent()) {
          setSession({ key: created.key, vaultId: created.header.vaultId });
          setNotice('Vault created. Save an encrypted backup and keep the passphrase safe.');
        }
      } else if (mode === 'change') {
        if (!state || !session) return;
        if (newPassphrase !== repeat) throw new Error('The two passphrases do not match.');
        const header = await rewrapVaultHeader(state.header, passphrase, newPassphrase, now());
        await save(replaceVaultHeader(state, header), isCurrent);
        if (isCurrent()) setNotice('Passphrase changed. Your other devices use it after they sync. Old backups still need the old passphrase.');
      } else if (mode === 'restore') {
        if (!backup) return;
        if (await accountHasVault()) {
          setMode('unlock');
          setBackup(undefined);
          throw new Error('Your account already has a vault. Unlock it, then use Import backup to add these logins.');
        }
        const migrated = await migrateVaultFile(readVaultFile(backup), passphrase, now());
        await save(await stateWithEntries(migrated.header, migrated.key, migrated.entries), isCurrent);
        if (isCurrent()) {
          setSession({ key: migrated.key, vaultId: migrated.header.vaultId });
          setNotice('Encrypted backup restored.');
        }
      } else if (mode === 'import') {
        if (!backup || !state || !session) return;
        const opened = await openVault(readVaultFile(backup), passphrase);
        const known = new Set(Object.keys(state.entries));
        const added = opened.entries.filter((entry) => !known.has(entryRowId(entry.id)));
        await save(await stateWithEntries(state.header, session.key, added, state), isCurrent);
        if (isCurrent()) {
          const kept = opened.entries.length - added.length;
          setNotice(`Imported ${added.length} ${added.length === 1 ? 'login' : 'logins'}.${kept ? ` ${kept} already in the vault ${kept === 1 ? 'was' : 'were'} kept as they are.` : ''}`);
        }
      } else if (stored?.kind === 'legacy') {
        // A vault saved before sync existed: convert it (same key, same passphrase).
        const migrated = await migrateVaultFile(readVaultFile(stored.text), passphrase, now());
        await save(await stateWithEntries(migrated.header, migrated.key, migrated.entries), isCurrent);
        if (isCurrent()) setSession({ key: migrated.key, vaultId: migrated.header.vaultId });
      } else if (state) {
        const key = await unlockVaultHeader(state.header, passphrase);
        if (isCurrent()) setSession({ key, vaultId: state.header.vaultId });
      }
      if (isCurrent()) {
        setBackup(undefined);
        setMode('unlock');
      }
    });
  };

  const closeEditors = () => {
    setDraft(undefined);
    setRevealed(undefined);
    setDeleting(undefined);
  };

  const submitEntry = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !session || !state) return;
    const entry = { ...draft, title: draft.title.trim(), id: draft.id || crypto.randomUUID() };
    void run(async (isCurrent) => {
      if (!entry.title) throw new Error('Enter a title.');
      const record = await sealVaultRecord(session.vaultId, session.key, entry, now());
      await save(putVaultRecord(state, entryRowId(entry.id), record), isCurrent);
      if (isCurrent()) closeEditors();
    });
  };

  const removeEntry = (entry: VaultEntry) => {
    if (!state) return;
    void run(async (isCurrent) => {
      await save(deleteVaultRecord(state, entryRowId(entry.id), now()), isCurrent);
      if (isCurrent()) closeEditors();
    });
  };

  const exportBackup = () => {
    if (!state || !session) return;
    void run(async () => {
      const file = await exportVaultFile(state.header, session.key, entries);
      const filename = `dayflow-vault-${todayString()}.json`;
      beginExternalActivity();
      try {
        const { saved } = await exportVaultBackup(JSON.stringify(file), filename);
        if (saved && mounted.current) setNotice('Encrypted backup saved. It opens with the current vault passphrase.');
      } finally {
        endExternalActivity();
      }
    });
  };

  const loadBackup = async (file: File, nextMode: 'restore' | 'import') => {
    endExternalActivity();
    setError('');
    try {
      if (file.size > MAX_VAULT_FILE) throw new Error('The vault file exceeds 2 MB.');
      const selected = readVaultFile(await file.text());
      if (!mounted.current) return;
      setBackup(JSON.stringify(selected));
      clearPassphrases();
      setMode(nextMode);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not open the backup.');
    }
  };

  const discard = () => {
    void run(async () => {
      const result = await discardLocalVault(storedText ?? null);
      lock();
      setConfirmDiscard(false);
      setSync(result);
      await readStore();
      setNotice('This device now uses your account’s vault. Use Import backup after unlocking to add any saved logins.');
    });
  };

  const cancelForm = () => {
    clearPassphrases();
    setMode('unlock');
    setBackup(undefined);
    setError('');
  };
  const visibleEntries = session ? entries.filter((entry) =>
    [entry.title, entry.website, entry.username].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())),
  ) : undefined;
  const hasVault = stored?.kind === 'legacy' || stored?.kind === 'synced';
  const blocked = sync?.status === 'conflict' || sync?.status === 'other-account';

  const backupInput = (nextMode: 'restore' | 'import', label: string) => (
    <label className="block space-y-1 text-sm font-semibold">
      <span>{label}</span>
      <input className={inputClass} type="file" accept=".json,application/json" disabled={busy}
        onClick={() => beginExternalActivity()}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void loadBackup(file, nextMode);
          else endExternalActivity();
        }} />
    </label>
  );

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xl font-bold"><KeyRound className="size-5" /> Password Vault</h2>
        <div className="flex gap-2">
          {session && <Button variant="secondary" onClick={lock}><LockKeyhole className="size-4" /> Lock vault</Button>}
          {onExit && <Button variant="ghost" onClick={onExit}>Back to sign in</Button>}
        </div>
      </div>
      <SyncLine signedIn={signedIn} hasVault={hasVault} sync={sync} />
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-indigo-50 p-3 text-sm text-indigo-800 dark:bg-indigo-950 dark:text-indigo-100">{notice}</p>}
      {problem && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{problem}</p>}

      {blocked && (
        <Card className="space-y-3 p-4">
          <p className="text-sm">
            {sync?.status === 'conflict'
              ? 'Your account already has a password vault made on another device, so this device’s vault cannot sync.'
              : 'This device’s vault syncs with a different Dayflow account.'}
            {' '}Unlock this vault and save an encrypted backup first. Then switch this device to your account’s vault and import the backup into it.
          </p>
          {confirmDiscard ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">Remove this device’s vault copy? Logins not in a backup are lost.</p>
              <Button size="sm" variant="destructive" disabled={busy} onClick={discard}>Remove and use account vault</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDiscard(false)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => setConfirmDiscard(true)}>Use my account’s vault on this device</Button>
          )}
        </Card>
      )}

      {storedText === undefined ? (
        <Card className="p-4">
          {error ? <Button variant="secondary" onClick={() => {
            setError('');
            setReload((value) => value + 1);
            if (!protectedScreen) void setVaultScreenProtected(true).then(() => setProtectedScreen(true))
              .catch(() => setError('Screen protection is unavailable. Update the Android app to use the vault.'));
          }}>Retry</Button> : <p role="status">Loading vault…</p>}
        </Card>
      ) : problem ? null : !session || mode === 'change' || mode === 'import' ? (
        <Card className="space-y-4 p-4">
          {!hasVault && mode === 'unlock' ? (
            <>
              <p className="text-sm">
                {signedIn
                  ? 'Create a vault for your account, or restore an encrypted Dayflow vault backup. It syncs to your other devices encrypted; only your passphrase opens it.'
                  : 'Create a vault on this device or restore an encrypted Dayflow vault backup. Sign in to Dayflow to sync it between devices.'}
              </p>
              <Button disabled={busy} onClick={() => { setError(''); setMode('create'); }}>Create vault</Button>
              {backupInput('restore', 'Restore encrypted backup')}
            </>
          ) : (
            <form className="space-y-3" onSubmit={submitPassphrase} autoComplete="off">
              {mode === 'create' && (
                <p className="text-sm">Use a unique passphrase of at least {MIN_VAULT_PASSPHRASE} characters. Keep it somewhere safe: nobody can recover it, and every device opens the vault with it.</p>
              )}
              {mode === 'unlock' && stored?.kind === 'legacy' && (
                <p className="text-sm">Unlock once to update this vault so it can sync. Your passphrase stays the same.</p>
              )}
              {mode === 'import' && <p className="text-sm">Logins from the backup are added. Logins already in the vault stay as they are.</p>}
              {mode !== 'create' && <PassphraseField
                label={mode === 'restore' || mode === 'import' ? 'Backup passphrase' : mode === 'change' ? 'Current vault passphrase' : 'Vault passphrase'}
                value={passphrase} onChange={setPassphrase} disabled={busy}
              />}
              {(mode === 'create' || mode === 'change') && <>
                <PassphraseField label="New vault passphrase" value={newPassphrase} onChange={setNewPassphrase} disabled={busy} />
                <PassphraseField label="Repeat vault passphrase" value={repeat} onChange={setRepeat} disabled={busy} />
              </>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? 'Working…' : { unlock: 'Unlock', create: 'Create vault', restore: 'Restore vault', change: 'Change passphrase', import: 'Import logins' }[mode]}
                </Button>
                {mode !== 'unlock' && <Button variant="ghost" type="button" disabled={busy} onClick={cancelForm}>Cancel</Button>}
              </div>
            </form>
          )}
        </Card>
      ) : draft ? (
        <EntryEditor entry={draft} onChange={setDraft} onSave={submitEntry} busy={busy}
          onCancel={() => { setDraft(undefined); setError(''); }} />
      ) : (
        <>
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => { setDraft({ ...blankEntry }); setRevealed(undefined); }}><Plus className="size-4" /> Add login</Button>
              <Button disabled={busy} variant="secondary" onClick={exportBackup}><Download className="size-4" /> Save encrypted backup</Button>
              <Button disabled={busy} variant="ghost" onClick={() => { setRevealed(undefined); setMode('change'); }}>Change passphrase</Button>
            </div>
            <details className="text-sm">
              <summary className="flex cursor-pointer items-center gap-2 font-semibold"><Upload className="size-4" /> Import backup</summary>
              <div className="mt-2">{backupInput('import', 'Choose an encrypted Dayflow vault backup')}</div>
            </details>
            <input type="search" aria-label="Search vault" placeholder="Search by site or username" className={inputClass}
              value={query} onChange={(event) => { setRevealed(undefined); setQuery(event.target.value); }} />
          </Card>
          {failedCount > 0 && (
            <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              {failedCount} {failedCount === 1 ? 'login' : 'logins'} could not be decrypted and {failedCount === 1 ? 'is' : 'are'} hidden. {failedCount === 1 ? 'It was' : 'They were'} changed outside Dayflow or made with another vault.
            </p>
          )}
          {visibleEntries?.length === 0 && <p className="text-sm">{entries.length ? 'No matching logins.' : 'Your vault is empty.'}</p>}
          {visibleEntries?.map((entry) => (
            <Card key={entry.id} className="space-y-3 p-4">
              <div className="break-words">
                <h3 className="font-bold">{entry.title}</h3>
                {entry.website && <p className="text-sm">{entry.website}</p>}
                {entry.username && <p className="text-sm">{entry.username}</p>}
              </div>
              {revealed === entry.id && <p className="break-all rounded-lg bg-slate-100 p-2 font-mono dark:bg-slate-900">{entry.password}</p>}
              {deleting === entry.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm">Delete this login on all your devices?</p>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => removeEntry(entry)}>Delete login</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(undefined)}>Cancel</Button>
                </div>
              ) : <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRevealed(revealed === entry.id ? undefined : entry.id)}>
                  {revealed === entry.id ? 'Hide password' : 'Reveal password'}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async (isCurrent) => {
                  await copyVaultSecret(entry.password);
                  if (isCurrent()) setNotice(hasNativePasswordVault() ? 'Password copied.' : 'Password copied. It is cleared from the clipboard in 30 seconds.');
                })}><Copy className="size-4" /> Copy password</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRevealed(undefined); setDraft(entry); }}>Edit</Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => {
                  setRevealed(undefined);
                  setDeleting(entry.id);
                }}>Delete</Button>
              </div>}
            </Card>
          ))}
        </>
      )}
    </section>
  );
}

function SyncLine({ signedIn, hasVault, sync }: { signedIn: boolean; hasVault: boolean; sync: VaultSyncResult | null }) {
  if (!isCloudConfigured()) return null;
  let text: string;
  let ok = false;
  if (!signedIn) text = 'Signed out: this vault is on this device only. Sign in to sync it.';
  else if (!sync) text = 'Checking your account…';
  else if (sync.status === 'synced') {
    text = 'Synced with your account. Only encrypted data leaves this device.';
    ok = true;
  } else if (sync.status === 'no-vault') text = hasVault ? 'Not synced yet.' : 'No vault in your account yet.';
  else if (sync.status === 'needs-upgrade') text = 'Unlock once to start syncing this vault.';
  else if (sync.status === 'offline') text = `Couldn’t sync${sync.message ? ` (${sync.message})` : ''}. Changes stay on this device and sync later.`;
  else if (sync.status === 'local-only') text = 'This vault is on this device only.';
  else text = 'Not syncing: see below.';
  const Icon = ok ? Cloud : CloudOff;
  return (
    <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <Icon className="size-4 shrink-0" /> {text}
    </p>
  );
}

function PassphraseField({ label, value, onChange, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block space-y-1 text-sm font-semibold">
      <span>{label}</span>
      <input className={inputClass} type="password" required maxLength={256} autoComplete="off"
        value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function EntryEditor({ entry, onChange, onSave, onCancel, busy }: {
  entry: VaultEntry;
  onChange: (entry: VaultEntry) => void;
  onSave: (event: FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [length, setLength] = useState(20);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);

  return (
    <Card className="p-4">
      <form className="space-y-3" onSubmit={onSave} autoComplete="off">
        <h3 className="font-bold">{entry.id ? 'Edit login' : 'New login'}</h3>
        <fieldset disabled={busy} className="space-y-3">
          {([
            ['title', 'Title', 200], ['website', 'Website', 2048],
            ['username', 'Username', 512], ['password', 'Password', 1024],
          ] as const).map(([field, label, maxLength]) => (
            <label key={field} className="block space-y-1 text-sm font-semibold">
              <span>{label}</span>
              <input className={inputClass} type={field === 'password' && !showPassword ? 'password' : 'text'}
                required={field === 'title' || field === 'password'} maxLength={maxLength}
                spellCheck={false} autoCapitalize="none" autoComplete="off"
                value={entry[field]} onChange={(event) => onChange({ ...entry, [field]: event.target.value })} />
            </label>
          ))}
          <Button variant="ghost" size="sm" type="button" onClick={() => setShowPassword((value) => !value)}>
            {showPassword ? 'Hide password' : 'Reveal password'}
          </Button>
          <details className="rounded-xl border border-slate-300 p-3 dark:border-slate-700">
            <summary className="cursor-pointer text-sm font-semibold">Password generator</summary>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2">Length
                <input className={`${inputClass} !w-20`} type="number" min={8} max={64} value={length}
                  onChange={(event) => setLength(Number(event.target.value))} />
              </label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={digits} onChange={(event) => setDigits(event.target.checked)} /> Digits</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={symbols} onChange={(event) => setSymbols(event.target.checked)} /> Symbols</label>
              <Button type="button" variant="secondary" disabled={!Number.isInteger(length) || length < 8 || length > 64}
                onClick={() => onChange({ ...entry, password: generateVaultPassword(length, digits, symbols) })}>Generate</Button>
            </div>
          </details>
          <label className="block space-y-1 text-sm font-semibold">
            <span>Notes</span>
            <textarea className={inputClass} maxLength={4000} spellCheck={false} autoCapitalize="none"
              value={entry.notes} onChange={(event) => onChange({ ...entry, notes: event.target.value })} />
          </label>
        </fieldset>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save login'}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
