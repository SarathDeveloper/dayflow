import React, { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock,
  BatteryCharging,
  Bell,
  BellRing,
  CheckCircle2,
  Mic,
  Settings,
  TriangleAlert,
  Volume2,
} from 'lucide-react';
import type { Goal, Habit, HabitCheckIn, NotificationSettings, Task } from '../types';
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
import { Button } from './ui/Button';
import { Card } from './ui/Card';

const TEST_DELAY_MS = 10_000;
const UPCOMING_LIMIT = 15;

interface NotificationsViewProps {
  settings: NotificationSettings;
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
  onOpenSettings: () => void;
}

type CheckState = 'ok' | 'fix' | 'unknown';

interface Check {
  key: string;
  icon: React.ElementType;
  title: string;
  okText: string;
  fixText: string;
  state: CheckState;
  action?: { label: string; run: () => void };
}

const formatWhen = (at: Date): string => {
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const day = at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
};

/** Opens a system settings screen without the app lock kicking in on the way back. */
const openSystemScreen = (open: () => Promise<void>) => {
  beginExternalActivity();
  void open().catch((e) => console.warn('Could not open settings:', e));
};

/**
 * Everything about reminders in one place: whether Android lets them through
 * (permission, exact alarms, battery), tests for the drawer and the voice, and
 * what is scheduled next.
 */
export const NotificationsView: React.FC<NotificationsViewProps> = ({
  settings,
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
  onOpenSettings,
}) => {
  const native = isNativeAndroid();
  const [testMessage, setTestMessage] = useState('');

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
    () => buildReminderPlans(tasks, settings, new Date(), habits, habitCheckIns, goals, songIds).slice(0, UPCOMING_LIMIT),
    [tasks, settings, habits, habitCheckIns, goals, songIds]
  );

  const checks: Check[] = native
    ? [
        {
          key: 'permission',
          icon: Bell,
          title: 'Notifications allowed',
          okText: 'Dayflow can post reminders to your notification drawer.',
          fixText: 'Android is blocking Dayflow’s notifications, so no reminder can appear.',
          state: nativeSetup ? (nativeSetup.granted ? 'ok' : 'fix') : 'unknown',
          action: nativeSetup?.granted
            ? { label: 'Notification settings', run: () => openSystemScreen(() => DayflowAlarm.openNotificationSettings()) }
            : { label: 'Allow notifications', run: onRequestPermission },
        },
        {
          key: 'exact',
          icon: AlarmClock,
          title: 'Exact alarms',
          okText: 'Reminders fire on the minute.',
          fixText: 'Without “Alarms & reminders”, Android may deliver reminders several minutes late.',
          state: !nativeSetup
            ? 'unknown'
            : nativeSetup.exactAlarm === 'granted' || nativeSetup.exactAlarm === 'unsupported'
              ? 'ok'
              : 'fix',
          action:
            nativeSetup && (nativeSetup.exactAlarm === 'denied' || nativeSetup.exactAlarm === 'prompt')
              ? { label: 'Allow exact alarms', run: onOpenExactAlarmSettings }
              : undefined,
        },
        {
          key: 'battery',
          icon: BatteryCharging,
          title: 'Battery use: Unrestricted',
          okText: 'Your phone lets Dayflow keep its reminders when the app is closed.',
          fixText:
            'Battery saver is on for Dayflow. Many phones delete its reminders once you swipe the app away. Open App info → Battery, choose Unrestricted (or No restrictions), and turn on Autostart if your phone has it.',
          state: batteryUnrestricted === null ? 'unknown' : batteryUnrestricted ? 'ok' : 'fix',
          action: { label: 'Open App info', run: () => openSystemScreen(() => DayflowAlarm.openAppSettings()) },
        },
      ]
    : [
        {
          key: 'web',
          icon: Bell,
          title: 'Browser notifications',
          okText: 'Reminders show while this tab is open. For reminders with the app closed, use the Android app.',
          fixText: 'This browser is not allowed to show Dayflow notifications.',
          state: webPermission === 'granted' ? 'ok' : webPermission === 'unsupported' ? 'unknown' : 'fix',
          action: webPermission === 'granted' ? undefined : { label: 'Allow notifications', run: onRequestPermission },
        },
      ];

  const problems = checks.filter((check) => check.state === 'fix').length;
  const speaks = shouldSpeak(settings.defaultSound, false, settings);

  const runTestNotification = async () => {
    if (!native) {
      audioService.playSound(settings.defaultSound, 'Test reminder');
      setTestMessage('Played your reminder sound. On the website, notifications only show while the tab is open.');
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
    const text = spokenText('Drink water');
    if (native) {
      void DayflowAlarm.speak({ text }).catch((e) => console.warn('Test voice failed:', e));
    } else {
      audioService.playSound('voice', 'Drink water');
    }
    setTestMessage('You should hear “Reminder: Drink water”. Nothing? Check your media and notification volume, and that a text-to-speech engine is installed (Settings → Accessibility → Text-to-speech).');
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-black text-slate-900 dark:text-white">Notifications</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {problems > 0
            ? `${problems} setting${problems === 1 ? '' : 's'} can stop your reminders. Fix ${problems === 1 ? 'it' : 'them'} below.`
            : 'Check that reminders reach you, test them, and see what is coming up.'}
        </p>
      </div>

      <Card className="divide-y divide-slate-100 dark:divide-slate-800">
        {checks.map((check) => {
          const Icon = check.icon;
          return (
            <div key={check.key} className="flex items-start gap-3 p-4">
              <Icon className="w-5 h-5 mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-bold text-slate-900 dark:text-white">
                  {check.title}
                  {check.state === 'ok' && <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-label="OK" />}
                  {check.state === 'fix' && <TriangleAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" aria-label="Needs fixing" />}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-snug mt-0.5">
                  {check.state === 'fix' ? check.fixText : check.state === 'ok' ? check.okText : 'Checking…'}
                </p>
                {check.action && (check.state === 'fix' || check.key === 'permission' || check.key === 'battery') && (
                  <Button
                    size="sm"
                    variant={check.state === 'fix' ? 'primary' : 'secondary'}
                    className="mt-2"
                    onClick={check.action.run}
                  >
                    {check.action.label}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </Card>

      <Card className="p-4 space-y-3">
        <div>
          <p className="text-sm font-bold text-slate-900 dark:text-white">Test</p>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-snug">
            Sound: {settings.soundEnabled ? settings.defaultSound : 'off'}
            {speaks ? ' · read aloud' : ''}
            {settings.speechEnabled ? ' · Voice announcements on' : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void runTestNotification()}>
            <BellRing className="w-4 h-4" />
            {native ? 'Send test in 10 s' : 'Play reminder sound'}
          </Button>
          <Button size="sm" variant="secondary" onClick={runTestVoice}>
            <Mic className="w-4 h-4" />
            Test voice
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenSettings}>
            <Settings className="w-4 h-4" />
            Sound settings
          </Button>
        </div>
        {testMessage && (
          <p role="status" className="text-xs text-indigo-700 dark:text-indigo-300 leading-snug">
            {testMessage}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <p className="text-sm font-bold text-slate-900 dark:text-white mb-2">Coming up</p>
        {upcoming.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            No reminders scheduled. Turn on a reminder when you add a task or habit.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {upcoming.map((plan) => {
              const voice = shouldSpeak(plan.sound, plan.ring, settings);
              return (
                <li key={plan.notificationId} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">{plan.title}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{formatWhen(plan.fireAt)}</p>
                  </div>
                  <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    {plan.ring ? (
                      <>
                        <AlarmClock className="w-3.5 h-3.5" /> Rings
                      </>
                    ) : voice ? (
                      <>
                        <Mic className="w-3.5 h-3.5" /> Voice
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-3.5 h-3.5" /> {settings.soundEnabled ? plan.sound : 'Silent'}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
};
