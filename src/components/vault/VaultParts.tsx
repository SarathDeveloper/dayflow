/** Small shared pieces of the Password Vault screens. */
import { useEffect, useState } from 'react';
import { Check, Cloud, CloudOff, Copy, CreditCard, KeyRound, RefreshCw, StickyNote, Wifi } from 'lucide-react';
import type { VaultEntry, VaultItemKind } from '../../lib/passwordVault';
import { passwordStrength, STRENGTH_LABEL } from '../../lib/vaultHealth';
import type { Strength } from '../../lib/vaultHealth';
import { totpCode } from '../../lib/totp';
import type { VaultSyncResult } from '../../services/passwordVault';
import { cn } from '../../lib/cn';

export const inputClass = 'w-full min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white';
export const labelClass = 'block space-y-1 text-sm font-semibold';

export const KIND_LABEL: Record<VaultItemKind, string> = {
  login: 'Login',
  card: 'Card',
  wifi: 'Wi-Fi',
  note: 'Secure note',
};

export const KIND_PLURAL: Record<VaultItemKind, string> = {
  login: 'Logins',
  card: 'Cards',
  wifi: 'Wi-Fi',
  note: 'Notes',
};

export const KIND_ICON: Record<VaultItemKind, typeof KeyRound> = {
  login: KeyRound,
  card: CreditCard,
  wifi: Wifi,
  note: StickyNote,
};

export const SUGGESTED_CATEGORIES = ['Banking', 'Work', 'Personal', 'Social', 'Shopping', 'Bills'];

const AVATAR_COLORS = [
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
];

export function kindOf(entry: VaultEntry): VaultItemKind {
  return entry.kind ?? 'login';
}

function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : title.trim().slice(0, 2);
  return letters.toUpperCase() || '?';
}

export function ItemAvatar({ entry, size = 'md' }: { entry: VaultEntry; size?: 'md' | 'lg' }) {
  let hash = 0;
  for (const char of entry.title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const kind = kindOf(entry);
  const Icon = KIND_ICON[kind];
  const box = size === 'lg' ? 'size-12 text-base' : 'size-10 text-sm';
  return (
    <div aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-xl font-bold', box, AVATAR_COLORS[hash % AVATAR_COLORS.length])}>
      {kind === 'login' ? initials(entry.title) : <Icon className="size-5" />}
    </div>
  );
}

/** "Card ending 4242" style secondary line for the list. */
export function itemSubtitle(entry: VaultEntry): string {
  const kind = kindOf(entry);
  if (kind === 'card') {
    const digits = entry.card?.number.replace(/\D/g, '') ?? '';
    return digits.length >= 4 ? `Card ending ${digits.slice(-4)}` : 'Card';
  }
  if (kind === 'wifi') return entry.username ? `Wi-Fi · ${entry.username}` : 'Wi-Fi';
  if (kind === 'note') return 'Secure note';
  return entry.username || entry.website || '';
}

/** A copy button that shows a tick for a moment. */
export function CopyButton({ label, onCopy, disabled, icon: Icon = Copy }: {
  label: string;
  onCopy: () => Promise<void>;
  disabled?: boolean;
  icon?: typeof Copy;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void onCopy().then(() => setDone(true)).catch(() => undefined);
      }}
      className="flex size-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white">
      {done ? <Check className="size-4 text-emerald-600" /> : <Icon className="size-4" />}
    </button>
  );
}

const STRENGTH_STYLE: Record<Strength, { bar: string; text: string; width: string }> = {
  weak: { bar: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-300', width: 'w-1/4' },
  fair: { bar: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300', width: 'w-2/4' },
  strong: { bar: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', width: 'w-3/4' },
  'very-strong': { bar: 'bg-emerald-600', text: 'text-emerald-700 dark:text-emerald-300', width: 'w-full' },
};

export function StrengthBadge({ password }: { password: string }) {
  const strength = passwordStrength(password);
  const style = STRENGTH_STYLE[strength];
  return <span className={cn('text-xs font-semibold', style.text)}>{STRENGTH_LABEL[strength]}</span>;
}

export function StrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const strength = passwordStrength(password);
  const style = STRENGTH_STYLE[strength];
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800">
        <div className={cn('h-1.5 rounded-full transition-all', style.bar, style.width)} />
      </div>
      <p className={cn('text-xs font-semibold', style.text)}>Strength: {STRENGTH_LABEL[strength]}</p>
    </div>
  );
}

/** The live 2FA code with a countdown. */
export function TotpCode({ secret, onCopy }: { secret: string; onCopy: (code: string) => Promise<void> }) {
  const [state, setState] = useState<{ code: string; remaining: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    const tick = () => {
      void totpCode(secret).then((next) => {
        if (current) {
          setState(next);
          setError('');
        }
      }).catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : 'Invalid 2FA secret.');
      });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [secret]);
  if (error) return <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>;
  if (!state) return <p className="text-sm">…</p>;
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-xl font-bold tracking-widest">{state.code.replace(/(\d{3})(?=\d)/g, '$1 ')}</span>
      <span className={cn('text-xs tabular-nums', state.remaining <= 5 ? 'text-rose-600' : 'text-slate-500 dark:text-slate-400')}>{state.remaining}s</span>
      <CopyButton label="Copy 2FA code" onCopy={() => onCopy(state.code)} />
    </div>
  );
}

function relative(iso: string | null, now: number): string {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function SyncPill({ configured, signedIn, sync, syncedAt, syncing, onSync }: {
  configured: boolean;
  signedIn: boolean;
  sync: VaultSyncResult | null;
  syncedAt: string | null;
  syncing: boolean;
  onSync: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!configured) return null;
  let text: string;
  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  if (!signedIn) text = 'This device only · sign in to sync';
  else if (syncing && !sync) text = 'Syncing…';
  else if (!sync) text = 'Not synced yet';
  else if (sync.status === 'synced') {
    text = `Synced ${relative(syncedAt, now)}`;
    tone = 'ok';
  } else if (sync.status === 'offline') {
    text = 'Offline · changes sync later';
    tone = 'warn';
  } else if (sync.status === 'needs-upgrade') text = 'Unlock once to start syncing';
  else if (sync.status === 'no-vault') text = 'No vault in your account yet';
  else if (sync.status === 'local-only') text = 'This device only';
  else {
    text = 'Not syncing';
    tone = 'warn';
  }
  const Icon = tone === 'ok' ? Cloud : CloudOff;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span title={sync?.message} className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
        tone === 'ok' && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
        tone === 'warn' && 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
        tone === 'muted' && 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
      )}>
        <Icon className="size-3.5" /> {text}
      </span>
      {signedIn && (
        <button type="button" onClick={onSync} disabled={syncing}
          className="inline-flex min-h-9 items-center gap-1 rounded-full px-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-300 dark:hover:bg-indigo-950">
          <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} /> Sync now
        </button>
      )}
    </div>
  );
}

/** Adds https:// to a bare host; returns null for anything that is not http(s). */
export function openableUrl(website: string): string | null {
  const value = website.trim();
  if (!value) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
