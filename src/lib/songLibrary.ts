/**
 * The device's alarm song library. Android keeps the files in the app's own
 * storage (so they ring with the app closed); the website keeps them in
 * IndexedDB. Components read the list through `useSongs`.
 */
import { useSyncExternalStore } from 'react';
import { isNativeAndroid } from './platform';
import { MAX_MUSIC_BYTES } from './sounds';
import { MAX_SONGS, isValidSongId, type SongInfo } from './songs';
import { audioService } from '../services/audioService';
import { DayflowAlarm } from '../services/dayflowAlarm';

export interface AddSongsResult {
  added: SongInfo[];
  /** Files that were not added, with a short reason. */
  skipped: { name: string; reason: 'too-large' | 'empty' | 'limit' | 'failed' }[];
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

interface LibraryState {
  songs: SongInfo[];
  ready: boolean;
}

let state: LibraryState = { songs: [], ready: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function setSongs(songs: SongInfo[]): void {
  const sorted = [...songs].sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id));
  state = { songs: sorted, ready: true };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!state.ready && !loading) void refreshSongs();
  return () => listeners.delete(listener);
}

/** Songs on this device, oldest first. `ready` is false until the first load finishes. */
export function useSongs(): LibraryState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function refreshSongs(): Promise<void> {
  loading = (async () => {
    try {
      setSongs(isNativeAndroid() ? await nativeList() : await webList());
    } catch (e) {
      console.warn('Could not load the alarm songs:', e);
      setSongs(state.songs);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

function cleanSongs(raw: unknown): SongInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is SongInfo => Boolean(item) && isValidSongId((item as SongInfo).id))
    .map((item) => ({
      id: item.id,
      name: typeof item.name === 'string' && item.name ? item.name : 'Song',
      size: Number(item.size) || 0,
      addedAt: Number(item.addedAt) || 0,
    }));
}

async function nativeList(): Promise<SongInfo[]> {
  const result = await DayflowAlarm.listSongs();
  return cleanSongs(result.songs);
}

// ---------------------------------------------------------------------------
// Website (IndexedDB)
// ---------------------------------------------------------------------------

const DB_NAME = 'dayflow-media';
const STORE = 'files';
const SONG_PREFIX = 'song:';
/** The single song saved before the library existed. */
const LEGACY_KEY = 'reminder-music';
const LEGACY_ID = 'legacy';

interface StoredSong {
  name: string;
  blob: Blob;
  addedAt?: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        let result: T | undefined;
        if (request) request.onsuccess = () => (result = request.result);
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

async function webGet(id: string): Promise<StoredSong | null> {
  if (!isValidSongId(id)) return null;
  const value = await idbRequest<StoredSong>('readonly', (store) => store.get(SONG_PREFIX + id));
  return value?.blob ? value : null;
}

/** Moves the pre-library song into the library once. */
async function migrateLegacy(): Promise<void> {
  const legacy = await idbRequest<StoredSong>('readonly', (store) => store.get(LEGACY_KEY));
  if (!legacy) return;
  await idbRequest('readwrite', (store) => {
    if (legacy.blob && legacy.blob.size > 0) {
      store.put({ name: legacy.name || 'Song', blob: legacy.blob, addedAt: 0 } satisfies StoredSong, SONG_PREFIX + LEGACY_ID);
    }
    store.delete(LEGACY_KEY);
  });
}

async function webList(): Promise<SongInfo[]> {
  if (typeof indexedDB === 'undefined') return [];
  await migrateLegacy();
  const songs: SongInfo[] = [];
  await openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const key = String(cursor.key);
          const value = cursor.value as StoredSong | undefined;
          const id = key.startsWith(SONG_PREFIX) ? key.slice(SONG_PREFIX.length) : '';
          if (isValidSongId(id) && value?.blob && value.blob.size > 0) {
            songs.push({ id, name: value.name || 'Song', size: value.blob.size, addedAt: value.addedAt ?? 0 });
          }
          cursor.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
  return songs;
}

function newSongId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Adds picked files. Exported for tests and for the file input path. */
export async function addSongFiles(files: File[]): Promise<AddSongsResult> {
  const result: AddSongsResult = { added: [], skipped: [] };
  let count = (await webList()).length;
  for (const file of files) {
    const name = file.name || 'Song';
    if (file.size <= 0) {
      result.skipped.push({ name, reason: 'empty' });
      continue;
    }
    if (file.size > MAX_MUSIC_BYTES) {
      result.skipped.push({ name, reason: 'too-large' });
      continue;
    }
    if (count >= MAX_SONGS) {
      result.skipped.push({ name, reason: 'limit' });
      continue;
    }
    const song: SongInfo = { id: newSongId(), name, size: file.size, addedAt: Date.now() + result.added.length };
    try {
      await idbRequest('readwrite', (store) => {
        store.put({ name, blob: file, addedAt: song.addedAt } satisfies StoredSong, SONG_PREFIX + song.id);
      });
      result.added.push(song);
      count += 1;
    } catch (e) {
      console.warn('Could not save the song:', e);
      result.skipped.push({ name, reason: 'failed' });
    }
  }
  return result;
}

/**
 * Opens the system file picker for audio. Must be called straight from a tap:
 * mobile browsers only open the picker during a user gesture, so nothing is
 * awaited before `click()`.
 */
function pickAudioFiles(onLateFiles: (files: File[]) => void): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    let fallback: number | undefined;
    // Older browsers (iOS Safari < 16.4, Chrome < 113) never fire 'cancel'. When the
    // page gets focus back with no 'change' a few seconds later, treat the picker as
    // dismissed so the buttons come back. A 'change' that still arrives afterwards (a
    // slow cloud file) is added through `onLateFiles`.
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;
      window.clearTimeout(fallback);
      fallback = window.setTimeout(() => finish([], false), 4000);
    };
    const finish = (files: File[], done = true) => {
      if (done) {
        window.removeEventListener('focus', onReturn);
        document.removeEventListener('visibilitychange', onReturn);
        input.remove();
      }
      window.clearTimeout(fallback);
      if (settled) {
        if (files.length > 0) onLateFiles(files);
        return;
      }
      settled = true;
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
    // Listen only after the picker has opened, so the click itself does not count as a return.
    window.setTimeout(() => {
      if (settled) return;
      window.addEventListener('focus', onReturn);
      document.addEventListener('visibilitychange', onReturn);
    }, 300);
  });
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/** Lets the person pick one or more songs and adds them. Call from a tap. */
export async function addSongs(): Promise<AddSongsResult> {
  if (isNativeAndroid()) {
    const result = await DayflowAlarm.addSongs();
    setSongs(cleanSongs(result.songs));
    const added = cleanSongs(result.songs).filter((song) => (result.added ?? []).includes(song.id));
    return { added, skipped: Array.isArray(result.skipped) ? result.skipped : [] };
  }
  const files = await pickAudioFiles((late) => {
    void addSongFiles(late).then(() => refreshSongs());
  });
  if (files.length === 0) return { added: [], skipped: [] };
  const result = await addSongFiles(files);
  await refreshSongs();
  return result;
}

export async function removeSong(id: string): Promise<void> {
  if (!isValidSongId(id)) return;
  await stopSongPreview();
  if (isNativeAndroid()) {
    const result = await DayflowAlarm.removeSong({ id });
    setSongs(cleanSongs(result.songs));
    return;
  }
  await idbRequest('readwrite', (store) => {
    store.delete(SONG_PREFIX + id);
  });
  await refreshSongs();
}

export type PreviewResult = 'played' | 'failed' | 'superseded';

// Each preview or stop bumps this, so a slower earlier preview can neither
// start nor report a result after it was replaced or stopped.
let previewToken = 0;
// True while a website preview owns the audio, so stopping a preview never silences a ringing alarm.
let previewPlaying = false;

/**
 * Plays a song once. 'superseded' means another preview or a stop came first.
 * `onEnded` fires when the song plays to the end (website only).
 */
export async function previewSong(id: string, onEnded?: () => void): Promise<PreviewResult> {
  const token = ++previewToken;
  const stale = () => token !== previewToken;
  try {
    if (isNativeAndroid()) {
      await DayflowAlarm.preview({ sound: `music:${id}` });
      if (stale()) return 'superseded';
      return state.songs.some((song) => song.id === id) ? 'played' : 'failed';
    }
    const saved = await webGet(id);
    if (stale()) return 'superseded';
    if (!saved) return 'failed';
    const played = await audioService.playFile(saved.blob, false, {
      isCancelled: stale,
      onEnded: () => {
        if (stale()) return;
        previewPlaying = false;
        onEnded?.();
      },
    });
    if (played && !stale()) previewPlaying = true;
    if (stale()) return 'superseded';
    return played ? 'played' : 'failed';
  } catch (e) {
    if (stale()) return 'superseded';
    console.warn('Could not preview the song:', e);
    return 'failed';
  }
}

export async function stopSongPreview(): Promise<void> {
  previewToken += 1;
  const wasPlaying = previewPlaying;
  previewPlaying = false;
  try {
    if (isNativeAndroid()) await DayflowAlarm.stopPreview();
    else if (wasPlaying) audioService.stopLoop();
  } catch {
    // Nothing was playing.
  }
}

/** Website ring screen: loops the song. Resolves false when it is missing or the browser blocks playback. */
export async function loopSong(id: string | null | undefined, isCancelled?: () => boolean): Promise<boolean> {
  if (!id || isNativeAndroid()) return false;
  try {
    const saved = await webGet(id);
    if (!saved || isCancelled?.()) return false;
    previewToken += 1;
    previewPlaying = false;
    return await audioService.playFile(saved.blob, true, { isCancelled });
  } catch (e) {
    console.warn('Could not play the song:', e);
    return false;
  }
}

/** Clears the library cache, for tests. */
export function resetSongLibraryForTests(): void {
  state = { songs: [], ready: false };
  loading = null;
}
