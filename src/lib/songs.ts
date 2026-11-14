/**
 * Alarm songs: a small library of audio files kept on this device. A task,
 * habit or alarm set to "Local music" stores the id of the song it plays.
 * Song files never sync, so an id saved on another device may not exist
 * here; then the oldest song on this device plays, and with no songs at all
 * the chime does.
 */
import type { SoundType } from '../types';

export interface SongInfo {
  id: string;
  /** File name as picked, e.g. "Morning.mp3". */
  name: string;
  size: number;
  /** Milliseconds since epoch. The library is ordered oldest first. */
  addedAt: number;
}

export const MAX_SONGS = 30;

const SONG_ID = /^[A-Za-z0-9-]{1,64}$/;

export function isValidSongId(id: unknown): id is string {
  return typeof id === 'string' && SONG_ID.test(id);
}

/** The song to play for a saved choice: that song if it is here, else the oldest one, else none. */
export function pickSong(songId: string | undefined, songIds: readonly string[]): string | null {
  if (songId && songIds.includes(songId)) return songId;
  return songIds[0] ?? null;
}

/**
 * The sound string the Android ring service understands: built-in names, or
 * `music:<id>` for a song. Voice cannot loop, so it rings as the chime.
 */
export function nativeRingSound(sound: SoundType, songId: string | null | undefined): string {
  if (sound === 'voice') return 'chime';
  if (sound === 'music') return songId ? `music:${songId}` : 'chime';
  return sound;
}

/** "Morning walk.mp3" -> "Morning walk". */
export function songTitle(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return base || 'Song';
}

export type SongSkipReason = 'too-large' | 'empty' | 'limit' | 'failed';

/** One sentence about files that were not added, or '' when every file was added. */
export function describeSkippedSongs(skipped: { name: string; reason: SongSkipReason }[]): string {
  if (skipped.length === 0) return '';
  const reason: Record<SongSkipReason, string> = {
    'too-large': 'over 15 MB',
    empty: 'empty file',
    limit: `the library holds ${MAX_SONGS} songs`,
    failed: 'could not be saved',
  };
  if (skipped.length === 1) return `Not added: ${songTitle(skipped[0].name)} (${reason[skipped[0].reason] ?? reason.failed}).`;
  const reasons = Array.from(new Set(skipped.map((item) => reason[item.reason] ?? reason.failed)));
  return `${skipped.length} songs not added (${reasons.join(', ')}).`;
}

export function formatSongSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
