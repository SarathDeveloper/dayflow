import type { NotificationSettings, SoundType } from '../types';
import type { ReminderPlan } from './reminders';

/** A reminder Android reads aloud with text-to-speech when it fires, app open or closed. */
export interface SpokenReminderPlan {
  id: string;
  notificationId: number;
  /** Epoch ms. */
  at: number;
  text: string;
}

/**
 * A reminder is spoken when its sound is "Voice", or when "Voice announcements"
 * is on (then the chosen chime plays and the title is read after it). Nothing is
 * spoken with sound off. Ringing alarms keep their own loop and are not spoken.
 */
export function shouldSpeak(sound: SoundType, ring: boolean, settings: NotificationSettings): boolean {
  if (!settings.soundEnabled || ring) return false;
  return sound === 'voice' || Boolean(settings.speechEnabled);
}

export function spokenText(title: string): string {
  return `Reminder: ${title}`;
}

/** The speech schedule for the native side, from the same plans the notifications use. */
export function buildSpokenReminderPlans(
  plans: readonly ReminderPlan[],
  settings: NotificationSettings,
  nowMs: number
): SpokenReminderPlan[] {
  return plans
    .filter((plan) => plan.notificationId >= 0 && plan.fireAt.getTime() > nowMs)
    .filter((plan) => shouldSpeak(plan.sound, plan.ring, settings))
    .map((plan) => ({
      id: plan.occurrenceId,
      notificationId: plan.notificationId,
      at: plan.fireAt.getTime(),
      text: spokenText(plan.title),
    }));
}
