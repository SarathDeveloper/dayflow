import { describe, expect, it } from 'vitest';
import type { Alarm, NotificationSettings, Task } from '../types';
import { buildReminderPlans } from './reminders';
import { upcomingRings } from './alarms';
import { describeSkippedSongs, formatSongSize, isValidSongId, nativeRingSound, pickSong, songTitle } from './songs';

const settings: NotificationSettings = {
  browserNotificationsEnabled: true,
  soundEnabled: true,
  speechEnabled: false,
  defaultSound: 'chime',
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
};

const now = new Date(2026, 9, 28, 8, 0, 0);

function taskAt(time: string, reminder: Partial<Task['reminder']> = {}): Task {
  return {
    id: 'task-1',
    title: 'Standup',
    completed: false,
    date: '2026-10-28',
    time,
    priority: 'medium',
    category: 'Work',
    subtasks: [],
    recurrence: { type: 'none' },
    reminder: { enabled: true, remindBeforeMinutes: 0, sound: 'music', ...reminder },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function wakeAlarm(over: Partial<Alarm> = {}): Alarm {
  return {
    id: 'alarm-1',
    label: 'Wake',
    time: '07:00',
    enabled: true,
    daysOfWeek: [],
    sound: 'music',
    snoozeMinutes: 10,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

describe('pickSong', () => {
  it('plays the chosen song when it is on this device', () => {
    expect(pickSong('b', ['a', 'b'])).toBe('b');
  });

  it('falls back to the oldest song for a missing or unknown choice (e.g. picked on another device)', () => {
    expect(pickSong(undefined, ['a', 'b'])).toBe('a');
    expect(pickSong('from-laptop', ['a', 'b'])).toBe('a');
  });

  it('has nothing to play without songs', () => {
    expect(pickSong('a', [])).toBeNull();
  });
});

describe('nativeRingSound', () => {
  it('encodes a song for the Android ring service', () => {
    expect(nativeRingSound('music', 'abc-1')).toBe('music:abc-1');
  });

  it('rings the chime for music without a song, and for voice', () => {
    expect(nativeRingSound('music', null)).toBe('chime');
    expect(nativeRingSound('voice', null)).toBe('chime');
    expect(nativeRingSound('bell', 'abc')).toBe('bell');
  });
});

describe('song ids and labels', () => {
  it('accepts only safe ids, so an id can never reach outside the song folder', () => {
    expect(isValidSongId('3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab')).toBe(true);
    expect(isValidSongId('legacy')).toBe(true);
    expect(isValidSongId('../shared_prefs/x')).toBe(false);
    expect(isValidSongId('')).toBe(false);
    expect(isValidSongId(42)).toBe(false);
  });

  it('shows a song without its file extension', () => {
    expect(songTitle('Morning walk.mp3')).toBe('Morning walk');
    expect(songTitle('.hidden')).toBe('.hidden');
    expect(songTitle('  ')).toBe('Song');
  });

  it('formats sizes and explains skipped files', () => {
    expect(formatSongSize(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(formatSongSize(200)).toBe('1 KB');
    expect(describeSkippedSongs([])).toBe('');
    expect(describeSkippedSongs([{ name: 'Big.flac', reason: 'too-large' }])).toBe('Not added: Big (over 15 MB).');
    expect(describeSkippedSongs([
      { name: 'a.mp3', reason: 'too-large' },
      { name: 'b.mp3', reason: 'too-large' },
    ])).toBe('2 songs not added (over 15 MB).');
  });
});

describe('song routing to the ring service', () => {
  it('rings a task reminder with its own song', () => {
    const plans = buildReminderPlans([taskAt('09:00', { songId: 'b' })], settings, now, [], [], [], ['a', 'b']);
    expect(plans[0]).toMatchObject({ sound: 'music', songId: 'b', ring: true });
    expect(upcomingRings(plans, [], now, ['a', 'b'])[0].sound).toBe('music:b');
  });

  it('rings the oldest song when the chosen one is not on this device', () => {
    const plans = buildReminderPlans([taskAt('09:00', { songId: 'gone' })], settings, now, [], [], [], ['a']);
    expect(upcomingRings(plans, [], now, ['a'])[0].sound).toBe('music:a');
  });

  it('falls back to a chime without any songs', () => {
    const plans = buildReminderPlans([taskAt('09:00', { songId: 'b', alarm: true })], settings, now);
    expect(plans[0]).toMatchObject({ sound: 'chime', ring: true, songId: undefined });
    expect(upcomingRings(plans, [], now)[0].sound).toBe('chime');
  });

  it('gives each clock alarm its own song', () => {
    const rings = upcomingRings([], [wakeAlarm({ songId: 'b' }), wakeAlarm({ id: 'alarm-2', time: '07:30' })], now, ['a', 'b']);
    expect(rings.map((ring) => ring.sound)).toEqual(['music:b', 'music:a']);
    expect(upcomingRings([], [wakeAlarm({ songId: 'b' })], now, [])[0].sound).toBe('chime');
  });
});
