import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { SpokenReminderPlan } from '../lib/spokenReminders';

export interface NativeRingPlan {
  id: string;
  notificationId: number;
  at: number;
  title: string;
  body: string;
  sound: string;
  kind: 'task' | 'habit' | 'alarm';
  snoozeMinutes: number;
  /** HH:mm. Set for clock alarms so a dismiss can schedule the next day. */
  time?: string;
  daysOfWeek?: number[];
}

export interface AlarmEvent {
  type: 'dismiss' | 'snooze';
  id: string;
  kind: 'task' | 'habit' | 'alarm';
  at: number;
  snoozeMinutes: number;
}

export interface NativeSong {
  id: string;
  name: string;
  size: number;
  addedAt: number;
}

export interface NativeSongSkip {
  name: string;
  reason: 'too-large' | 'empty' | 'limit' | 'failed';
}

interface DayflowAlarmPlugin {
  /** Opens the audio picker (several files allowed) and copies the picks into app storage. */
  addSongs(): Promise<{ songs: NativeSong[]; added: string[]; skipped: NativeSongSkip[] }>;
  listSongs(): Promise<{ songs: NativeSong[] }>;
  removeSong(options: { id: string }): Promise<{ songs: NativeSong[] }>;
  /** `sound` is a built-in name or `music:<song id>`. */
  preview(options: { sound: string }): Promise<void>;
  stopPreview(): Promise<void>;
  sync(options: { plans: NativeRingPlan[] }): Promise<void>;
  /** Replaces the spoken-reminder schedule (read aloud with text-to-speech, app open or closed). */
  syncSpeech(options: { plans: SpokenReminderPlan[] }): Promise<void>;
  /** Reads `text` aloud now, even on silent. */
  speak(options: { text: string }): Promise<void>;
  /** `unrestricted` is false while Android battery optimisation can stop reminders. */
  getBatteryStatus(): Promise<{ unrestricted: boolean; manufacturer: string }>;
  /** This app's system page (Battery, Autostart, Notifications). */
  openAppSettings(): Promise<void>;
  /** This app's notification settings. */
  openNotificationSettings(): Promise<void>;
  consumeEvents(): Promise<{ events: AlarmEvent[] }>;
  /** Open the Android share sheet for a text file (a JSON backup by default). The file stays in app cache. */
  shareBackup(options: {
    filename: string;
    contents: string;
    mimeType?: string;
    title?: string;
  }): Promise<void>;
  pickBackupFolder(): Promise<{ name: string }>;
  getBackupFolder(): Promise<{ has: boolean; lost: boolean; name: string }>;
  clearBackupFolder(): Promise<void>;
  writeBackupFile(options: { contents: string }): Promise<void>;
  addListener(
    eventName: 'alarmEvent',
    listenerFunc: (event: AlarmEvent) => void
  ): Promise<PluginListenerHandle>;
}

export const DayflowAlarm = registerPlugin<DayflowAlarmPlugin>('DayflowAlarm');
