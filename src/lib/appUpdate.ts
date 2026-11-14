/**
 * Android app updates, decided from the release feed (update.json in the
 * latest GitHub Release, written by scripts/release-android.mjs).
 *
 * Two layers:
 * - App code (the web bundle): downloaded silently and switched to on the next
 *   cold start. Only when this phone's native build is new enough for it.
 * - The APK itself: needed when Android code changed. Offered to the person;
 *   Android always asks them to tap Install.
 */

export const UPDATE_FEED_URL = 'https://github.com/SarathDeveloper/dayflow/releases/latest/download/update.json';

/** Checks on resume at most this often; opening the app always checks. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After "Later", the APK offer stays quiet this long. */
export const APK_OFFER_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface UpdateManifest {
  web: {
    version: string;
    url: string;
    /** SHA-256 of the zip, lowercase hex. */
    checksum: string;
    /** The lowest native build (versionCode) this code runs on. */
    minNativeBuild: number;
  };
  apk: {
    /** versionCode of the APK in this release. */
    build: number;
    versionName: string;
    url: string;
    /** SHA-256 of the APK, lowercase hex. */
    sha256: string;
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const RELEASE_URL = /^https:\/\/github\.com\/SarathDeveloper\/dayflow\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Validates the feed. Anything unexpected, including files hosted elsewhere, is ignored. */
export function parseUpdateManifest(raw: unknown): UpdateManifest | null {
  let data = raw;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const { web, apk } = data as Record<string, unknown>;
  if (!web || typeof web !== 'object' || !apk || typeof apk !== 'object') return null;
  const w = web as Record<string, unknown>;
  const a = apk as Record<string, unknown>;
  if (typeof w.version !== 'string' || !SAFE_VERSION.test(w.version)) return null;
  if (typeof w.url !== 'string' || !RELEASE_URL.test(w.url)) return null;
  if (typeof w.checksum !== 'string' || !HEX64.test(w.checksum)) return null;
  if (!isPositiveInt(w.minNativeBuild)) return null;
  if (!isPositiveInt(a.build)) return null;
  if (typeof a.versionName !== 'string' || !SAFE_VERSION.test(a.versionName)) return null;
  if (typeof a.url !== 'string' || !RELEASE_URL.test(a.url)) return null;
  if (typeof a.sha256 !== 'string' || !HEX64.test(a.sha256)) return null;
  return {
    web: { version: w.version, url: w.url, checksum: w.checksum, minNativeBuild: w.minNativeBuild },
    apk: { build: a.build, versionName: a.versionName, url: a.url, sha256: a.sha256 },
  };
}

export interface UpdateState {
  /** App-code version running now ('dev' for a local build). */
  currentWeb: string;
  /** This phone's native build (versionCode). */
  nativeBuild: number;
  /** A downloaded version waiting for the next start. */
  pendingWeb?: string | null;
  /** A version that was switched to and rolled back; never retried. */
  failedWeb?: string | null;
}

export interface UpdatePlan {
  downloadWeb: boolean;
  offerApk: boolean;
}

/** Release versions start with a UTC stamp: "20261114.1842-477f216". */
const RELEASE_VERSION = /^\d{8}\.\d{4}-[0-9a-f]{7,40}$/;

export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version);
}

/**
 * True when `candidate` should replace `current`. A local build ('dev' or
 * anything unstamped) takes any release; between releases only a later stamp
 * wins, so an older feed never downgrades newer code.
 */
export function isNewerWebVersion(candidate: string, current: string): boolean {
  if (!isReleaseVersion(candidate)) return false;
  if (!isReleaseVersion(current)) return true;
  return candidate.slice(0, 13) > current.slice(0, 13);
}

export function planUpdate(manifest: UpdateManifest, state: UpdateState): UpdatePlan {
  const offerApk = manifest.apk.build > state.nativeBuild;
  const fits = state.nativeBuild >= manifest.web.minNativeBuild;
  const version = manifest.web.version;
  const downloadWeb =
    fits &&
    isNewerWebVersion(version, state.currentWeb) &&
    version !== state.pendingWeb &&
    version !== state.failedWeb;
  return { downloadWeb, offerApk };
}
