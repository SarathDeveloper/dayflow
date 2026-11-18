export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  avatarColor?: string;
  createdAt: string;
}

export type RecurrenceType = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export type SoundType = 'chime' | 'bell' | 'digital' | 'gentle' | 'voice' | 'music';

export interface Subtask {
  id: string;
  title: string;
  completed: boolean;
}

export interface TaskReminder {
  enabled: boolean;
  remindBeforeMinutes: number; // 0 = at time, 5, 15, 30, 60
  sound: SoundType;
  /** With Local music: the alarm song on this device. Missing or unknown plays the oldest song. */
  songId?: string;
  /** Loop until Dismiss or Snooze. Local music always rings this way. */
  alarm?: boolean;
  lastNotifiedAt?: string;
  snoozedUntil?: string;
}

export interface TaskRecurrence {
  type: RecurrenceType;
  intervalDays?: number; // for custom interval
  daysOfWeek?: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  endDate?: string;
}

export interface Task {
  id: string;
  userId?: string;
  title: string;
  description?: string;
  completed: boolean;
  completedAt?: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:mm
  estimatedMinutes?: number;
  priority: Priority;
  category: string;
  subtasks: Subtask[];
  recurrence: TaskRecurrence;
  reminder: TaskReminder;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  userId?: string;
  name: string;
  color: string; // hex or tailwind color name
  icon: string; // lucide icon identifier
  updatedAt?: string;
}

export interface NotificationSettings {
  browserNotificationsEnabled: boolean;
  soundEnabled: boolean;
  speechEnabled: boolean;
  defaultSound: SoundType;
  /** @deprecated Name of the single song from before the song library. Kept so old backups load. */
  localMusicName?: string;
  /** Daily focus goal for the progress score, in minutes. Missing means 50. */
  dailyFocusGoalMinutes?: number;
  /** Time available for planned tasks, minutes per weekday (0 = Sunday … 6). Missing means 240 each. */
  availableMinutesByWeekday?: number[];
  quietHours: {
    enabled: boolean;
    start: string; // "22:00"
    end: string;   // "07:00"
  };
}

export type ActiveTab = 'home' | 'today' | 'calendar' | 'timeline' | 'focus' | 'goals' | 'habits' | 'alarms' | 'diary' | 'categories' | 'stats' | 'finance' | 'settings' | 'vault' | 'maintenance' | 'documents' | 'notifications';

export type GoalStatus = 'active' | 'paused' | 'completed';

export interface Goal {
  id: string;
  userId?: string;
  title: string;
  note?: string;
  startDate: string; // YYYY-MM-DD
  targetDate: string; // YYYY-MM-DD
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export type HabitScheduleType = 'daily' | 'weekdays' | 'custom' | 'times_per_week';

export type HabitColor = 'indigo' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet';

export interface HabitSchedule {
  type: HabitScheduleType;
  /** 0 = Sunday … 6 = Saturday. Used when type is `custom`. */
  daysOfWeek?: number[];
  /** 1–7. Used when type is `times_per_week`. */
  timesPerWeek?: number;
}

export interface HabitReminder {
  enabled: boolean;
  time: string; // HH:mm
  sound: SoundType;
  /** With Local music: the alarm song on this device. Missing or unknown plays the oldest song. */
  songId?: string;
  /** Loop until Dismiss or Snooze. Local music always rings this way. */
  alarm?: boolean;
  lastNotifiedAt?: string;
  snoozedUntil?: string;
}

/** A clock alarm. Empty `daysOfWeek` rings once, then turns off after dismiss. */
export interface Alarm {
  id: string;
  userId?: string;
  label: string;
  time: string; // HH:mm
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. Empty means once. */
  daysOfWeek: number[];
  sound: SoundType;
  /** With Local music: the alarm song on this device. Missing or unknown plays the oldest song. */
  songId?: string;
  snoozeMinutes: number;
  snoozedUntil?: string;
  /** Set when this occurrence was dismissed so it does not ring again in the same window. */
  acknowledgedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Habit {
  id: string;
  userId?: string;
  title: string;
  goalId?: string;
  schedule: HabitSchedule;
  archived: boolean;
  color?: HabitColor;
  /** Lucide icon name from the habit preset. */
  icon?: string;
  /** Amount that counts as done for the day. Missing or 1 is a simple check. */
  targetCount?: number;
  unit?: string;
  reminder?: HabitReminder;
  createdAt: string;
  updatedAt: string;
}

/** One record per habit per calendar day. Deleting it unchecks that day. */
export interface HabitCheckIn {
  id: string;
  userId?: string;
  habitId: string;
  date: string; // YYYY-MM-DD
  /** A skip keeps a daily streak but does not count as done. */
  skipped?: boolean;
  note?: string;
  /** Logged amount. For a simple check, omit it or set it to at least 1. 0 is a note-only record. */
  value?: number;
  createdAt: string;
  updatedAt: string;
}

/** `null` deletes the day's check-in. */
export interface HabitCheckInPatch {
  skipped: boolean;
  note?: string;
  value?: number;
}

export type DiaryMood = 'great' | 'good' | 'okay' | 'low' | 'rough';

/** A photo kept on a diary note, already resized to a JPEG data URL. */
export interface DiaryImage {
  id: string;
  dataUrl: string;
}

/** Answers to the evening review prompts. */
export interface DiaryReflection {
  wentWell?: string;
  missed?: string;
  learned?: string;
  improve?: string;
}

/** One note. A calendar day can hold many of these. */
export interface DiaryEntry {
  id: string;
  userId?: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  mood: DiaryMood;
  body: string;
  images?: DiaryImage[];
  /** 1 (drained) … 5 (full of energy). Set by the evening review. */
  energy?: number;
  /** Present on the one evening-review entry of a day. */
  reflection?: DiaryReflection;
  createdAt: string;
  updatedAt: string;
}

/** A finished Focus Room session (breaks are not recorded). */
export interface FocusSession {
  id: string;
  userId?: string;
  date: string; // YYYY-MM-DD, local day the session ended
  startedAt: string; // ISO
  minutes: number;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Money ledger: accounts
// ---------------------------------------------------------------------------

export type AccountType = 'cash' | 'savings' | 'current' | 'gold' | 'stocks' | 'other';

export interface Account {
  id: string;
  userId?: string;
  name: string; // "YES Bank", "Indian Bank", "Cash Wallet"
  type: AccountType;
  bankName?: string;
  accountNickname?: string;
  lastFourDigits?: string;
  /** Balance the account held before the first tracked transaction, in rupees. */
  openingBalance: number;
  /** Archived accounts keep their history but are excluded from totals/pickers. */
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Ledger-wide preferences. Stored as an array (one record, id = 'ledger') so it
 * rides the same record-level sync/merge path as every other collection.
 */
export interface LedgerSettings {
  id: string;
  userId?: string;
  allowNegativeBalance: boolean;
  defaultAccountId?: string;
  /** Last savings, gold, or stocks account a save was moved into. */
  defaultSavingsAccountId?: string;
  updatedAt: string;
}

/**
 * `transfer` moves money between two accounts and is never counted as income
 * or expense. `upi` and `bank` are legacy payment methods kept so entries
 * created before the ledger existed still render correctly.
 */
export type TransactionType = 'expense' | 'income' | 'transfer';

export type PaymentMethod =
  | 'cash'
  | 'gpay'
  | 'phonepe'
  | 'bank_transfer'
  | 'card'
  | 'other'
  | 'upi'
  | 'bank';

export type FinanceRecurrenceType = 'none' | 'daily' | 'weekly' | 'monthly';

export interface FinanceRecurrence {
  type: FinanceRecurrenceType;
  endDate?: string; // YYYY-MM-DD
}

export interface FinanceTransaction {
  id: string;
  userId?: string;
  type: TransactionType;
  amount: number;
  category: string;
  note?: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:mm (optional)
  paymentMethod?: PaymentMethod;
  /** Funding account for expenses / receiving account for income. */
  accountId?: string;
  /** Transfers only: the account money lands in. */
  destinationAccountId?: string;
  /** Links an ATM-fee expense to the transfer that produced it. */
  linkedTransferId?: string;
  recurrence: FinanceRecurrence;
  recurrenceGroupId?: string; // links generated instances in a series
  /** The debt this money movement belongs to (borrowing, lending, repaying, an EMI). */
  debtId?: string;
  /** What it was for that debt. Borrowed / lent / repaid / received money is not income or spending. */
  debtRole?: DebtFlowRole;
  /** The bill payment this entry paid. */
  billPaymentId?: string;
  createdAt: string;
  updatedAt: string;
}

export type DebtFlowRole = 'borrowed' | 'lent' | 'repaid' | 'received' | 'emi';

export interface MonthlyBudget {
  id: string;
  userId?: string;
  month: string; // YYYY-MM
  limit: number;
  updatedAt?: string;
}

export interface CategoryBudget {
  id: string;
  userId?: string;
  month: string; // YYYY-MM
  category: string;
  limit: number;
  updatedAt?: string;
}

/** A money category the user added. Built-in names stay in the category lists. */
export interface FinanceCategory {
  id: string;
  name: string;
  kind: 'income' | 'expense';
  createdAt: string;
  updatedAt: string;
}

export type DebtDirection = 'lent' | 'owed';

export interface Debt {
  id: string;
  userId?: string;
  direction: DebtDirection; // lent = receivable, owed = payable
  personName: string;
  amount: number;
  date: string; // YYYY-MM-DD when it happened
  dueDate?: string; // YYYY-MM-DD optional
  note?: string;
  paid: boolean;
  paidAt?: string;
  /** A loan repaid in EMIs (home, car, personal loan). `amount` is the principal. */
  loan?: DebtLoanTerms;
  /** Part payments so far (for a loan: prepayments on top of the EMIs). */
  payments?: DebtPayment[];
  /** Account the money moved through (received into / paid from). */
  accountId?: string;
  /** Ledger entry for the money borrowed or lent, when recorded. */
  transactionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DebtLoanTerms {
  /** Yearly interest rate in percent, e.g. 10.5. 0 for an interest-free EMI. */
  annualRate: number;
  tenureMonths: number;
  /** YYYY-MM-DD of the first EMI. */
  firstEmiDate: string;
}

export interface DebtPayment {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number;
  /** Ledger entry that moved this money, when recorded. */
  transactionId?: string;
  /** Made by ticking the debt paid (unticking removes it). */
  settles?: boolean;
}

export interface SavingsGoal {
  id: string;
  userId?: string;
  month: string; // YYYY-MM
  target: number;
  updatedAt?: string;
}

export interface SavingsEntry {
  id: string;
  userId?: string;
  date: string; // YYYY-MM-DD
  amount: number; // how much saved that day
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavingsStreakState {
  currentStreak: number;
  longestStreak: number;
  lastSavedDate?: string; // YYYY-MM-DD
}

export interface BillTemplate {
  id: string;
  userId?: string;
  name: string; // e.g. "Electricity", "Internet"
  amount: number; // expected amount
  category: string; // expense category
  dueDayOfMonth: number; // 1-31
  paymentMethod?: PaymentMethod;
  accountId?: string; // account the bill is paid from (optional)
  active: boolean; // false = paused
  note?: string;
  /** A loan's EMI: the debt it repays. */
  debtId?: string;
  /** First and last month (YYYY-MM) the bill is due, when it is not open-ended. */
  startMonth?: string;
  endMonth?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillPayment {
  id: string;
  userId?: string;
  billId: string; // links to template
  month: string; // YYYY-MM
  amount: number; // actual paid amount (defaults to template amount)
  dueDate: string; // YYYY-MM-DD clamped to last day of month
  paid: boolean;
  paidAt?: string;
  transactionId?: string; // links to auto-created FinanceTransaction
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetAlertStateEntry {
  eightyNotifiedAt?: string;
  hundredNotifiedAt?: string;
}

export interface BudgetAlertState {
  [key: string]: BudgetAlertStateEntry; // key = `${month}` or `${month}-${category}`
}

export interface BudgetAlert {
  key: string;
  level: 'warning' | 'critical';
  scope: string; // 'Monthly' or category name
  spent: number;
  limit: number;
  pct: number;
}

export interface ActiveAlert {
  task: Task;
  triggeredAt: Date;
}

export type MaintenanceKind = 'vehicle' | 'home';

/** One completed service of a maintenance item. Ids are unique across all collections. */
export interface MaintenanceServiceRecord {
  id: string;
  date: string; // YYYY-MM-DD, local
  notes: string;
  /**
   * Amount paid in rupees, when it is NOT already in Money. A record linked to a
   * Money transaction (`transactionId`) takes its cost from that transaction, so
   * the spend is never counted twice.
   */
  cost?: number;
  /** An existing expense transaction in Money that paid for this service. */
  transactionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A recurring, date-based vehicle or home maintenance task. Synced like other collections. */
export interface MaintenanceItem {
  id: string;
  userId?: string;
  asset: string; // "Honda City", "Kitchen water filter"
  kind: MaintenanceKind;
  title: string; // "Engine oil change"
  due: string; // next due date, YYYY-MM-DD, local
  intervalMonths: number; // 1..120
  /** Days before `due` to remind (0 = on the due date). Empty = no reminders. */
  reminderDays: number[];
  history: MaintenanceServiceRecord[];
  createdAt: string;
  updatedAt: string;
}
