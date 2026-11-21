/**
 * Publishes an Android release that installed apps update from.
 *
 *   npm run publish:android               build and publish a GitHub Release
 *   npm run publish:android -- --dry-run  build into release-out/ only
 *
 * Every release carries:
 * - web-<version>.zip  the app code. Phones download it silently and switch to
 *                      it on their next start (src/services/appUpdater.ts).
 * - dayflow-<name>-b<build>.apk  the full app, with the same app code inside.
 * - update.json        the feed phones read from releases/latest/download/.
 *
 * The APK's build number (versionCode) only rises when Android code changed:
 * the android/ folder, capacitor.config.ts, or a native plugin's version. That
 * is what makes phones offer the new APK; otherwise they take the code silently.
 *
 * The APK is the debug variant, signed with this computer's debug key, like the
 * APK already installed on the phone. Android only installs an update signed
 * with the same key, so release from this computer.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const REPO = 'SarathDeveloper/dayflow';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'release-out');
const dryRun = process.argv.includes('--dry-run');
const isWindows = process.platform === 'win32';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: isWindows && !options.noShell,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (options.raw) {
    return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
  }
  if (result.status !== 0 && !options.allowFail) {
    if (options.capture) process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
  }
  return options.capture ? (result.stdout ?? '').trim() : '';
}

const git = (...args) => run('git', args, { capture: true, noShell: true });
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const dirty = git('status', '--porcelain', '--untracked-files=no');
// Untracked files in build inputs would ship without being in the commit.
const untracked = git(
  'ls-files', '--others', '--exclude-standard', '--',
  'src', 'public', 'android', 'scripts', 'index.html', 'capacitor.config.ts',
  'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json',
);
if ((dirty || untracked) && !dryRun) {
  console.error(
    'Commit or stash your changes first; a release must match a pushed commit.\n' +
      [dirty, untracked && 'Untracked:\n' + untracked].filter(Boolean).join('\n'),
  );
  process.exit(1);
}
const head = git('rev-parse', 'HEAD');
if (!dryRun) {
  git('fetch', 'origin', 'main', '--quiet');
  if (git('rev-parse', 'origin/main') !== head) {
    console.error('HEAD is not origin/main. Push main first, then release.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Fingerprint of everything that ends up as Android code. */
function nativeHash() {
  const hash = createHash('sha256');
  const files = git('ls-files', 'android', 'capacitor.config.ts').split('\n').filter(Boolean).sort();
  for (const file of files) {
    hash.update(file + '\0');
    // Normalise line endings so a checkout's CRLF/LF choice does not count as a change.
    hash.update(readFileSync(join(root, file)).toString('binary').replace(/\r\n/g, '\n') + '\0');
  }
  // Native packages: the Capacitor runtime (its Android code is in capacitor/, not
  // android/), every Gradle project cap sync wires in, and any dependency with
  // an android/ folder.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const nativePackages = new Set(['@capacitor/android', '@capacitor/core', '@capacitor/cli']);
  const settings = readFileSync(join(root, 'android/capacitor.settings.gradle'), 'utf8');
  for (const match of settings.matchAll(/node_modules\/((?:@[^/'"]+\/)?[^/'"]+)\//g)) nativePackages.add(match[1]);
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (existsSync(join(root, 'node_modules', name, 'android'))) nativePackages.add(name);
  }
  for (const name of [...nativePackages].sort()) {
    const file = join(root, 'node_modules', name, 'package.json');
    const version = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : 'missing';
    hash.update(`${name}@${version}\0`);
  }
  return hash.digest('hex');
}

/**
 * The latest release's update.json. Null only when no release exists yet; any
 * other failure stops the script, because guessing would reset the build number.
 */
async function previousManifest() {
  const view = run('gh', ['release', 'view', '--repo', REPO, '--json', 'tagName', '-q', '.tagName'], {
    capture: true,
    raw: true,
    noShell: true,
  });
  let tag = view.status === 0 ? view.stdout : null;
  if (!tag) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': 'Dayflow-Release' },
      });
      if (res.status === 404) return null;
      if (res.ok) {
        const data = await res.json();
        tag = data.tag_name;
      }
    } catch {
      // ignore
    }
  }
  if (!tag) {
    if (view.status !== 0 && /release not found/i.test(view.stderr)) return null;
    throw new Error(`Could not read the latest release: ${view.stderr || 'gh/fetch failed'}. Check gh auth and the network, then retry.`);
  }
  const tmp = join(outDir, 'previous-update.json');
  rmSync(tmp, { force: true });
  const download = run('gh', ['release', 'download', tag, '--repo', REPO, '--pattern', 'update.json', '--output', tmp, '--clobber'], {
    capture: true,
    raw: true,
    noShell: true,
  });
  if (download.status !== 0 || !existsSync(tmp)) {
    try {
      const res = await fetch(`https://github.com/${REPO}/releases/download/${tag}/update.json`);
      if (res.ok) {
        const text = await res.text();
        writeFileSync(tmp, text);
      }
    } catch {
      // ignore
    }
  }
  if (!existsSync(tmp)) {
    throw new Error(`Could not download update.json from ${tag}: ${download.stderr || 'missing asset'}.`);
  }
  const manifest = JSON.parse(readFileSync(tmp, 'utf8'));
  if (!Number.isInteger(manifest?.apk?.build) || manifest.apk.build < 1) {
    throw new Error(`update.json in ${tag} has no valid apk.build.`);
  }
  return manifest;
}

mkdirSync(outDir, { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const versionName = pkg.version;
const native = nativeHash();
const previous = await previousManifest();
// Before the first release, phones run build 2 (no updater) or a hand-installed
// test build 3; the first release is build 4 so both are offered it.
const previousBuild = previous ? previous.apk.build : 3;
const nativeChanged = !previous || previous.apk?.nativeHash !== native;
const build = nativeChanged ? previousBuild + 1 : previousBuild;

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}.${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
const webVersion = `${stamp}-${head.slice(0, 7)}`;
const tag = `android-${webVersion}`;

console.log(`\nRelease ${tag}`);
console.log(`  app code ${webVersion}`);
console.log(`  APK ${versionName} build ${build} (${nativeChanged ? 'Android code changed: phones will be offered the APK' : 'Android code unchanged: phones update silently'})\n`);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

run('npx', ['vite', 'build', '--mode', 'capacitor'], { env: { VITE_APP_BUILD: webVersion } });
run('npx', ['cap', 'sync', 'android']);

/** 1980-01-01, the earliest valid zip date; fixed so the same files give the same zip. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** Minimal zip writer (deflate), so no zip tool or package is needed. */
function zipDirectory(dir, target) {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else entries.push(full);
    }
  };
  walk(dir);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const full of entries) {
    const name = Buffer.from(relative(dir, full).split(sep).join('/'), 'utf8');
    const data = readFileSync(full);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, packed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + packed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(target, Buffer.concat([...chunks, centralBuffer, end]));
}

const zipName = `web-${webVersion}.zip`;
const zipPath = join(outDir, zipName);
zipDirectory(join(root, 'dist'), zipPath);

const androidHome = process.env.ANDROID_HOME || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
run(join(root, 'android', isWindows ? 'gradlew.bat' : 'gradlew'), ['assembleDebug', '-q', `-PdayflowVersionCode=${build}`, `-PdayflowVersionName=${versionName}`], {
  cwd: join(root, 'android'),
  env: androidHome ? { ANDROID_HOME: androidHome } : {},
});
const apkName = `dayflow-${versionName}-b${build}.apk`;
const apkPath = join(outDir, apkName);
copyFileSync(join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'), apkPath);

// cap sync rewrites two Gradle files with different line endings only; put them back.
for (const file of ['android/app/capacitor.build.gradle', 'android/capacitor.settings.gradle']) {
  const realChange = git('diff', '--ignore-cr-at-eol', '--', file);
  if (!realChange) git('checkout', '--', file);
}

const download = (name) => `https://github.com/${REPO}/releases/download/${tag}/${name}`;
const manifest = {
  schema: 1,
  publishedAt: now.toISOString(),
  commit: head,
  web: {
    version: webVersion,
    url: download(zipName),
    checksum: sha256(readFileSync(zipPath)),
    // Built against this build's Android code.
    minNativeBuild: build,
  },
  apk: {
    build,
    versionName,
    url: download(apkName),
    sha256: sha256(readFileSync(apkPath)),
    nativeHash: native,
  },
};
const manifestPath = join(outDir, 'update.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`\nBuilt:\n  ${relative(root, zipPath)}\n  ${relative(root, apkPath)}\n  ${relative(root, manifestPath)}`);

if (dryRun) {
  console.log('\nDry run: nothing was published.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const notes = [
  `App code ${webVersion} from ${head.slice(0, 7)}.`,
  nativeChanged
    ? `Android build ${build}: Android code changed, so installed apps offer this APK.`
    : `Android build ${build} unchanged: installed apps update silently.`,
  '',
  'Install the APK once by hand; after that Dayflow updates itself (Settings → App updates).',
].join('\n');
run('gh', [
  'release', 'create', tag,
  '--repo', REPO,
  '--target', head,
  '--title', `Dayflow ${versionName} (build ${build}) · ${webVersion}`,
  '--notes', notes,
  '--latest',
  zipPath, apkPath, manifestPath,
], { noShell: true });
console.log(`\nPublished ${tag}. Phones pick it up on their next start or within a few hours.`);
