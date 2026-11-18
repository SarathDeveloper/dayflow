import React, { useEffect, useState } from 'react';
import { DownloadCloud, RefreshCw } from 'lucide-react';
import { isReleaseVersion } from '../lib/appUpdate';
import { checkForUpdates, getUpdateStatus, restartIntoUpdate, type UpdateStatus } from '../services/appUpdater';
import { offerApkUpdate } from '../hooks/useAppUpdates';

/** "20261114.1842-477f216" -> "14 Nov 2026, 18:42 UTC". */
function describeVersion(version: string): string {
  if (!isReleaseVersion(version)) return 'local build';
  const y = Number(version.slice(0, 4));
  const m = Number(version.slice(4, 6));
  const d = Number(version.slice(6, 8));
  const hh = Number(version.slice(9, 11));
  const mm = Number(version.slice(11, 13));
  const at = new Date(Date.UTC(y, m - 1, d, hh, mm));
  return at.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Settings (Android): version, update status, and a manual check. */
export const AppUpdatesSection: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getUpdateStatus()
      .then((value) => !cancelled && setStatus(value))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const check = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('Checking…');
    try {
      const result = await checkForUpdates();
      setStatus(await getUpdateStatus());
      switch (result.kind) {
        case 'up-to-date':
          setMessage('Dayflow is up to date.');
          break;
        case 'downloaded':
        case 'pending':
          setMessage('An update is ready. It applies the next time you open Dayflow, or restart now.');
          break;
        case 'apk':
          setMessage('A new app version is available.');
          await offerApkUpdate(result.manifest, true);
          break;
        case 'offline':
          setMessage('Could not reach the update server. Check your connection.');
          break;
        default:
          setMessage('The update check failed. Try again later.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 bg-slate-50 dark:bg-slate-950/60 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
      <h3 className="font-bold text-slate-800 dark:text-slate-200 text-xs flex items-center gap-1.5">
        <DownloadCloud className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
        <span>App updates</span>
      </h3>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
        Updates download in the background and apply when you reopen Dayflow.
      </p>
      {status && (
        <p className="text-[11px] text-slate-600 dark:text-slate-300">
          Version {status.versionName} (build {status.nativeBuild}) · app code {describeVersion(status.webVersion)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700 font-semibold disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          Check for updates
        </button>
        {status?.pendingVersion && (
          <button
            type="button"
            onClick={() => void restartIntoUpdate()}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-semibold"
          >
            Restart to update
          </button>
        )}
      </div>
      {message && <p className="text-[11px] text-slate-600 dark:text-slate-300">{message}</p>}
    </div>
  );
};
