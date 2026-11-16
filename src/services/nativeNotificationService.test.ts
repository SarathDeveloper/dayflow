import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtraReminderPlan } from '../lib/extraReminders';

interface Pending {
  id: number;
  schedule?: { at?: unknown };
  extra?: unknown;
}

const state = vi.hoisted(() => ({
  native: true,
  pending: [] as Pending[],
  cancelled: [] as number[],
  scheduled: [] as Array<Record<string, unknown>>,
  exact: 'granted' as string,
}));

vi.mock('../lib/platform', () => ({
  isNativeAndroid: () => state.native,
  isNative: () => state.native,
  platformName: () => (state.native ? 'android' : 'web'),
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    getPending: async () => ({ notifications: state.pending.map((entry) => ({ ...entry })) }),
    cancel: async ({ notifications }: { notifications: { id: number }[] }) => {
      state.cancelled.push(...notifications.map((entry) => entry.id));
    },
    schedule: async ({ notifications }: { notifications: Array<Record<string, unknown>> }) => {
      state.scheduled.push(...notifications);
    },
    checkExactNotificationSetting: async () => ({ exact_alarm: state.exact }),
  },
}));

const { syncExtraReminders, cancelAllTaskReminders, cancelAllExtraReminders, planNotificationReconcile, syncScheduledNotifications } =
  await import('./nativeNotificationService');

const FUTURE = Date.now() + 5 * 24 * 60 * 60 * 1000;

function plan(id: number, at: number, route = 'documents'): ExtraReminderPlan {
  return { notificationId: id, fireAt: new Date(at), title: 'Document reminder', body: 'body', route };
}

beforeEach(() => {
  state.native = true;
  state.pending = [];
  state.cancelled = [];
  state.scheduled = [];
  state.exact = 'granted';
});

describe('planNotificationReconcile', () => {
  it('only looks at ids it owns', () => {
    const now = Date.now();
    const pending = [
      { id: 5, schedule: { at: new Date(FUTURE).toISOString() } },
      { id: -5, schedule: { at: new Date(FUTURE).toISOString() } },
    ];
    const result = planNotificationReconcile(pending, [], now, (id) => id < 0);
    expect(result.toCancel).toEqual([{ id: -5 }]);
  });

  it('keeps matching pending entries, reschedules moved ones and skips already-fired records', () => {
    const now = Date.now();
    const pending = [
      { id: -1, schedule: { at: new Date(FUTURE).toISOString() } },
      { id: -2, schedule: { at: new Date(FUTURE).toISOString() } },
      { id: -3, schedule: { at: new Date(now - 60_000).toISOString() } },
      { id: -4, schedule: { at: new Date(FUTURE + 500).toISOString() } },
    ];
    const plans = [plan(-1, FUTURE), plan(-2, FUTURE + 60_000), plan(-4, FUTURE), plan(-9, FUTURE)];
    const result = planNotificationReconcile(pending, plans, now, (id) => id < 0);
    expect(result.toCancel).toEqual([{ id: -2 }]);
    expect(result.toSchedule.map((entry) => entry.notificationId)).toEqual([-2, -9]);
  });
});

describe('syncExtraReminders', () => {
  it('schedules negative ids on the chime channel with the route as taskId', async () => {
    const result = await syncExtraReminders([plan(-10, FUTURE, 'maintenance:abc')], { granted: true });
    expect(result).toEqual({ scheduled: 1, cancelled: 0, skipped: false });
    expect(state.scheduled).toHaveLength(1);
    const scheduled = state.scheduled[0];
    expect(scheduled.id).toBe(-10);
    expect(scheduled.channelId).toBe('reminders_chime');
    expect(scheduled.extra).toEqual({ taskId: 'maintenance:abc' });
    expect(scheduled.isExactNotification).toBe(true);
    expect(scheduled.isExactMandatory).toBe(false);
  });

  it('requests exact alarms only when allowed', async () => {
    state.exact = 'denied';
    await syncExtraReminders([plan(-10, FUTURE)], { granted: true });
    expect(state.scheduled[0].isExactNotification).toBe(false);
  });

  it('never cancels task or habit alarms (ids >= 0)', async () => {
    state.pending = [
      { id: 0, schedule: { at: new Date(FUTURE).toISOString() } },
      { id: 42, schedule: { at: new Date(FUTURE).toISOString() } },
      { id: -7, schedule: { at: new Date(FUTURE).toISOString() } },
    ];
    const result = await syncExtraReminders([], { granted: true });
    expect(state.cancelled).toEqual([-7]);
    expect(result.cancelled).toBe(1);
  });

  it('drops plans with non-negative or duplicate ids', async () => {
    await syncExtraReminders([plan(3, FUTURE), plan(-3, FUTURE), plan(-3, FUTURE + 1000)], { granted: true });
    expect(state.scheduled.map((entry) => entry.id)).toEqual([-3]);
  });

  it('does nothing without permission or off Android', async () => {
    state.pending = [{ id: -7, schedule: { at: new Date(FUTURE).toISOString() } }];
    expect(await syncExtraReminders([plan(-1, FUTURE)], { granted: false })).toEqual({
      scheduled: 0,
      cancelled: 0,
      skipped: true,
    });
    state.native = false;
    expect((await syncExtraReminders([plan(-1, FUTURE)], { granted: true })).skipped).toBe(true);
    expect(state.cancelled).toEqual([]);
    expect(state.scheduled).toEqual([]);
  });
});

describe('task reminder sync leaves extra reminders alone', () => {
  it('cancelAllTaskReminders keeps ids < 0 and cancelAllExtraReminders keeps ids >= 0', async () => {
    state.pending = [{ id: 1 }, { id: -1 }, { id: 0 }, { id: -2 }];
    await cancelAllTaskReminders();
    expect(state.cancelled.sort((a, b) => a - b)).toEqual([0, 1]);
    state.cancelled = [];
    await cancelAllExtraReminders();
    expect(state.cancelled.sort((a, b) => a - b)).toEqual([-2, -1]);
  });

  it('syncScheduledNotifications does not cancel pending ids < 0', async () => {
    state.pending = [
      { id: -11, schedule: { at: new Date(FUTURE).toISOString() } },
      { id: 77, schedule: { at: new Date(FUTURE).toISOString() } },
    ];
    await syncScheduledNotifications(
      [],
      {
        browserNotificationsEnabled: true,
        soundEnabled: true,
        speechEnabled: false,
        defaultSound: 'chime',
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
      },
      { granted: true }
    );
    expect(state.cancelled).toContain(77);
    expect(state.cancelled).not.toContain(-11);
  });
});
