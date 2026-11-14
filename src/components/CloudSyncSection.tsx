import React, { useEffect, useState } from 'react';
import { CheckCircle2, Cloud, CloudOff, Loader2, LogOut, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { cn } from '../lib/cn';
import type { CloudSyncApi } from '../hooks/useCloudSync';
import type { CloudCheckStep } from '../services/cloudSyncService';

interface CloudSyncSectionProps {
  sync: CloudSyncApi;
}

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

/** Account and sync controls. Sign-in itself happens on the login screen before the app opens. */
export const CloudSyncSection: React.FC<CloudSyncSectionProps> = ({ sync }) => {
  const { status, account, lastSyncedAt, error, configured } = sync;
  const isBusy = status === 'syncing';
  const [checking, setChecking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [checks, setChecks] = useState<CloudCheckStep[] | null>(null);

  useEffect(() => {
    if (!account) setChecks(null);
  }, [account]);

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
    if (!configured) return 'Cloud sync is not configured for this build. Data stays on this device.';
    if (status === 'syncing') return 'Syncing…';
    if (status === 'error') return error ?? 'Last sync failed.';
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
          <span>Account & Sync</span>
        </h3>
        {account && (
          <span
            className={cn(
              'text-[10px] font-bold px-2 py-0.5 rounded-full border',
              status === 'error'
                ? 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800'
                : 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
            )}
          >
            {status === 'error' ? 'Not synced' : 'Synced'}
          </span>
        )}
      </div>

      {account && (
        <div className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="truncate">Signed in as {account.email}</span>
        </div>
      )}

      <p className={cn('text-[11px] leading-relaxed', status === 'error' ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400')}>
        {statusLine}
      </p>

      {configured && account && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={() => void sync.syncNow()} disabled={isBusy || signingOut}>
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
            disabled={isBusy || signingOut}
          >
            <span>Restore from cloud</span>
          </Button>

          <Button size="sm" variant="ghost" onClick={() => void runCheck()} disabled={isBusy || checking || signingOut}>
            {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            <span>Test connection</span>
          </Button>

          <Button
            size="sm"
            variant="danger"
            disabled={signingOut}
            onClick={() => {
              if (!window.confirm('Sign out? Your data stays on this device, and you will need to sign in again to use Dayflow.')) return;
              setSigningOut(true);
              void sync.disconnect().finally(() => setSigningOut(false));
            }}
          >
            {signingOut ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
            <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
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
                <span className="font-semibold text-slate-800 dark:text-slate-200">{check.step}:</span> {check.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {configured && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-relaxed">
          Your tasks, money and diary sync to your account, and this device keeps a full copy that works offline.
        </p>
      )}
    </div>
  );
};
