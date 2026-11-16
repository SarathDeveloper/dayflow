import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Copy, Download, KeyRound, LockKeyhole, Plus } from 'lucide-react';
import {
  createVault, generateVaultPassword, MAX_VAULT_FILE, MIN_VAULT_PASSPHRASE,
  openVault, readVaultFile, sealEntries,
} from '../lib/passwordVault';
import type { VaultEntry } from '../lib/passwordVault';
import { PasswordVault } from '../services/passwordVault';
import { todayString } from '../lib/ledger';
import { Button } from './ui/Button';
import { Card } from './ui/Card';

const IDLE_MS = 60_000;
const inputClass = 'w-full min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white';
const blankEntry = { id: '', title: '', website: '', username: '', password: '', notes: '' };

type OpenVault = Awaited<ReturnType<typeof openVault>>;
type Mode = 'unlock' | 'create' | 'restore' | 'change';

export default function PasswordVaultView({ onExit }: { onExit?: () => void }) {
  const [stored, setStored] = useState<string | null>();
  const [protectedScreen, setProtectedScreen] = useState(false);
  const [session, setSession] = useState<OpenVault | null>(null);
  const [mode, setMode] = useState<Mode>('unlock');
  const [backup, setBackup] = useState<string>();
  const [passphrase, setPassphrase] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<VaultEntry>();
  const [revealed, setRevealed] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);

  const clearPassphrases = useCallback(() => {
    setPassphrase('');
    setNewPassphrase('');
    setRepeat('');
  }, []);

  const lock = useCallback(() => {
    epoch.current++;
    setSession(null);
    setDraft(undefined);
    setRevealed(undefined);
    setDeleting(undefined);
    setQuery('');
    clearPassphrases();
    setMode((current) => current === 'change' ? 'unlock' : current);
  }, [clearPassphrases]);

  useEffect(() => {
    mounted.current = true;
    const protection = PasswordVault.setScreenProtected({ enabled: true });
    void protection.then(() => {
      if (mounted.current) setProtectedScreen(true);
    }).catch(() => {
      if (mounted.current) setError('Screen protection is unavailable. Update the Android app to use the vault.');
    });
    const onVisibility = () => {
      if (document.hidden) lock();
    };
    const listener = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) lock();
    });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      epoch.current++;
      document.removeEventListener('visibilitychange', onVisibility);
      void listener.then((handle) => handle.remove()).catch(() => {});
      void PasswordVault.setScreenProtected({ enabled: false }).catch(() => {});
    };
  }, [lock]);

  useEffect(() => {
    if (!protectedScreen) return;
    let current = true;
    void PasswordVault.read().then(({ contents }) => {
      if (current) setStored(contents ?? null);
    }).catch(() => {
      if (current) setError('Could not read the vault on this device.');
    });
    return () => { current = false; };
  }, [protectedScreen, reload]);

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

  const save = async (next: OpenVault, isCurrent: () => boolean) => {
    if (!isCurrent()) return;
    const contents = JSON.stringify(next.file);
    await PasswordVault.write({ contents, previous: stored ?? undefined });
    if (!mounted.current) return;
    setStored(contents);
    if (isCurrent()) setSession(next);
  };

  const submitPassphrase = (event: FormEvent) => {
    event.preventDefault();
    void run(async (isCurrent) => {
      clearPassphrases();
      if (mode === 'create' || mode === 'change') {
        if (newPassphrase !== repeat) throw new Error('The two passphrases do not match.');
        if (mode === 'change' && stored) await openVault(readVaultFile(stored), passphrase);
        if (!isCurrent()) return;
        await save(await createVault(newPassphrase, session?.entries), isCurrent);
        if (isCurrent()) setNotice('Save an encrypted backup with your new passphrase.');
      } else {
        const source = mode === 'restore' ? backup : stored;
        if (!source) return;
        const opened = await openVault(readVaultFile(source), passphrase);
        if (!isCurrent()) return;
        if (mode === 'restore') {
          await save(opened, isCurrent);
          if (isCurrent()) setNotice('Encrypted backup restored.');
        } else {
          setSession(opened);
        }
      }
      if (isCurrent()) {
        setBackup(undefined);
        setMode('unlock');
      }
    });
  };

  const saveEntries = async (entries: VaultEntry[], isCurrent: () => boolean) => {
    if (!session || !isCurrent()) return;
    const encrypted = await sealEntries(session.file.id, session.key, entries);
    await save({ ...session, file: { ...session.file, entries: encrypted }, entries }, isCurrent);
    if (isCurrent()) {
      setDraft(undefined);
      setRevealed(undefined);
      setDeleting(undefined);
    }
  };

  const submitEntry = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !session) return;
    const entry = { ...draft, title: draft.title.trim(), id: draft.id || crypto.randomUUID() };
    void run(async (isCurrent) => {
      if (!entry.title) throw new Error('Enter a title.');
      const entries = draft.id
        ? session.entries.map((item) => item.id === entry.id ? entry : item)
        : [...session.entries, entry];
      await saveEntries(entries, isCurrent);
    });
  };

  const exportBackup = () => {
    if (!stored || !session) return;
    void run(async () => {
      const filename = `dayflow-vault-${todayString()}.json`;
      const { saved } = await PasswordVault.exportBackup({ contents: stored, filename });
      if (saved && mounted.current) setNotice('Encrypted backup saved.');
    });
  };

  const loadBackup = async (file: File) => {
    setError('');
    try {
      if (file.size > MAX_VAULT_FILE) throw new Error('The vault file exceeds 2 MB.');
      const selected = readVaultFile(await file.text());
      if (!mounted.current) return;
      setBackup(JSON.stringify(selected));
      clearPassphrases();
      setMode('restore');
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not open the backup.');
    }
  };

  const cancelForm = () => {
    clearPassphrases();
    setMode('unlock');
    setBackup(undefined);
    setError('');
  };
  const visibleEntries = session?.entries.filter((entry) =>
    [entry.title, entry.website, entry.username].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())),
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
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-indigo-50 p-3 text-sm text-indigo-800 dark:bg-indigo-950 dark:text-indigo-100">{notice}</p>}

      {stored === undefined ? (
        <Card className="p-4">
          {error ? <Button variant="secondary" onClick={() => {
            setError('');
            setReload((value) => value + 1);
            if (!protectedScreen) void PasswordVault.setScreenProtected({ enabled: true }).then(() => setProtectedScreen(true))
              .catch(() => setError('Screen protection is unavailable. Update the Android app to use the vault.'));
          }}>Retry</Button> : <p role="status">Loading vault…</p>}
        </Card>
      ) : !session || mode === 'change' ? (
        <Card className="space-y-4 p-4">
          {stored === null && mode === 'unlock' ? (
            <>
              <p className="text-sm">Create a vault on this device or restore an encrypted Dayflow vault backup.</p>
              <Button onClick={() => { setError(''); setMode('create'); }}>Create vault</Button>
              <label className="block space-y-1 text-sm font-semibold">
                <span>Restore encrypted backup</span>
                <input className={inputClass} type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void loadBackup(file);
                }} />
              </label>
            </>
          ) : (
            <form className="space-y-3" onSubmit={submitPassphrase} autoComplete="off">
              {mode === 'create' && (
                <p className="text-sm">Use a unique passphrase of at least {MIN_VAULT_PASSPHRASE} characters. Keep it somewhere safe. A backup requires the passphrase in use when you saved it.</p>
              )}
              {mode !== 'create' && <PassphraseField
                label={mode === 'restore' ? 'Backup passphrase' : mode === 'change' ? 'Current vault passphrase' : 'Vault passphrase'}
                value={passphrase} onChange={setPassphrase} disabled={busy}
              />}
              {(mode === 'create' || mode === 'change') && <>
                <PassphraseField label="New vault passphrase" value={newPassphrase} onChange={setNewPassphrase} disabled={busy} />
                <PassphraseField label="Repeat vault passphrase" value={repeat} onChange={setRepeat} disabled={busy} />
              </>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? 'Working…' : { unlock: 'Unlock', create: 'Create vault', restore: 'Restore vault', change: 'Change passphrase' }[mode]}
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
            <input type="search" aria-label="Search vault" placeholder="Search by site or username" className={inputClass}
              value={query} onChange={(event) => { setRevealed(undefined); setQuery(event.target.value); }} />
          </Card>
          {visibleEntries?.length === 0 && <p className="text-sm">{session.entries.length ? 'No matching logins.' : 'Your vault is empty.'}</p>}
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
                  <p className="text-sm">Delete this login?</p>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run((isCurrent) =>
                    saveEntries(session.entries.filter((item) => item.id !== entry.id), isCurrent),
                  )}>Delete login</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(undefined)}>Cancel</Button>
                </div>
              ) : <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRevealed(revealed === entry.id ? undefined : entry.id)}>
                  {revealed === entry.id ? 'Hide password' : 'Reveal password'}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async (isCurrent) => {
                  await PasswordVault.copySecret({ text: entry.password });
                  if (isCurrent()) setNotice('Password copied.');
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
