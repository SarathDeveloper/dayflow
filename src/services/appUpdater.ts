/**
 * Android app updates (see lib/appUpdate.ts for the rules).
 *
 * App code: a newer bundle is downloaded in the background and switched to at
 * the next cold start, before anything renders, so an open editor or a running
 * picker is never interrupted. New code confirms itself (notifyAppReady) only
 * after its first screen has rendered; code that fails before that is rolled
 * back by the updater after 15 s, and a rolled-back version is never retried.
 *
 * APK: when Android code changed, the person is offered the new APK, which
 * DayflowUpdate downloads and hands to Android's installer.
 *
 * Only the sideloaded (debug) build has DayflowUpdate; everywhere else the
 * updater stays off, so a Play build never self-updates from GitHub.
 */
import { App as CapApp } from '@capacitor/app';
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { isNativeAndroid } from '../lib/platform';
import { readJson, writeJson } from '../lib/persistence';
import {
  APK_OFFER_SNOOZE_MS,
  UPDATE_FEED_URL,
  isNewerWebVersion,
  isReleaseVersion,
  parseUpdateManifest,
  planUpdate,
  type UpdateManifest,
} from '../lib/appUpdate';

interface DayflowUpdatePlugin {
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  /** `shown` is false when the app was in the background; the installer then opens on return. */
  installApk(options: { url: string; sha256: string }): Promise<{ shown: boolean }>;
}

const DayflowUpdate = registerPlugin<DayflowUpdatePlugin>('DayflowUpdate');

// Device-only bookkeeping.
const PENDING_KEY = 'dayflow_update_pending_v1'; // { id, version } downloaded, not yet switched to
const SWITCHING_KEY = 'dayflow_update_switching_v1'; // version being switched to right now
const FAILED_KEY = 'dayflow_update_failed_v1'; // version that was rolled back
const LAST_CHECK_KEY = 'dayflow_update_last_check_v1';
const APK_SNOOZE_KEY = 'dayflow_update_apk_snooze_v1'; // { build, until }

interface PendingBundle {
  id: string;
  version: string;
}

/** True in the sideloaded Android app, which updates itself from GitHub Releases. */
export function isAppUpdaterAvailable(): boolean {
  return (
    isNativeAndroid() &&
    Capacitor.isPluginAvailable('DayflowUpdate') &&
    Capacitor.isPluginAvailable('CapacitorUpdater')
  );
}

/** The app-code version running now. Release builds stamp it; local builds are 'dev'. */
export function currentWebVersion(): string {
  return import.meta.env.VITE_APP_BUILD?.trim() || 'dev';
}

function readPending(): PendingBundle | null {
  const value = readJson<PendingBundle | null>(PENDING_KEY, null);
  return value && typeof value.id === 'string' && typeof value.version === 'string' ? value : null;
}

function clearKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/** Best effort: removes a downloaded bundle that will not be used. */
function discardBundle(id: string | undefined): void {
  if (!id) return;
  CapacitorUpdater.delete({ id }).catch(() => undefined);
}

/**
 * Takes the pending bundle if it is still worth switching to. A stale one (the
 * running code is as new, e.g. a newer APK was installed) or a known-bad one is
 * discarded.
 */
function takeUsablePending(): PendingBundle | null {
  const pending = readPending();
  if (!pending) return null;
  clearKey(PENDING_KEY);
  const failed = readJson<string | null>(FAILED_KEY, null);
  if (!isNewerWebVersion(pending.version, currentWebVersion()) || pending.version === failed) {
    discardBundle(pending.id);
    return null;
  }
  return pending;
}

async function switchTo(pending: PendingBundle): Promise<boolean> {
  try {
    writeJson(SWITCHING_KEY, pending.version);
    await CapacitorUpdater.set({ id: pending.id });
    return true;
  } catch (e) {
    clearKey(SWITCHING_KEY);
    discardBundle(pending.id);
    console.warn('Could not switch to the downloaded update:', e);
    return false;
  }
}

/**
 * Runs first on every Android start, before React renders. Records whether the
 * last switch held and switches to a downloaded update. Resolves true when the
 * app is reloading into new code.
 */
export async function startAppUpdater(): Promise<boolean> {
  if (!isAppUpdaterAvailable()) return false;
  const switching = readJson<string | null>(SWITCHING_KEY, null);
  if (switching) {
    clearKey(SWITCHING_KEY);
    // Back on other code after switching: the new version failed and was rolled back.
    if (switching !== currentWebVersion()) writeJson(FAILED_KEY, switching);
  }
  const pending = takeUsablePending();
  return pending ? switchTo(pending) : false;
}

let confirmed = false;

/**
 * Tells the updater this code works. Called once the first screen has rendered
 * (main.tsx), so code that crashes while rendering is rolled back instead.
 */
export async function confirmAppReady(): Promise<void> {
  if (confirmed || !isNativeAndroid() || !Capacitor.isPluginAvailable('CapacitorUpdater')) return;
  confirmed = true;
  try {
    await Promise.race([
      CapacitorUpdater.notifyAppReady(),
      new Promise((resolve) => window.setTimeout(resolve, 3000)),
    ]);
  } catch (e) {
    console.warn('Updater not ready:', e);
  }
}

/**
 * Error screen escape hatch: marks the running code as bad and goes back to the
 * app code inside the installed APK.
 */
export async function restoreInstalledVersion(): Promise<void> {
  const running = currentWebVersion();
  if (isReleaseVersion(running)) writeJson(FAILED_KEY, running);
  const pending = readPending();
  clearKey(PENDING_KEY);
  discardBundle(pending?.id);
  await CapacitorUpdater.reset();
}

export interface UpdateStatus {
  versionName: string;
  nativeBuild: number;
  webVersion: string;
  pendingVersion: string | null;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const info = await CapApp.getInfo();
  return {
    versionName: info.version,
    nativeBuild: Number(info.build) || 0,
    webVersion: currentWebVersion(),
    pendingVersion: readPending()?.version ?? null,
  };
}

export type UpdateCheckResult =
  | { kind: 'up-to-date' }
  | { kind: 'downloaded'; version: string }
  | { kind: 'pending'; version: string }
  | { kind: 'apk'; manifest: UpdateManifest }
  | { kind: 'offline' }
  | { kind: 'error' };

let checking: Promise<UpdateCheckResult> | null = null;

async function fetchManifest(): Promise<UpdateManifest | null | 'offline'> {
  try {
    const response = await CapacitorHttp.get({
      url: UPDATE_FEED_URL,
      responseType: 'text',
      connectTimeout: 15_000,
      readTimeout: 20_000,
    });
    if (response.status === 404) return null; // No release published yet.
    if (response.status < 200 || response.status >= 300) return 'offline';
    return parseUpdateManifest(response.data);
  } catch {
    return 'offline';
  }
}

/**
 * Looks for updates. Downloads newer app code silently; reports an APK update
 * for the caller to offer. Concurrent calls share one check.
 */
export function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isAppUpdaterAvailable()) return Promise.resolve({ kind: 'up-to-date' });
  if (checking) return checking;
  checking = (async (): Promise<UpdateCheckResult> => {
    try {
      const manifest = await fetchManifest();
      if (manifest === 'offline') return { kind: 'offline' };
      writeJson(LAST_CHECK_KEY, Date.now());
      if (!manifest) return { kind: 'up-to-date' };

      const status = await getUpdateStatus();
      const plan = planUpdate(manifest, {
        currentWeb: status.webVersion,
        nativeBuild: status.nativeBuild,
        pendingWeb: status.pendingVersion,
        failedWeb: readJson<string | null>(FAILED_KEY, null),
      });

      if (plan.downloadWeb) {
        const previous = readPending();
        const bundle = await CapacitorUpdater.download({
          url: manifest.web.url,
          version: manifest.web.version,
          checksum: manifest.web.checksum,
        });
        writeJson(PENDING_KEY, { id: bundle.id, version: manifest.web.version } satisfies PendingBundle);
        // A newer download replaces one that was never applied.
        if (previous && previous.id !== bundle.id) discardBundle(previous.id);
      }
      if (plan.offerApk) return { kind: 'apk', manifest };
      if (plan.downloadWeb) return { kind: 'downloaded', version: manifest.web.version };
      const pending = readPending();
      return pending ? { kind: 'pending', version: pending.version } : { kind: 'up-to-date' };
    } catch (e) {
      console.warn('Update check failed:', e);
      return { kind: 'error' };
    } finally {
      checking = null;
    }
  })();
  return checking;
}

export function lastUpdateCheckAt(): number {
  return readJson<number>(LAST_CHECK_KEY, 0);
}

/** Switches to the downloaded update now (reloads the app). */
export async function restartIntoUpdate(): Promise<boolean> {
  const pending = takeUsablePending();
  return pending ? switchTo(pending) : false;
}

export function isApkOfferSnoozed(build: number, now = Date.now()): boolean {
  const snooze = readJson<{ build: number; until: number } | null>(APK_SNOOZE_KEY, null);
  return Boolean(snooze && snooze.build === build && snooze.until > now);
}

export function snoozeApkOffer(build: number, now = Date.now()): void {
  writeJson(APK_SNOOZE_KEY, { build, until: now + APK_OFFER_SNOOZE_MS });
}

export type ApkInstallResult = 'opened' | 'waiting' | 'needs-permission' | 'failed' | 'busy';

/** Downloads the APK and opens Android's installer. */
export async function installApkUpdate(manifest: UpdateManifest): Promise<ApkInstallResult> {
  try {
    const { allowed } = await DayflowUpdate.canInstall();
    if (!allowed) return 'needs-permission';
    const { shown } = await DayflowUpdate.installApk({ url: manifest.apk.url, sha256: manifest.apk.sha256 });
    return shown ? 'opened' : 'waiting';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('install-permission')) return 'needs-permission';
    if (message.includes('busy')) return 'busy';
    console.warn('APK update failed:', e);
    return 'failed';
  }
}

export function openInstallPermissionSettings(): Promise<void> {
  return DayflowUpdate.openInstallSettings();
}
