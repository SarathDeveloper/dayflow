/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Search, Filter, Plus, Calendar, CheckCircle2, Clock, Sparkles, Tag, ArrowUpDown, X } from 'lucide-react';
import { Task, Category, NotificationSettings, ActiveTab, Priority, FinanceTransaction, MonthlyBudget, CategoryBudget, FinanceCategory, Debt, SavingsGoal, MoneyGoal, BudgetAlert, BudgetAlertState, BillTemplate, BillPayment, SavingsEntry, SavingsStreakState, Account, LedgerSettings, Goal, Habit, HabitCheckIn, HabitCheckInPatch, DiaryEntry, DiaryMood, DiaryReflection, Alarm, FocusSession, MaintenanceItem } from './types';
import { INITIAL_CATEGORIES } from './data/initialCategories';
import { getInitialTasks } from './data/initialTasks';
import { Header } from './components/Header';
import { DateBar } from './components/DateBar';
import { TaskCard } from './components/TaskCard';
import { QuickAddBar } from './components/QuickAddBar';
import { DailyPlanCard } from './components/DailyPlanCard';
import { TaskModal } from './components/TaskModal';
import { FinanceModal } from './components/FinanceModal';
import { AccountModal } from './components/ledger/AccountModal';
import { TransferModal } from './components/ledger/TransferModal';
import { DebtModal } from './components/DebtModal';
import { BillTemplateModal } from './components/BillTemplateModal';
import { SavingsModal } from './components/SavingsModal';
import { HabitsView } from './components/HabitsView';
import { TodayHabitsCard } from './components/TodayHabitsCard';
import { TodayAlarmCard } from './components/TodayAlarmCard';
import { AlarmRingOverlay } from './components/AlarmRingOverlay';
import { HabitModal } from './components/HabitModal';
import { DiaryView } from './components/DiaryView';
import { DiaryEntryModal } from './components/DiaryEntryModal';
import { TodayDiaryCard } from './components/TodayDiaryCard';
import { materializeRecurringTransactions } from './lib/financeRecurrence';
import { materializeBillPayments } from './lib/billMaterializer';
import { deriveStreakState } from './lib/savingsStreak';
import {
  countedSavingsAmounts,
  savingsBucketTest,
  ledgerTransactions,
  resolveSavingsDestinationId,
} from './lib/savingsLedger';
import { setCategoryBudget, setMonthlyBudget, staleCarryStops } from './lib/budgetCarry';
import { checkBudgetAlerts, formatAlertMessage } from './lib/budgetAlerts';
import { cleanReflection, composeReflectionBody, currentTimeString, diaryCollectionFits, diaryPreview, isDiaryMood, reflectionFor, sanitizeDiaryImages, validateDiaryDraft } from './lib/diary';
import { DEFAULT_PAYMENT_METHOD, financeCategoryError, isCustomFinanceCategory, normalizeCategoryName, reassignDeletedCategoryBudgets, sameCategoryName } from './data/financeCategories';
import {
  buildAtmFee,
  buildIncomeOrExpense,
  buildTransfer,
  assignAccountToTransactions,
  idsRemovedByCascade,
  removeTransactionCascade,
  resolveDefaultAccountId,
  isLedgerError,
  ledgerErrorDialog,
  nowTimeString,
  todayString,
  currentMonthKey,
  newLedgerId,
  upsertTransactions,
  validateEntry,
  validateTransfer,
  type EntryDraft,
  type TransferDraft,
} from './lib/ledger';
import { addRupees, formatRupees, fromPaise, toPaise } from './lib/money';
import { debtOutstanding } from './lib/debtPlanner';
import {
  addDebtPayment, debtOpeningDraft, debtPaymentDraft, debtTransactionIds, emiBillChanged, emiBillId, emiBillTemplate,
  linkBillPayment, matchBillForExpense, relinkRestoredTransactions, reopenDebt, syncEditedTransaction,
  unlinkDeletedTransactions,
} from './lib/moneyLinks';
import type { DebtPayment, PaymentMethod } from './types';
import { NotificationBanner } from './components/NotificationBanner';
import { SettingsModal } from './components/SettingsModal';
import { BottomNav } from './components/BottomNav';
import { MobileSidebar, Sidebar } from './components/Sidebar';
import { HomeView } from './components/HomeView';
import { InstallPrompt } from './components/InstallPrompt';
import { AppLockScreen } from './components/AppLockScreen';
import { Dropdown } from './components/ui/Dropdown';
import { Toast } from './components/ui/Toast';
import { dismissTopDialog, setDialogsSuspended, showAlert, showChoice, showConfirm } from './components/ui/AppDialog';
import { closeTopOverlay } from './lib/overlayBack';
import { Card } from './components/ui/Card';
import { Button } from './components/ui/Button';
import { NotificationService } from './services/notificationService';
import { isRecurring, nextOccurrence, nextOccurrenceId, nextOccurrenceOf, rescheduled, skipOccurrence } from './lib/taskRecurrence';
import { App as CapApp } from '@capacitor/app';
import { StatusBar, Style as StatusBarStyle } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import {
  cancelAllExtraReminders,
  cancelAllTaskReminders,
  ensureNotificationSetup,
  registerReminderListeners,
  requestExactAlarmPermission,
  syncExtraReminders,
  syncScheduledNotifications,
  readNotificationStatus,
  type NotificationSetupResult,
} from './services/nativeNotificationService';
import { buildExtraReminderPlans, DOCUMENTS_ROUTE, maintenanceIdFromRoute } from './lib/extraReminders';
import { buildMoneyReminders, moneySectionFromRoute, type MoneySection } from './lib/moneyReminders';
import { cardDues } from './lib/creditCard';
import { readDocumentReminders, subscribeDocumentReminders } from './services/documentReminderStore';
import { loadMaintenanceFromStorage, saveMaintenanceToStorage } from './services/maintenanceStorage';
import {
  mergeMaintenanceItems, newMaintenanceItem, recordService, updateMaintenanceItem, updateServiceRecord, deleteServiceRecord,
} from './lib/maintenance';
import { consumeExternalResume, finishExternalResume, shouldIgnorePauseForExternal } from './lib/externalActivity';
import { TodayMaintenanceCard } from './components/TodayMaintenanceCard';
import { TodayDocumentsCard } from './components/TodayDocumentsCard';
import type { ItemDraft, MaintenanceDocumentIntent, ServiceDraft } from './components/MaintenanceView';
import { isNative, isNativeAndroid } from './lib/platform';
import { isAppLockEnabled } from './lib/appLock';
import {
  canUsePasswordUnlock,
  isAppLockActive,
  isUnlockPromptOpen,
  promptAppUnlock,
  shouldIgnoreAppPause,
  shouldIgnoreAppResume,
} from './services/appLock';
import { WEB_RELOCK_AFTER_MS } from './lib/webLock';
import { checkAccountPassword } from './services/cloudSyncService';
import {
  BackupError,
  buildBackup,
  backupFilename,
  isShareCancel,
  parseBackup,
  recordIds,
  saveBackupFile,
  stampImportedBackup,
  type BackupArrayKey,
  type ParsedBackup,
} from './lib/backup';
import {
  chooseBackupFolder,
  clearBackupFolder,
  isBackupCancel,
  isChoosingBackupFolder,
  readAutoBackupStatus,
  writeAutomaticBackup,
} from './lib/localBackupFolder';
import {
  DEFAULT_SETTINGS,
  getStorageKeys,
  markDeleted,
  readSyncMeta,
  requestPersistentStorage,
  unmarkDeleted,
  writeSyncMeta,
} from './lib/persistence';
import { WEEKLY_REPORT_TASK_ID, buildReminderPlans } from './lib/reminders';
import { resolveReminderDelivery } from './lib/sounds';
import {
  alarmDueAt,
  applyAlarmRingEvent,
  applyHabitRingEvent,
  applyTaskRingEvent,
  upcomingRings,
  type RingSession,
} from './lib/alarms';
import { useSongs } from './lib/songLibrary';
import { pickSong } from './lib/songs';
import { buildFocusSession } from './lib/focusSessions';
import { dailyProgress, weeklyConsistency } from './lib/progressScore';
import { TodayProgressCard } from './components/TodayProgressCard';
import { WeeklyReportCard, WeeklyReportSheet } from './components/WeeklyReport';
import { isWeeklyReportSeen, markWeeklyReportSeen, reportWeekStart } from './lib/weeklyReport';
import { DayflowAlarm } from './services/dayflowAlarm';
import { clearHomeWidgets, updateHomeWidgets } from './services/homeWidgets';
import { buildWidgetSnapshot } from './lib/widgetSnapshot';
import { homeSummary } from './lib/homeSummary';
import { audioService } from './services/audioService';
import { canSetCheckIn, habitBlockReason, isComplete, isDueToday, isScheduledOn, isSkipped, todayDateString } from './lib/habits';
import { useCloudSync } from './hooks/useCloudSync';
import { useAppUpdates } from './hooks/useAppUpdates';
import { ReminderReliabilityCard } from './components/ReminderReliabilityCard';
import { NotificationsView } from './components/NotificationsView';
import { buildSpokenReminderPlans } from './lib/spokenReminders';

const REMINDER_NOTICE_DISMISSED_KEY = 'daily_tasks_reminder_notice_dismissed_v1';
const PasswordVaultView = lazy(() => import('./components/PasswordVaultView'));
const MaintenanceView = lazy(() => import('./components/MaintenanceView'));
const DocumentVaultView = lazy(() => import('./components/DocumentVaultView'));
// Tabs off the home screen load on first visit, keeping the first download small.
const CalendarView = lazy(() => import('./components/CalendarView').then((m) => ({ default: m.CalendarView })));
const TimelineView = lazy(() => import('./components/TimelineView').then((m) => ({ default: m.TimelineView })));
const FocusRoom = lazy(() => import('./components/FocusRoom').then((m) => ({ default: m.FocusRoom })));
const CategoriesView = lazy(() => import('./components/CategoriesView').then((m) => ({ default: m.CategoriesView })));
const StatsView = lazy(() => import('./components/StatsView').then((m) => ({ default: m.StatsView })));
const FinanceView = lazy(() => import('./components/FinanceView').then((m) => ({ default: m.FinanceView })));
const AlarmsView = lazy(() => import('./components/AlarmsView').then((m) => ({ default: m.AlarmsView })));
const GoalsView = lazy(() => import('./components/GoalsView').then((m) => ({ default: m.GoalsView })));

/** Skip the write while a profile switch is still loading, so the previous profile is not saved under the new keys. */
function usePersistJson(key: string, value: unknown, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value, enabled]);
}

interface AppProps {
  /** The person signed in with their password moments ago: skip the app-lock prompt once. */
  skipInitialLock?: boolean;
}

/** Device flag: the one-time budget carry-over stop rows were written. */
const BUDGET_CARRY_MIGRATION_KEY = 'dayflow_budget_carry_v1';

export default function App({ skipInitialLock = false }: AppProps) {
  const todayStr = todayString();

  // Theme State (Light / Dark Mode)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('daily_tasks_theme_v1');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) {
      console.warn('Failed to parse saved theme:', e);
    }
    return 'light';
  });

  useEffect(() => {
    localStorage.setItem('daily_tasks_theme_v1', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#0f172a' : '#ffffff');

    // Match the Android status bar icons to the active theme.
    if (isNative()) {
      void StatusBar.setStyle({
        style: theme === 'dark' ? StatusBarStyle.Dark : StatusBarStyle.Light,
      }).catch(() => {});
    }
  }, [theme]);

  const handleToggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // One profile on this device. Desktop and phone meet in the same cloud account.
  const storageKeys = getStorageKeys(null);
  const userTasksKey = storageKeys.tasks;
  const userCategoriesKey = storageKeys.categories;
  const userFinanceKey = storageKeys.transactions;
  const userAccountsKey = storageKeys.accounts;
  const userLedgerSettingsKey = storageKeys.ledgerSettings;
  const userBudgetsKey = storageKeys.budgets;
  const userCatBudgetsKey = storageKeys.categoryBudgets;
  const userFinanceCategoriesKey = storageKeys.financeCategories;
  const userDebtsKey = storageKeys.debts;
  const userSavingsKey = storageKeys.savingsGoals;
  const userMoneyGoalsKey = storageKeys.moneyGoals;
  const userAlertStateKey = storageKeys.alertState;
  const userBillTemplatesKey = storageKeys.billTemplates;
  const userBillPaymentsKey = storageKeys.billPayments;
  const userSavingsEntriesKey = storageKeys.savingsEntries;
  const userSavingsStreakKey = storageKeys.savingsStreak;
  const userGoalsKey = storageKeys.goals;
  const userHabitsKey = storageKeys.habits;
  const userHabitCheckInsKey = storageKeys.habitCheckIns;
  const userAlarmsKey = storageKeys.alarms;
  const userFocusSessionsKey = storageKeys.focusSessions;
  const userMaintenanceKey = storageKeys.maintenanceItems;
  const userDiaryKey = storageKeys.diaryEntries;
  const STORAGE_KEY_SETTINGS = storageKeys.settings;

  // 1. Core State
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      const saved = localStorage.getItem(userTasksKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse saved tasks:', e);
    }
    return getInitialTasks();
  });

  const [categories, setCategories] = useState<Category[]>(() => {
    try {
      const saved = localStorage.getItem(userCategoriesKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse categories:', e);
    }
    return INITIAL_CATEGORIES;
  });

  const [transactions, setTransactions] = useState<FinanceTransaction[]>(() => {
    try {
      const saved = localStorage.getItem(userFinanceKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse finance transactions:', e);
    }
    return [];
  });

  const [accounts, setAccounts] = useState<Account[]>(() => {
    try {
      const saved = localStorage.getItem(userAccountsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse finance accounts:', e);
    }
    return [];
  });

  const [ledgerSettings, setLedgerSettings] = useState<LedgerSettings[]>(() => {
    try {
      const saved = localStorage.getItem(userLedgerSettingsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse ledger settings:', e);
    }
    return [];
  });

  const [budgets, setBudgets] = useState<MonthlyBudget[]>(() => {
    try {
      const saved = localStorage.getItem(userBudgetsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse finance budgets:', e);
    }
    return [];
  });

  const [categoryBudgets, setCategoryBudgets] = useState<CategoryBudget[]>(() => {
    try {
      const saved = localStorage.getItem(userCatBudgetsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse category budgets:', e);
    }
    return [];
  });

  const [financeCategories, setFinanceCategories] = useState<FinanceCategory[]>(() => {
    try {
      const saved = localStorage.getItem(userFinanceCategoriesKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse finance categories:', e);
    }
    return [];
  });

  const [debts, setDebts] = useState<Debt[]>(() => {
    try {
      const saved = localStorage.getItem(userDebtsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse debts:', e);
    }
    return [];
  });

  const [savingsGoals, setSavingsGoals] = useState<SavingsGoal[]>(() => {
    try {
      const saved = localStorage.getItem(userSavingsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse savings goals:', e);
    }
    return [];
  });

  const [moneyGoals, setMoneyGoals] = useState<MoneyGoal[]>(() => {
    try {
      const saved = localStorage.getItem(userMoneyGoalsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse money goals:', e);
    }
    return [];
  });

  const [budgetAlertState, setBudgetAlertState] = useState<BudgetAlertState>(() => {
    try {
      const saved = localStorage.getItem(userAlertStateKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse alert state:', e);
    }
    return {};
  });

  const [financeAlerts, setFinanceAlerts] = useState<BudgetAlert[]>([]);

  const [billTemplates, setBillTemplates] = useState<BillTemplate[]>(() => {
    try {
      const saved = localStorage.getItem(userBillTemplatesKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse bill templates:', e);
    }
    return [];
  });

  const [billPayments, setBillPayments] = useState<BillPayment[]>(() => {
    try {
      const saved = localStorage.getItem(userBillPaymentsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse bill payments:', e);
    }
    return [];
  });

  const [savingsEntries, setSavingsEntries] = useState<SavingsEntry[]>(() => {
    try {
      const saved = localStorage.getItem(userSavingsEntriesKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse savings entries:', e);
    }
    return [];
  });

  const [goals, setGoals] = useState<Goal[]>(() => {
    try {
      const saved = localStorage.getItem(userGoalsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse goals:', e);
    }
    return [];
  });

  const [habits, setHabits] = useState<Habit[]>(() => {
    try {
      const saved = localStorage.getItem(userHabitsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse habits:', e);
    }
    return [];
  });

  const [habitCheckIns, setHabitCheckIns] = useState<HabitCheckIn[]>(() => {
    try {
      const saved = localStorage.getItem(userHabitCheckInsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse habit check-ins:', e);
    }
    return [];
  });
  const [editingHabit, setEditingHabit] = useState<Habit | null>(null);

  const [alarms, setAlarms] = useState<Alarm[]>(() => {
    try {
      const saved = localStorage.getItem(userAlarmsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse alarms:', e);
    }
    return [];
  });
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>(() => {
    try {
      const saved = localStorage.getItem(userFocusSessionsKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse focus sessions:', e);
    }
    return [];
  });
  // Maintenance: damaged stored data is copied aside (never silently overwritten) and reported.
  const [maintenanceLoad, setMaintenanceLoad] = useState(() => loadMaintenanceFromStorage(userMaintenanceKey));
  const [maintenanceItems, setMaintenanceItems] = useState<MaintenanceItem[]>(() => maintenanceLoad.items);
  const [maintenanceSaveError, setMaintenanceSaveError] = useState<string | null>(null);
  const [documentIntent, setDocumentIntent] = useState<MaintenanceDocumentIntent | null>(null);
  const [ringing, setRinging] = useState<RingSession | null>(null);
  // Alarm songs live on this device only; reminders pick from these ids.
  const { songs } = useSongs();
  const songIds = useMemo(() => songs.map((song) => song.id), [songs]);

  const [diaryEntries, setDiaryEntries] = useState<DiaryEntry[]>(() => {
    try {
      const saved = localStorage.getItem(userDiaryKey);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to parse diary entries:', e);
    }
    return [];
  });
  const [isDiaryModalOpen, setIsDiaryModalOpen] = useState(false);
  const [editingDiaryEntry, setEditingDiaryEntry] = useState<DiaryEntry | null>(null);
  const [diaryDraftDate, setDiaryDraftDate] = useState(todayStr);
  const [recentlyDeletedDiary, setRecentlyDeletedDiary] = useState<{ entry: DiaryEntry; index: number } | null>(null);

  // Streak counts legacy logs plus transfers of new money into savings, gold, or stocks.
  const savingsStreak = useMemo<SavingsStreakState>(
    () => deriveStreakState(countedSavingsAmounts(savingsEntries, transactions, accounts)),
    [savingsEntries, transactions, accounts]
  );

  const [settings, setSettings] = useState<NotificationSettings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    } catch (e) {
      console.warn('Failed to parse settings:', e);
    }
    return DEFAULT_SETTINGS;
  });
  const [appLocked, setAppLocked] = useState(() => isAppLockActive() && !skipInitialLock);
  const [lockError, setLockError] = useState('');
  const [nativeBootReady, setNativeBootReady] = useState(() => !isNativeAndroid());
  // Android: silent app-code updates, and an offer when a new APK is needed.
  useAppUpdates(nativeBootReady);

  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const openMenu = useCallback(() => setIsMenuOpen(true), []);
  const closeMenu = useCallback(() => setIsMenuOpen(false), []);
  const [permissionStatus, setPermissionStatus] = useState<
    NotificationPermission | 'unsupported'
  >(() => NotificationService.getPermissionStatus());

  // Native reminder state (Android only).
  const [nativeSetup, setNativeSetup] = useState<NotificationSetupResult | null>(null);
  /** False while Android battery optimisation can delete reminders (null: unknown / not Android). */
  const [batteryUnrestricted, setBatteryUnrestricted] = useState<boolean | null>(null);
  const refreshBatteryStatus = useCallback(async () => {
    if (!isNativeAndroid()) return;
    try {
      const { unrestricted } = await DayflowAlarm.getBatteryStatus();
      setBatteryUnrestricted(unrestricted);
    } catch (e) {
      console.warn('Could not read battery status:', e);
    }
  }, []);
  const [reminderNoticeDismissed, setReminderNoticeDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(REMINDER_NOTICE_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  // Bumped after a cloud pull so the whole app reloads from localStorage.
  const [dataEpoch, setDataEpoch] = useState(0);
  // Bumped on any local data change so cloud sync can debounce.
  const [localRevision, setLocalRevision] = useState(0);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'completed'>('all');
  const [sortBy, setSortBy] = useState<'time' | 'priority-desc' | 'priority-asc' | 'title'>('time');

  // Modals & Active Alerts
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isFinanceModalOpen, setIsFinanceModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<FinanceTransaction | null>(null);
  const [financeDraftDefaults, setFinanceDraftDefaults] = useState<{
    type?: 'income' | 'expense';
    accountId?: string;
  } | null>(null);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [editingTransfer, setEditingTransfer] = useState<FinanceTransaction | null>(null);
  const [isDebtModalOpen, setIsDebtModalOpen] = useState(false);
  const [editingDebt, setEditingDebt] = useState<Debt | null>(null);
  const [isBillTemplateModalOpen, setIsBillTemplateModalOpen] = useState(false);
  const [editingBillTemplate, setEditingBillTemplate] = useState<BillTemplate | null>(null);
  const [isSavingsModalOpen, setIsSavingsModalOpen] = useState(false);
  const [editingSavingsEntry, setEditingSavingsEntry] = useState<SavingsEntry | null>(null);
  const [editingSavingsTransfer, setEditingSavingsTransfer] = useState<FinanceTransaction | null>(null);
  const [savingsPresetAmount, setSavingsPresetAmount] = useState<number | null>(null);
  const [recentlyDeletedTransaction, setRecentlyDeletedTransaction] = useState<{
    txs: FinanceTransaction[];
  } | null>(null);
  /** Entries a one-tap add just saved (quick entry, repeat or savings chips), for the Undo toast. */
  /** A money reminder was tapped: FinanceView opens this section. */
  const [requestedMoneySection, setRequestedMoneySection] = useState<{ section: MoneySection; at: number } | null>(null);
  const [recentlyAddedTransactions, setRecentlyAddedTransactions] = useState<{
    ids: string[];
    message: string;
  } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [backupFolderSupported, setBackupFolderSupported] = useState(false);
  const [backupFolderName, setBackupFolderName] = useState<string | null>(null);
  const [backupLastSavedAt, setBackupLastSavedAt] = useState<string | null>(null);
  const [backupFolderError, setBackupFolderError] = useState('');
  const [activeAlert, setActiveAlert] = useState<{ task: Task; triggeredAt: Date } | null>(null);
  const [focusTask, setFocusTask] = useState<Task | null>(null);
  /** Timer length for the next focus session, e.g. what is left of a time block. */
  const [focusMinutes, setFocusMinutes] = useState<number | undefined>(undefined);
  /** Start time for a new task opened from a Timeline hour. */
  const [newTaskTime, setNewTaskTime] = useState<string | undefined>(undefined);

  // Undo toast for recently deleted tasks
  const [recentlyDeleted, setRecentlyDeleted] = useState<{ task: Task; index: number } | null>(null);
  // Week (Monday) shown in the weekly report sheet; null when closed.
  const [reportWeek, setReportWeek] = useState<string | null>(null);
  const [reportSeenTick, setReportSeenTick] = useState(0);

  // Saves wait until stored data is in state. Writing earlier, during a cloud
  // reload, would persist the previous snapshot over the one just applied.
  const hydrationToken = String(dataEpoch);
  const [readyHydrationToken, setReadyHydrationToken] = useState(hydrationToken);
  const canPersist = readyHydrationToken === hydrationToken;

  // Reload after a cloud merge writes a new snapshot into localStorage.
  useEffect(() => {
    try {
      const savedTasks = localStorage.getItem(userTasksKey);
      if (savedTasks) {
        setTasks(JSON.parse(savedTasks));
      } else {
        setTasks(getInitialTasks());
      }

      const savedCats = localStorage.getItem(userCategoriesKey);
      if (savedCats) {
        setCategories(JSON.parse(savedCats));
      } else {
        setCategories(INITIAL_CATEGORIES);
      }

      const savedFinance = localStorage.getItem(userFinanceKey);
      const loadedFinance: FinanceTransaction[] = savedFinance
        ? JSON.parse(savedFinance)
        : [];
      // Materialize recurring transactions up to today.
      const todayStrLoad = todayString();
      const materialized = materializeRecurringTransactions(loadedFinance, todayStrLoad);
      setTransactions(materialized);

      const savedAccounts = localStorage.getItem(userAccountsKey);
      setAccounts(savedAccounts ? JSON.parse(savedAccounts) : []);

      const savedLedgerSettings = localStorage.getItem(userLedgerSettingsKey);
      setLedgerSettings(savedLedgerSettings ? JSON.parse(savedLedgerSettings) : []);

      const savedBudgets = localStorage.getItem(userBudgetsKey);
      setBudgets(savedBudgets ? JSON.parse(savedBudgets) : []);

      const savedCatBudgets = localStorage.getItem(userCatBudgetsKey);
      setCategoryBudgets(savedCatBudgets ? JSON.parse(savedCatBudgets) : []);

      const savedFinanceCategories = localStorage.getItem(userFinanceCategoriesKey);
      setFinanceCategories(savedFinanceCategories ? JSON.parse(savedFinanceCategories) : []);

      const savedDebts = localStorage.getItem(userDebtsKey);
      setDebts(savedDebts ? JSON.parse(savedDebts) : []);

      const savedSavings = localStorage.getItem(userSavingsKey);
      setSavingsGoals(savedSavings ? JSON.parse(savedSavings) : []);

      const savedSavingsEntries = localStorage.getItem(userSavingsEntriesKey);
      setSavingsEntries(savedSavingsEntries ? JSON.parse(savedSavingsEntries) : []);

      const savedMoneyGoals = localStorage.getItem(userMoneyGoalsKey);
      setMoneyGoals(savedMoneyGoals ? JSON.parse(savedMoneyGoals) : []);

      const savedAlertState = localStorage.getItem(userAlertStateKey);
      setBudgetAlertState(savedAlertState ? JSON.parse(savedAlertState) : {});
      setFinanceAlerts([]);

      const savedBillTemplates = localStorage.getItem(userBillTemplatesKey);
      const loadedBillTemplates: BillTemplate[] = savedBillTemplates
        ? JSON.parse(savedBillTemplates)
        : [];
      setBillTemplates(loadedBillTemplates);

      const savedBillPayments = localStorage.getItem(userBillPaymentsKey);
      const loadedBillPayments: BillPayment[] = savedBillPayments
        ? JSON.parse(savedBillPayments)
        : [];

      // Materialize bill payments up to current month.
      const currentMonthLoad = currentMonthKey();
      const { payments: materializedPayments } = materializeBillPayments(
        loadedBillTemplates,
        loadedBillPayments,
        currentMonthLoad
      );
      setBillPayments(materializedPayments);

      const savedGoals = localStorage.getItem(userGoalsKey);
      setGoals(savedGoals ? JSON.parse(savedGoals) : []);

      const savedHabits = localStorage.getItem(userHabitsKey);
      setHabits(savedHabits ? JSON.parse(savedHabits) : []);

      const savedHabitCheckIns = localStorage.getItem(userHabitCheckInsKey);
      setHabitCheckIns(savedHabitCheckIns ? JSON.parse(savedHabitCheckIns) : []);

      const savedAlarms = localStorage.getItem(userAlarmsKey);
      setAlarms(savedAlarms ? JSON.parse(savedAlarms) : []);

      const savedFocusSessions = localStorage.getItem(userFocusSessionsKey);
      setFocusSessions(savedFocusSessions ? JSON.parse(savedFocusSessions) : []);

      const reloadedMaintenance = loadMaintenanceFromStorage(userMaintenanceKey);
      setMaintenanceLoad(reloadedMaintenance);
      setMaintenanceItems(reloadedMaintenance.items);

      const savedDiary = localStorage.getItem(userDiaryKey);
      setDiaryEntries(savedDiary ? JSON.parse(savedDiary) : []);

      const savedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
      setSettings(
        savedSettings ? { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) } : DEFAULT_SETTINGS
      );
    } catch (e) {
      console.warn('Error loading user data:', e);
    } finally {
      setReadyHydrationToken(String(dataEpoch));
    }
  }, [dataEpoch, userTasksKey, userCategoriesKey, userFinanceKey, userAccountsKey, userLedgerSettingsKey, userBudgetsKey, userCatBudgetsKey, userFinanceCategoriesKey, userDebtsKey, userSavingsKey, userSavingsEntriesKey, userMoneyGoalsKey, userAlertStateKey, userBillTemplatesKey, userBillPaymentsKey, userGoalsKey, userHabitsKey, userHabitCheckInsKey, userAlarmsKey, userFocusSessionsKey, userMaintenanceKey, userDiaryKey, STORAGE_KEY_SETTINGS]);

  // Auto-Save Persistence
  usePersistJson(userTasksKey, tasks, canPersist);
  usePersistJson(userCategoriesKey, categories, canPersist);
  usePersistJson(userFinanceKey, transactions, canPersist);
  usePersistJson(userAccountsKey, accounts, canPersist);
  usePersistJson(userLedgerSettingsKey, ledgerSettings, canPersist);
  usePersistJson(userBudgetsKey, budgets, canPersist);
  usePersistJson(userCatBudgetsKey, categoryBudgets, canPersist);

  // Once per device: budgets that had lapsed before carry-over get a stop row, so
  // they do not come back. Stop rows never override a real row (budgetCarry.ts).
  useEffect(() => {
    if (!canPersist) return;
    try {
      if (localStorage.getItem(BUDGET_CARRY_MIGRATION_KEY)) return;
      localStorage.setItem(BUDGET_CARRY_MIGRATION_KEY, '1');
    } catch {
      return;
    }
    const stops = staleCarryStops(budgets, categoryBudgets, currentMonthKey(), new Date().toISOString());
    if (stops.budgets.length) setBudgets((prev) => [...prev, ...stops.budgets.filter((s) => !prev.some((b) => b.id === s.id))]);
    if (stops.categoryBudgets.length) {
      setCategoryBudgets((prev) => [...prev, ...stops.categoryBudgets.filter((s) => !prev.some((b) => b.id === s.id))]);
    }
    // Runs when stored data is ready; the flag keeps it to once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPersist]);
  usePersistJson(userFinanceCategoriesKey, financeCategories, canPersist);
  usePersistJson(userDebtsKey, debts, canPersist);
  usePersistJson(userSavingsKey, savingsGoals, canPersist);
  usePersistJson(userAlertStateKey, budgetAlertState, canPersist);
  usePersistJson(userBillTemplatesKey, billTemplates, canPersist);
  usePersistJson(userBillPaymentsKey, billPayments, canPersist);
  usePersistJson(userSavingsEntriesKey, savingsEntries, canPersist);
  usePersistJson(userMoneyGoalsKey, moneyGoals, canPersist);
  usePersistJson(userGoalsKey, goals, canPersist);
  usePersistJson(userHabitsKey, habits, canPersist);
  usePersistJson(userHabitCheckInsKey, habitCheckIns, canPersist);
  usePersistJson(userAlarmsKey, alarms, canPersist);
  usePersistJson(userFocusSessionsKey, focusSessions, canPersist);
  useEffect(() => {
    if (!canPersist) return;
    setMaintenanceSaveError(saveMaintenanceToStorage(userMaintenanceKey, maintenanceItems));
  }, [userMaintenanceKey, maintenanceItems, canPersist]);
  usePersistJson(userDiaryKey, diaryEntries, canPersist);
  usePersistJson(userSavingsStreakKey, savingsStreak, canPersist);

  useEffect(() => {
    if (!canPersist) return;
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    // Only stamp a settings edit when the serialized value actually changed
    // since the last stamp. This keeps a cloud-pulled value from being
    // re-stamped as the newest local edit (which would stop it propagating).
    const serialized = JSON.stringify(settings);
    const meta = readSyncMeta(storageKeys);
    if (meta.settingsSnapshot === serialized) return;
    writeSyncMeta(storageKeys, {
      ...meta,
      settingsUpdatedAt: new Date().toISOString(),
      settingsSnapshot: serialized,
    });
  }, [settings, STORAGE_KEY_SETTINGS, storageKeys, canPersist]);

  // Single revision counter for every piece of user data -> drives cloud sync
  // debouncing without wiring a callback into a dozen save effects.
  useEffect(() => {
    setLocalRevision((value) => value + 1);
  }, [
    tasks,
    categories,
    transactions,
    accounts,
    ledgerSettings,
    budgets,
    categoryBudgets,
    financeCategories,
    debts,
    savingsGoals,
    savingsEntries,
    moneyGoals,
    billTemplates,
    billPayments,
    goals,
    habits,
    habitCheckIns,
    alarms,
    focusSessions,
    maintenanceItems,
    diaryEntries,
  ]);

  // Cloud sync (Supabase)
  const cloudSync = useCloudSync({
    revision: localRevision,
    onDataApplied: () => setDataEpoch((value) => value + 1),
  });

  // Request Notification Permission
  const handleRequestPermission = async () => {
    if (isNativeAndroid()) {
      const result = await ensureNotificationSetup();
      setNativeSetup(result);
      setPermissionStatus(result.granted ? 'granted' : 'denied');
      if (result.granted) {
        setSettings((prev) => ({ ...prev, browserNotificationsEnabled: true }));
      }
      return;
    }
    const granted = await NotificationService.requestPermission();
    setPermissionStatus(NotificationService.getPermissionStatus());
    if (granted) {
      setSettings((prev) => ({ ...prev, browserNotificationsEnabled: true }));
    }
  };

  // Trigger Notification Callback
  const handleTriggerAlert = useCallback((task: Task) => {
    setActiveAlert({ task, triggeredAt: new Date() });
  }, []);

  const handleOpenExactAlarmSettings = useCallback(() => {
    void requestExactAlarmPermission();
  }, []);

  const dismissReminderNotice = useCallback(() => {
    try {
      localStorage.setItem(REMINDER_NOTICE_DISMISSED_KEY, '1');
    } catch {
      // ignore storage failures
    }
    setReminderNoticeDismissed(true);
  }, []);

  // Dialogs wait while the lock screen or the alarm ring screen covers the app.
  useEffect(() => {
    setDialogsSuspended(appLocked || Boolean(ringing));
  }, [appLocked, ringing]);
  useEffect(() => () => setDialogsSuspended(false), []);

  // Keep refs to the latest values so native listeners never capture stale data.
  const tasksRef = useRef<Task[]>(tasks);
  tasksRef.current = tasks;
  // Handlers that await a confirmation must read these afterwards, not the
  // values from the render that opened it: a cloud sync can land meanwhile.
  const transactionsRef = useRef<FinanceTransaction[]>(transactions);
  transactionsRef.current = transactions;
  const billPaymentsRef = useRef<BillPayment[]>(billPayments);
  billPaymentsRef.current = billPayments;
  const settingsRef = useRef<NotificationSettings>(settings);
  settingsRef.current = settings;
  const habitsRef = useRef<Habit[]>(habits);
  habitsRef.current = habits;
  const habitCheckInsRef = useRef<HabitCheckIn[]>(habitCheckIns);
  habitCheckInsRef.current = habitCheckIns;
  const goalsRef = useRef<Goal[]>(goals);
  goalsRef.current = goals;
  const alarmsRef = useRef<Alarm[]>(alarms);
  alarmsRef.current = alarms;
  const writeLeaveBackupRef = useRef<() => void>(() => {});
  const songIdsRef = useRef(songIds);
  songIdsRef.current = songIds;
  const ringingRef = useRef<RingSession | null>(ringing);
  ringingRef.current = ringing;
  const nativeBootReadyRef = useRef(nativeBootReady);
  nativeBootReadyRef.current = nativeBootReady;

  const unlockApp = useCallback(async () => {
    if (isUnlockPromptOpen()) return;
    if (!isAppLockActive()) {
      setAppLocked(false);
      setLockError('');
      return;
    }
    const result = await promptAppUnlock();
    if (result.ok) {
      setAppLocked(false);
      setLockError('');
    } else {
      setAppLocked(true);
      setLockError(result.canceled ? '' : result.message);
    }
  }, []);
  const unlockAppRef = useRef(unlockApp);
  unlockAppRef.current = unlockApp;

  // ---------------------------------------------------------------------
  // Reminders
  // ---------------------------------------------------------------------
  // Native (Android): everything is a real AlarmManager entry, so it fires with
  // the app closed. The browser polling loop below only runs on the web build.
  useEffect(() => {
    if (!isNativeAndroid()) return;

    let removeListeners: (() => void) | undefined;
    let cancelled = false;

    const boot = async () => {
      try {
        // Hide the splash first: the notification permission dialog would
        // otherwise appear on top of a blank splash screen with no context.
        await SplashScreen.hide().catch(() => {});

        const result = await ensureNotificationSetup();
        if (cancelled) return;
        setNativeSetup(result);
        setPermissionStatus(result.granted ? 'granted' : 'denied');
        void refreshBatteryStatus();

        removeListeners = await registerReminderListeners({
          onDue: (taskId) => {
            // Document / maintenance reminders: the system notification is enough while the app is open.
            if (taskId === DOCUMENTS_ROUTE || maintenanceIdFromRoute(taskId) || moneySectionFromRoute(taskId)) return;
            if (taskId.startsWith('habit:')) {
              setActiveTab('habits');
              return;
            }
            const task = tasksRef.current.find((t) => t.id === taskId);
            if (task) setActiveAlert({ task, triggeredAt: new Date() });
          },
          onOpened: (taskId) => {
            if (taskId === DOCUMENTS_ROUTE) {
              // The vault always asks for its passphrase first.
              setActiveTab('documents');
              return;
            }
            if (maintenanceIdFromRoute(taskId)) {
              setActiveTab('maintenance');
              return;
            }
            const moneySection = moneySectionFromRoute(taskId);
            if (moneySection) {
              setRequestedMoneySection({ section: moneySection, at: Date.now() });
              setActiveTab('finance');
              return;
            }
            if (taskId === WEEKLY_REPORT_TASK_ID) {
              setActiveTab('today');
              openWeeklyReportRef.current();
              return;
            }
            if (taskId.startsWith('habit:')) {
              setActiveTab('habits');
              return;
            }
            const task = tasksRef.current.find((t) => t.id === taskId);
            if (!task) return;
            setSelectedDate(task.date);
            setActiveTab('today');
            setActiveAlert({ task, triggeredAt: new Date() });
          },
        });
        // Unmounted (sign-out) while the listeners were being attached.
        if (cancelled) removeListeners();
      } catch (e) {
        console.warn('Native reminder setup failed:', e);
      } finally {
        if (!cancelled) setNativeBootReady(true);
      }
    };

    void boot();

    return () => {
      cancelled = true;
      removeListeners?.();
    };
    // Boot once per app launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const promptedAfterBoot = useRef(false);
  useEffect(() => {
    if (!nativeBootReady || promptedAfterBoot.current) return;
    promptedAfterBoot.current = true;
    if (isAppLockActive() && !skipInitialLock) void unlockApp();
  }, [nativeBootReady, unlockApp]);

  // Website: lock again after a minute away (another tab, screen off). The
  // timer covers the screen while away, so nothing shows before the prompt.
  useEffect(() => {
    if (isNativeAndroid()) return;
    let hiddenAt: number | null = null;
    let timer: number | undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (shouldIgnoreAppPause()) return;
        hiddenAt = Date.now();
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (isAppLockActive()) setAppLocked(true);
        }, WEB_RELOCK_AFTER_MS);
        return;
      }
      window.clearTimeout(timer);
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (shouldIgnoreAppResume() || !isAppLockActive()) return;
      if (away >= WEB_RELOCK_AFTER_MS) {
        setAppLocked(true);
        setLockError('');
        void unlockAppRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(timer);
    };
  }, []);

  const unlockWithPassword = useCallback(async (password: string): Promise<string> => {
    const result = await checkAccountPassword(password);
    if (result === 'ok') {
      setAppLocked(false);
      setLockError('');
      return '';
    }
    if (result === 'wrong') return 'That password is not right.';
    if (result === 'rate-limited') return 'Too many tries. Wait a minute, then try again.';
    return 'Could not check the password. Check your connection and try again.';
  }, []);

  // Home-screen widgets show task titles and spending, so they stay blank while
  // app lock is on. A short delay batches bursts of edits into one update.
  // `localToday` re-pushes after midnight on the next render, e.g. app resume.
  const localToday = todayString();
  useEffect(() => {
    if (!isNativeAndroid()) return;
    const timer = window.setTimeout(() => {
      const push = isAppLockEnabled()
        ? clearHomeWidgets()
        : updateHomeWidgets(buildWidgetSnapshot(localToday, tasks, ledgerTransactions(transactions, accounts), budgets));
      void push.catch((e) => console.warn('Failed to update home widgets:', e));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [tasks, transactions, accounts, budgets, appLocked, localToday]);

  const pushNativeSchedule = useCallback((granted: boolean) => {
    if (!isNativeAndroid()) return;
    const ready = songIdsRef.current;
    if (granted) {
      void syncScheduledNotifications(
        tasksRef.current,
        settingsRef.current,
        { granted: true },
        habitsRef.current,
        habitCheckInsRef.current,
        goalsRef.current,
        ready
      );
    }
    const plans = buildReminderPlans(
      tasksRef.current,
      settingsRef.current,
      new Date(),
      habitsRef.current,
      habitCheckInsRef.current,
      goalsRef.current,
      ready
    );
    void DayflowAlarm.sync({ plans: upcomingRings(plans, alarmsRef.current, new Date(), ready) }).catch((e) => {
      console.warn('Failed to sync ringing alarms:', e);
    });
    void DayflowAlarm.syncSpeech({ plans: buildSpokenReminderPlans(plans, settingsRef.current, Date.now()) }).catch((e) => {
      console.warn('Failed to sync spoken reminders:', e);
    });
  }, []);

  // Reconcile the phone's alarms whenever tasks or reminder settings change.
  useEffect(() => {
    if (!isNativeAndroid()) return;
    const timer = setTimeout(() => {
      pushNativeSchedule(Boolean(nativeSetup?.granted));
    }, 600);
    return () => clearTimeout(timer);
  }, [tasks, settings, habits, habitCheckIns, goals, alarms, songIds, nativeSetup?.granted, pushNativeSchedule]);

  // Document expiry + maintenance reminders use negative notification ids, so they
  // never collide with (or get cancelled by) the task/habit sync above.
  const maintenanceItemsRef = useRef(maintenanceItems);
  maintenanceItemsRef.current = maintenanceItems;
  // Bills, EMIs, card dues and debts also remind through this sync (moneyReminders.ts).
  const moneyReminderInputRef = useRef({ billTemplates, debts, accounts, transactions });
  moneyReminderInputRef.current = { billTemplates, debts, accounts, transactions };
  const pushExtraReminders = useCallback((granted: boolean) => {
    if (!isNativeAndroid()) return;
    const today = todayString();
    const money = moneyReminderInputRef.current;
    const plans = buildExtraReminderPlans({
      documents: readDocumentReminders().entries,
      maintenance: maintenanceItemsRef.current,
      money:
        settingsRef.current.moneyReminders === false
          ? []
          : buildMoneyReminders({
              billTemplates: money.billTemplates,
              billPayments: billPaymentsRef.current,
              debts: money.debts,
              cards: cardDues(money.accounts, money.transactions, today),
              today,
            }),
      now: new Date(),
    });
    void syncExtraReminders(plans, { granted }).catch((e) => console.warn('Failed to sync document/maintenance reminders:', e));
  }, []);
  const [documentReminderTick, setDocumentReminderTick] = useState(0);
  useEffect(() => subscribeDocumentReminders(() => setDocumentReminderTick((value) => value + 1)), []);
  useEffect(() => {
    if (!isNativeAndroid()) return;
    const timer = setTimeout(() => pushExtraReminders(Boolean(nativeSetup?.granted)), 600);
    return () => clearTimeout(timer);
  }, [maintenanceItems, documentReminderTick, nativeSetup?.granted, pushExtraReminders, billTemplates, billPayments, debts, accounts, transactions, settings.moneyReminders]);
  const extraReminderNote = !isNativeAndroid()
    ? 'On the website these reminders show on Today only; notifications need the Android app.'
    : nativeSetup && !nativeSetup.granted
      ? 'Notifications are off for Dayflow, so these reminders only show on Today. Turn them on in Android settings.'
      : null;

  writeLeaveBackupRef.current = () => {
    const file = buildBackup({
      tasks,
      categories,
      transactions,
      accounts,
      ledgerSettings,
      budgets,
      categoryBudgets,
      financeCategories,
      debts,
      savingsGoals,
      savingsEntries,
      moneyGoals,
      goals,
      habits,
      habitCheckIns,
      alarms,
      focusSessions,
      maintenanceItems,
      diaryEntries,
      billTemplates,
      billPayments,
      settings,
      theme,
      budgetAlertState,
    });
    void writeAutomaticBackup(file).then((result) => {
      if (result === 'saved') {
        setBackupLastSavedAt(new Date().toISOString());
        return;
      }
      if (result === 'lost') {
        setBackupFolderName(null);
        setBackupLastSavedAt(null);
        setBackupFolderError('Choose the folder again.');
      }
    });
  };

  useEffect(() => {
    void readAutoBackupStatus().then((status) => {
      setBackupFolderSupported(status.supported);
      setBackupFolderName(status.name);
      setBackupLastSavedAt(status.lastSavedAt);
      if (status.lost) setBackupFolderError('Choose the folder again.');
    });
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) return;
    void readAutoBackupStatus().then((status) => {
      setBackupFolderSupported(status.supported);
      setBackupFolderName(status.name);
      setBackupLastSavedAt(status.lastSavedAt);
      if (status.lost) setBackupFolderError('Choose the folder again.');
    });
  }, [isSettingsOpen]);

  useEffect(() => {
    if (isNative()) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden' && !isChoosingBackupFolder() && !shouldIgnorePauseForExternal()) {
        writeLeaveBackupRef.current();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Coming back to the foreground: re-check permissions and reschedule, since
  // Android drops alarms scheduled while exact-alarm access was revoked.
  // Registered once; current settings are read through a ref.
  useEffect(() => {
    if (!isNativeAndroid()) return;
    let remove: (() => void) | undefined;
    let disposed = false;
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        if (shouldIgnoreAppPause() || isChoosingBackupFolder() || shouldIgnorePauseForExternal()) return;
        writeLeaveBackupRef.current();
        if (isAppLockEnabled()) {
          setAppLocked(true);
          setLockError('');
        }
        return;
      }
      const backFromPicker = consumeExternalResume();
      // Clear the picker coverage once every listener (this one and the document vault) has
      // seen this resume, so a later real background locks as usual.
      if (backFromPicker) window.setTimeout(finishExternalResume, 1500);
      if (
        !isChoosingBackupFolder() &&
        !backFromPicker &&
        !shouldIgnoreAppResume() &&
        nativeBootReadyRef.current &&
        isAppLockEnabled()
      ) {
        setAppLocked(true);
        void unlockAppRef.current();
      }
      void (async () => {
        const current = await readNotificationStatus();
        const granted = current.granted;
        setPermissionStatus(granted ? 'granted' : 'denied');
        setNativeSetup((prev) => (prev ? current : prev));
        void refreshBatteryStatus();
        pushNativeSchedule(granted);
        pushExtraReminders(granted);
        try {
          const { events } = await DayflowAlarm.consumeEvents();
          for (const event of events ?? []) {
            if (event.kind === 'task') setTasks((prev) => applyTaskRingEvent(prev, event));
            else if (event.kind === 'habit') setHabits((prev) => applyHabitRingEvent(prev, event));
            else setAlarms((prev) => applyAlarmRingEvent(prev, event));
          }
        } catch (e) {
          console.warn('Could not read alarm events:', e);
        }
      })();
    }).then((handle) => {
      // App unmounts on sign-out, possibly before the listener is attached.
      if (disposed) {
        void handle.remove();
        return;
      }
      remove = () => {
        try {
          handle.remove();
        } catch {
          // already detached
        }
      };
    });
    return () => {
      disposed = true;
      remove?.();
    };
  }, []);

  useEffect(() => {
    if (!isNativeAndroid()) return;
    let remove = () => {};
    let disposed = false;
    const applyQueued = async () => {
      try {
        const { events } = await DayflowAlarm.consumeEvents();
        for (const event of events ?? []) {
          if (event.kind === 'task') setTasks((prev) => applyTaskRingEvent(prev, event));
          else if (event.kind === 'habit') setHabits((prev) => applyHabitRingEvent(prev, event));
          else setAlarms((prev) => applyAlarmRingEvent(prev, event));
        }
      } catch (e) {
        console.warn('Could not read alarm events:', e);
      }
    };
    void applyQueued();
    void DayflowAlarm.addListener('alarmEvent', () => {
      void applyQueued();
    }).then((handle) => {
      // App unmounts on sign-out, possibly before the listener is attached.
      if (disposed) {
        void handle.remove();
        return;
      }
      remove = () => {
        try {
          handle.remove();
        } catch {
          // already detached
        }
      };
    });
    return () => {
      disposed = true;
      remove();
    };
  }, []);

  // Web / PWA fallback: the original in-page poller, still useful in a tab.
  useEffect(() => {
    if (isNative()) return;

    const checkReminders = () => {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
      const currentDateNum = String(now.getDate()).padStart(2, '0');
      const todayDateStr = `${currentYear}-${currentMonth}-${currentDateNum}`;
      const currentMins = now.getHours() * 60 + now.getMinutes();

      setTasks((prevTasks) =>
        prevTasks.map((t) => {
          if (t.completed || !t.reminder?.enabled || !t.time) return t;

          if (t.reminder.snoozedUntil && new Date(t.reminder.snoozedUntil) > now) {
            return t;
          }

          const [h, m] = t.time.split(':').map(Number);
          const taskMins = h * 60 + m;
          const leadTimeMins = t.reminder.remindBeforeMinutes || 0;
          const remindAtMins = taskMins - leadTimeMins;

          if (t.date === todayDateStr && currentMins >= remindAtMins && currentMins <= remindAtMins + 2) {
            const lastNotified = t.reminder.lastNotifiedAt
              ? new Date(t.reminder.lastNotifiedAt).getTime()
              : 0;
            const twoMinsAgo = now.getTime() - 120000;

            if (lastNotified < twoMinsAgo) {
              const delivery = resolveReminderDelivery(
                t.reminder.sound,
                t.reminder.alarm,
                songIdsRef.current.length > 0,
                settings.defaultSound
              );
              if (delivery.ring) {
                if (ringingRef.current?.id !== t.id) {
                  setRinging({
                    id: t.id,
                    kind: 'task',
                    title: t.title,
                    body: t.time || '',
                    sound: delivery.sound,
                    songId: pickSong(t.reminder.songId, songIdsRef.current),
                    snoozeMinutes: 10,
                  });
                }
                return t;
              }
              void NotificationService.sendTaskNotification(t, settings, handleTriggerAlert);
              return {
                ...t,
                reminder: {
                  ...t.reminder,
                  lastNotifiedAt: now.toISOString(),
                  snoozedUntil: undefined,
                },
              };
            }
          }
          return t;
        })
      );

      setHabits((prev) => {
        let changed = false;
        const next = prev.map((habit) => {
          if (!habit.reminder?.enabled || !habit.reminder.time) return habit;
          if (habitBlockReason(habit, goalsRef.current)) return habit;
          if (!isScheduledOn(habit, todayDateStr)) return habit;
          if (!isDueToday(habit, todayDateStr, goalsRef.current, habitCheckInsRef.current)) return habit;
          const entry = habitCheckInsRef.current.find(
            (item) => item.habitId === habit.id && item.date === todayDateStr
          );
          if (isComplete(habit, entry) || isSkipped(entry)) return habit;

          if (habit.reminder.snoozedUntil && new Date(habit.reminder.snoozedUntil) > now) return habit;

          const [hours, minutes] = habit.reminder.time.split(':').map(Number);
          if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return habit;
          const remindAtMins = hours * 60 + minutes;
          const snoozeAt = habit.reminder.snoozedUntil ? new Date(habit.reminder.snoozedUntil) : null;
          const snoozeDue = Boolean(
            snoozeAt && snoozeAt <= now && now.getTime() - snoozeAt.getTime() <= 120000
          );
          const timeDue = currentMins >= remindAtMins && currentMins <= remindAtMins + 2;
          if (!snoozeDue && !timeDue) return habit;

          const lastNotified = habit.reminder.lastNotifiedAt
            ? new Date(habit.reminder.lastNotifiedAt).getTime()
            : 0;
          if (lastNotified >= now.getTime() - 120000) return habit;

          const occurrenceId = `habit:${habit.id}:${todayDateStr}`;
          const delivery = resolveReminderDelivery(
            habit.reminder.sound,
            habit.reminder.alarm,
            songIdsRef.current.length > 0,
            settings.defaultSound
          );
          if (delivery.ring) {
            if (ringingRef.current?.id !== occurrenceId) {
              setRinging({
                id: occurrenceId,
                kind: 'habit',
                title: habit.title,
                body: habit.reminder.time,
                sound: delivery.sound,
                songId: pickSong(habit.reminder.songId, songIdsRef.current),
                snoozeMinutes: 10,
              });
            }
            return habit;
          }

          void NotificationService.sendSimpleNotification(
            `Habit: ${habit.title}`,
            habit.reminder.time,
            habit.reminder.sound,
            `habit-${habit.id}`,
            settings
          );
          changed = true;
          return {
            ...habit,
            reminder: { ...habit.reminder, lastNotifiedAt: now.toISOString() },
            updatedAt: now.toISOString(),
          };
        });
        return changed ? next : prev;
      });

      for (const alarm of alarmsRef.current) {
        const due = alarmDueAt(alarm, now);
        if (!due) continue;
        if (ringingRef.current?.id === alarm.id) break;
        const delivery = resolveReminderDelivery(alarm.sound, true, songIdsRef.current.length > 0, settings.defaultSound);
        setRinging({
          id: alarm.id,
          kind: 'alarm',
          title: alarm.label || 'Alarm',
          body: alarm.time,
          sound: delivery.sound,
          songId: pickSong(alarm.songId, songIdsRef.current),
          snoozeMinutes: alarm.snoozeMinutes || 10,
        });
        break;
      }
    };

    const timer = setInterval(checkReminders, 5000);
    return () => clearInterval(timer);
  }, [settings, handleTriggerAlert]);

  // Ask the WebView to keep this origin's data on disk (best effort).
  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  const closeHabitModalRef = useRef<(() => void) | null>(null);
  const closeGoalModalRef = useRef<(() => void) | null>(null);
  const closeDiaryModalRef = useRef<(() => void) | null>(null);
  const registerHabitClose = useCallback((close: (() => void) | null) => {
    closeHabitModalRef.current = close;
  }, []);
  const registerGoalClose = useCallback((close: (() => void) | null) => {
    closeGoalModalRef.current = close;
  }, []);
  const registerDiaryClose = useCallback((close: (() => void) | null) => {
    closeDiaryModalRef.current = close;
  }, []);

  useEffect(() => {
    if (!isDiaryModalOpen) return;
    registerDiaryClose(() => {
      setIsDiaryModalOpen(false);
      setEditingDiaryEntry(null);
    });
    return () => registerDiaryClose(null);
  }, [isDiaryModalOpen, registerDiaryClose]);

  const finishRing = (type: 'dismiss' | 'snooze') => {
    const current = ringingRef.current;
    if (!current) return;
    const event = {
      type,
      id: current.id,
      kind: current.kind,
      at: Date.now(),
      snoozeMinutes: current.snoozeMinutes,
    };
    if (current.kind === 'task') setTasks((prev) => applyTaskRingEvent(prev, event));
    else if (current.kind === 'habit') setHabits((prev) => applyHabitRingEvent(prev, event));
    else setAlarms((prev) => applyAlarmRingEvent(prev, event));
    setRinging(null);
    audioService.stopLoop();
  };

  const handleSaveAlarm = (partial: Partial<Alarm>) => {
    const now = new Date().toISOString();
    if (partial.id) {
      setAlarms((prev) =>
        prev.map((alarm) =>
          alarm.id === partial.id
            ? {
                ...alarm,
                ...partial,
                label: partial.label?.trim() || alarm.label,
                daysOfWeek: partial.daysOfWeek ?? alarm.daysOfWeek,
                updatedAt: now,
              }
            : alarm
        )
      );
      return;
    }
    const created: Alarm = {
      id: newLedgerId('alarm'),
      label: partial.label?.trim() || 'Alarm',
      time: partial.time || '07:00',
      enabled: partial.enabled ?? true,
      daysOfWeek: partial.daysOfWeek ?? [],
      sound: partial.sound || 'chime',
      songId: partial.sound === 'music' ? partial.songId : undefined,
      snoozeMinutes: partial.snoozeMinutes || 10,
      createdAt: now,
      updatedAt: now,
    };
    setAlarms((prev) => [created, ...prev]);
  };

  const handleDeleteAlarm = (id: string) => {
    markDeleted(storageKeys, [id]);
    setAlarms((prev) => prev.filter((alarm) => alarm.id !== id));
  };

  // Android hardware back: close whatever is open instead of killing the app.
  // The handler body is recreated every render and reached through a ref so the
  // native listener is registered exactly once (re-registering on every modal
  // change leaked listeners and made one back press fire several handlers).
  // The drawer never stays open over a tab switch (e.g. a notification tap), an alert,
  // the weekly report, a ringing alarm or the app lock.
  useEffect(() => {
    setIsMenuOpen(false);
  }, [activeTab, activeAlert, reportWeek, ringing, appLocked]);

  const backHandlerRef = useRef<() => void>(() => {});
  backHandlerRef.current = () => {
    // An open alert or confirmation closes first, as if cancelled.
    if (dismissTopDialog()) return;
    // Then a full-screen overlay inside a screen (the document viewer).
    if (closeTopOverlay()) return;
    if (reportWeek) {
      setReportWeek(null);
      return;
    }
    if (ringing) {
      finishRing('dismiss');
      return;
    }
    if (isMenuOpen) {
      setIsMenuOpen(false);
      return;
    }
    if (closeDiaryModalRef.current) {
      const close = closeDiaryModalRef.current;
      closeDiaryModalRef.current = null;
      close();
      return;
    }
    if (editingHabit) {
      setEditingHabit(null);
      return;
    }
    if (closeHabitModalRef.current) {
      const close = closeHabitModalRef.current;
      closeHabitModalRef.current = null;
      close();
      return;
    }
    if (closeGoalModalRef.current) {
      const close = closeGoalModalRef.current;
      closeGoalModalRef.current = null;
      close();
      return;
    }
    if (isTaskModalOpen) {
      setIsTaskModalOpen(false);
      setEditingTask(null);
      return;
    }
    if (isFinanceModalOpen) {
      setIsFinanceModalOpen(false);
      setEditingTransaction(null);
      return;
    }
    if (isDebtModalOpen) {
      setIsDebtModalOpen(false);
      setEditingDebt(null);
      return;
    }
    if (isBillTemplateModalOpen) {
      setIsBillTemplateModalOpen(false);
      setEditingBillTemplate(null);
      return;
    }
    if (isSavingsModalOpen) {
      setIsSavingsModalOpen(false);
      setEditingSavingsEntry(null);
      setEditingSavingsTransfer(null);
      setSavingsPresetAmount(null);
      return;
    }
    if (isSettingsOpen) {
      setIsSettingsOpen(false);
      return;
    }
    if (activeAlert) {
      setActiveAlert(null);
      return;
    }
    if (activeTab !== 'home') {
      setActiveTab('home');
      return;
    }
    // At the root screen: behave like a normal Android app and background it.
    void CapApp.minimizeApp();
  };

  useEffect(() => {
    if (!isNative()) return;
    let remove: (() => void) | undefined;
    let disposed = false;

    void CapApp.addListener('backButton', () => backHandlerRef.current()).then((handle) => {
      // App unmounts on sign-out, possibly before the listener is attached.
      if (disposed) {
        void handle.remove();
        return;
      }
      remove = () => {
        try {
          handle.remove();
        } catch {
          // already detached
        }
      };
    });

    return () => {
      disposed = true;
      remove?.();
    };
  }, []);

  // Complete Task & Generate Next Recurring Task
  const handleToggleComplete = (taskId: string) => {
    setTasks((prev) => {
      const newTasks = [...prev];
      const targetIndex = newTasks.findIndex((t) => t.id === taskId);
      if (targetIndex === -1) return prev;

      const target = newTasks[targetIndex];
      const willBeCompleted = !target.completed;

      const now = new Date().toISOString();
      // updatedAt lets cloud sync keep this check over an older copy.
      newTasks[targetIndex] = {
        ...target,
        completed: willBeCompleted,
        completedAt: willBeCompleted ? now : undefined,
        updatedAt: now,
      };

      if (willBeCompleted && isRecurring(target)) {
        const nextDate = nextOccurrenceOf(target);
        const ended = Boolean(target.recurrence.endDate && nextDate > target.recurrence.endDate);
        const nextId = nextOccurrenceId(target, nextDate);
        const exists = newTasks.some((t) => t.id === nextId || (t.title === target.title && t.date === nextDate));

        if (!ended && !exists) {
          newTasks.push(nextOccurrence(target, nextDate, now));
        }
      }

      return newTasks;
    });
  };

  // Toggle Subtask
  const handleToggleSubtask = (taskId: string, subtaskId: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        return {
          ...t,
          subtasks: t.subtasks.map((s) =>
            s.id === subtaskId ? { ...s, completed: !s.completed } : s
          ),
          updatedAt: new Date().toISOString(),
        };
      })
    );
  };

  // Save / Add Task
  const handleSaveTask = (partial: Partial<Task>) => {
    if (partial.id) {
      setTasks((prev) =>
        prev.map((t) => (t.id === partial.id ? ({ ...t, ...partial, updatedAt: new Date().toISOString() } as Task) : t))
      );
    } else {
      const newTask: Task = {
        id: newLedgerId('task'),
        title: partial.title || 'New Task',
        description: partial.description || '',
        completed: false,
        date: partial.date || selectedDate,
        time: partial.time || '09:00',
        estimatedMinutes: partial.estimatedMinutes || 30,
        priority: partial.priority || 'medium',
        category: partial.category || categories[0]?.name || 'Work',
        subtasks: partial.subtasks || [],
        recurrence: partial.recurrence || { type: 'none' },
        reminder: partial.reminder || { enabled: true, remindBeforeMinutes: 5, sound: 'chime' },
        tags: partial.tags || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setTasks((prev) => [newTask, ...prev]);
    }
  };

  // Delete Task (with undo toast)
  const handleDeleteTask = (taskId: string) => {
    markDeleted(storageKeys, [taskId]);
    setTasks((prev) => {
      const index = prev.findIndex((t) => t.id === taskId);
      if (index === -1) return prev;
      setRecentlyDeleted({ task: prev[index], index });
      setRecentlyAddedTransactions(null);
      // Clear any pending undo toast to keep a single toast slot.
      setRecentlyDeletedTransaction(null);
      setRecentlyDeletedDiary(null);
      return prev.filter((t) => t.id !== taskId);
    });
  };

  // Undo the most recent deletion -- re-insert the task at its original index
  const handleUndoDelete = () => {
    if (!recentlyDeleted) return;
    unmarkDeleted(storageKeys, [recentlyDeleted.task.id]);
    setTasks((prev) => {
      const copy = [...prev];
      copy.splice(recentlyDeleted.index, 0, recentlyDeleted.task);
      return copy;
    });
    setRecentlyDeleted(null);
  };

  // Delete Category
  const handleDeleteCategory = (catId: string) => {
    const targetCat = categories.find((c) => c.id === catId);
    if (!targetCat) return;

    markDeleted(storageKeys, [catId]);
    const remainingCats = categories.filter((c) => c.id !== catId);
    setCategories(remainingCats);

    const fallbackCat = remainingCats[0]?.name || 'General';
    setTasks((prev) =>
      prev.map((t) => (t.category === targetCat.name ? { ...t, category: fallbackCat } : t))
    );
  };

  // Skip just this occurrence of a recurring task. At the end of the series
  // there is no next date, so the last occurrence is checked off instead.
  const handleSkipTask = (taskId: string) => {
    const now = new Date().toISOString();
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        return skipOccurrence(t, now) ?? { ...t, completed: true, completedAt: now, updatedAt: now };
      })
    );
    if (activeAlert?.task.id === taskId) setActiveAlert(null);
  };

  // Move tasks to another day and/or time, re-arming their reminders.
  const handleRescheduleTasks = (taskIds: string[], change: { date?: string; time?: string }) => {
    const ids = new Set(taskIds);
    const now = new Date().toISOString();
    setTasks((prev) =>
      prev.map((t) => {
        if (!ids.has(t.id)) return t;
        const moved = rescheduled(t, change.date ?? t.date, now);
        return {
          ...moved,
          time: change.time ?? t.time,
          // Moving a task keeps its progress; only the reminder is re-armed.
          completed: t.completed,
          completedAt: t.completedAt,
          subtasks: t.subtasks,
        };
      })
    );
  };

  // Add one checklist step from the task card.
  const handleAddSubtask = (taskId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              subtasks: [...t.subtasks, { id: newLedgerId('sub'), title: trimmed, completed: false }],
              updatedAt: new Date().toISOString(),
            }
          : t
      )
    );
  };

  // Snooze Task
  const handleSnoozeTask = (taskId: string, minutes: number) => {
    const snoozedUntil = new Date(Date.now() + minutes * 60000).toISOString();
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        return {
          ...t,
          reminder: {
            ...t.reminder,
            snoozedUntil,
          },
        };
      })
    );
    if (activeAlert?.task.id === taskId) {
      setActiveAlert(null);
    }
  };

  // Quick Add at Time from Timeline
  const handleQuickAddTaskAtTime = (timeStr: string) => {
    setEditingTask(null);
    setNewTaskTime(timeStr);
    setIsTaskModalOpen(true);
  };

  // Start Focus Session
  const handleStartFocus = (task: Task, minutes?: number) => {
    setFocusTask(task);
    setFocusMinutes(minutes);
    setActiveTab('focus');
  };

  // Reset Data
  const handleResetTasks = () => {
    // Tombstone everything that is about to disappear so a cloud merge on
    // another device does not bring it back.
    markDeleted(storageKeys, [
      ...tasks.map((t) => t.id),
      ...categories.map((c) => c.id),
      ...transactions.map((t) => t.id),
      ...accounts.map((a) => a.id),
      ...ledgerSettings.map((s) => s.id),
      ...budgets.map((b) => b.id),
      ...categoryBudgets.map((b) => b.id),
      ...financeCategories.map((c) => c.id),
      ...debts.map((d) => d.id),
      ...savingsGoals.map((g) => g.id),
      ...savingsEntries.map((e) => e.id),
      ...moneyGoals.map((g) => g.id),
      ...billTemplates.map((b) => b.id),
      ...billPayments.map((p) => p.id),
      ...goals.map((g) => g.id),
      ...habits.map((h) => h.id),
      ...habitCheckIns.map((c) => c.id),
      ...diaryEntries.map((entry) => entry.id),
      ...focusSessions.map((session) => session.id),
      ...maintenanceItems.map((item) => item.id),
    ]);
    if (isNativeAndroid()) {
      void cancelAllTaskReminders();
      void cancelAllExtraReminders();
    }
    const freshTasks = getInitialTasks();
    setTasks(freshTasks);
    setCategories(INITIAL_CATEGORIES);
    // The sample data is (re)created here, so clear any tombstones it inherits.
    unmarkDeleted(storageKeys, [
      ...freshTasks.map((t) => t.id),
      ...INITIAL_CATEGORIES.map((c) => c.id),
    ]);
    setTransactions([]);
    setAccounts([]);
    setLedgerSettings([]);
    setBudgets([]);
    setCategoryBudgets([]);
    setFinanceCategories([]);
    setDebts([]);
    setSavingsGoals([]);
    setMoneyGoals([]);
    setBudgetAlertState({});
    setFinanceAlerts([]);
    setBillTemplates([]);
    setBillPayments([]);
    setSavingsEntries([]);
    setGoals([]);
    setHabits([]);
    setHabitCheckIns([]);
    setAlarms([]);
    setDiaryEntries([]);
    setFocusSessions([]);
    setMaintenanceItems([]);
    setRecentlyDeletedDiary(null);
    setIsSettingsOpen(false);
  };

  const applyImportedBackup = (parsed: ParsedBackup) => {
    const stamped = stampImportedBackup(parsed);
    const current: Record<BackupArrayKey, unknown> = {
      tasks,
      categories,
      transactions,
      accounts,
      ledgerSettings,
      budgets,
      categoryBudgets,
      financeCategories,
      debts,
      savingsGoals,
      savingsEntries,
      moneyGoals,
      goals,
      habits,
      habitCheckIns,
      alarms,
      focusSessions,
      maintenanceItems,
      diaryEntries,
      billTemplates,
      billPayments,
    };

    // Tombstone only records removed from collections this file actually replaces.
    const removed: string[] = [];
    const imported: string[] = [];
    for (const key of stamped.present) {
      if (key === 'settings') continue;
      const nextIds = new Set(recordIds(stamped.data[key]));
      for (const id of recordIds(current[key])) {
        if (!nextIds.has(id)) removed.push(id);
      }
      for (const id of nextIds) imported.push(id);
    }
    markDeleted(storageKeys, removed);
    unmarkDeleted(storageKeys, Array.from(new Set(imported)));

    const { data, present } = stamped;
    if (present.includes('tasks')) setTasks(data.tasks ?? []);
    if (present.includes('categories')) setCategories(data.categories ?? []);
    if (present.includes('transactions')) setTransactions(data.transactions ?? []);
    if (present.includes('accounts')) setAccounts(data.accounts ?? []);
    if (present.includes('ledgerSettings')) setLedgerSettings(data.ledgerSettings ?? []);
    if (present.includes('budgets')) setBudgets(data.budgets ?? []);
    if (present.includes('categoryBudgets')) setCategoryBudgets(data.categoryBudgets ?? []);
    if (present.includes('financeCategories')) setFinanceCategories(data.financeCategories ?? []);
    if (present.includes('debts')) setDebts(data.debts ?? []);
    if (present.includes('savingsGoals')) setSavingsGoals(data.savingsGoals ?? []);
    if (present.includes('savingsEntries')) setSavingsEntries(data.savingsEntries ?? []);
    if (present.includes('moneyGoals')) setMoneyGoals(data.moneyGoals ?? []);
    if (present.includes('goals')) setGoals(data.goals ?? []);
    if (present.includes('habits')) setHabits(data.habits ?? []);
    if (present.includes('habitCheckIns')) setHabitCheckIns(data.habitCheckIns ?? []);
    if (present.includes('alarms')) setAlarms(data.alarms ?? []);
    if (present.includes('focusSessions')) setFocusSessions(data.focusSessions ?? []);
    if (present.includes('maintenanceItems')) setMaintenanceItems(data.maintenanceItems ?? []);
    if (present.includes('diaryEntries')) {
      setDiaryEntries(data.diaryEntries ?? []);
      setRecentlyDeletedDiary(null);
    }
    if (present.includes('billTemplates')) setBillTemplates(data.billTemplates ?? []);
    if (present.includes('billPayments')) setBillPayments(data.billPayments ?? []);
    if (present.includes('settings') && data.settings) setSettings(data.settings);
    if (stamped.theme) setTheme(stamped.theme);
    if (stamped.budgetAlertState) setBudgetAlertState(stamped.budgetAlertState);
  };
  // The import confirm is async; apply with the latest render's state, not the one that opened it.
  const applyImportedBackupRef = useRef(applyImportedBackup);
  applyImportedBackupRef.current = applyImportedBackup;

  const handleChooseBackupFolder = () => {
    void chooseBackupFolder()
      .then((folder) => {
        setBackupFolderName(folder.name);
        setBackupFolderSupported(true);
        setBackupFolderError('');
      })
      .catch((error) => {
        if (isBackupCancel(error)) return;
        setBackupFolderError('Could not use that folder.');
      });
  };

  const handleStopBackupFolder = () => {
    void clearBackupFolder().then(() => {
      setBackupFolderName(null);
      setBackupLastSavedAt(null);
      setBackupFolderError('');
    });
  };

  const handleExportData = () => {
    const backup = buildBackup({
      tasks,
      categories,
      transactions,
      accounts,
      ledgerSettings,
      budgets,
      categoryBudgets,
      financeCategories,
      debts,
      savingsGoals,
      savingsEntries,
      moneyGoals,
      goals,
      habits,
      habitCheckIns,
      alarms,
      focusSessions,
      maintenanceItems,
      diaryEntries,
      billTemplates,
      billPayments,
      settings,
      theme,
      budgetAlertState,
    });
    const contents = JSON.stringify(backup, null, 2);
    const filename = backupFilename();
    const save = isNativeAndroid()
      ? DayflowAlarm.shareBackup({ filename, contents })
      : saveBackupFile(contents, filename);
    void save.catch((err) => {
      if (isShareCancel(err)) return;
      console.warn('Backup export failed:', err);
      void showAlert({
        title: 'Could not save the backup',
        message: 'Try again, or choose a different place to save it.',
        tone: 'warning',
      });
    });
  };

  const handleImportData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      let parsed: ParsedBackup;
      try {
        const text = String(reader.result ?? '').replace(/^\uFEFF/, '');
        parsed = parseBackup(JSON.parse(text));
      } catch (err) {
        void showAlert({
          title: 'Can\u2019t import this file',
          message: err instanceof BackupError ? err.message : 'This file is not a Dayflow backup.',
          tone: 'warning',
        });
        return;
      }
      const confirmed = await showConfirm({
        title: 'Replace this device\u2019s data?',
        message: 'Tasks, diary, habits, goals, money and alarms in the backup will overwrite what is on this device.',
        tone: 'warning',
        confirmLabel: 'Replace data',
      });
      if (!confirmed) return;
      try {
        applyImportedBackupRef.current(parsed);
        void showAlert({ title: 'Backup imported', message: 'This device now has the data from the backup.', tone: 'success' });
      } catch (err) {
        void showAlert({
          title: 'Import failed',
          message: err instanceof BackupError ? err.message : 'The backup could not be applied.',
          tone: 'warning',
        });
      }
    };
    reader.onerror = () => {
      void showAlert({ title: 'Could not read that file', message: 'Choose the file again and retry.', tone: 'warning' });
    };
    reader.readAsText(file);
  };

  // Maintenance. The lib stamps updatedAt on every change and throws user-facing errors,
  // which MaintenanceView shows. A deleted item leaves a tombstone so sync does not revive it.
  const changeMaintenanceItem = (id: string, change: (item: MaintenanceItem) => MaintenanceItem) => {
    const item = maintenanceItems.find((candidate) => candidate.id === id);
    if (!item) throw new Error('This maintenance item no longer exists.');
    const next = change(item);
    setMaintenanceItems((prev) => prev.map((candidate) => (candidate.id === id ? next : candidate)));
  };
  const maintenanceLinkContext = { items: maintenanceItems, transactions };
  const handleCreateMaintenance = (draft: ItemDraft) => {
    const item = newMaintenanceItem(draft, new Date().toISOString());
    setMaintenanceItems((prev) => [...prev, item]);
  };
  const handleUpdateMaintenance = (id: string, draft: ItemDraft) =>
    changeMaintenanceItem(id, (item) => updateMaintenanceItem(item, draft, new Date().toISOString()));
  const handleDeleteMaintenance = (id: string) => {
    markDeleted(storageKeys, [id]);
    setMaintenanceItems((prev) => prev.filter((item) => item.id !== id));
  };
  const handleRecordService = (id: string, service: ServiceDraft) =>
    changeMaintenanceItem(id, (item) => recordService(item, service, new Date().toISOString(), maintenanceLinkContext));
  const handleUpdateService = (id: string, recordId: string, service: ServiceDraft) =>
    changeMaintenanceItem(id, (item) =>
      updateServiceRecord(
        item,
        recordId,
        { date: service.date, notes: service.notes, cost: service.cost ?? null, transactionId: service.transactionId ?? null },
        new Date().toISOString(),
        maintenanceLinkContext,
      ),
    );
  const handleDeleteService = (id: string, recordId: string) =>
    changeMaintenanceItem(id, (item) => deleteServiceRecord(item, recordId, new Date().toISOString()));
  /** Merges an export file (newer edits win). Items new to this device are re-stamped so sync keeps them. */
  const handleImportMaintenance = (incoming: MaintenanceItem[]): number => {
    const now = new Date().toISOString();
    const known = new Map<string, MaintenanceItem>(maintenanceItems.map((item) => [item.id, item]));
    const merged = mergeMaintenanceItems(maintenanceItems, incoming).map((item) =>
      known.has(item.id) ? item : { ...item, updatedAt: now },
    );
    const changed = merged.filter((item) => known.get(item.id)?.updatedAt !== item.updatedAt).length;
    unmarkDeleted(storageKeys, merged.filter((item) => !known.has(item.id)).map((item) => item.id));
    setMaintenanceItems(merged);
    return changed;
  };

  // Goals and habits
  const handleSaveGoal = (partial: Partial<Goal>) => {
    const now = new Date().toISOString();
    if (partial.id) {
      setGoals((prev) =>
        prev.map((goal) =>
          goal.id === partial.id
            ? {
                ...goal,
                title: partial.title?.trim() || goal.title,
                note: partial.note?.trim() || undefined,
                startDate: partial.startDate || goal.startDate,
                targetDate: partial.targetDate || goal.targetDate,
                status: partial.status || goal.status,
                updatedAt: now,
              }
            : goal
        )
      );
      return;
    }

    const created: Goal = {
      id: newLedgerId('goal'),
      title: partial.title?.trim() || 'New goal',
      note: partial.note?.trim() || undefined,
      startDate: partial.startDate || todayStr,
      targetDate: partial.targetDate || todayStr,
      status: partial.status || 'active',
      createdAt: now,
      updatedAt: now,
    };
    setGoals((prev) => [created, ...prev]);
  };

  const handleDeleteGoal = (id: string) => {
    markDeleted(storageKeys, [id]);
    const now = new Date().toISOString();
    setGoals((prev) => prev.filter((goal) => goal.id !== id));
    setHabits((prev) =>
      prev.map((habit) =>
        habit.goalId === id ? { ...habit, goalId: undefined, updatedAt: now } : habit
      )
    );
  };

  const handleSaveHabit = (partial: Partial<Habit>) => {
    const now = new Date().toISOString();
    const reminder = partial.reminder?.enabled
      ? {
          enabled: true as const,
          time: partial.reminder.time || '08:00',
          sound: partial.reminder.sound,
          songId: partial.reminder.sound === 'music' ? partial.reminder.songId : undefined,
          alarm: partial.reminder.alarm || undefined,
          lastNotifiedAt: partial.reminder.lastNotifiedAt,
          snoozedUntil: partial.reminder.snoozedUntil,
        }
      : undefined;
    const targetCount = partial.targetCount && partial.targetCount > 1 ? partial.targetCount : undefined;
    if (partial.id) {
      setHabits((prev) =>
        prev.map((habit) =>
          habit.id === partial.id
            ? {
                ...habit,
                title: partial.title?.trim() || habit.title,
                goalId: partial.goalId || undefined,
                schedule: partial.schedule || habit.schedule,
                archived: partial.archived ?? habit.archived,
                color: partial.color === undefined ? habit.color : partial.color,
                icon: partial.icon === undefined ? habit.icon : partial.icon,
                targetCount,
                unit: targetCount ? partial.unit?.trim() || undefined : undefined,
                reminder: reminder
                  ? {
                      ...reminder,
                      lastNotifiedAt: habit.reminder?.lastNotifiedAt,
                      snoozedUntil: habit.reminder?.snoozedUntil,
                    }
                  : undefined,
                updatedAt: now,
              }
            : habit
        )
      );
      return;
    }

    const created: Habit = {
      id: newLedgerId('habit'),
      title: partial.title?.trim() || 'New habit',
      goalId: partial.goalId || undefined,
      schedule: partial.schedule || { type: 'daily' },
      archived: partial.archived ?? false,
      color: partial.color,
      icon: partial.icon,
      targetCount,
      unit: targetCount ? partial.unit?.trim() || undefined : undefined,
      reminder,
      createdAt: now,
      updatedAt: now,
    };
    setHabits((prev) => [created, ...prev]);
  };

  const handleDeleteHabit = (id: string) => {
    const removedChecks = habitCheckIns.filter((entry) => entry.habitId === id).map((entry) => entry.id);
    markDeleted(storageKeys, [id, ...removedChecks]);
    setHabits((prev) => prev.filter((habit) => habit.id !== id));
    setHabitCheckIns((prev) => prev.filter((entry) => entry.habitId !== id));
  };

  const openDiaryComposer = (date: string, entry: DiaryEntry | null = null) => {
    setEditingDiaryEntry(entry);
    setDiaryDraftDate(entry?.date || date);
    setIsDiaryModalOpen(true);
  };

  /**
   * Energy and reflection are set by the evening review. Sending the key
   * decides: a value sets it, undefined clears it. An ordinary diary edit does
   * not send them, so it keeps whatever was there.
   */
  const withReviewFields = (entry: DiaryEntry, partial: Partial<DiaryEntry>): DiaryEntry => {
    const next: DiaryEntry = { ...entry };
    if ('energy' in partial) {
      if (partial.energy === undefined) delete next.energy;
      else next.energy = partial.energy;
    }
    if ('reflection' in partial) {
      if (partial.reflection === undefined) delete next.reflection;
      else next.reflection = partial.reflection;
    }
    return next;
  };

  const handleSaveDiaryEntry = (partial: Partial<DiaryEntry>): boolean => {
    const mood = partial.mood && isDiaryMood(partial.mood) ? partial.mood : 'okay';
    const images = sanitizeDiaryImages(partial.images);
    const draft = {
      date: partial.date || selectedDate,
      time: partial.time || currentTimeString(),
      mood,
      body: partial.body || '',
      imageCount: images.length,
    };
    const error = validateDiaryDraft(draft);
    if (error) {
      void showAlert({ title: 'Can’t save this note', message: error, tone: 'warning' });
      return false;
    }
    const now = new Date().toISOString();
    const savedMood = draft.mood as DiaryMood;
    const savedImages = images.length > 0 ? images : undefined;
    const next = partial.id
      ? diaryEntries.map((entry) =>
          entry.id === partial.id
            ? withReviewFields({
                ...entry,
                date: draft.date,
                time: draft.time,
                mood: savedMood,
                body: draft.body.trim(),
                images: savedImages,
                updatedAt: now,
              }, partial)
            : entry
        )
      : [
          withReviewFields({
            id: newLedgerId('diary'),
            date: draft.date,
            time: draft.time,
            mood: savedMood,
            body: draft.body.trim(),
            images: savedImages,
            createdAt: now,
            updatedAt: now,
          } as DiaryEntry, partial),
          ...diaryEntries,
        ];
    if (!diaryCollectionFits(next)) {
      void showAlert({
        title: 'Not enough space for these photos',
        message: 'They use more space than this device can keep. Remove a photo and try again.',
        tone: 'warning',
      });
      return false;
    }
    setDiaryEntries(next);
    return true;
  };

  /** The evening review: one structured diary entry per day, updated if saved again. */
  const handleSaveReflection = (input: {
    date: string;
    mood: DiaryMood;
    energy?: number;
    reflection: DiaryReflection;
  }): boolean => {
    const existing = reflectionFor(diaryEntries, input.date);
    const reflection = cleanReflection(input.reflection);
    return handleSaveDiaryEntry({
      id: existing?.id,
      date: input.date,
      time: existing?.time ?? currentTimeString(),
      mood: input.mood,
      body: composeReflectionBody(reflection),
      images: existing?.images,
      energy: input.energy,
      reflection,
    });
  };

  const handleDeleteDiaryEntry = (id: string) => {
    markDeleted(storageKeys, [id]);
    setDiaryEntries((prev) => {
      const index = prev.findIndex((entry) => entry.id === id);
      if (index === -1) return prev;
      setRecentlyDeletedDiary({ entry: prev[index], index });
      setRecentlyAddedTransactions(null);
      setRecentlyDeleted(null);
      setRecentlyDeletedTransaction(null);
      return prev.filter((entry) => entry.id !== id);
    });
  };

  const handleUndoDeleteDiary = () => {
    if (!recentlyDeletedDiary) return;
    unmarkDeleted(storageKeys, [recentlyDeletedDiary.entry.id]);
    setDiaryEntries((prev) => {
      const copy = [...prev];
      copy.splice(recentlyDeletedDiary.index, 0, recentlyDeletedDiary.entry);
      return copy;
    });
    setRecentlyDeletedDiary(null);
  };

  const handleSetCheckIn = (habitId: string, date: string, patch: HabitCheckInPatch | null) => {
    const today = todayDateString();
    // Future days take only a planned rest day.
    if (!canSetCheckIn(date, today, patch)) return;
    const habit = habits.find((item) => item.id === habitId);
    if (!habit || habitBlockReason(habit, goals) || !isScheduledOn(habit, date)) return;

    const now = new Date().toISOString();
    const id = `checkin-${habitId}-${date}`;
    setHabitCheckIns((prev) => {
      const existing = prev.filter((entry) => entry.habitId === habitId && entry.date === date);
      if (patch === null) {
        if (existing.length === 0) return prev;
        markDeleted(
          storageKeys,
          existing.map((entry) => entry.id)
        );
        const ids = new Set(existing.map((entry) => entry.id));
        return prev.filter((entry) => !ids.has(entry.id));
      }
      const prior = existing.find((entry) => entry.id === id) ?? existing[0];
      const extras = existing.filter((entry) => entry.id !== id).map((entry) => entry.id);
      if (extras.length > 0) markDeleted(storageKeys, extras);
      unmarkDeleted(storageKeys, [id]);
      const next: HabitCheckIn = {
        id,
        userId: prior?.userId,
        habitId,
        date,
        skipped: patch.skipped || undefined,
        note: patch.note?.trim() || undefined,
        value: patch.skipped ? undefined : patch.value,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
      return [...prev.filter((entry) => entry.habitId !== habitId || entry.date !== date), next];
    });
  };

  const handleLinkHabit = (habitId: string, goalId?: string) => {
    const now = new Date().toISOString();
    setHabits((prev) =>
      prev.map((habit) =>
        habit.id === habitId ? { ...habit, goalId: goalId || undefined, updatedAt: now } : habit
      )
    );
  };

  // Finance handlers
  const handleSaveTransaction = (
    partial: Partial<FinanceTransaction>,
    options?: { allowOverdraft?: boolean }
  ) => {
    const now = new Date();
    const nowIso = now.toISOString();
    if (partial.id) {
      const original = transactions.find((t) => t.id === partial.id);
      if (!original) return;
      const updated: FinanceTransaction = {
        ...original,
        type: partial.type ?? original.type,
        amount: partial.amount ?? original.amount,
        category: partial.category ?? original.category,
        note: partial.note,
        date: partial.date ?? original.date,
        time: partial.time ?? original.time,
        paymentMethod: partial.paymentMethod ?? original.paymentMethod,
        accountId: partial.accountId,
        recurrence: partial.recurrence ?? original.recurrence,
        updatedAt: nowIso,
      };
      setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      // A bill payment or debt linked to this entry takes its new amount and date.
      setBillPayments((prev) => {
        const linked = syncEditedTransaction(updated, prev, [], nowIso);
        return linked.changed ? linked.billPayments : prev;
      });
      setDebts((prev) => {
        const linked = syncEditedTransaction(updated, [], prev, nowIso);
        return linked.changed ? linked.debts : prev;
      });
      return;
    }

    const recurrence = partial.recurrence || { type: 'none' as const };
    const draft: EntryDraft = {
      type: partial.type === 'income' ? 'income' : 'expense',
      amount: partial.amount || 0,
      accountId: partial.accountId,
      category: partial.category || 'Other',
      note: partial.note,
      paymentMethod: partial.paymentMethod || DEFAULT_PAYMENT_METHOD,
      date: partial.date || selectedDate,
      time: partial.time,
      recurrence,
      recurrenceGroupId:
        recurrence.type !== 'none'
          ? `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          : undefined,
    };

    const validation = validateEntry(draft, {
      accounts,
      transactions,
      settings: ledgerSettings[0] || { allowNegativeBalance: false },
    });
    if (isLedgerError(validation)) {
      const alreadyLeftTheBank =
        options?.allowOverdraft && validation.code === 'insufficient-balance';
      if (!alreadyLeftTheBank) {
        void showAlert(ledgerErrorDialog(validation));
        return false;
      }
    }

    const newTx = buildIncomeOrExpense(draft, { now });
    setTransactions((prev) => [newTx, ...prev]);
    void offerBillMatch(newTx);
    return true;
  };

  /**
   * A new expense that looks like an unpaid bill (name in the note, or same
   * category and a close amount near the due date): ask, then link them so the
   * bill is paid and not counted twice.
   */
  const offerBillMatch = async (tx: FinanceTransaction) => {
    const match = matchBillForExpense(tx, billTemplates, billPayments);
    if (!match) return;
    const { payment, template } = match;
    const due = new Date(`${payment.dueDate}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const ok = await showConfirm({
      title: `Is this your ${template.name} bill?`,
      message: `Marks ${template.name} (${formatRupees(payment.amount)}, due ${due}) as paid with this ${formatRupees(tx.amount)} entry.`,
      confirmLabel: 'Yes, mark paid',
      cancelLabel: 'No',
    });
    if (!ok) return;
    const stamp = new Date().toISOString();
    setBillPayments((prev) =>
      prev.map((p) => (p.id === payment.id && !p.paid ? linkBillPayment(p, tx, stamp).payment : p))
    );
    setTransactions((prev) =>
      prev.map((t) =>
        t.id === tx.id
          ? {
              ...t,
              billPaymentId: payment.id,
              ...(template.debtId ? { debtId: template.debtId, debtRole: 'emi' as const } : {}),
              updatedAt: stamp,
            }
          : t
      )
    );
  };

  const handleDeleteTransaction = async (id: string) => {
    const tx = transactions.find((t) => t.id === id);
    if (!tx) return;
    const isTransfer = tx.type === 'transfer';
    const hasLinkedFee = transactions.some((t) => t.linkedTransferId === id);
    const isRecurring = tx.recurrence?.type && tx.recurrence.type !== 'none';
    const question = isTransfer
      ? hasLinkedFee
        ? { title: 'Delete this transfer?', message: 'Its linked ATM fee is deleted too.' }
        : { title: 'Delete this transfer?', message: 'Both account balances update.' }
      : isRecurring
        ? { title: 'Delete this entry only?', message: 'The series keeps creating future entries.' }
        : { title: 'Delete this transaction?' };
    const linkNote = tx.billPaymentId
      ? 'The bill it paid is marked unpaid again.'
      : tx.debtRole === 'repaid' || tx.debtRole === 'received'
        ? 'The payment is taken off its debt too.'
        : tx.debtRole === 'borrowed' || tx.debtRole === 'lent'
          ? 'The debt stays, without this ledger entry.'
          : '';
    if (linkNote) {
      const base = 'message' in question && question.message ? `${question.message} ` : '';
      Object.assign(question, { message: `${base}${linkNote}` });
    }
    // A plain entry is deleted at once with an Undo toast; ask only when more than it changes.
    const needsConfirm = hasLinkedFee || isRecurring || Boolean(linkNote);
    if (needsConfirm && !(await showConfirm({ ...question, tone: 'danger', confirmLabel: 'Delete' }))) return;

    // Recompute from the latest list: a sync may have changed it while the dialog was open.
    const latest = transactionsRef.current;
    if (!latest.some((t) => t.id === id)) return;
    const removedIds = idsRemovedByCascade(latest, id);
    const removed = latest.filter((t) => removedIds.includes(t.id));
    markDeleted(storageKeys, removedIds);
    setTransactions((prev) => removeTransactionCascade(prev, id));
    // A bill it paid becomes unpaid again; a debt payment it made is removed.
    const stamp = new Date().toISOString();
    setBillPayments((prev) => {
      const linked = unlinkDeletedTransactions(removedIds, prev, [], stamp);
      return linked.changed ? linked.billPayments : prev;
    });
    setDebts((prev) => {
      const linked = unlinkDeletedTransactions(removedIds, [], prev, stamp);
      return linked.changed ? linked.debts : prev;
    });
    setRecentlyDeletedTransaction({ txs: removed });
    // Clear any pending undo toast to keep a single toast slot.
    setRecentlyDeleted(null);
    setRecentlyDeletedDiary(null);
    setRecentlyAddedTransactions(null);
  };

  /** Removes entries a one-tap add just saved (no confirm): tombstones, cascades and unlinks. */
  const handleUndoAddTransactions = () => {
    const added = recentlyAddedTransactions;
    setRecentlyAddedTransactions(null);
    if (!added) return;
    const latest = transactionsRef.current;
    const removedIds = [...new Set<string>(added.ids.flatMap((id) => (latest.some((t) => t.id === id) ? idsRemovedByCascade(latest, id) : [])))];
    if (!removedIds.length) return;
    markDeleted(storageKeys, removedIds);
    setTransactions((prev) => prev.filter((t) => !removedIds.includes(t.id)));
    const stamp = new Date().toISOString();
    setBillPayments((prev) => {
      const linked = unlinkDeletedTransactions(removedIds, prev, [], stamp);
      return linked.changed ? linked.billPayments : prev;
    });
    setDebts((prev) => {
      const linked = unlinkDeletedTransactions(removedIds, [], prev, stamp);
      return linked.changed ? linked.debts : prev;
    });
  };

  /** Shows the "Added … · Undo" toast in the single toast slot. */
  const announceAdded = (ids: string[], message: string) => {
    setRecentlyDeleted(null);
    setRecentlyDeletedDiary(null);
    setRecentlyDeletedTransaction(null);
    setRecentlyAddedTransactions({ ids, message });
  };

  const handleUndoDeleteTransaction = () => {
    if (!recentlyDeletedTransaction) return;
    unmarkDeleted(
      storageKeys,
      recentlyDeletedTransaction.txs.map((t) => t.id)
    );
    // Restamp: the delete may already have synced, and the newer save must win the merge.
    const stamp = new Date().toISOString();
    const restored = recentlyDeletedTransaction.txs.map((t) => ({ ...t, updatedAt: stamp }));
    setTransactions((prev) => upsertTransactions(prev, restored));
    setBillPayments((prev) => {
      const linked = relinkRestoredTransactions(restored, prev, [], stamp);
      return linked.changed ? linked.billPayments : prev;
    });
    setDebts((prev) => {
      const linked = relinkRestoredTransactions(restored, [], prev, stamp);
      return linked.changed ? linked.debts : prev;
    });
    setRecentlyDeletedTransaction(null);
  };

  /** Budgets carry over (lib/budgetCarry.ts): 0 removes; a past month's edit pins the next month. */
  const handleSetBudget = (month: string, limit: number) => {
    const now = new Date().toISOString();
    setBudgets((prev) => setMonthlyBudget(prev, month, limit, currentMonthKey(), now));
  };

  const handleAddFinanceCategory = (kind: 'income' | 'expense', raw: string): string | null => {
    const error = financeCategoryError(raw, kind, financeCategories);
    if (error) return error;
    const name = normalizeCategoryName(raw);
    const now = new Date().toISOString();
    setFinanceCategories((prev) => {
      if (financeCategoryError(name, kind, prev)) return prev;
      return [
        ...prev,
        { id: newLedgerId('fincat'), name, kind, createdAt: now, updatedAt: now },
      ];
    });
    return null;
  };

  const handleDeleteFinanceCategory = (kind: 'income' | 'expense', raw: string) => {
    const name = normalizeCategoryName(raw);
    if (!isCustomFinanceCategory(name, kind, financeCategories)) return;
    const removed = financeCategories.filter(
      (item) => item.kind === kind && sameCategoryName(item.name, name)
    );
    markDeleted(
      storageKeys,
      removed.map((item) => item.id)
    );
    const now = new Date().toISOString();
    setFinanceCategories((prev) => prev.filter((item) => !removed.some((itemRemoved) => itemRemoved.id === item.id)));
    setTransactions((prev) =>
      prev.map((tx) =>
        tx.type === kind && sameCategoryName(tx.category, name)
          ? { ...tx, category: 'Other', updatedAt: now }
          : tx
      )
    );
    if (kind === 'expense') {
      setBillTemplates((prev) =>
        prev.map((bill) =>
          sameCategoryName(bill.category, name) ? { ...bill, category: 'Other', updatedAt: now } : bill
        )
      );
      setCategoryBudgets((prev) => {
        const reassigned = reassignDeletedCategoryBudgets(prev, name, now);
        if (reassigned.droppedIds.length > 0) markDeleted(storageKeys, reassigned.droppedIds);
        return reassigned.budgets;
      });
    }
  };

  const handleSetCategoryBudget = (month: string, category: string, limit: number) => {
    const now = new Date().toISOString();
    setCategoryBudgets((prev) => setCategoryBudget(prev, month, category, limit, currentMonthKey(), now));
  };

  /** Budgets carry over, so removing one stores "no budget" (0) from this month on. */
  const handleRemoveCategoryBudget = (month: string, category: string) => {
    handleSetCategoryBudget(month, category, 0);
  };

  const handleQuickAddTransaction = (amount: number, category: string) => {
    const accountId = resolveDefaultAccountId(accounts, ledgerSettings[0]);
    if (!accountId) {
      setIsAccountModalOpen(true);
      return;
    }
    const account = accounts.find((a) => a.id === accountId);
    const draft: EntryDraft = {
      type: 'expense',
      amount,
      accountId,
      category,
      paymentMethod: account?.type === 'cash' ? 'cash' : 'bank_transfer',
      date: selectedDate,
      time: nowTimeString(),
    };
    const validation = validateEntry(draft, {
      accounts,
      transactions,
      settings: ledgerSettings[0] || { allowNegativeBalance: false },
    });
    if (isLedgerError(validation)) {
      void showAlert(ledgerErrorDialog(validation));
      return;
    }
    const tx = buildIncomeOrExpense(draft);
    setTransactions((prev) => [tx, ...prev]);
    announceAdded([tx.id], `Added ${formatRupees(amount)} ${category}`);
  };

  const openFinanceModal = (
    tx?: FinanceTransaction | null,
    defaults?: { type?: 'income' | 'expense'; accountId?: string }
  ) => {
    setEditingTransaction(tx || null);
    setFinanceDraftDefaults(defaults || null);
    setIsFinanceModalOpen(true);
  };

  // ===== Ledger handlers =====
  const openAccountModal = (account?: Account | null) => {
    setEditingAccount(account || null);
    setIsAccountModalOpen(true);
  };

  /** Picks a bank as kept for future savings (off the Money ledger), or puts it back. */
  const handleSetSavingsOnly = (accountId: string, savingsOnly: boolean) => {
    const now = new Date().toISOString();
    setAccounts((prev) =>
      prev.map((a) => (a.id === accountId && Boolean(a.savingsOnly) !== savingsOnly ? { ...a, savingsOnly, updatedAt: now } : a))
    );
  };

  const handleSaveAccount = async (partial: Partial<Account>): Promise<boolean> => {
    const now = new Date().toISOString();
    const name = (partial.name || '').trim();
    if (!name) return false;

    if (partial.id) {
      const existing = accounts.find((a) => a.id === partial.id);
      if (!existing) return false;
      if (!existing.isArchived && partial.isArchived) {
        const confirmed = await showConfirm({
          title: `Archive “${existing.name}”?`,
          message: 'It stops appearing in totals and pickers. All of its transactions are kept.',
          tone: 'warning',
          confirmLabel: 'Archive',
        });
        // Refusing the confirmation must not silently drop the other edits.
        if (!confirmed) return false;
      }
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === partial.id
            ? {
                ...a,
                name,
                type: partial.type ?? a.type,
                bankName: partial.bankName,
                accountNickname: partial.accountNickname,
                lastFourDigits: partial.lastFourDigits,
                openingBalance: partial.openingBalance ?? a.openingBalance,
                isArchived: partial.isArchived ?? a.isArchived,
                creditLimit: partial.creditLimit,
                statementDay: partial.statementDay,
                dueDay: partial.dueDay,
                updatedAt: now,
              }
            : a
        )
      );
      return true;
    }

    const newAccount: Account = {
      id: newLedgerId('acct'),
      name,
      type: partial.type || 'savings',
      bankName: partial.bankName,
      accountNickname: partial.accountNickname,
      lastFourDigits: partial.lastFourDigits,
      openingBalance: partial.openingBalance ?? 0,
      isArchived: false,
      creditLimit: partial.creditLimit,
      statementDay: partial.statementDay,
      dueDay: partial.dueDay,
      createdAt: now,
      updatedAt: now,
    };
    setAccounts((prev) => [...prev, newAccount]);
    return true;
  };

  const openTransferModal = (tx?: FinanceTransaction | null) => {
    setEditingTransfer(tx || null);
    setIsTransferModalOpen(true);
  };

  const handleSaveTransfer = (draft: TransferDraft, onSaved?: (records: FinanceTransaction[]) => void) => {
    const validation = validateTransfer(draft, {
      accounts,
      transactions,
      settings: ledgerSettings[0] || { allowNegativeBalance: false },
    });
    if (isLedgerError(validation)) {
      void showAlert(ledgerErrorDialog(validation));
      return false;
    }

    const transfer = buildTransfer(draft);
    const original = draft.id ? transactions.find((t) => t.id === draft.id) : undefined;
    if (original) {
      transfer.createdAt = original.createdAt;
      transfer.recurrence = original.recurrence;
    }

    const records: FinanceTransaction[] = [transfer];
    const hasExistingFee = transactions.some((t) => t.linkedTransferId === transfer.id);
    if (!original && draft.atmFee && draft.atmFee > 0) {
      records.push(
        buildAtmFee(transfer, draft.atmFee, {
          category: 'Bills & Utilities',
          paymentMethod: 'cash',
        })
      );
    }
    if (hasExistingFee) {
      // Keep the linked fee in sync with an edited transfer's account and date.
      for (const tx of transactions) {
        if (tx.linkedTransferId !== transfer.id) continue;
        if (tx.date === transfer.date && tx.accountId === transfer.accountId) continue;
        records.push({
          ...tx,
          date: transfer.date,
          accountId: transfer.accountId,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    setTransactions((prev) => upsertTransactions(prev, records));
    onSaved?.(records);

    const destination = accounts.find((account) => account.id === transfer.destinationAccountId);
    if (destination && savingsBucketTest(accounts)(destination)) {
      const stamp = new Date().toISOString();
      setLedgerSettings((prev) => {
        if (prev[0]?.defaultSavingsAccountId === destination.id) return prev;
        if (prev.length === 0) {
          return [
            {
              id: 'ledger',
              allowNegativeBalance: false,
              defaultSavingsAccountId: destination.id,
              updatedAt: stamp,
            },
          ];
        }
        return prev.map((settingsRecord, index) =>
          index === 0
            ? { ...settingsRecord, defaultSavingsAccountId: destination.id, updatedAt: stamp }
            : settingsRecord
        );
      });
    }
    return true;
  };

  const handleUpdateLedgerSettings = (partial: Partial<LedgerSettings>) => {
    const now = new Date().toISOString();
    setLedgerSettings((prev) => {
      if (prev.length === 0) {
        return [
          {
            id: 'ledger',
            allowNegativeBalance: false,
            ...partial,
            updatedAt: now,
          },
        ];
      }
      return prev.map((settingsRecord, index) =>
        index === 0 ? { ...settingsRecord, ...partial, updatedAt: now } : settingsRecord
      );
    });
  };

  const handleBulkAssignAccount = (txIds: string[], accountId: string) => {
    if (txIds.length === 0 || !accountId) return;
    setTransactions((prev) => assignAccountToTransactions(prev, txIds, accountId));
  };

  const handleQuickAdd = () => {
    // Home is about today: don't add to a date that was left picked on the Today tab.
    if (activeTab === 'home') setSelectedDate(todayStr);
    if (activeTab === 'diary') {
      openDiaryComposer(selectedDate);
    } else if (activeTab === 'today' || activeTab === 'finance') {
      openFinanceModal(null);
    } else {
      setEditingTask(null);
      setIsTaskModalOpen(true);
    }
  };

  // Debt handlers
  /** Ledger validation context for the current state. */
  const ledgerContext = () => ({
    accounts,
    transactions,
    settings: ledgerSettings[0] || { allowNegativeBalance: false },
  });

  /** A loan you owe gets (or updates) its monthly EMI bill; anything else has none. */
  const syncEmiBill = (debt: Debt | null, removedDebtId?: string) => {
    const id = emiBillId(debt?.id ?? removedDebtId ?? '');
    const existing = billTemplates.find((bill) => bill.id === id);
    const stamp = new Date().toISOString();
    if (!debt) {
      if (!existing) return;
      markDeleted(storageKeys, [id]);
      setBillTemplates((prev) => prev.filter((bill) => bill.id !== id));
      return;
    }
    const next = emiBillTemplate(debt, existing, stamp);
    if (!next) {
      if (existing?.active) {
        setBillTemplates((prev) => prev.map((bill) => (bill.id === id ? { ...bill, active: false, updatedAt: stamp } : bill)));
      }
      return;
    }
    if (!emiBillChanged(next, existing)) return;
    setBillTemplates((prev) => (prev.some((bill) => bill.id === id) ? prev.map((bill) => (bill.id === id ? next : bill)) : [...prev, next]));
  };

  /**
   * Saves a debt. With `ledger`, the money borrowed (in) or lent (out) is also
   * a ledger entry in that account; an already-linked entry follows the edit.
   * False (with an alert) when the account cannot cover it.
   */
  const handleSaveDebt = (
    partial: Partial<Debt>,
    ledger?: { accountId: string; paymentMethod?: PaymentMethod }
  ): boolean => {
    const now = new Date();
    const stamp = now.toISOString();
    const existing = partial.id ? debts.find((d) => d.id === partial.id) : undefined;
    let debt: Debt = existing
      ? {
          ...existing,
          direction: partial.direction ?? existing.direction,
          personName: partial.personName ?? existing.personName,
          amount: partial.amount ?? existing.amount,
          date: partial.date ?? existing.date,
          dueDate: partial.dueDate,
          note: partial.note,
          loan: partial.loan,
          updatedAt: stamp,
        }
      : {
          id: `debt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          direction: partial.direction || 'lent',
          personName: partial.personName || 'Unknown',
          amount: partial.amount || 0,
          date: partial.date || selectedDate,
          dueDate: partial.dueDate,
          note: partial.note,
          loan: partial.loan,
          paid: false,
          createdAt: stamp,
          updatedAt: stamp,
        };

    const linked = debt.transactionId ? transactions.find((t) => t.id === debt.transactionId) : undefined;
    let record: FinanceTransaction | null = null;
    if (linked || ledger) {
      const accountId = ledger?.accountId ?? linked?.accountId;
      if (!accountId) return false;
      const draft = debtOpeningDraft(debt, {
        accountId,
        paymentMethod: ledger?.paymentMethod ?? linked?.paymentMethod,
        time: linked?.time ?? nowTimeString(),
      });
      const validation = validateEntry({ ...draft, id: linked?.id }, ledgerContext());
      if (isLedgerError(validation)) {
        void showAlert(ledgerErrorDialog(validation));
        return false;
      }
      record = linked
        ? {
            ...linked,
            type: draft.type,
            amount: fromPaise(toPaise(draft.amount)),
            category: draft.category,
            note: draft.note,
            date: draft.date,
            accountId: draft.accountId,
            paymentMethod: draft.paymentMethod,
            debtId: debt.id,
            debtRole: draft.debtRole,
            updatedAt: stamp,
          }
        : { ...buildIncomeOrExpense(draft, { now }), debtId: debt.id, debtRole: draft.debtRole };
      debt = { ...debt, transactionId: record.id, accountId };
    }

    if (record) setTransactions((prev) => upsertTransactions(prev, [record as FinanceTransaction]));
    setDebts((prev) => (existing ? prev.map((d) => (d.id === debt.id ? debt : d)) : [debt, ...prev]));
    syncEmiBill(debt);
    return true;
  };

  /**
   * A part payment (or loan prepayment). With `ledger`, the money also moves:
   * out of the account when you repay, into it when you get money back.
   */
  const handleAddDebtPayment = (
    id: string,
    amount: number,
    date: string,
    ledger?: { accountId: string; paymentMethod?: PaymentMethod }
  ): boolean => {
    const debt = debts.find((d) => d.id === id);
    if (!debt || !(amount > 0)) return false;
    const now = new Date();
    const stamp = now.toISOString();
    const payment: DebtPayment = { id: `dpay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, date, amount };
    if (ledger) {
      const draft = debtPaymentDraft(debt, amount, date, { ...ledger, time: nowTimeString() });
      const validation = validateEntry(draft, ledgerContext());
      if (isLedgerError(validation)) {
        void showAlert(ledgerErrorDialog(validation));
        return false;
      }
      const tx = { ...buildIncomeOrExpense(draft, { now }), debtId: debt.id, debtRole: draft.debtRole };
      payment.transactionId = tx.id;
      setTransactions((prev) => [tx, ...prev]);
    }
    const next = addDebtPayment(debt, payment, stamp);
    setDebts((prev) => prev.map((d) => (d.id === id ? next : d)));
    if (next.paid !== debt.paid) syncEmiBill(next);
    return true;
  };

  /** One line from the quick-add bar or a repeated entry: the same rules as the full form. */
  const handleQuickEntry = (entry: {
    type: 'income' | 'expense';
    amount: number;
    category: string;
    note?: string;
    paymentMethod?: PaymentMethod;
    accountId?: string;
  }): boolean => {
    const accountId = entry.accountId && accounts.some((a) => a.id === entry.accountId && !a.isArchived && !a.savingsOnly)
      ? entry.accountId
      : resolveDefaultAccountId(accounts, ledgerSettings[0]);
    if (!accountId) {
      setIsAccountModalOpen(true);
      return false;
    }
    const account = accounts.find((a) => a.id === accountId);
    const draft: EntryDraft = {
      type: entry.type,
      amount: entry.amount,
      accountId,
      category: entry.category,
      note: entry.note,
      paymentMethod: entry.paymentMethod ?? (account?.type === 'cash' ? 'cash' : 'bank_transfer'),
      date: todayString(),
      time: nowTimeString(),
    };
    const validation = validateEntry(draft, {
      accounts,
      transactions,
      settings: ledgerSettings[0] || { allowNegativeBalance: false },
    });
    if (isLedgerError(validation)) {
      void showAlert(ledgerErrorDialog(validation));
      return false;
    }
    const tx = buildIncomeOrExpense(draft);
    setTransactions((prev) => [tx, ...prev]);
    const addedMessage = `${entry.type === 'income' ? 'Added income' : 'Added'} ${formatRupees(entry.amount)} ${entry.note?.trim() || entry.category}`;
    void offerBillMatch(tx).finally(() => announceAdded([tx.id], addedMessage));
    return true;
  };

  /** One payment split across categories: validated as one total, saved as one entry per part. */
  /**
   * A bill paid in full and split with friends: your share is spending, and
   * each friend's share is money lent to them (a lent debt with its ledger entry).
   */
  const handleSplitWithFriends = (split: {
    accountId: string;
    date: string;
    note?: string;
    category: string;
    paymentMethod?: PaymentMethod;
    mine: number;
    friends: { name: string; amount: number }[];
  }): boolean => {
    const friends = split.friends.filter((f) => f.name.trim() && f.amount > 0);
    const total = [{ amount: split.mine }, ...friends].reduce(addRupees, 0);
    const base: EntryDraft = {
      type: 'expense',
      amount: total,
      accountId: split.accountId,
      category: split.category,
      note: split.note,
      paymentMethod: split.paymentMethod,
      date: split.date,
      time: nowTimeString(),
    };
    // The whole bill leaves the account at once: check it as one amount.
    const validation = validateEntry(base, ledgerContext());
    if (isLedgerError(validation)) {
      void showAlert(ledgerErrorDialog(validation));
      return false;
    }
    const now = new Date();
    const stamp = now.toISOString();
    const records: FinanceTransaction[] = [];
    if (split.mine > 0) records.push(buildIncomeOrExpense({ ...base, amount: split.mine }, { now }));
    const newDebts: Debt[] = friends.map((friend) => {
      const debt: Debt = {
        id: newLedgerId('debt'),
        direction: 'lent',
        personName: friend.name.trim(),
        amount: fromPaise(toPaise(friend.amount)),
        date: split.date,
        note: split.note,
        paid: false,
        accountId: split.accountId,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const draft = debtOpeningDraft(debt, { accountId: split.accountId, paymentMethod: split.paymentMethod, time: base.time });
      const tx = { ...buildIncomeOrExpense(draft, { now }), debtId: debt.id, debtRole: draft.debtRole };
      records.push(tx);
      return { ...debt, transactionId: tx.id };
    });
    setTransactions((prev) => [...records, ...prev]);
    setDebts((prev) => [...newDebts, ...prev]);
    void showAlert({
      title: 'Split saved',
      message: `${formatRupees(split.mine)} is your spending. ${friends.length === 1 ? 'Your friend owes' : `${friends.length} friends owe`} you the rest: see Debts to remind them.`,
      tone: 'success',
    });
    return true;
  };

  /** Ticked bank statement rows become ledger entries on that account (Undo removes them all). */
  const handleImportStatement = (
    accountId: string,
    rows: { date: string; description: string; type: 'income' | 'expense'; amount: number; category: string }[]
  ) => {
    if (!accounts.some((a) => a.id === accountId) || rows.length === 0) return;
    const now = new Date();
    const records = rows.map((row) =>
      buildIncomeOrExpense(
        {
          type: row.type,
          amount: row.amount,
          accountId,
          category: row.category,
          note: row.description || undefined,
          paymentMethod: 'bank_transfer',
          date: row.date,
        },
        { now }
      )
    );
    setTransactions((prev) => [...records, ...prev]);
    announceAdded(records.map((r) => r.id), `Imported ${records.length} ${records.length === 1 ? 'entry' : 'entries'}`);
  };

  const handleSplitEntry = (split: {
    accountId: string;
    date: string;
    note?: string;
    paymentMethod?: PaymentMethod;
    lines: { category: string; amount: number }[];
  }): boolean => {
    const lines = split.lines.filter((line) => line.amount > 0);
    const total = lines.reduce(addRupees, 0);
    const base: EntryDraft = {
      type: 'expense',
      amount: total,
      accountId: split.accountId,
      category: lines[0]?.category ?? 'Other',
      note: split.note,
      paymentMethod: split.paymentMethod,
      date: split.date,
      time: nowTimeString(),
    };
    const validation = validateEntry(base, {
      accounts,
      transactions,
      settings: ledgerSettings[0] || { allowNegativeBalance: false },
    });
    if (isLedgerError(validation)) {
      void showAlert(ledgerErrorDialog(validation));
      return false;
    }
    const now = new Date();
    const records = lines.map((line) => buildIncomeOrExpense({ ...base, amount: line.amount, category: line.category }, { now }));
    setTransactions((prev) => [...records, ...prev]);
    return true;
  };

  const handleDeleteDebt = async (id: string) => {
    const debt = debts.find((d) => d.id === id);
    if (!debt) return;
    const confirmed = await showConfirm({
      title: `Delete the debt for ${debt.personName}?`,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    const linkedIds = debtTransactionIds(debt, transactionsRef.current);
    const removeEntries = linkedIds.length > 0 && (await showConfirm({
      title: `Also delete its ${linkedIds.length} ledger ${linkedIds.length === 1 ? 'entry' : 'entries'}?`,
      message: 'Balances go back as if the money never moved. Keep them if it really moved.',
      tone: 'danger',
      confirmLabel: 'Delete entries',
      cancelLabel: 'Keep entries',
    }));
    const stamp = new Date().toISOString();
    if (removeEntries) {
      const latest = transactionsRef.current;
      const removedIds = [...new Set(linkedIds.flatMap((txId) => idsRemovedByCascade(latest, txId)))];
      markDeleted(storageKeys, removedIds);
      setTransactions((prev) => prev.filter((t) => !removedIds.includes(t.id)));
    } else if (linkedIds.length > 0) {
      // Kept entries stay borrowed / repaid money (not income or spending), just without the debt.
      setTransactions((prev) => prev.map((t) => (linkedIds.includes(t.id) ? { ...t, debtId: undefined, updatedAt: stamp } : t)));
    }
    markDeleted(storageKeys, [id]);
    setDebts((prev) => prev.filter((d) => d.id !== id));
    syncEmiBill(null, id);
  };

  /**
   * Ticking "paid" asks which account the rest moved through (the debt's own
   * account listed first) and records it as a ledger entry; "Just mark paid"
   * records nothing. Unticking removes that entry again.
   */
  const handleToggleDebtPaid = async (id: string) => {
    const debt = debts.find((d) => d.id === id);
    if (!debt) return;
    const now = new Date();
    const stamp = now.toISOString();
    if (debt.paid) {
      const { debt: reopened, removedTransactionIds } = reopenDebt(debt, stamp);
      if (removedTransactionIds.length) {
        const latest = transactionsRef.current;
        const removedIds = [...new Set(removedTransactionIds.flatMap((txId) => idsRemovedByCascade(latest, txId)))];
        markDeleted(storageKeys, removedIds);
        setTransactions((prev) => prev.filter((t) => !removedIds.includes(t.id)));
      }
      setDebts((prev) => prev.map((d) => (d.id === id ? reopened : d)));
      syncEmiBill(reopened);
      return;
    }
    const today = todayString();
    const left = debtOutstanding(debt, today);
    const owed = debt.direction === 'owed';
    let account: Account | undefined;
    let next: Debt = { ...debt, paid: true, paidAt: stamp, updatedAt: stamp };
    const open = accounts.filter((a) => !a.isArchived && !a.savingsOnly);
    if (left > 0 && open.length) {
      // Ask which account the money moved through (the debt's own first), or just tick it.
      const linked = open.find((a) => a.id === debt.accountId);
      const ordered = linked ? [linked, ...open.filter((a) => a !== linked)] : open;
      const JUST_MARK = '__just-mark-paid';
      const picked = await showChoice({
        title: owed
          ? `Which account repaid ${formatRupees(left)} to ${debt.personName}?`
          : `Which account got ${formatRupees(left)} back from ${debt.personName}?`,
        message: 'It is added to the ledger. Pick "Just mark paid" if no account was used.',
        choices: [
          ...ordered.map((a) => ({ value: a.id, label: a.name })),
          { value: JUST_MARK, label: 'Just mark paid' },
        ],
      });
      if (picked === null) return;
      account = open.find((a) => a.id === picked);
    }
    if (left > 0 && account) {
      const draft = debtPaymentDraft(debt, left, today, { accountId: account.id, time: nowTimeString() });
      const validation = validateEntry(draft, ledgerContext());
      if (isLedgerError(validation)) {
        void showAlert(ledgerErrorDialog(validation));
        return;
      }
      const tx = { ...buildIncomeOrExpense(draft, { now }), debtId: debt.id, debtRole: draft.debtRole };
      setTransactions((prev) => [tx, ...prev]);
      next = {
        ...next,
        payments: [...(debt.payments ?? []), { id: newLedgerId('dpay'), date: today, amount: left, transactionId: tx.id, settles: true }],
      };
    }
    setDebts((prev) => prev.map((d) => (d.id === id ? next : d)));
    syncEmiBill(next);
  };

  const openDebtModal = (debt?: Debt | null) => {
    setEditingDebt(debt || null);
    setIsDebtModalOpen(true);
  };

  /** Adds or edits a named savings goal. */
  const handleSaveMoneyGoal = (partial: Partial<MoneyGoal>) => {
    const now = new Date().toISOString();
    const name = (partial.name ?? '').trim();
    if (!name || !(Number(partial.target) > 0)) return false;
    setMoneyGoals((prev) => {
      const existing = partial.id ? prev.find((g) => g.id === partial.id) : undefined;
      if (existing) {
        return prev.map((g) =>
          g.id === existing.id
            ? {
                ...g,
                name,
                target: Number(partial.target),
                targetDate: partial.targetDate || undefined,
                accountId: partial.accountId || undefined,
                savedAmount: partial.accountId ? undefined : partial.savedAmount,
                archived: partial.archived ?? g.archived,
                updatedAt: now,
              }
            : g
        );
      }
      return [
        ...prev,
        {
          id: newLedgerId('mgoal'),
          name,
          target: Number(partial.target),
          targetDate: partial.targetDate || undefined,
          accountId: partial.accountId || undefined,
          savedAmount: partial.accountId ? undefined : partial.savedAmount,
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    return true;
  };

  const handleDeleteMoneyGoal = (id: string) => {
    markDeleted(storageKeys, [id]);
    setMoneyGoals((prev) => prev.filter((g) => g.id !== id));
  };

  // Savings goal handler
  const handleSetSavingsGoal = (month: string, target: number) => {
    const now = new Date().toISOString();
    setSavingsGoals((prev) => {
      const existing = prev.find((g) => g.month === month);
      if (existing) {
        return prev.map((g) => (g.month === month ? { ...g, target, updatedAt: now } : g));
      }
      return [
        ...prev,
        {
          id: `goal-${month}`,
          month,
          target,
          updatedAt: now,
        },
      ];
    });
  };

  // Dismiss a finance alert
  const handleDismissAlert = (key: string) => {
    setFinanceAlerts((prev) => prev.filter((a) => a.key !== key));
  };

  // Bill handlers
  const handleSaveBillTemplate = (partial: Partial<BillTemplate>) => {
    const now = new Date().toISOString();
    if (partial.id) {
      setBillTemplates((prev) =>
        prev.map((t) =>
          t.id === partial.id
            ? {
                ...t,
                name: partial.name ?? t.name,
                amount: partial.amount ?? t.amount,
                category: partial.category ?? t.category,
                dueDayOfMonth: partial.dueDayOfMonth ?? t.dueDayOfMonth,
                paymentMethod: partial.paymentMethod ?? t.paymentMethod,
                accountId: partial.accountId,
                active: partial.active ?? t.active,
                note: partial.note,
                updatedAt: now,
              }
            : t
        )
      );
    } else {
      const newTemplate: BillTemplate = {
        id: `bill-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: partial.name || 'Untitled Bill',
        amount: partial.amount || 0,
        category: partial.category || 'Other',
        dueDayOfMonth: partial.dueDayOfMonth || 1,
        paymentMethod: partial.paymentMethod || DEFAULT_PAYMENT_METHOD,
        accountId: partial.accountId,
        active: partial.active ?? true,
        note: partial.note,
        createdAt: now,
        updatedAt: now,
      };
      setBillTemplates((prev) => [...prev, newTemplate]);
    }
  };

  const handleDeleteBillTemplate = async (id: string) => {
    const template = billTemplates.find((t) => t.id === id);
    if (!template) return;
    const confirmed = await showConfirm({
      title: `Delete the “${template.name}” bill?`,
      message: 'Unpaid bills from it are removed. Paid history is kept.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    // The latest payments, so the tombstones match exactly what the filter below removes.
    const unpaid = billPaymentsRef.current.filter((p) => p.billId === id && !p.paid).map((p) => p.id);
    markDeleted(storageKeys, [id, ...unpaid]);
    setBillTemplates((prev) => prev.filter((t) => t.id !== id));
    // Remove future unpaid payments for this template; keep paid ones for history.
    setBillPayments((prev) =>
      prev.filter(
        (p) => !(p.billId === id && !p.paid)
      )
    );
  };

  /**
   * Pays a bill: a ledger expense from the chosen account on the chosen day,
   * linked both ways. An EMI bill also counts on its loan (role `emi`).
   */
  const handlePayBill = (
    payment: BillPayment,
    details: { amount: number; accountId: string; date: string; paymentMethod?: PaymentMethod }
  ): boolean => {
    const template = billTemplates.find((t) => t.id === payment.billId);
    const account = accounts.find((a) => a.id === details.accountId);
    const draft: EntryDraft = {
      type: 'expense',
      amount: details.amount,
      accountId: details.accountId,
      category: template?.category || 'Other',
      note: `${template?.name || 'Bill'} payment`,
      paymentMethod:
        details.paymentMethod || template?.paymentMethod || (account?.type === 'cash' ? 'cash' : 'bank_transfer'),
      date: details.date,
      time: nowTimeString(),
    };
    const validation = validateEntry(draft, ledgerContext());
    if (isLedgerError(validation)) {
      void showAlert(ledgerErrorDialog(validation));
      return false;
    }
    const now = new Date().toISOString();
    const newTx: FinanceTransaction = {
      ...buildIncomeOrExpense(draft),
      billPaymentId: payment.id,
      ...(template?.debtId ? { debtId: template.debtId, debtRole: 'emi' as const } : {}),
    };
    setTransactions((prev) => [newTx, ...prev]);
    setBillPayments((prev) =>
      prev.map((p) => (p.id === payment.id ? linkBillPayment(p, newTx, now).payment : p))
    );
    return true;
  };

  /** Ticking pays with the bill's defaults; unticking asks whether to delete the linked entry. */
  const handleToggleBillPaid = async (payment: BillPayment) => {
    const template = billTemplates.find((t) => t.id === payment.billId);
    if (!payment.paid) {
      const accountId = template?.accountId || resolveDefaultAccountId(accounts, ledgerSettings[0]);
      if (!accountId) {
        setIsAccountModalOpen(true);
        return;
      }
      handlePayBill(payment, { amount: payment.amount, accountId, date: todayString() });
      return;
    }
    const linkedTx = payment.transactionId ? transactions.find((t) => t.id === payment.transactionId) : undefined;
    let deleteEntry = false;
    if (linkedTx) {
      const choice = await showConfirm({
        title: `Mark ${template?.name ?? 'this bill'} unpaid?`,
        message: `Its ledger entry (${formatRupees(linkedTx.amount)} on ${linkedTx.date}) can be deleted too, or kept if the money really left.`,
        tone: 'danger',
        confirmLabel: 'Delete the entry too',
        cancelLabel: 'Keep the entry',
      });
      deleteEntry = choice;
    }
    const stamp = new Date().toISOString();
    if (linkedTx && deleteEntry) {
      const removedIds = idsRemovedByCascade(transactionsRef.current, linkedTx.id);
      markDeleted(storageKeys, removedIds);
      setTransactions((prev) => removeTransactionCascade(prev, linkedTx.id));
    } else if (linkedTx) {
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === linkedTx.id
            ? { ...t, billPaymentId: undefined, ...(t.debtRole === 'emi' ? { debtId: undefined, debtRole: undefined } : {}), updatedAt: stamp }
            : t
        )
      );
    }
    setBillPayments((prev) =>
      prev.map((p) =>
        p.id === payment.id ? { ...p, paid: false, paidAt: undefined, transactionId: undefined, updatedAt: stamp } : p
      )
    );
  };

  const handleUpdateBillPaymentAmount = (payment: BillPayment, amount: number) => {
    const rupees = fromPaise(toPaise(amount));
    const stamp = new Date().toISOString();
    // A paid bill's ledger entry changes too: check the account can cover it first.
    if (payment.paid && payment.transactionId) {
      const linkedTx = transactions.find((t) => t.id === payment.transactionId);
      if (linkedTx && linkedTx.accountId) {
        const validation = validateEntry(
          {
            id: linkedTx.id,
            type: 'expense',
            amount: rupees,
            accountId: linkedTx.accountId,
            category: linkedTx.category,
            date: linkedTx.date,
          },
          ledgerContext()
        );
        if (isLedgerError(validation)) {
          void showAlert(ledgerErrorDialog(validation));
          return;
        }
        setTransactions((prev) =>
          prev.map((t) => (t.id === payment.transactionId ? { ...t, amount: rupees, updatedAt: stamp } : t))
        );
      }
    }
    setBillPayments((prev) =>
      prev.map((p) => (p.id === payment.id ? { ...p, amount: rupees, updatedAt: stamp } : p))
    );
  };

  const openBillTemplateModal = (template?: BillTemplate | null) => {
    setEditingBillTemplate(template || null);
    setIsBillTemplateModalOpen(true);
  };

  // ===== Savings handlers =====
  const closeSavingsModal = () => {
    setIsSavingsModalOpen(false);
    setEditingSavingsEntry(null);
    setEditingSavingsTransfer(null);
    setSavingsPresetAmount(null);
  };

  const openSavingsModal = (entry?: SavingsEntry | null) => {
    setEditingSavingsEntry(entry || null);
    setEditingSavingsTransfer(null);
    setSavingsPresetAmount(null);
    setIsSavingsModalOpen(true);
  };

  const openSavingsTransferModal = (tx: FinanceTransaction) => {
    setEditingSavingsEntry(null);
    setEditingSavingsTransfer(tx);
    setSavingsPresetAmount(null);
    setIsSavingsModalOpen(true);
  };

  const openSavingsModalWithAmount = (amount: number) => {
    setEditingSavingsEntry(null);
    setEditingSavingsTransfer(null);
    setSavingsPresetAmount(amount);
    setIsSavingsModalOpen(true);
  };

  const handleSaveSavingsEntry = (partial: Partial<SavingsEntry>) => {
    const now = new Date().toISOString();
    if (partial.id) {
      setSavingsEntries((prev) =>
        prev.map((e) =>
          e.id === partial.id
            ? {
                ...e,
                date: partial.date ?? e.date,
                amount: partial.amount ?? e.amount,
                note: partial.note,
                updatedAt: now,
              }
            : e
        )
      );
    } else {
      const newEntry: SavingsEntry = {
        id: `sav-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        date: partial.date || todayString(),
        amount: partial.amount || 0,
        note: partial.note,
        createdAt: now,
        updatedAt: now,
      };
      setSavingsEntries((prev) => [newEntry, ...prev]);
    }
  };

  const handleDeleteSavingsEntry = (id: string) => {
    markDeleted(storageKeys, [id]);
    setSavingsEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const handleQuickAddSavings = (amount: number) => {
    const settingsRecord = ledgerSettings[0];
    const fromAccountId = resolveDefaultAccountId(accounts, settingsRecord);
    const toAccountId = resolveSavingsDestinationId(accounts, settingsRecord?.defaultSavingsAccountId);
    if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
      openSavingsModalWithAmount(amount);
      return;
    }
    const fromName = accounts.find((a) => a.id === fromAccountId)?.name ?? 'account';
    const toName = accounts.find((a) => a.id === toAccountId)?.name ?? 'savings';
    handleSaveTransfer(
      {
        amount,
        fromAccountId,
        toAccountId,
        date: todayString(),
        time: nowTimeString(),
        note: 'Quick add',
      },
      (records) => announceAdded(records.map((r) => r.id), `Moved ${formatRupees(amount)} ${fromName} → ${toName}`)
    );
  };

  // Budget alert effect: check thresholds when transactions/budgets change.
  // Only fires for the current month to avoid spamming on month navigation.
  useEffect(() => {
    const currentMonth = currentMonthKey();
    const { alerts, stateUpdates } = checkBudgetAlerts({
      transactions: ledgerTransactions(transactions, accounts),
      budgets,
      categoryBudgets,
      alertState: budgetAlertState,
      month: currentMonth,
    });

    if (alerts.length > 0) {
      // Append new alerts (dedupe by key in case of rapid re-fires)
      setFinanceAlerts((prev) => {
        const existingKeys = new Set(prev.map((a) => a.key));
        const fresh = alerts.filter((a) => !existingKeys.has(a.key));
        return [...prev, ...fresh];
      });

      // Fire browser notifications if enabled
      if (settings.browserNotificationsEnabled) {
        for (const alert of alerts) {
          try {
            new Notification('Budget Alert', {
              body: formatAlertMessage(alert),
            });
          } catch (e) {
            console.warn('Notification failed:', e);
          }
        }
      }

      // Stamp alert state so we don't re-fire
      setBudgetAlertState((prev) => {
        const next = { ...prev };
        for (const [key, entry] of Object.entries(stateUpdates)) {
          next[key] = { ...next[key], ...entry };
        }
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, accounts, budgets, categoryBudgets]);

  // Materialize bill payments when templates change (e.g. new template added).
  useEffect(() => {
    if (billTemplates.length === 0) return;
    const currentMonth = currentMonthKey();
    setBillPayments((prev) => {
      const { payments } = materializeBillPayments(billTemplates, prev, currentMonth);
      // Avoid causing an unnecessary state update if nothing changed.
      if (payments.length === prev.length) return prev;
      return payments;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billTemplates]);

  // Daily Progress Score for the date in the date bar, and the last 7 finished days.
  const progressInput = useMemo(
    () => ({ tasks, habits, checkIns: habitCheckIns, goals, focusSessions, settings }),
    [tasks, habits, habitCheckIns, goals, focusSessions, settings],
  );
  const dayProgress = useMemo(() => dailyProgress(progressInput, selectedDate, todayStr), [progressInput, selectedDate, todayStr]);
  const weekProgress = useMemo(() => weeklyConsistency(progressInput, todayStr), [progressInput, todayStr]);
  // Home always describes today, whatever date the Today tab has picked.
  const homeProgress = useMemo(
    () => (selectedDate === todayStr ? dayProgress : dailyProgress(progressInput, todayStr, todayStr)),
    [selectedDate, todayStr, dayProgress, progressInput],
  );
  // Android-only nudge when reminders may arrive late; shown on Home (the launch screen) and Today.
  const reminderReliabilityCard =
    isNativeAndroid() && !reminderNoticeDismissed ? (
      <ReminderReliabilityCard
        state={
          nativeSetup
            ? {
                permissionGranted: nativeSetup.granted,
                exactAlarm: nativeSetup.exactAlarm,
                batteryRestricted: batteryUnrestricted === false,
              }
            : null
        }
        onRequestPermission={() => void handleRequestPermission()}
        onOpenExactAlarmSettings={handleOpenExactAlarmSettings}
        onOpenNotificationsPage={() => setActiveTab('notifications')}
        onDismiss={dismissReminderNotice}
      />
    ) : null;
  const homeData = useMemo(
    () =>
      activeTab === 'home'
        ? homeSummary({
            today: todayStr,
            tasks,
            habits,
            checkIns: habitCheckIns,
            goals,
            transactions,
            budgets,
            billPayments,
            diaryEntries,
          })
        : null,
    [activeTab, todayStr, tasks, habits, habitCheckIns, goals, transactions, budgets, billPayments, diaryEntries],
  );

  // Weekly report: due for this week on Sunday, otherwise for the week just ended.
  const weeklyInput = useMemo(
    () => ({ ...progressInput, transactions, savingsEntries, accounts }),
    [progressInput, transactions, savingsEntries, accounts],
  );
  const dueReportWeek = reportWeekStart(todayStr);
  const hasAnyActivity = tasks.length + habits.length + transactions.length > 0;
  // reportSeenTick re-reads the device-only "seen" flag after opening.
  const showReportCard = hasAnyActivity && reportSeenTick >= 0 && !isWeeklyReportSeen(dueReportWeek);
  const openWeeklyReport = (weekStart: string = dueReportWeek) => {
    if (weekStart === dueReportWeek) {
      markWeeklyReportSeen(dueReportWeek);
      setReportSeenTick((value) => value + 1);
    }
    setReportWeek(weekStart);
  };
  const openWeeklyReportRef = useRef(openWeeklyReport);
  openWeeklyReportRef.current = openWeeklyReport;

  // Extract all unique tags across tasks
  const allTags = Array.from(new Set(tasks.flatMap((t) => t.tags || []).filter(Boolean)));

  // Priority Rank Mapping
  const priorityRank: Record<Priority, number> = {
    urgent: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  // Filter Tasks for Today / Selected Date View
  const filteredDateTasks = tasks
    .filter((t) => {
      if (t.date !== selectedDate) return false;
      if (statusFilter === 'pending' && t.completed) return false;
      if (statusFilter === 'completed' && !t.completed) return false;
      if (categoryFilter !== 'all' && t.category !== categoryFilter) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (tagFilter !== 'all' && (!t.tags || !t.tags.includes(tagFilter))) return false;
      if (
        searchQuery &&
        !t.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !t.description?.toLowerCase().includes(searchQuery.toLowerCase())
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'priority-desc') {
        return priorityRank[b.priority] - priorityRank[a.priority];
      }
      if (sortBy === 'priority-asc') {
        return priorityRank[a.priority] - priorityRank[b.priority];
      }
      if (sortBy === 'title') {
        return a.title.localeCompare(b.title);
      }
      // Default: By Time
      return (a.time || '23:59').localeCompare(b.time || '23:59');
    });

  const completedTodayCount = tasks.filter((t) => t.date === selectedDate && t.completed).length;
  const totalTodayCount = tasks.filter((t) => t.date === selectedDate).length;

  const hasActiveFilters =
    categoryFilter !== 'all' || priorityFilter !== 'all' || tagFilter !== 'all' || statusFilter !== 'all' || searchQuery !== '';

  return (
    <>
    <div
      inert={appLocked}
      className={`min-h-dvh font-sans selection:bg-indigo-500 selection:text-white pb-[calc(6rem+env(safe-area-inset-bottom,0px))] lg:pb-8 lg:pl-64 transition-colors duration-200 ${
      theme === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-stone-50 text-slate-900'
    }`}>
      {/* App Header */}
      <Header
        notificationSettings={settings}
        permissionStatus={permissionStatus}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onRequestPermission={() => setActiveTab('notifications')}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenMenu={openMenu}
        isMenuOpen={isMenuOpen}
      />

      <InstallPrompt />

      {ringing && !isNative() && (
        <AlarmRingOverlay
          title={ringing.title}
          body={ringing.body}
          sound={ringing.sound}
          songId={ringing.songId}
          snoozeMinutes={ringing.snoozeMinutes}
          onDismiss={() => finishRing('dismiss')}
          onSnooze={() => finishRing('snooze')}
        />
      )}

      {/* Triggered Alarm / Notification Banner */}
      <NotificationBanner
        permissionStatus={permissionStatus}
        onRequestPermission={handleRequestPermission}
        activeAlert={activeAlert}
        onDismissAlert={() => setActiveAlert(null)}
        onCompleteAlertTask={(id) => {
          handleToggleComplete(id);
          setActiveAlert(null);
        }}
        onSnoozeAlertTask={handleSnoozeTask}
      />

      {/* Date Selector Strip (shown on Today and Timeline tabs) */}
      {(activeTab === 'today' || activeTab === 'timeline') && (
        <DateBar
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          tasks={tasks}
        />
      )}

      {/* Main Content Area */}
      <main className="max-w-5xl lg:max-w-6xl mx-auto px-4 py-5 lg:pl-6 lg:pr-8">
        {activeTab === 'maintenance' && (
          <Suspense fallback={<p role="status">Loading maintenance…</p>}>
            <MaintenanceView
              items={maintenanceItems}
              transactions={transactions}
              reminderNote={extraReminderNote}
              storageError={maintenanceSaveError}
              damagedNotice={maintenanceLoad.notice}
              damagedKey={maintenanceLoad.damagedKey}
              onCreate={handleCreateMaintenance}
              onUpdate={handleUpdateMaintenance}
              onDelete={handleDeleteMaintenance}
              onRecordService={handleRecordService}
              onUpdateService={handleUpdateService}
              onDeleteService={handleDeleteService}
              onImport={handleImportMaintenance}
              onOpenDocuments={(intent) => {
                setDocumentIntent(intent);
                setActiveTab('documents');
              }}
            />
          </Suspense>
        )}
        {activeTab === 'documents' && !appLocked && !ringing && (
          <Suspense fallback={<p role="status">Loading documents…</p>}>
            <DocumentVaultView
              maintenanceItems={maintenanceItems}
              intent={documentIntent}
              onIntentHandled={() => setDocumentIntent(null)}
              reminderNote={extraReminderNote}
            />
          </Suspense>
        )}
        {activeTab === 'vault' && !appLocked && !ringing && (
          <Suspense fallback={<p role="status">Loading vault…</p>}>
            <PasswordVaultView />
          </Suspense>
        )}
        {/* HOME DASHBOARD */}
        {activeTab === 'home' && homeData && (
          <div className="space-y-4">
            {reminderReliabilityCard}
            {showReportCard && <WeeklyReportCard weekStart={dueReportWeek} onOpen={() => openWeeklyReport()} />}
            <HomeView
              summary={homeData}
              progress={homeProgress}
              weekly={weekProgress}
              alarms={alarms}
              onOpen={(tab) => {
                // Home describes today, so whatever it opens (Today, Diary, ...) starts on today too.
                setSelectedDate(todayStr);
                setActiveTab(tab);
              }}
            />
          </div>
        )}
        {/* TODAY VIEW */}
        {activeTab === 'today' && (
          <div className="space-y-5">
            {showReportCard && <WeeklyReportCard weekStart={dueReportWeek} onOpen={() => openWeeklyReport()} />}
            <TodayProgressCard
              progress={dayProgress}
              weekly={weekProgress}
              when={selectedDate === todayStr ? 'today' : selectedDate > todayStr ? 'future' : 'past'}
            />
            <TodayAlarmCard alarms={alarms} onOpen={() => setActiveTab('alarms')} />
            <TodayMaintenanceCard
              items={maintenanceItems}
              today={todayStr}
              reminderNote={extraReminderNote}
              onOpen={() => setActiveTab('maintenance')}
            />
            <TodayDocumentsCard
              today={todayStr}
              reminderNote={extraReminderNote}
              onOpen={() => {
                setDocumentIntent(null);
                setActiveTab('documents');
              }}
            />
            <TodayHabitsCard
              date={selectedDate}
              goals={goals}
              habits={habits}
              checkIns={habitCheckIns}
              onSetCheckIn={handleSetCheckIn}
              onEditHabit={setEditingHabit}
              onDeleteHabit={handleDeleteHabit}
              onOpenHabits={() => setActiveTab('habits')}
            />
            <TodayDiaryCard
              date={selectedDate}
              entries={diaryEntries}
              onOpen={() => setActiveTab('diary')}
            />
            {/* Search, Filter & Sort Controls */}
            <Card className="p-3 space-y-2.5">
              {/* Full Width Search Bar */}
              <div className="relative w-full">
                <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search daily tasks..."
                  className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 rounded-xl pl-9 pr-8 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 min-h-[40px]"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Scrollable Filter & Sort Pills Strip */}
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 pr-2 snap-x touch-pan-x">
                {/* Priority Filter */}
                <Dropdown
                  value={priorityFilter}
                  onChange={setPriorityFilter}
                  title="Filter by Priority"
                  options={[
                    { value: 'all', label: 'All Priorities' },
                    { value: 'urgent', label: '🔴 Urgent' },
                    { value: 'high', label: '🟠 High' },
                    { value: 'medium', label: '🔵 Medium' },
                    { value: 'low', label: '🟢 Low' },
                  ]}
                />

                {/* Category Filter */}
                <Dropdown
                  value={categoryFilter}
                  onChange={setCategoryFilter}
                  title="Filter by Category"
                  options={[
                    { value: 'all', label: 'All Categories' },
                    ...categories.map((c) => ({ value: c.name, label: c.name })),
                  ]}
                />

                {/* Tag Filter */}
                {allTags.length > 0 && (
                  <Dropdown
                    value={tagFilter}
                    onChange={setTagFilter}
                    title="Filter by Tag"
                    options={[
                      { value: 'all', label: 'All Tags' },
                      ...allTags.map((tag) => ({ value: tag, label: `#${tag}` })),
                    ]}
                  />
                )}

                {/* Status Filter */}
                <Dropdown
                  value={statusFilter}
                  onChange={(v) => setStatusFilter(v as any)}
                  title="Filter by Status"
                  options={[
                    { value: 'all', label: 'All Status' },
                    { value: 'pending', label: 'Pending' },
                    { value: 'completed', label: 'Completed' },
                  ]}
                />

                {/* Sort Selector */}
                <Dropdown
                  value={sortBy}
                  onChange={(v) => setSortBy(v as any)}
                  title="Sort Tasks"
                  accent="indigo"
                  options={[
                    { value: 'time', label: 'Sort by Time' },
                    { value: 'priority-desc', label: 'Priority (Urgent → Low)' },
                    { value: 'priority-asc', label: 'Priority (Low → Urgent)' },
                    { value: 'title', label: 'Title (A-Z)' },
                  ]}
                />
              </div>
            </Card>

            {/* Active Filters Bar */}
            {hasActiveFilters && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-700 dark:text-slate-300">Active Filters:</span>
                {categoryFilter !== 'all' && (
                  <span className="bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 px-2 py-0.5 rounded-lg flex items-center gap-1">
                    Category: {categoryFilter}
                    <button onClick={() => setCategoryFilter('all')}>&times;</button>
                  </span>
                )}
                {priorityFilter !== 'all' && (
                  <span className="bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 px-2 py-0.5 rounded-lg flex items-center gap-1 uppercase font-bold text-[10px]">
                    Priority: {priorityFilter}
                    <button onClick={() => setPriorityFilter('all')}>&times;</button>
                  </span>
                )}
                {tagFilter !== 'all' && (
                  <span className="bg-slate-200 dark:bg-slate-800 text-teal-700 dark:text-teal-300 border border-slate-300 dark:border-slate-700 px-2 py-0.5 rounded-lg flex items-center gap-1">
                    #{tagFilter}
                    <button onClick={() => setTagFilter('all')}>&times;</button>
                  </span>
                )}
                {statusFilter !== 'all' && (
                  <span className="bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 px-2 py-0.5 rounded-lg flex items-center gap-1">
                    Status: {statusFilter}
                    <button onClick={() => setStatusFilter('all')}>&times;</button>
                  </span>
                )}
                <button
                  onClick={() => {
                    setCategoryFilter('all');
                    setPriorityFilter('all');
                    setTagFilter('all');
                    setStatusFilter('all');
                    setSearchQuery('');
                  }}
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white underline text-xs ml-1"
                >
                  Clear all
                </button>
              </div>
            )}

            {/* Native reminder reliability nudge (Android only, dismissible) */}
            {reminderReliabilityCard}

            {selectedDate === localToday && (
              <DailyPlanCard
                tasks={tasks}
                today={localToday}
                onToggleComplete={handleToggleComplete}
                onRescheduleTasks={handleRescheduleTasks}
                onSaveDiaryEntry={handleSaveDiaryEntry}
                onSaveReflection={handleSaveReflection}
                existingReflection={reflectionFor(diaryEntries, localToday)}
                settings={settings}
              />
            )}

            <QuickAddBar categories={categories} defaultDate={selectedDate} onAdd={handleSaveTask} />

            {/* Daily Completion Progress Banner */}
            <div className="bg-gradient-to-r from-blue-50/60 via-white to-blue-50/40 dark:from-slate-900 dark:via-indigo-950/60 dark:to-slate-900 border border-blue-200/60 dark:border-indigo-900/40 rounded-2xl p-3 sm:p-4 flex items-center justify-between shadow-sm transition-colors">
              <div className="min-w-0">
                <span className="text-[10px] sm:text-[11px] uppercase tracking-wider font-bold text-indigo-600 dark:text-indigo-400 block">
                  Daily Task Goal
                </span>
                <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                  {completedTodayCount} of {totalTodayCount} Tasks Completed
                </h3>
              </div>
              <div className="w-12 h-12 sm:w-14 sm:h-14 shrink-0 rounded-full border-4 border-indigo-500/30 flex items-center justify-center font-extrabold text-indigo-700 dark:text-indigo-300 text-xs sm:text-sm bg-white dark:bg-transparent">
                {totalTodayCount > 0
                  ? `${Math.round((completedTodayCount / totalTodayCount) * 100)}%`
                  : '0%'}
              </div>
            </div>

            {/* Tasks Stack List */}
            {filteredDateTasks.length > 0 ? (
              <div className="columns-1 md:columns-2 xl:columns-3 gap-3">
                {filteredDateTasks.map((task) => (
                  <div key={task.id} className="mb-3 break-inside-avoid">
                    <TaskCard
                      task={task}
                      categories={categories}
                      onToggleComplete={handleToggleComplete}
                      onToggleSubtask={handleToggleSubtask}
                      onEditTask={(t) => {
                        setEditingTask(t);
                        setIsTaskModalOpen(true);
                      }}
                      onDeleteTask={handleDeleteTask}
                      onSnoozeTask={handleSnoozeTask}
                      onStartFocus={handleStartFocus}
                      onSelectTagFilter={(tag) => setTagFilter(tag)}
                      onSkipTask={handleSkipTask}
                      onAddSubtask={handleAddSubtask}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 px-4 bg-white/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-slate-800 rounded-2xl transition-colors">
                <CheckCircle2 className="w-12 h-12 text-slate-400 dark:text-slate-600 mx-auto mb-3" />
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">No tasks found</h3>
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-1 max-w-xs mx-auto">
                  {hasActiveFilters
                    ? 'No tasks match your active filter criteria. Try clearing filters.'
                    : 'Click the (+) button below to create a task or schedule a recurring reminder.'}
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  {hasActiveFilters && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setCategoryFilter('all');
                        setPriorityFilter('all');
                        setTagFilter('all');
                        setStatusFilter('all');
                        setSearchQuery('');
                      }}
                    >
                      Clear Filters
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setEditingTask(null);
                      setIsTaskModalOpen(true);
                    }}
                  >
                    + Add Daily Task
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <Suspense fallback={<p role="status" className="text-sm text-stone-500">Loading…</p>}>
        {activeTab === 'calendar' && (
          <CalendarView
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            tasks={tasks}
            goals={goals}
            habits={habits}
            checkIns={habitCheckIns}
            transactions={transactions}
            diaryEntries={diaryEntries}
            onToggleTask={handleToggleComplete}
            onEditTask={(task) => {
              setEditingTask(task);
              setIsTaskModalOpen(true);
            }}
            onSetCheckIn={handleSetCheckIn}
            onAddTask={() => {
              setEditingTask(null);
              setIsTaskModalOpen(true);
            }}
            onAddFinance={(type) => openFinanceModal(null, { type })}
            onAddNote={() => openDiaryComposer(selectedDate)}
            onEditNote={(entry) => openDiaryComposer(entry.date, entry)}
          />
        )}

        {/* TIMELINE VIEW */}
        {activeTab === 'timeline' && (
          <TimelineView
            selectedDate={selectedDate}
            tasks={tasks}
            categories={categories}
            onToggleComplete={handleToggleComplete}
            onEditTask={(t) => {
              setEditingTask(t);
              setIsTaskModalOpen(true);
            }}
            onQuickAddTaskAtTime={handleQuickAddTaskAtTime}
            onStartFocus={handleStartFocus}
            onRescheduleTask={(taskId, time) => handleRescheduleTasks([taskId], { time })}
          />
        )}

        {/* FOCUS TIMER ROOM VIEW */}
        {activeTab === 'focus' && (
          <FocusRoom
            tasks={tasks}
            initialActiveTask={focusTask}
            initialMinutes={focusMinutes}
            onCompleteTask={handleToggleComplete}
            onSessionComplete={(session) =>
              setFocusSessions((prev) => [buildFocusSession(session), ...prev])
            }
          />
        )}

        {activeTab === 'goals' && (
          <GoalsView
            goals={goals}
            habits={habits}
            checkIns={habitCheckIns}
            onSaveGoal={handleSaveGoal}
            onDeleteGoal={handleDeleteGoal}
            onSaveHabit={handleSaveHabit}
            onLinkHabit={handleLinkHabit}
            onRegisterClose={registerGoalClose}
          />
        )}

        {activeTab === 'habits' && (
          <HabitsView
            goals={goals}
            habits={habits}
            checkIns={habitCheckIns}
            onSetCheckIn={handleSetCheckIn}
            onSaveHabit={handleSaveHabit}
            onDeleteHabit={handleDeleteHabit}
            onOpenGoals={() => setActiveTab('goals')}
            onRegisterClose={registerHabitClose}
          />
        )}

        {activeTab === 'notifications' && (
          <NotificationsView
            settings={settings}
            onUpdateSettings={setSettings}
            nativeSetup={nativeSetup}
            batteryUnrestricted={batteryUnrestricted}
            webPermission={permissionStatus}
            tasks={tasks}
            habits={habits}
            habitCheckIns={habitCheckIns}
            goals={goals}
            songIds={songIds}
            onRequestPermission={() => void handleRequestPermission()}
            onOpenExactAlarmSettings={handleOpenExactAlarmSettings}
            onStatusChange={(status) => {
              setNativeSetup(status);
              setPermissionStatus(status.granted ? 'granted' : 'denied');
            }}
            onRefreshBattery={refreshBatteryStatus}
          />
        )}

        {activeTab === 'alarms' && (
          <AlarmsView
            alarms={alarms}
            onSave={handleSaveAlarm}
            onDelete={handleDeleteAlarm}
            onToggle={(id, enabled) =>
              setAlarms((prev) =>
                prev.map((alarm) =>
                  alarm.id === id ? { ...alarm, enabled, updatedAt: new Date().toISOString() } : alarm
                )
              )
            }
          />
        )}

        {activeTab === 'diary' && (
          <DiaryView
            entries={diaryEntries}
            selectedDate={selectedDate}
            onAdd={() => openDiaryComposer(selectedDate)}
            onEdit={(entry) => openDiaryComposer(entry.date, entry)}
            onDelete={handleDeleteDiaryEntry}
          />
        )}

        {/* CATEGORIES & TAGS VIEW */}
        {activeTab === 'categories' && (
          <CategoriesView
            categories={categories}
            tasks={tasks}
            onAddCategory={(cat) => setCategories([...categories, cat])}
            onDeleteCategory={handleDeleteCategory}
            onSelectCategoryFilter={(catName) => {
              setCategoryFilter(catName);
              setActiveTab('today');
            }}
            onSelectTagFilter={(tagName) => {
              setTagFilter(tagName);
              setActiveTab('today');
            }}
          />
        )}

        {/* STATS & STREAK VIEW */}
        {activeTab === 'stats' && (
          <StatsView
            tasks={tasks}
            habits={habits}
            checkIns={habitCheckIns}
            goals={goals}
            onOpenWeeklyReport={() => openWeeklyReport()}
          />
        )}

        {/* PERSONAL FINANCE VIEW */}
        {activeTab === 'finance' && (
          <FinanceView
            requestedSection={requestedMoneySection}
            transactions={transactions}
            budgets={budgets}
            categoryBudgets={categoryBudgets}
            financeCategories={financeCategories}
            onAddFinanceCategory={handleAddFinanceCategory}
            onDeleteFinanceCategory={handleDeleteFinanceCategory}
            debts={debts}
            savingsGoals={savingsGoals}
            moneyGoals={moneyGoals}
            onSaveMoneyGoal={handleSaveMoneyGoal}
            onDeleteMoneyGoal={handleDeleteMoneyGoal}
            billTemplates={billTemplates}
            billPayments={billPayments}
            financeAlerts={financeAlerts}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            ledger={{
              accounts,
              transactions,
              ledgerSettings,
              financeCategories,
              selectedDate,
              onAddIncome: (accountId) => openFinanceModal(null, { type: 'income', accountId }),
              onAddExpense: (accountId) => openFinanceModal(null, { type: 'expense', accountId }),
              onTransfer: () => openTransferModal(null),
              onAddAccount: () => openAccountModal(null),
              onEditAccount: (account) => openAccountModal(account),
              onEditTransaction: (tx) => openFinanceModal(tx),
              onEditTransfer: (tx) => openTransferModal(tx),
              onDeleteTransaction: handleDeleteTransaction,
              onUpdateLedgerSettings: handleUpdateLedgerSettings,
              onBulkAssignAccount: handleBulkAssignAccount,
              onImportStatement: handleImportStatement,
            }}
            onAddTransaction={() => openFinanceModal(null)}
            onEditTransaction={(tx) => openFinanceModal(tx)}
            onDeleteTransaction={handleDeleteTransaction}
            onSetBudget={handleSetBudget}
            onSetCategoryBudget={handleSetCategoryBudget}
            onRemoveCategoryBudget={handleRemoveCategoryBudget}
            onQuickAdd={handleQuickAddTransaction}
            onAddDebt={() => openDebtModal(null)}
            onEditDebt={(debt) => openDebtModal(debt)}
            onDeleteDebt={handleDeleteDebt}
            onToggleDebtPaid={handleToggleDebtPaid}
            onSetSavingsGoal={handleSetSavingsGoal}
            onAddBillTemplate={() => openBillTemplateModal(null)}
            onEditBillTemplate={(template) => openBillTemplateModal(template)}
            onDeleteBillTemplate={handleDeleteBillTemplate}
            onToggleBillPaid={handleToggleBillPaid}
            onUpdateBillPaymentAmount={handleUpdateBillPaymentAmount}
            savingsEntries={savingsEntries}
            savingsStreak={savingsStreak}
            onAddSavings={() => openSavingsModal(null)}
            onEditSavings={(entry) => openSavingsModal(entry)}
            onEditSavingsTransfer={openSavingsTransferModal}
            onDeleteSavings={handleDeleteSavingsEntry}
            onQuickAddSavings={handleQuickAddSavings}
            onSetSavingsOnly={handleSetSavingsOnly}
            onDismissAlert={handleDismissAlert}
            onConfirmBankSms={(partial) =>
              handleSaveTransaction(partial, { allowOverdraft: true }) === true
            }
            onQuickEntry={handleQuickEntry}
            onSplitEntry={handleSplitEntry}
            onSplitWithFriends={handleSplitWithFriends}
            onAddDebtPayment={handleAddDebtPayment}
            onPayBill={handlePayBill}
          />
        )}
        </Suspense>
      </main>

      {/* Desktop Sidebar Nav */}
      <Sidebar
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        onOpenQuickAdd={handleQuickAdd}
      />

      {/* Mobile sidebar drawer (header menu button or left-edge swipe) */}
      <MobileSidebar
        isOpen={isMenuOpen}
        activeTab={activeTab}
        onOpen={openMenu}
        onClose={closeMenu}
        onChangeTab={setActiveTab}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Bottom Mobile Nav */}
      <BottomNav
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        onOpenQuickAdd={handleQuickAdd}
      />

      <DiaryEntryModal
        isOpen={isDiaryModalOpen}
        onClose={() => {
          setIsDiaryModalOpen(false);
          setEditingDiaryEntry(null);
        }}
        onSave={handleSaveDiaryEntry}
        initialEntry={editingDiaryEntry}
        defaultDate={diaryDraftDate}
      />

      {/* Add / Edit Task Modal */}
      <TaskModal
        isOpen={isTaskModalOpen}
        onClose={() => {
          setIsTaskModalOpen(false);
          setEditingTask(null);
          setNewTaskTime(undefined);
        }}
        onSaveTask={handleSaveTask}
        initialTask={editingTask}
        initialTime={newTaskTime}
        categories={categories}
        selectedDate={selectedDate}
      />

      {/* Add / Edit Finance Transaction Modal */}
      {isFinanceModalOpen && (
        <FinanceModal
          isOpen={isFinanceModalOpen}
          onClose={() => {
            setIsFinanceModalOpen(false);
            setEditingTransaction(null);
            setFinanceDraftDefaults(null);
          }}
          onSave={handleSaveTransaction}
          initialTransaction={editingTransaction}
          selectedDate={selectedDate}
          accounts={accounts}
          transactions={transactions}
          ledgerSettings={ledgerSettings}
          financeCategories={financeCategories}
          onAddFinanceCategory={handleAddFinanceCategory}
          onDeleteFinanceCategory={handleDeleteFinanceCategory}
          initialType={financeDraftDefaults?.type}
          initialAccountId={financeDraftDefaults?.accountId}
        />
      )}

      {/* Add / Edit Ledger Account Modal */}
      {isAccountModalOpen && (
        <AccountModal
          isOpen={isAccountModalOpen}
          onClose={() => {
            setIsAccountModalOpen(false);
            setEditingAccount(null);
          }}
          onSave={handleSaveAccount}
          initialAccount={editingAccount}
          accounts={accounts}
          transactions={transactions}
        />
      )}

      {/* Transfer Money Modal */}
      {isTransferModalOpen && (
        <TransferModal
          isOpen={isTransferModalOpen}
          onClose={() => {
            setIsTransferModalOpen(false);
            setEditingTransfer(null);
          }}
          onSave={handleSaveTransfer}
          accounts={accounts}
          transactions={transactions}
          ledgerSettings={ledgerSettings}
          initialTransfer={editingTransfer}
          selectedDate={selectedDate}
        />
      )}

      {/* Add / Edit Debt Modal */}
      <DebtModal
        isOpen={isDebtModalOpen}
        onClose={() => {
          setIsDebtModalOpen(false);
          setEditingDebt(null);
        }}
        onSave={handleSaveDebt}
        initialDebt={editingDebt}
        selectedDate={selectedDate}
        accounts={accounts.filter((account) => !account.isArchived && !account.savingsOnly)}
        defaultAccountId={resolveDefaultAccountId(accounts, ledgerSettings[0]) ?? undefined}
      />

      {/* Add / Edit Bill Template Modal */}
      <BillTemplateModal
        isOpen={isBillTemplateModalOpen}
        onClose={() => {
          setIsBillTemplateModalOpen(false);
          setEditingBillTemplate(null);
        }}
        onSave={handleSaveBillTemplate}
        initialTemplate={editingBillTemplate}
        accounts={accounts}
        financeCategories={financeCategories}
        onAddFinanceCategory={handleAddFinanceCategory}
        onDeleteFinanceCategory={handleDeleteFinanceCategory}
      />

      {/* Add / Edit Savings — a transfer into savings, gold, or stocks */}
      <SavingsModal
        isOpen={isSavingsModalOpen}
        onClose={closeSavingsModal}
        onSaveTransfer={handleSaveTransfer}
        onSaveLegacy={handleSaveSavingsEntry}
        initialTransfer={editingSavingsTransfer}
        initialLegacy={editingSavingsEntry}
        presetAmount={savingsPresetAmount}
        accounts={accounts}
        transactions={transactions}
        ledgerSettings={ledgerSettings}
        selectedDate={selectedDate}
      />

      <HabitModal
        isOpen={editingHabit !== null}
        onClose={() => setEditingHabit(null)}
        onSave={(habit) => {
          handleSaveHabit(habit);
          setEditingHabit(null);
        }}
        initialHabit={editingHabit}
        goals={goals}
      />

      {/* Settings Modal */}
      {reportWeek && (
        <WeeklyReportSheet
          input={weeklyInput}
          today={todayStr}
          initialWeekStart={reportWeek}
          onClose={() => setReportWeek(null)}
        />
      )}

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onUpdateSettings={setSettings}
        onResetTasks={handleResetTasks}
        onExportData={handleExportData}
        onImportData={handleImportData}
        backupFolderSupported={backupFolderSupported}
        backupFolderName={backupFolderName}
        backupLastSavedAt={backupLastSavedAt}
        backupFolderError={backupFolderError}
        onChooseBackupFolder={handleChooseBackupFolder}
        onStopBackupFolder={handleStopBackupFolder}
        cloudSync={cloudSync}
        onOpenNotifications={() => {
          setIsSettingsOpen(false);
          setActiveTab('notifications');
        }}
      />

      {recentlyDeletedDiary && (
        <Toast
          message={`Note "${diaryPreview(recentlyDeletedDiary.entry.body, 40)}" deleted`}
          onUndo={handleUndoDeleteDiary}
          onDismiss={() => setRecentlyDeletedDiary(null)}
        />
      )}

      {/* Undo Toast for recently deleted tasks */}
      {recentlyDeleted && (
        <Toast
          message={`Task "${recentlyDeleted.task.title}" deleted`}
          onUndo={handleUndoDelete}
          onDismiss={() => setRecentlyDeleted(null)}
        />
      )}

      {/* Undo Toast for recently deleted finance transactions */}
      {recentlyDeletedTransaction && (
        <Toast
          message={`Transaction of ${new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
          }).format(recentlyDeletedTransaction.txs[0]?.amount ?? 0)} deleted`}
          onUndo={handleUndoDeleteTransaction}
          onDismiss={() => setRecentlyDeletedTransaction(null)}
        />
      )}

      {/* Undo Toast for one-tap adds (quick entry, repeat chips, savings chips) */}
      {recentlyAddedTransactions && (
        <Toast
          message={recentlyAddedTransactions.message}
          onUndo={handleUndoAddTransactions}
          onDismiss={() => setRecentlyAddedTransactions(null)}
        />
      )}
    </div>
    {appLocked && (
      <AppLockScreen
        theme={theme}
        error={lockError}
        onUnlock={() => void unlockApp()}
        onUsePassword={canUsePasswordUnlock() ? unlockWithPassword : undefined}
      />
    )}
    </>
  );
}
