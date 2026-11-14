import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  CloudOff,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { Button } from './ui/Button';
import { cn } from '../lib/cn';
import type { CloudSyncApi } from '../hooks/useCloudSync';
import type { CloudCheckStep } from '../services/cloudSyncService';

interface CloudSyncSectionProps {
  sync: CloudSyncApi;
}

const MIN_PASSWORD_LENGTH = 8;

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never synced';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'Never synced';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  return `Synced ${Math.round(hours / 24)} d ago`;
}

const inputClass =
  'w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500';

export const CloudSyncSection: React.FC<CloudSyncSectionProps> = ({ sync }) => {
  const { status, account, lastSyncedAt, error, notice, configured } = sync;
  const isBusy = status === 'syncing' || status === 'connecting';
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<CloudCheckStep[] | null>(null);
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // A result from the previous account would be misleading after a switch.
  useEffect(() => {
    if (!account) setChecks(null);
  }, [account]);

  const showForm = configured && (!account || status === 'needs-auth');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!email.trim() || !password) {
      setFormError('Enter your email and password.');
      return;
    }
    if (mode === 'signup' && password.length < MIN_PASSWORD_LENGTH) {
      setFormError(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);
      return;
    }
    const ok = mode === 'signin' ? await sync.signIn(email, password) : await sync.signUp(email, password);
    if (ok) {
      setPassword('');
      if (mode === 'signup') setMode('signin');
    }
  };

  const runCheck = async () => {
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await sync.testConnection());
    } catch (e) {
      setChecks([{ step: 'Connection test', ok: false, message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setChecking(false);
    }
  };

  const statusLine = (() => {
    if (!configured) return 'Not configured for this build.';
    if (status === 'connecting') return mode === 'signup' ? 'Creating your account…' : 'Signing in…';
    if (status === 'syncing') return 'Syncing…';
    if (status === 'needs-auth') return error ?? 'Sign in again to keep syncing.';
    if (status === 'error') return error ?? 'Last sync failed.';
    if (!account) return 'Data stays on this device until you sign in.';
    return formatRelative(lastSyncedAt);
  })();

  return (
    <div className="space-y-3 bg-slate-50 dark:bg-slate-950/60 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold text-slate-800 dark:text-slate-200 text-xs flex items-center gap-1.5">
          {account ? (
            <Cloud className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          ) : (
            <CloudOff className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          )}
          <span>Cloud Sync</span>
        </h3>
        {account && status !== 'connecting' && (
          <span
            className={cn(
              'text-[10px] font-bold px-2 py-0.5 rounded-full border',
              status === 'error' || status === 'needs-auth'
                ? 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800'
                : 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
            )}
          >
            {status === 'error' ? 'Error' : status === 'needs-auth' ? 'Sign in' : 'Linked'}
          </span>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{statusLine}</p>

      {account && (
        <div className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="truncate">{account.email}</span>
        </div>
      )}

      {notice && (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-400 break-words" role="status">
          {notice}
        </p>
      )}

      {error && !account && status !== 'needs-auth' && (
        <p className="text-[11px] text-rose-600 dark:text-rose-400 break-words" role="alert">
          {error}
        </p>
      )}

      {!configured && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Set <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
          <code className="font-mono">VITE_SUPABASE_PUBLISHABLE_KEY</code> and rebuild to enable cloud sync.
        </p>
      )}

      {showForm && (
        <form className="space-y-2" onSubmit={(event) => void submit(event)}>
          <div className="flex gap-1 rounded-lg bg-slate-200/70 dark:bg-slate-800 p-0.5 text-[11px] font-semibold">
            {(['signin', 'signup'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setFormError(null);
                }}
                className={cn(
                  'flex-1 rounded-md py-1.5 transition-colors',
                  mode === value
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400',
                )}
                aria-pressed={mode === value}
              >
                {value === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="sr-only">Email</span>
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
              disabled={isBusy}
              required
            />
          </label>
          <label className="block">
            <span className="sr-only">Password</span>
            <input
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              placeholder={mode === 'signin' ? 'Password' : `Password (${MIN_PASSWORD_LENGTH}+ characters)`}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
              disabled={isBusy}
              required
            />
          </label>
          {formError && (
            <p className="text-[11px] text-rose-600 dark:text-rose-400" role="alert">
              {formError}
            </p>
          )}
          <Button type="submit" size="sm" variant="primary" disabled={isBusy} className="w-full justify-center">
            {isBusy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : mode === 'signin' ? (
              <LogIn className="w-3.5 h-3.5" />
            ) : (
              <UserPlus className="w-3.5 h-3.5" />
            )}
            <span>{mode === 'signin' ? 'Sign in and sync' : 'Create account'}</span>
          </Button>
        </form>
      )}

      {configured && account && status !== 'needs-auth' && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={() => void sync.syncNow()} disabled={isBusy}>
            {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span>Sync now</span>
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (
                window.confirm(
                  'Replace the data on this device with the cloud copy? Changes on this device that have not synced yet will be lost.',
                )
              ) {
                void sync.restoreFromCloud();
              }
            }}
            disabled={isBusy}
          >
            <span>Restore from cloud</span>
          </Button>

          <Button size="sm" variant="ghost" onClick={() => void runCheck()} disabled={isBusy || checking}>
            {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            <span>Test connection</span>
          </Button>

          <Button size="sm" variant="danger" onClick={() => void sync.disconnect()} disabled={isBusy}>
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </Button>
        </div>
      )}

      {checks && (
        <ul className="space-y-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5">
          {checks.map((check, index) => (
            <li key={`${check.step}-${index}`} className="flex items-start gap-1.5 text-[11px]">
              {check.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-px" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0 mt-px" />
              )}
              <span className="text-slate-600 dark:text-slate-300 break-words">
                <span className="font-semibold text-slate-800 dark:text-slate-200">{check.step}:</span>{' '}
                {check.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {configured && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
          Your tasks, money and diary sync to your own account, and each device keeps a full copy that works
          offline. Sync now uploads this device and downloads changes made elsewhere.
          {account ? ' Signing out leaves your data on this device.' : ''}
        </p>
      )}
    </div>
  );
};
