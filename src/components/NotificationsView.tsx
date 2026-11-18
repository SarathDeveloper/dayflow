import React, { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock,
  BatteryCharging,
  Bell,
  BellRing,
  Clock,
  Mic,
  Moon,
  Repeat,
  TriangleAlert,
  Volume2,
} from 'lucide-react';
import type { Goal, Habit, HabitCheckIn, NotificationSettings, SoundType, Task } from '../types';
import { buildReminderPlans } from '../lib/reminders';
import { shouldSpeak, spokenText } from '../lib/spokenReminders';
import { isNativeAndroid } from '../lib/platform';
import { beginExternalActivity } from '../lib/externalActivity';
import { DayflowAlarm } from '../services/dayflowAlarm';
import {
  readNotificationStatus,
  sendTestNotification,
  type NotificationSetupResult,
} from '../services/nativeNotificationService';
import { audioService } from '../services/audioService';
import { AlarmSongsSection } from './AlarmSongsSection';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { SettingSwitch } from './ui/SettingSwitch';

const TEST_DELAY_MS = 10_000;
const UPCOMING_PREVIEW = 6;
const UPCOMING_MAX = 30;

const SOUND_CHOICES: { id: SoundType; label: string }[] = [
  { id: 'chime', label: 'Gentle chime' },
  { id: 'bell', label: 'Harmonic bell' },
  { id: 'digital', label: 'Digital pulse' },
  { id: 'gentle', label: 'Soothing chord' },
  { id: 'voice', label: 'Voice only' },
];

const field =
  'min-h-10 w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
const sectionLabel = 'px-1 pb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400';

interface NotificationsViewProps {
  settings: NotificationSettings;
  onUpdateSettings: (next: NotificationSettings) => void;
  nativeSetup: NotificationSetupResult | null;
  batteryUnrestricted: boolean | null;
  webPermission: NotificationPermission | 'unsupported';
  tasks: Task[];
  habits: Habit[];
  habitCheckIns: HabitCheckIn[];
  goals: Goal[];
  songIds: readonly string[];
  onRequestPermission: () => void;
  onOpenExactAlarmSettings: () => void;
  onStatusChange: (status: NotificationSetupResult) => void;
  onRefreshBattery: () => Promise<void>;
}

type TileState = 'ok' | 'fix' | 'unknown';

interface Tile {
  key: string;
  icon: React.ElementType;
  label: string;
  state: TileState;
  okWord: string;
  fixWord: string;
  /** Shown under the tiles while this one needs fixing. */
  problem: string;
  fixLabel: string;
  onFix: () => void;
  /** Tapping a healthy tile opens the related system screen. */
  onOpen?: () => void;
}

/** Opens a system settings screen without the app lock kicking in on the way back. */
const openSystemScreen = (open: () => Promise<void>) => {
  beginExternalActivity();
  void open().catch((e) => console.warn('Could not open settings:', e));
};

const formatTime = (at: Date): string => at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const dayLabel = (at: Date): string => {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (at.toDateString() === today.toDateString()) return 'Today';
  if (at.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

const tileTone: Record<TileState, string> = {
  ok: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:border-emerald-500/30',
  fix: 'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-500/10 dark:text-amber-200 dark:border-amber-500/40',
  unknown: 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700',
};

/**
 * The control center for reminders: whether Android lets them through
 * (permission, exact alarms, battery), every sound and quiet-hours setting,
 * alarm songs, tests, and what fires next.
 */
export const NotificationsView: React.FC<NotificationsViewProps> = ({
  settings,
  onUpdateSettings,
  nativeSetup,
  batteryUnrestricted,
  webPermission,
  tasks,
  habits,
  habitCheckIns,
  goals,
  songIds,
  onRequestPermission,
  onOpenExactAlarmSettings,
  onStatusChange,
  onRefreshBattery,
}) => {
  const native = isNativeAndroid();
  const [testMessage, setTestMessage] = useState('');
  const [showAll, setShowAll] = useState(false);

  // Coming back from a settings screen: read the state again.
  useEffect(() => {
    if (!native) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void readNotificationStatus().then(onStatusChange).catch(() => {});
      void onRefreshBattery();
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
    // Read once on open and on each return; the callbacks are stable enough for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  const upcoming = useMemo(
    () => buildReminderPlans(tasks, settings, new Date(), habits, habitCheckIns, goals, songIds).slice(0, UPCOMING_MAX),
    [tasks, settings, habits, habitCheckIns, goals, songIds]
  );
  const shown = showAll ? upcoming : upcoming.slice(0, UPCOMING_PREVIEW);

  const exactState: TileState = !nativeSetup
    ? 'unknown'
    : nativeSetup.exactAlarm === 'granted' || nativeSetup.exactAlarm === 'unsupported'
      ? 'ok'
      : 'fix';

  const tiles: Tile[] = native
    ? [
        {
          key: 'permission',
          icon: Bell,
          label: 'Alerts',
          state: nativeSetup ? (nativeSetup.granted ? 'ok' : 'fix') : 'unknown',
          okWord: 'Allowed',
          fixWord: 'Blocked',
          problem: 'Android is blocking Dayflow’s notifications, so no reminder can appear.',
          fixLabel: 'Allow notifications',
          onFix: onRequestPermission,
          onOpen: () => openSystemScreen(() => DayflowAlarm.openNotificationSettings()),
        },
        {
          key: 'exact',
          icon: Clock,
          label: 'Timing',
          state: exactState,
          okWord: 'On time',
          fixWord: 'May be late',
          problem: 'Without “Alarms & reminders”, Android can deliver reminders several minutes late.',
          fixLabel: 'Allow exact alarms',
          onFix: onOpenExactAlarmSettings,
        },
        {
          key: 'battery',
          icon: BatteryCharging,
          label: 'Battery',
          state: batteryUnrestricted === null ? 'unknown' : batteryUnrestricted ? 'ok' : 'fix',
          okWord: 'Unrestricted',
          fixWord: 'Fix',
          problem:
            'Battery saver is on for Dayflow, and many phones delete its reminders once you swipe the app away. In App info, open Battery and choose Unrestricted. Turn on Autostart too if your phone has it.',
          fixLabel: 'Open App info',
          onFix: () => openSystemScreen(() => DayflowAlarm.openAppSettings()),
          onOpen: () => openSystemScreen(() => DayflowAlarm.openAppSettings()),
        },
      ]
    : [
        {
          key: 'web',
          icon: Bell,
          label: 'Browser alerts',
          state: webPermission === 'granted' ? 'ok' : webPermission === 'unsupported' ? 'unknown' : 'fix',
          okWord: 'Allowed',
          fixWord: 'Blocked',
          problem: 'This browser is not allowed to show Dayflow notifications.',
          fixLabel: 'Allow notifications',
          onFix: onRequestPermission,
        },
      ];

  const problems = tiles.filter((tile) => tile.state === 'fix');
  const update = (patch: Partial<NotificationSettings>) => onUpdateSettings({ ...settings, ...patch });

  const runTestNotification = async () => {
    if (!native) {
      audioService.playSound(settings.defaultSound, 'Test reminder');
      setTestMessage('Played your reminder sound. On the website, reminders only show while this tab is open.');
      return;
    }
    try {
      await sendTestNotification(settings, TEST_DELAY_MS);
      setTestMessage('A test reminder arrives in 10 seconds. Close Dayflow now and check your notification drawer.');
    } catch (e) {
      console.warn('Test notification failed:', e);
      setTestMessage('Could not send the test. Allow notifications first.');
    }
  };

  const runTestVoice = () => {
    if (native) {
      void DayflowAlarm.speak({ text: spokenText('Drink water') }).catch((e) => console.warn('Test voice failed:', e));
    } else {
      audioService.playSound('voice', 'Drink water');
    }
    setTestMessage(
      'You should hear “Reminder: Drink water”. Nothing? Check the volume, and that a text-to-speech engine is installed (Settings → Accessibility → Text-to-speech).'
    );
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h2 className="text-lg font-black text-slate-900 dark:text-white">Notifications</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {problems.length > 0
            ? `${problems.length} setting${problems.length === 1 ? '' : 's'} can stop your reminders.`
            : 'Reminders can reach you. Sound, voice and quiet hours are below.'}
        </p>
      </div>

      {/* Status tiles */}
      <section aria-label="Reminder delivery" className="space-y-2">
        <div className={`grid gap-2 ${tiles.length === 3 ? 'grid-cols-3' : 'grid-cols-1'}`}>
          {tiles.map((tile) => {
            const Icon = tile.icon;
            const action = tile.state === 'fix' ? tile.onFix : tile.onOpen;
            return (
              <button
                key={tile.key}
                type="button"
                onClick={action}
                disabled={!action}
                aria-label={`${tile.label}: ${tile.state === 'fix' ? tile.fixWord : tile.state === 'ok' ? tile.okWord : 'checking'}`}
                className={`flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-center transition-colors enabled:hover:brightness-95 enabled:active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-indigo-500 ${tileTone[tile.state]}`}
              >
                <Icon aria-hidden="true" className="size-5" />
                <span className="text-[11px] font-medium opacity-80">{tile.label}</span>
                <span className="text-xs font-bold leading-tight">
                  {tile.state === 'fix' ? tile.fixWord : tile.state === 'ok' ? tile.okWord : '…'}
                </span>
              </button>
            );
          })}
        </div>
        {problems.map((tile) => (
          <div
            key={tile.key}
            className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/30"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-snug text-amber-900 dark:text-amber-200">{tile.problem}</p>
              <Button size="sm" className="mt-2" onClick={tile.onFix}>
                {tile.fixLabel}
              </Button>
            </div>
          </div>
        ))}
        {!native && (
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            On the website, reminders show only while this tab is open. Use the Android app to get them with the app closed.
          </p>
        )}
      </section>

      {/* Sound */}
      <section aria-labelledby="notif-sound">
        <h3 id="notif-sound" className={sectionLabel}>Sound</h3>
        <Card className="divide-y divide-slate-100 px-4 dark:divide-slate-800">
          <SettingSwitch
            label="Play sounds"
            description="Off makes every reminder silent."
            checked={settings.soundEnabled}
            onChange={(soundEnabled) => update({ soundEnabled })}
          />
          <div className="py-3">
            <label htmlFor="notif-default-sound" className="block text-sm font-medium">
              Reminder sound
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">For new tasks and habits. Each one can pick its own.</p>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <select
                id="notif-default-sound"
                value={settings.defaultSound === 'music' ? 'chime' : settings.defaultSound}
                disabled={!settings.soundEnabled}
                onChange={(event) => update({ defaultSound: event.target.value as SoundType })}
                className={field}
              >
                {SOUND_CHOICES.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="secondary"
                aria-label="Play reminder sound"
                onClick={() => audioService.playSound(settings.defaultSound, 'Drink water')}
              >
                <Volume2 aria-hidden="true" className="size-4" />
                Play
              </Button>
            </div>
          </div>
          <SettingSwitch
            label="Read reminders aloud"
            description="Says the title after the sound. Reminders set to Voice are always read."
            checked={settings.speechEnabled}
            disabled={!settings.soundEnabled}
            onChange={(speechEnabled) => update({ speechEnabled })}
          />
        </Card>
      </section>

      {/* Quiet hours */}
      <section aria-labelledby="notif-quiet">
        <h3 id="notif-quiet" className={sectionLabel}>Quiet hours</h3>
        <Card className="px-4">
          <SettingSwitch
            label="Pause reminders overnight"
            description={
              settings.quietHours.enabled
                ? `No reminders from ${settings.quietHours.start} to ${settings.quietHours.end}. Alarms still ring.`
                : 'Alarms still ring during quiet hours.'
            }
            checked={settings.quietHours.enabled}
            onChange={(enabled) => update({ quietHours: { ...settings.quietHours, enabled } })}
          />
          {settings.quietHours.enabled && (
            <div className="grid grid-cols-2 gap-2 pb-3">
              {(['start', 'end'] as const).map((time) => (
                <label key={time} className="min-w-0 space-y-1 text-xs font-medium text-slate-600 dark:text-slate-400">
                  <span className="flex items-center gap-1">
                    <Moon aria-hidden="true" className="size-3.5" />
                    {time === 'start' ? 'From' : 'Until'}
                  </span>
                  <input
                    type="time"
                    value={settings.quietHours[time]}
                    onChange={(event) => update({ quietHours: { ...settings.quietHours, [time]: event.target.value } })}
                    className={field}
                  />
                </label>
              ))}
            </div>
          )}
        </Card>
      </section>

      {/* Alarm songs (own heading and border) */}
      <Card className="px-4 pb-3 [&>section]:border-t-0">
        <AlarmSongsSection />
      </Card>

      {/* Test */}
      <section aria-labelledby="notif-test">
        <h3 id="notif-test" className={sectionLabel}>Test</h3>
        <Card className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => void runTestNotification()}>
              <BellRing aria-hidden="true" className="size-4" />
              {native ? 'Test alert' : 'Test sound'}
            </Button>
            <Button variant="secondary" onClick={runTestVoice}>
              <Mic aria-hidden="true" className="size-4" />
              Test voice
            </Button>
          </div>
          {testMessage && (
            <p role="status" className="text-xs leading-snug text-indigo-700 dark:text-indigo-300">
              {testMessage}
            </p>
          )}
        </Card>
      </section>

      {/* Coming up */}
      <section aria-labelledby="notif-upcoming">
        <h3 id="notif-upcoming" className={sectionLabel}>
          Coming up{upcoming.length > 0 ? ` · ${upcoming.length}${upcoming.length === UPCOMING_MAX ? '+' : ''}` : ''}
        </h3>
        <Card className="px-4">
          {upcoming.length === 0 ? (
            <p className="py-4 text-sm text-slate-500 dark:text-slate-400">
              No reminders scheduled. Turn on a reminder when you add a task or habit.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {shown.map((plan, index) => {
                  const day = dayLabel(plan.fireAt);
                  const newDay = index === 0 || dayLabel(shown[index - 1].fireAt) !== day;
                  const voice = shouldSpeak(plan.sound, plan.ring, settings);
                  const KindIcon = plan.ring ? AlarmClock : voice ? Mic : plan.habitId ? Repeat : Bell;
                  return (
                    <li key={plan.notificationId} className="py-2.5">
                      {newDay && (
                        <p className="pb-1 text-[11px] font-semibold text-slate-400 dark:text-slate-500">{day}</p>
                      )}
                      <div className="flex items-center gap-3">
                        <span className="w-16 shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                          {formatTime(plan.fireAt)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-white">
                          {plan.title}
                        </span>
                        <KindIcon
                          aria-label={plan.ring ? 'Rings' : voice ? 'Read aloud' : plan.habitId ? 'Habit' : 'Notification'}
                          className={`size-4 shrink-0 ${
                            plan.ring ? 'text-rose-600 dark:text-rose-400' : voice ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'
                          }`}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {upcoming.length > UPCOMING_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setShowAll((value) => !value)}
                  className="w-full border-t border-slate-100 py-2.5 text-xs font-semibold text-indigo-700 dark:border-slate-800 dark:text-indigo-300"
                >
                  {showAll ? 'Show less' : `Show all ${upcoming.length}`}
                </button>
              )}
            </>
          )}
        </Card>
      </section>
    </div>
  );
};
