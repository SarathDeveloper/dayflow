import { describe, expect, it } from 'vitest';
import { isNewerWebVersion, parseUpdateManifest, planUpdate, type UpdateManifest } from './appUpdate';

const HASH = 'a'.repeat(64);
const BASE = 'https://github.com/SarathDeveloper/dayflow/releases/download/android-20261114.1842-477f216';

function manifest(over: { web?: Partial<UpdateManifest['web']>; apk?: Partial<UpdateManifest['apk']> } = {}) {
  return {
    schema: 1,
    web: { version: '20261114.1842-477f216', url: `${BASE}/web.zip`, checksum: HASH, minNativeBuild: 3, ...over.web },
    apk: { build: 3, versionName: '1.1.0', url: `${BASE}/dayflow-1.1.0-b3.apk`, sha256: HASH, nativeHash: 'x', ...over.apk },
  };
}

describe('parseUpdateManifest', () => {
  it('accepts the feed the release script writes, as JSON text or an object', () => {
    const parsed = parseUpdateManifest(JSON.stringify(manifest()));
    expect(parsed?.web.version).toBe('20261114.1842-477f216');
    expect(parseUpdateManifest(manifest())?.apk.build).toBe(3);
  });

  it('rejects downloads hosted anywhere but this project’s releases', () => {
    expect(parseUpdateManifest(manifest({ web: { url: 'https://evil.example/web.zip' } }))).toBeNull();
    expect(parseUpdateManifest(manifest({ apk: { url: 'https://github.com/someone/else/releases/download/x/a.apk' } }))).toBeNull();
    expect(parseUpdateManifest(manifest({ web: { url: `${BASE}/../../x.zip` } }))).toBeNull();
  });

  it('rejects malformed fields and junk', () => {
    expect(parseUpdateManifest(manifest({ web: { checksum: 'abc' } }))).toBeNull();
    expect(parseUpdateManifest(manifest({ apk: { build: 0 } }))).toBeNull();
    expect(parseUpdateManifest(manifest({ web: { version: '../x' } }))).toBeNull();
    expect(parseUpdateManifest('not json')).toBeNull();
    expect(parseUpdateManifest(null)).toBeNull();
  });
});

describe('isNewerWebVersion', () => {
  it('lets any release replace a local build', () => {
    expect(isNewerWebVersion('20261114.1842-477f216', 'dev')).toBe(true);
  });

  it('only moves forward between releases', () => {
    expect(isNewerWebVersion('20261115.0900-aaaaaaa', '20261114.1842-477f216')).toBe(true);
    expect(isNewerWebVersion('20261114.1842-477f216', '20261114.1842-477f216')).toBe(false);
    expect(isNewerWebVersion('20261113.0900-bbbbbbb', '20261114.1842-477f216')).toBe(false);
  });

  it('never takes an unstamped version from the feed', () => {
    expect(isNewerWebVersion('dev', '20261114.1842-477f216')).toBe(false);
  });
});

describe('planUpdate', () => {
  const feed = parseUpdateManifest(manifest())!;

  it('downloads newer app code silently when this build can run it', () => {
    expect(planUpdate(feed, { currentWeb: '20261110.0800-1111111', nativeBuild: 3 })).toEqual({ downloadWeb: true, offerApk: false });
  });

  it('offers the APK instead when the code needs newer Android code', () => {
    expect(planUpdate(feed, { currentWeb: '20261110.0800-1111111', nativeBuild: 2 })).toEqual({ downloadWeb: false, offerApk: true });
  });

  it('does nothing when already current, already downloaded, or after a rollback', () => {
    const v = feed.web.version;
    expect(planUpdate(feed, { currentWeb: v, nativeBuild: 3 }).downloadWeb).toBe(false);
    expect(planUpdate(feed, { currentWeb: 'dev', nativeBuild: 3, pendingWeb: v }).downloadWeb).toBe(false);
    expect(planUpdate(feed, { currentWeb: 'dev', nativeBuild: 3, failedWeb: v }).downloadWeb).toBe(false);
  });

  it('never offers an older APK', () => {
    expect(planUpdate(feed, { currentWeb: 'dev', nativeBuild: 4 }).offerApk).toBe(false);
  });
});
