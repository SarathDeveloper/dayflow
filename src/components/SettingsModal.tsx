import React, { useEffect, useRef, useState } from 'react';
import { X, Bell, Moon, Sun, Download, Upload, RotateCcw, Folder, Settings2 } from 'lucide-react';
import { NotificationSettings } from '../types';
import { setAppLockEnabled } from '../lib/appLock';
import { isNativeAndroid } from '../lib/platform';
import {
  forgetAppLockCredential,
  isAppLockActive,
  isAppLockSupported,
  promptAppUnlock,
  setUpAppLock,
} from '../services/appLock';
import { storedAccount } from '../services/cloudSyncService';
import { isAppUpdaterAvailable } from '../services/appUpdater';
import { SettingSwitch } from './ui/SettingSwitch';
import { AppUpdatesSection } from './AppUpdatesSection';
import { CloudSyncSection } from './CloudSyncSection';
import { ProgressSettingsSection } from './ProgressSettingsSection';
import type { CloudSyncApi } from '../hooks/useCloudSync';

const categories = [
  { id: 'general', label: 'General' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'planning', label: 'Planning' },
  { id: 'data', label: 'Data' },
] as const;

const sectionTitle = 'text-sm font-semibold text-slate-900 dark:text-slate-100';
const helpText = 'text-xs leading-relaxed text-slate-600 dark:text-slate-400';
const divider = 'border-t border-slate-200 dark:border-slate-800 pt-4';
const field = 'min-h-10 w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: NotificationSettings;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onUpdateSettings: (newSettings: NotificationSettings) => void;
  onResetTasks: () => void;
  onExportData: () => void;
  onImportData: (e: React.ChangeEvent<HTMLInputElement>) => void;
  backupFolderSupported: boolean;
  backupFolderName: string | null;
  backupLastSavedAt: string | null;
  backupFolderError: string;
  onChooseBackupFolder: () => void;
  onStopBackupFolder: () => void;
  cloudSync: CloudSyncApi;
  /** Sound, voice, quiet hours and alarm songs live on the Notifications page. */
  onOpenNotifications: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  theme,
  onToggleTheme,
  onUpdateSettings,
  onResetTasks,
  onExportData,
  onImportData,
  backupFolderSupported,
  backupFolderName,
  backupLastSavedAt,
  backupFolderError,
  onChooseBackupFolder,
  onStopBackupFolder,
  cloudSync,
  onOpenNotifications,
}) => {
  const [category, setCategory] = useState<(typeof categories)[number]['id']>('general');
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [appLockOn, setAppLockOn] = useState(() => isAppLockActive());
  const [appLockError, setAppLockError] = useState('');
  const [appLockBusy, setAppLockBusy] = useState(false);
  // Android always has the lock; a browser needs a built-in fingerprint/face/PIN authenticator.
  const [appLockSupported, setAppLockSupported] = useState(() => isNativeAndroid());

  useEffect(() => {
    if (!isOpen) {
      setCategory('general');
      return;
    }
    setAppLockOn(isAppLockActive());
    let cancelled = false;
    void isAppLockSupported().then((supported) => {
      if (!cancelled) setAppLockSupported(supported);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleAppLock = async () => {
    if (appLockBusy) return;
    setAppLockError('');
    setAppLockBusy(true);
    try {
      const enabling = !appLockOn;
      // Turning it on checks (Android) or registers (website) the fingerprint. Turning it
      // off asks again on Android; on the website the open app is already unlocked, and a
      // broken fingerprint must not trap the lock on.
      if (enabling || isNativeAndroid()) {
        const result = enabling ? await setUpAppLock(storedAccount()?.email ?? '') : await promptAppUnlock();
        if (!result.ok) {
          if (!result.canceled) setAppLockError(result.message);
          return;
        }
      }
      if (!enabling) forgetAppLockCredential();
      setAppLockEnabled(enabling);
      setAppLockOn(enabling);
    } finally {
      setAppLockBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4 bg-slate-950/60 dark:bg-slate-950/80 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const panel: HTMLDivElement = event.currentTarget;
          const controls = Array.from(panel.querySelectorAll<HTMLElement>(
            'button:enabled, input:enabled, select:enabled, summary, a[href]',
          )).filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        className="flex h-[min(34rem,94dvh)] w-full min-w-0 max-w-lg flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl animate-in fade-in sm:rounded-2xl dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
      >
        <header className="shrink-0 px-4 pt-4 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <h2 id="settings-title" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
              <Settings2 aria-hidden="true" className="size-5 text-indigo-600 dark:text-indigo-400" />
              Settings
            </h2>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close settings"
              onClick={onClose}
              className="grid size-11 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>

          <nav aria-label="Settings categories" className="mt-2 grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-950/60">
            {categories.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={category === id}
                onClick={() => {
                  if (category === id) return;
                  setCategory(id);
                  if (contentRef.current) contentRef.current.scrollTop = 0;
                }}
                className={`min-h-10 min-w-0 rounded-lg px-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-indigo-500 sm:text-sm ${
                  category === id
                    ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-800 dark:text-indigo-300'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] text-xs sm:px-6">
          <div hidden={category !== 'general'} className="space-y-5">
            <section className="space-y-3">
              <h3 className={sectionTitle}>Appearance</h3>
              <div role="group" aria-label="Color theme" className="grid grid-cols-2 gap-2">
                {([
                  { value: 'light', label: 'Light', icon: Sun },
                  { value: 'dark', label: 'Dark', icon: Moon },
                ] as const).map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={theme === value}
                    onClick={() => { if (theme !== value) onToggleTheme(); }}
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border px-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-indigo-500 ${
                      theme === value
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-200'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    {label}
                  </button>
                ))}
              </div>
            </section>

            {(appLockSupported || appLockOn) && (
              <section aria-label="App lock" className="border-t border-slate-200 pt-2 dark:border-slate-800">
                <SettingSwitch label="App lock" checked={appLockOn} disabled={appLockBusy} onChange={() => void toggleAppLock()} />
                <p className={helpText}>Use your fingerprint, face unlock, or PIN to open Dayflow.</p>
                {!isNativeAndroid() && (
                  <details className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                    <summary className="w-fit cursor-pointer rounded py-1 font-medium text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300">How app lock works</summary>
                    <p className="mt-2 leading-relaxed">
                      Locks after 1 minute away. Your account password also unlocks it.
                      It blocks access but doesn't encrypt data in this browser.
                    </p>
                  </details>
                )}
                {appLockOn && !appLockSupported && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                    This device lost its fingerprint, face or PIN unlock. Set one up again, or turn the lock off.
                  </p>
                )}
                {appLockError && <p role="alert" className="mt-2 text-xs text-rose-700 dark:text-rose-300">{appLockError}</p>}
              </section>
            )}

            {isAppUpdaterAvailable() && <AppUpdatesSection />}
          </div>

          {category === 'alerts' && (
            <section aria-labelledby="settings-alerts" className="space-y-3">
              <h3 id="settings-alerts" className={sectionTitle}>Notifications</h3>
              <p className={helpText}>
                Sounds, quiet hours and alarm songs are on the Notifications page.
              </p>
              <button
                type="button"
                onClick={onOpenNotifications}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
              >
                <Bell aria-hidden="true" className="size-4" />
                Open Notifications
              </button>
            </section>
          )}

          <div hidden={category !== 'planning'}>
            <ProgressSettingsSection settings={settings} onUpdateSettings={onUpdateSettings} />
          </div>

          <div hidden={category !== 'data'} className="space-y-5">
            <CloudSyncSection sync={cloudSync} />

            {/* Backup & Data Controls */}
            <div className={`space-y-3 ${divider}`}>
              <h3 className={sectionTitle}>Backup & recovery</h3>
              <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                Includes tasks, diary, habits, goals, money and alarms. Not alarm songs.
              </p>
              {backupFolderSupported && (
                <div className="space-y-2">
                  <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                    Leaving the app replaces dayflow-backup.json in that folder.
                  </p>
                  {backupFolderName ? (
                    <>
                      <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                        <Folder className="w-3.5 h-3.5" />
                        <span>{backupFolderName}</span>
                      </p>
                      {backupLastSavedAt && (
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          Last saved {new Date(backupLastSavedAt).toLocaleString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </p>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={onChooseBackupFolder}
                          className="py-2 px-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 font-semibold transition-colors"
                        >
                          Change folder
                        </button>
                        <button
                          onClick={onStopBackupFolder}
                          className="py-2 px-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 font-semibold transition-colors"
                        >
                          Stop automatic backup
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      onClick={onChooseBackupFolder}
                      className="w-full py-2 px-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 font-semibold flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Folder className="w-3.5 h-3.5" />
                      <span>Choose folder</span>
                    </button>
                  )}
                  {backupFolderError && (
                    <p className="text-[11px] text-rose-600 dark:text-rose-300">{backupFolderError}</p>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={onExportData}
                  className="py-2 px-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export JSON</span>
                </button>

                <label className="py-2 px-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors focus-within:outline-2 focus-within:outline-indigo-500">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Import JSON</span>
                  <input
                    type="file"
                    accept="application/json,.json,text/plain"
                    onChange={onImportData}
                    className="sr-only"
                  />
                </label>
              </div>

              <button
                onClick={onResetTasks}
                className="w-full mt-2 py-2 px-3 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 border border-rose-200 dark:border-rose-800/60 text-rose-600 dark:text-rose-300 font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset to Sample Tasks</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
