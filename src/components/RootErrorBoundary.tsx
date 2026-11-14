import React from 'react';
import { SplashScreen } from '@capacitor/splash-screen';
import { isReleaseVersion } from '../lib/appUpdate';
import { isNativeAndroid } from '../lib/platform';
import { currentWebVersion, isAppUpdaterAvailable, restoreInstalledVersion } from '../services/appUpdater';

interface State {
  failed: boolean;
}

/**
 * Last line of defence: a crash shows this screen instead of a blank page (or
 * a splash screen that never hides). On Android, updated app code can be
 * rolled back to the code inside the installed APK from here.
 */
export class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  declare props: Readonly<{ children: React.ReactNode }>;
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('Dayflow crashed:', error);
    if (isNativeAndroid()) void SplashScreen.hide().catch(() => undefined);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const canRestore = isAppUpdaterAvailable() && isReleaseVersion(currentWebVersion());
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-slate-950 px-6 text-center text-slate-100">
        <h1 className="text-lg font-bold">Something went wrong</h1>
        <p className="max-w-xs text-sm text-slate-400">
          Dayflow hit an error. Your data is saved on this device. Try reloading
          {canRestore ? ', or go back to the version that came with the app.' : '.'}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white"
        >
          Reload
        </button>
        {canRestore && (
          <button
            type="button"
            onClick={() => void restoreInstalledVersion().catch(() => window.location.reload())}
            className="rounded-xl border border-slate-700 px-6 py-2.5 text-sm font-semibold text-slate-200"
          >
            Restore previous version
          </button>
        )}
      </div>
    );
  }
}
