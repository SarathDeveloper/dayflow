import { useEffect } from 'react';
import { App as CapApp } from '@capacitor/app';
import { isNativeAndroid } from '../lib/platform';
import { UPDATE_CHECK_INTERVAL_MS, type UpdateManifest } from '../lib/appUpdate';
import {
  checkForUpdates,
  installApkUpdate,
  isApkOfferSnoozed,
  lastUpdateCheckAt,
  openInstallPermissionSettings,
  restartIntoUpdate,
  snoozeApkOffer,
} from '../services/appUpdater';
import { openAlert, showAlert, showConfirm } from '../components/ui/AppDialog';

let offering = false;

/**
 * Offers a new APK. "Later" keeps quiet for a day unless the person asked
 * (`manual`, from Settings). Android shows its own Install screen at the end.
 */
export async function offerApkUpdate(manifest: UpdateManifest, manual = false): Promise<void> {
  if (offering) return;
  if (!manual && isApkOfferSnoozed(manifest.apk.build)) return;
  offering = true;
  try {
    const ok = await showConfirm({
      title: 'Update available',
      message: `Dayflow ${manifest.apk.versionName} (build ${manifest.apk.build}) changes phone features, so it needs a new app install. Download it now? Android will ask you to tap Install. Your data stays.`,
      confirmLabel: 'Download',
      cancelLabel: 'Later',
    });
    if (!ok) {
      if (!manual) snoozeApkOffer(manifest.apk.build);
      return;
    }
    const downloading = openAlert({
      title: 'Downloading update…',
      message: 'Android’s installer opens when the download is ready.',
    });
    let result: Awaited<ReturnType<typeof installApkUpdate>>;
    try {
      result = await installApkUpdate(manifest);
    } finally {
      downloading.close();
    }
    if (result === 'waiting') {
      await showAlert({
        title: 'Update downloaded',
        message: 'Android’s installer opens when you come back to Dayflow.',
      });
    }
    if (result === 'needs-permission') {
      const open = await showConfirm({
        title: 'Allow Dayflow to install updates',
        message: 'Android needs your OK once. Turn on “Allow from this source” for Dayflow, come back, and tap Download again.',
        confirmLabel: 'Open settings',
      });
      if (open) await openInstallPermissionSettings().catch(() => undefined);
    } else if (result === 'failed') {
      await showAlert({
        title: 'Update download failed',
        message: 'Check your connection and try again from Settings → App updates.',
        tone: 'warning',
      });
    }
  } finally {
    offering = false;
  }
}

/**
 * Android: checks for updates 3 seconds after start and on returning to the
 * app (at most every few hours). New app code downloads in the background and asks
 * to restart (or applies on the next start); a new APK is offered.
 */
export function useAppUpdates(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isNativeAndroid()) return;
    let disposed = false;
    const run = async (force: boolean) => {
      if (!force && Date.now() - lastUpdateCheckAt() < UPDATE_CHECK_INTERVAL_MS) return;
      const result = await checkForUpdates();
      if (disposed) return;
      if (result.kind === 'apk') await offerApkUpdate(result.manifest);
      // New app code is ready: say so, instead of waiting silently for the next full start.
      if (result.kind === 'downloaded') {
        const now = await showConfirm({
          title: 'Update ready',
          message: 'Restart Dayflow now to use it? Otherwise it applies next time you open the app.',
          confirmLabel: 'Restart now',
          cancelLabel: 'Later',
        });
        if (now && !disposed) await restartIntoUpdate();
      }
    };
    const timer = window.setTimeout(() => void run(true), 3000);
    const listener = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void run(false);
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void listener.then((handle) => handle.remove());
    };
  }, [enabled]);
}
