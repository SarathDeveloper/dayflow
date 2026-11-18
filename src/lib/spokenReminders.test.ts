import { describe, expect, it } from 'vitest';
import type { NotificationSettings } from '../types';
import type { ReminderPlan } from './reminders';
import { buildSpokenReminderPlans, shouldSpeak } from './spokenReminders';

const base: NotificationSettings = {
  browserNotificationsEnabled: true,
  soundEnabled: true,
  speechEnabled: false,
  defaultSound: 'chime',
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
};

const plan = (over: Partial<ReminderPlan>): ReminderPlan => ({
  taskId: 't1',
  notificationId: 10,
  fireAt: new Date(2026, 10, 18, 9, 0),
  title: 'Walk',
  body: '',
  sound: 'chime',
  ring: false,
  occurrenceId: 't1',
  ...over,
});

const now = new Date(2026, 10, 18, 8, 0).getTime();

describe('shouldSpeak', () => {
  it('speaks the Voice sound', () => {
    expect(shouldSpeak('voice', false, base)).toBe(true);
  });
  it('speaks any sound when Voice announcements is on', () => {
    expect(shouldSpeak('bell', false, { ...base, speechEnabled: true })).toBe(true);
  });
  it('stays quiet for a chime without announcements', () => {
    expect(shouldSpeak('chime', false, base)).toBe(false);
  });
  it('never speaks with sound off or for a ringing alarm', () => {
    expect(shouldSpeak('voice', false, { ...base, soundEnabled: false })).toBe(false);
    expect(shouldSpeak('voice', true, base)).toBe(false);
  });
});

describe('buildSpokenReminderPlans', () => {
  it('keeps future voice plans with their notification id and text', () => {
    const result = buildSpokenReminderPlans(
      [plan({ sound: 'voice' }), plan({ notificationId: 11, occurrenceId: 't2', sound: 'chime' })],
      base,
      now
    );
    expect(result).toEqual([
      { id: 't1', notificationId: 10, at: new Date(2026, 10, 18, 9, 0).getTime(), text: 'Reminder: Walk' },
    ]);
  });
  it('drops past plans and negative ids', () => {
    expect(
      buildSpokenReminderPlans(
        [plan({ sound: 'voice', fireAt: new Date(now - 1000) }), plan({ sound: 'voice', notificationId: -5 })],
        base,
        now
      )
    ).toEqual([]);
  });
});
