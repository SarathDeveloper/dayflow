import { countsAsIncome, countsAsSpending } from '../lib/moneyLinks';
import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import {
  Wallet,
  Plus,
  ChevronLeft,
  ChevronRight,
  ArrowDownCircle,
  ArrowUpCircle,
  Pencil,
  Trash2,
  Calendar,
  PieChart,
  Target,
  Search,
  X,
  Repeat,
  Check,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  PiggyBank,
  BarChart3,
  Receipt,
  AlertCircle,
} from 'lucide-react';
import {
  BillPayment,
  BillTemplate,
  BudgetAlert,
  CategoryBudget,
  FinanceCategory,
  Debt,
  FinanceTransaction,
  MonthlyBudget,
  PaymentMethod,
  SavingsEntry,
  SavingsGoal,
  MoneyGoal,
  SavingsStreakState,
} from '../types';
import {
  ALL_PAYMENT_METHODS,
  EXPENSE_CATEGORIES,
  QUICK_ADD_AMOUNTS,
  accountTypeMeta,
  financeCategoryNames,
  isCustomFinanceCategory,
  quickAddCategoryNames,
} from '../data/financeCategories';
import { CategorySelect } from './ui/CategorySelect';
import { recentExpenseCategories } from '../lib/financeRecurrence';
import { addRupees, formatPaise, fromPaise, toPaise } from '../lib/money';
import { debtOutstanding } from '../lib/debtPlanner';
import { forecastMonth } from '../lib/moneyForecast';
import { QuickEntryBar } from './money/QuickEntryBar';
import { SplitEntryModal } from './money/SplitEntryModal';
import { BillPayModal } from './money/BillPayModal';
import { MonthOutlook } from './money/MonthOutlook';
import { MoneyReports } from './money/MoneyReports';
import { DebtLoanPanel, DebtPayoffPlanner } from './money/DebtPlanner';
import type { QuickEntry } from '../lib/quickEntry';
import type { SplitLine } from '../lib/quickEntry';
import { computeAccountBalances, resolveDefaultAccountId, todayString } from '../lib/ledger';
import {
  getDailySpendForMonth,
  getLast7DaysData,
  getMonthOverMonthCompare,
  getPrev7DaysTotals,
  getSavingsProgress,
} from '../lib/financeInsights';
import {
  getLastNDaysHeatmap,
  getMonthlySavingsTotal,
  getMonthlySavedDays,
  heatmapIntensity,
} from '../lib/savingsStreak';
import { bucketAccounts, countedSavingsAmounts, ledgerTransactions, savingsOnlyCandidates, savingsRowsForMonth } from '../lib/savingsLedger';
import { showAlert, showChoice } from './ui/AppDialog';
import { reminderMessage } from '../lib/friendSplit';
import type { FriendSplitInput } from './money/SplitEntryModal';
import { AccountDetailView } from './ledger/AccountDetailView';
import { TransactionDetailModal } from './ledger/TransactionDetailModal';
import { MoneyGoalModal } from './money/MoneyGoalModal';
import { goalProgress, sortGoals } from '../lib/moneyGoals';
import { effectiveCategoryBudgets, effectiveMonthlyBudget, isCarriedOver } from '../lib/budgetCarry';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Dropdown } from './ui/Dropdown';
import { FinanceAlertBanner } from './FinanceAlertBanner';
import { MonthlyReportCard } from './MonthlyReportCard';
import { LedgerView, type LedgerViewProps } from './ledger/LedgerView';
import { BANK_SMS_ENABLED } from '../lib/features';

// Loaded lazily and only when the flag is on, so a build with the flag off
// drops the module (and its top-level native plugin registration) entirely.
const BankSmsInbox = BANK_SMS_ENABLED
  ? lazy(() => import('./BankSmsInbox').then((m) => ({ default: m.BankSmsInbox })))
  : null;

interface FinanceViewProps {
  transactions: FinanceTransaction[];
  budgets: MonthlyBudget[];
  categoryBudgets: CategoryBudget[];
  financeCategories: FinanceCategory[];
  onAddFinanceCategory: (kind: 'income' | 'expense', name: string) => string | null;
  onDeleteFinanceCategory: (kind: 'income' | 'expense', name: string) => void;
  debts: Debt[];
  savingsGoals: SavingsGoal[];
  /** Named savings goals, shown on the Savings page. */
  moneyGoals: MoneyGoal[];
  onSaveMoneyGoal: (goal: Partial<MoneyGoal>) => boolean;
  onDeleteMoneyGoal: (id: string) => void;
  billTemplates: BillTemplate[];
  billPayments: BillPayment[];
  savingsEntries: SavingsEntry[];
  savingsStreak: SavingsStreakState;
  financeAlerts: BudgetAlert[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  ledger: LedgerViewProps;
  onAddTransaction: () => void;
  onEditTransaction: (tx: FinanceTransaction) => void;
  onDeleteTransaction: (id: string) => void;
  onSetBudget: (month: string, limit: number) => void;
  onSetCategoryBudget: (month: string, category: string, limit: number) => void;
  onRemoveCategoryBudget: (month: string, category: string) => void;
  onQuickAdd: (amount: number, category: string) => void;
  onAddDebt: () => void;
  onEditDebt: (debt: Debt) => void;
  onDeleteDebt: (id: string) => void;
  onToggleDebtPaid: (id: string) => void;
  onSetSavingsGoal: (month: string, target: number) => void;
  onAddBillTemplate: () => void;
  onEditBillTemplate: (template: BillTemplate) => void;
  onDeleteBillTemplate: (id: string) => void;
  onToggleBillPaid: (payment: BillPayment) => void;
  onUpdateBillPaymentAmount: (payment: BillPayment, amount: number) => void;
  onAddSavings: () => void;
  onEditSavings: (entry: SavingsEntry) => void;
  onEditSavingsTransfer: (tx: FinanceTransaction) => void;
  onDeleteSavings: (id: string) => void;
  onQuickAddSavings: (amount: number) => void;
  /** Set when a money reminder was tapped: opens that section (`at` makes each tap new). */
  requestedSection?: { section: 'bills' | 'debts' | 'ledger'; at: number } | null;
  /** Picks (or unpicks) a bank as kept for future savings. */
  onSetSavingsOnly: (accountId: string, savingsOnly: boolean) => void;
  onDismissAlert: (key: string) => void;
  /** Saves a confirmed bank SMS as a normal ledger entry. False keeps it pending. */
  onConfirmBankSms: (partial: Partial<FinanceTransaction>) => boolean;
  /** Quick-add bar and repeat chips. False when the entry was refused. */
  onQuickEntry: (entry: QuickEntry) => boolean;
  /** One payment split across categories. */
  onSplitEntry: (split: { accountId: string; date: string; note?: string; paymentMethod?: PaymentMethod; lines: SplitLine[] }) => boolean;
  /** A bill split with friends: your share is spending, theirs become lent debts. */
  onSplitWithFriends: (split: FriendSplitInput) => boolean;
  onAddDebtPayment: (id: string, amount: number, date: string, ledger?: { accountId: string }) => boolean;
  /** Pays a bill with the chosen amount, account and date (a linked ledger entry). */
  onPayBill: (payment: BillPayment, details: { amount: number; accountId: string; date: string; paymentMethod?: PaymentMethod }) => boolean;
}

type FinanceMode = 'ledger' | 'daily' | 'weekly' | 'monthly' | 'bills' | 'debts' | 'savings' | 'reports';

const MONEY_TAB_KEY = 'dayflow_money_tab_v1';

const MONEY_TABS: { mode: FinanceMode; label: string; icon: React.ElementType }[] = [
  { mode: 'ledger', label: 'Ledger', icon: Wallet },
  { mode: 'daily', label: 'Daily', icon: Calendar },
  { mode: 'weekly', label: '7 days', icon: TrendingUp },
  { mode: 'monthly', label: 'Monthly', icon: PieChart },
  { mode: 'bills', label: 'Bills', icon: Receipt },
  { mode: 'debts', label: 'Debts', icon: Wallet },
  { mode: 'savings', label: 'Savings', icon: PiggyBank },
  { mode: 'reports', label: 'Reports', icon: BarChart3 },
];
type FilterType = 'all' | 'expense' | 'income';
type FilterPayment = 'all' | PaymentMethod;
type DebtFilter = 'all' | 'outstanding' | 'settled';
type BillsSubView = 'payments' | 'templates';

const formatMoney = (amount: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount);

const toMonthKey = (dateStr: string) => dateStr.slice(0, 7);

const shiftDate = (dateStr: string, days: number) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return todayString(d);
};

const shiftMonth = (monthKey: string, offset: number) => {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (monthKey: string) => {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
};

const paymentLabel = (m?: PaymentMethod) =>
  m ? ALL_PAYMENT_METHODS.find((p) => p.value === m)?.label || m : '';
const paymentEmoji = (m?: PaymentMethod) =>
  m ? ALL_PAYMENT_METHODS.find((p) => p.value === m)?.emoji || '' : '';

export const FinanceView: React.FC<FinanceViewProps> = ({
  requestedSection,
  transactions: allTransactions,
  budgets,
  categoryBudgets,
  financeCategories,
  onAddFinanceCategory,
  onDeleteFinanceCategory,
  debts,
  savingsGoals,
  moneyGoals,
  onSaveMoneyGoal,
  onDeleteMoneyGoal,
  billTemplates,
  billPayments,
  savingsEntries,
  savingsStreak,
  financeAlerts,
  selectedDate,
  onSelectDate,
  ledger,
  onAddTransaction,
  onEditTransaction,
  onDeleteTransaction,
  onSetBudget,
  onSetCategoryBudget,
  onRemoveCategoryBudget,
  onQuickAdd,
  onAddDebt,
  onEditDebt,
  onDeleteDebt,
  onToggleDebtPaid,
  onSetSavingsGoal,
  onAddBillTemplate,
  onEditBillTemplate,
  onDeleteBillTemplate,
  onToggleBillPaid,
  onUpdateBillPaymentAmount,
  onAddSavings,
  onEditSavings,
  onEditSavingsTransfer,
  onDeleteSavings,
  onQuickAddSavings,
  onSetSavingsOnly,
  onDismissAlert,
  onConfirmBankSms,
  onQuickEntry,
  onSplitEntry,
  onSplitWithFriends,
  onAddDebtPayment,
  onPayBill,
}) => {
  // The last section opened is remembered on this device (a view preference, not synced).
  const [mode, setMode] = useState<FinanceMode>(() => {
    try {
      const saved = localStorage.getItem(MONEY_TAB_KEY);
      return MONEY_TABS.some((tab) => tab.mode === saved) ? (saved as FinanceMode) : 'ledger';
    } catch {
      return 'ledger';
    }
  });
  const tabStripRef = useRef<HTMLDivElement>(null);
  const selectMode = (next: FinanceMode) => {
    setMode(next);
    setSavingsDetailId(null);
    if (next === 'monthly' || next === 'savings') setSelectedMonth(toMonthKey(selectedDate));
    try {
      localStorage.setItem(MONEY_TAB_KEY, next);
    } catch {
      // Private mode or blocked storage: the tab just is not remembered.
    }
  };
  // A tapped money reminder opens its section.
  useEffect(() => {
    if (requestedSection) selectMode(requestedSection.section);
    // selectMode is recreated each render; the request object is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSection]);
  // Keep the open section visible in the strip (on a phone most of it is off-screen).
  useEffect(() => {
    const strip = tabStripRef.current;
    const active = strip?.querySelector<HTMLElement>('[data-active]');
    if (!strip || !active) return;
    strip.scrollTo({ left: active.offsetLeft - strip.clientWidth / 2 + active.offsetWidth / 2 });
  }, [mode]);
  const [savingsDetailId, setSavingsDetailId] = useState<string | null>(null);
  // Savings-only banks live on the Savings page: their own entries stay out of the
  // spending views, the forecast and the reports (Savings and net worth use all).
  const transactions = useMemo(
    () => ledgerTransactions(allTransactions, ledger.accounts),
    [allTransactions, ledger.accounts]
  );
  const [savingsDetailTx, setSavingsDetailTx] = useState<FinanceTransaction | null>(null);
  // Goal form: null = closed, 'new' = adding, a goal = editing it.
  const [goalForm, setGoalForm] = useState<MoneyGoal | 'new' | null>(null);

  /** "Pay me back": WhatsApp, the share sheet, or copy, with a UPI link when a UPI ID is set. */
  const remindFriend = async (debt: Debt) => {
    const settings = ledger.ledgerSettings[0];
    const message = reminderMessage({
      personName: debt.personName,
      amount: debtOutstanding(debt, todayString()),
      note: debt.note,
      upiId: settings?.upiId,
      payeeName: settings?.upiName,
    });
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const pick = await showChoice({
      title: `Remind ${debt.personName}`,
      message: settings?.upiId ? undefined : 'Add your UPI ID in Split with friends to include a pay link.',
      choices: [
        { value: 'whatsapp', label: 'WhatsApp' },
        ...(canShare ? [{ value: 'share', label: 'Share…' }] : []),
        { value: 'copy', label: 'Copy message' },
      ],
    });
    if (pick === 'whatsapp') {
      window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
    } else if (pick === 'share') {
      try {
        await navigator.share({ text: message });
      } catch {
        // Closed the share sheet: nothing to do.
      }
    } else if (pick === 'copy') {
      try {
        await navigator.clipboard.writeText(message);
        void showAlert({ title: 'Message copied', message: 'Paste it in any chat.', tone: 'success' });
      } catch {
        void showAlert({ title: 'Could not copy', message, tone: 'warning' });
      }
    }
  };
  const [detailTx, setDetailTx] = useState<FinanceTransaction | null>(null);
  // A transfer opens the transfer editor; the entry form would save it as an expense.
  const editAnyTransaction = (tx: FinanceTransaction) =>
    tx.type === 'transfer' ? ledger.onEditTransfer(tx) : onEditTransaction(tx);
  const [isSplitOpen, setIsSplitOpen] = useState(false);
  const [payingBill, setPayingBill] = useState<BillPayment | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(() => toMonthKey(selectedDate));
  const [budgetInput, setBudgetInput] = useState('');
  const [isEditingBudget, setIsEditingBudget] = useState(false);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<FilterPayment>('all');
  const [showFilters, setShowFilters] = useState(false);

  // Category budget editor
  const [catBudgetCategory, setCatBudgetCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [catBudgetAmount, setCatBudgetAmount] = useState('');
  const [addingCatBudget, setAddingCatBudget] = useState(false);

  // Savings goal editor
  const [savingsInput, setSavingsInput] = useState('');
  const [isEditingSavings, setIsEditingSavings] = useState(false);

  // Debt filter
  const [debtFilter, setDebtFilter] = useState<DebtFilter>('outstanding');

  // Bills sub-view
  const [billsSubView, setBillsSubView] = useState<BillsSubView>('payments');
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [paymentAmountInput, setPaymentAmountInput] = useState('');

  const todayStr = todayString();

  const dailyTx = useMemo(
    () =>
      transactions
        .filter((t) => t.date === selectedDate)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [transactions, selectedDate]
  );

  const dailyExpense = dailyTx
    .filter((t) => countsAsSpending(t))
    .reduce((s, t) => s + t.amount, 0);
  const dailyIncome = dailyTx
    .filter((t) => countsAsIncome(t))
    .reduce((s, t) => s + t.amount, 0);

  const monthlyTx = useMemo(
    () =>
      transactions
        .filter((t) => t.date.startsWith(selectedMonth))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [transactions, selectedMonth]
  );

  const monthlyExpense = monthlyTx
    .filter((t) => countsAsSpending(t))
    .reduce((s, t) => s + t.amount, 0);
  const monthlyIncome = monthlyTx
    .filter((t) => countsAsIncome(t))
    .reduce((s, t) => s + t.amount, 0);
  const monthlyNet = monthlyIncome - monthlyExpense;

  const categoryBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    monthlyTx
      .filter((t) => countsAsSpending(t))
      .forEach((t) => map.set(t.category, (map.get(t.category) || 0) + t.amount));
    return Array.from(map.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [monthlyTx]);

  const currentBudget = effectiveMonthlyBudget(budgets, selectedMonth);
  const budgetLimit = currentBudget?.limit ?? 0;
  const budgetUsedPct =
    budgetLimit > 0 ? Math.min(100, Math.round((monthlyExpense / budgetLimit) * 100)) : 0;
  const budgetRemaining = budgetLimit - monthlyExpense;

  const monthCategoryBudgets = useMemo(
    () => effectiveCategoryBudgets(categoryBudgets, selectedMonth),
    [categoryBudgets, selectedMonth]
  );

  const recentCats = useMemo(
    () => quickAddCategoryNames(recentExpenseCategories(transactions, 5), financeCategories),
    [transactions, financeCategories]
  );

  const filterCategoryNames = useMemo(() => {
    const kind = typeFilter === 'all' ? 'all' : typeFilter;
    const used = transactions
      .filter((tx) => typeFilter === 'all' || tx.type === typeFilter)
      .map((tx) => tx.category);
    return financeCategoryNames(kind, financeCategories, used);
  }, [typeFilter, transactions, financeCategories]);

  useEffect(() => {
    if (categoryFilter === 'all') return;
    const stillThere = filterCategoryNames.some(
      (name) => name.toLowerCase() === categoryFilter.toLowerCase()
    );
    if (!stillThere) setCategoryFilter('all');
  }, [categoryFilter, filterCategoryNames]);

  const expenseCategoryNames = useMemo(
    () => financeCategoryNames('expense', financeCategories),
    [financeCategories]
  );
  const incomeCategoryNames = useMemo(
    () => financeCategoryNames('income', financeCategories),
    [financeCategories]
  );
  const spendableAccounts = useMemo(
    () => ledger.accounts.filter((account) => !account.isArchived && !account.savingsOnly),
    [ledger.accounts]
  );
  const defaultAccountId = resolveDefaultAccountId(ledger.accounts, ledger.ledgerSettings[0]) ?? undefined;

  // The current month, whatever month the views are showing.
  const outlookToday = todayString();
  const forecast = useMemo(
    () =>
      forecastMonth({
        today: outlookToday,
        transactions,
        accounts: ledger.accounts,
        billTemplates,
        billPayments,
        budget: effectiveMonthlyBudget(budgets, outlookToday.slice(0, 7))?.limit ?? null,
      }),
    [outlookToday, transactions, ledger.accounts, billTemplates, billPayments, budgets]
  );

  useEffect(() => {
    if (expenseCategoryNames.some((name) => name.toLowerCase() === catBudgetCategory.toLowerCase())) return;
    setCatBudgetCategory('Other');
  }, [expenseCategoryNames, catBudgetCategory]);

  const applyFilters = (list: FinanceTransaction[]) =>
    list.filter((t) => {
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (categoryFilter !== 'all' && t.category !== categoryFilter) return false;
      if (paymentFilter !== 'all' && t.paymentMethod !== paymentFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const inCategory = t.category.toLowerCase().includes(q);
        const inNote = (t.note || '').toLowerCase().includes(q);
        if (!inCategory && !inNote) return false;
      }
      return true;
    });

  const filteredDailyTx = applyFilters(dailyTx);
  const filteredMonthlyTx = applyFilters(monthlyTx);

  const hasActiveFilters =
    typeFilter !== 'all' ||
    categoryFilter !== 'all' ||
    paymentFilter !== 'all' ||
    searchQuery !== '';

  const clearFilters = () => {
    setTypeFilter('all');
    setCategoryFilter('all');
    setPaymentFilter('all');
    setSearchQuery('');
  };

  const handleSaveBudget = () => {
    const parsed = parseFloat(budgetInput);
    if (!parsed || parsed <= 0 || Number.isNaN(parsed)) return;
    onSetBudget(selectedMonth, Math.round(parsed * 100) / 100);
    setIsEditingBudget(false);
    setBudgetInput('');
  };

  const openBudgetEdit = () => {
    setBudgetInput(budgetLimit > 0 ? String(budgetLimit) : '');
    setIsEditingBudget(true);
  };

  const handleAddCategoryBudget = () => {
    const parsed = parseFloat(catBudgetAmount);
    if (!parsed || parsed <= 0 || Number.isNaN(parsed)) return;
    onSetCategoryBudget(
      selectedMonth,
      catBudgetCategory,
      Math.round(parsed * 100) / 100
    );
    setCatBudgetAmount('');
    setAddingCatBudget(false);
  };

  // Insights: weekly, MoM, daily chart, savings
  const last7Days = useMemo(() => getLast7DaysData(transactions), [transactions]);
  const prev7Totals = useMemo(() => getPrev7DaysTotals(transactions), [transactions]);
  const week7Expense = last7Days.reduce((s, d) => s + d.expense, 0);
  const week7Avg = week7Expense / 7;
  const week7DeltaPct =
    prev7Totals.expense > 0
      ? Math.round(((week7Expense - prev7Totals.expense) / prev7Totals.expense) * 100)
      : null;

  const dailySpendMonth = useMemo(
    () => getDailySpendForMonth(transactions, selectedMonth),
    [transactions, selectedMonth]
  );
  const maxDailySpend = useMemo(
    () => Math.max(...dailySpendMonth.map((d) => d.amount), 1),
    [dailySpendMonth]
  );

  const prevMonthKey = useMemo(
    () => shiftMonth(selectedMonth, -1),
    [selectedMonth]
  );
  const momCompare = useMemo(
    () => getMonthOverMonthCompare(transactions, selectedMonth, prevMonthKey),
    [transactions, selectedMonth, prevMonthKey]
  );

  const currentSavingsGoal = savingsGoals.find((g) => g.month === selectedMonth);
  const savingsTarget = currentSavingsGoal?.target ?? 0;

  const handleSaveSavingsGoal = () => {
    const parsed = parseFloat(savingsInput);
    if (!parsed || parsed <= 0 || Number.isNaN(parsed)) return;
    onSetSavingsGoal(selectedMonth, Math.round(parsed * 100) / 100);
    setIsEditingSavings(false);
    setSavingsInput('');
  };

  const openSavingsEdit = () => {
    setSavingsInput(savingsTarget > 0 ? String(savingsTarget) : '');
    setIsEditingSavings(true);
  };

  // Debts
  const filteredDebts = useMemo(() => {
    const sorted = [...debts].sort((a, b) => {
      if (a.paid !== b.paid) return a.paid ? 1 : -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    if (debtFilter === 'outstanding') return sorted.filter((d) => !d.paid);
    if (debtFilter === 'settled') return sorted.filter((d) => d.paid);
    return sorted;
  }, [debts, debtFilter]);

  // What is still unpaid (part payments and loan EMIs counted), summed in paise.
  const today = todayString();
  const outstandingLent = debts
    .filter((d) => d.direction === 'lent' && !d.paid)
    .map((d) => ({ amount: debtOutstanding(d, today) }))
    .reduce(addRupees, 0);
  const outstandingOwed = debts
    .filter((d) => d.direction === 'owed' && !d.paid)
    .map((d) => ({ amount: debtOutstanding(d, today) }))
    .reduce(addRupees, 0);
  const debtNet = fromPaise(toPaise(outstandingLent) - toPaise(outstandingOwed));

  // Bills
  const monthBillPayments = useMemo(
    () =>
      billPayments
        .filter((p) => p.month === selectedMonth)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [billPayments, selectedMonth]
  );
  const billsTotalDue = monthBillPayments.reduce((s, p) => s + p.amount, 0);
  const billsPaidTotal = monthBillPayments
    .filter((p) => p.paid)
    .reduce((s, p) => s + p.amount, 0);
  const billsUnpaidCount = monthBillPayments.filter((p) => !p.paid).length;

  const startEditingPayment = (payment: BillPayment) => {
    setEditingPaymentId(payment.id);
    setPaymentAmountInput(String(payment.amount));
  };

  const submitPaymentAmount = (payment: BillPayment) => {
    const parsed = parseFloat(paymentAmountInput);
    if (parsed && parsed > 0 && !Number.isNaN(parsed)) {
      onUpdateBillPaymentAmount(payment, Math.round(parsed * 100) / 100);
    }
    setEditingPaymentId(null);
    setPaymentAmountInput('');
  };

  // Savings: new money into savings, gold, or stocks, plus older unlinked logs.
  const savingsToday = todayString();
  const countedSavings = useMemo(
    () => countedSavingsAmounts(savingsEntries, allTransactions, ledger.accounts),
    [savingsEntries, allTransactions, ledger.accounts]
  );
  const savingsHeatmap = useMemo(
    () => getLastNDaysHeatmap(countedSavings, 30),
    [countedSavings]
  );
  const heatmapMax = useMemo(
    () => savingsHeatmap.reduce((m, d) => Math.max(m, d.amount), 0),
    [savingsHeatmap]
  );
  const monthSavingsTotal = useMemo(
    () => getMonthlySavingsTotal(countedSavings, selectedMonth),
    [countedSavings, selectedMonth]
  );
  // The savings goal counts money moved into savings this month, as the Savings page does.
  const savingsProgress = useMemo(
    () => getSavingsProgress(monthSavingsTotal, savingsTarget),
    [monthSavingsTotal, savingsTarget]
  );
  const monthSavedDays = useMemo(
    () => getMonthlySavedDays(countedSavings, selectedMonth),
    [countedSavings, selectedMonth]
  );
  const monthSavingsList = useMemo(
    () => savingsRowsForMonth(savingsEntries, allTransactions, ledger.accounts, selectedMonth),
    [savingsEntries, allTransactions, ledger.accounts, selectedMonth]
  );
  const bucketBalances = useMemo(() => {
    const balances = computeAccountBalances(ledger.accounts, allTransactions);
    return bucketAccounts(ledger.accounts).map((account) => ({
      account,
      paise: balances.get(account.id) || 0,
    }));
  }, [ledger.accounts, allTransactions]);
  const savingsCandidates = useMemo(() => savingsOnlyCandidates(ledger.accounts), [ledger.accounts]);
  const savingsDetailAccount = savingsDetailId
    ? ledger.accounts.find((account) => account.id === savingsDetailId) ?? null
    : null;
  const daysInMonth = new Date(
    parseInt(selectedMonth.slice(0, 4)),
    parseInt(selectedMonth.slice(5, 7)),
    0
  ).getDate();
  const savedToday = countedSavings.some((entry) => entry.date === savingsToday && entry.amount > 0);
  const currentStreak = savingsStreak.currentStreak;
  const longestStreak = savingsStreak.longestStreak;
  const SAVINGS_QUICK_AMOUNTS = [50, 100, 200, 500];

  return (
    <div className="max-w-4xl lg:max-w-6xl mx-auto space-y-5 pb-20 lg:pb-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Wallet className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <span>Personal Finance</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Accounts, ledger, budgets and savings
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={onAddTransaction} className="self-start sm:self-auto">
          <Plus className="w-4 h-4" />
          Add Entry
        </Button>
      </div>

      {BankSmsInbox && (
        <Suspense fallback={null}>
          <BankSmsInbox
            accounts={ledger.accounts}
            transactions={transactions}
            financeCategories={financeCategories}
            onConfirm={onConfirmBankSms}
          />
        </Suspense>
      )}

      {/* Alert banner */}
      {financeAlerts.length > 0 && (
        <FinanceAlertBanner alerts={financeAlerts} onDismiss={onDismissAlert} />
      )}

      {/* Fast entry and the month ahead (not on the planning tabs) */}
      {mode !== 'reports' && mode !== 'debts' && mode !== 'bills' && (
        <QuickEntryBar
          accounts={spendableAccounts}
          transactions={transactions}
          expenseCategories={expenseCategoryNames}
          incomeCategories={incomeCategoryNames}
          today={outlookToday}
          onSave={onQuickEntry}
          onSplit={() => setIsSplitOpen(true)}
        />
      )}
      {spendableAccounts.length > 0 && (mode === 'ledger' || mode === 'daily' || mode === 'monthly') && (
        <MonthOutlook forecast={forecast} />
      )}
      <MoneyGoalModal
        isOpen={goalForm !== null}
        goal={goalForm === 'new' ? null : goalForm}
        accounts={[...bucketAccounts(ledger.accounts)].sort((a, b) => Number(Boolean(b.savingsOnly)) - Number(Boolean(a.savingsOnly)))}
        onClose={() => setGoalForm(null)}
        onSave={onSaveMoneyGoal}
        onDelete={onDeleteMoneyGoal}
      />
      <TransactionDetailModal
        tx={savingsDetailTx}
        accounts={ledger.accounts}
        onClose={() => setSavingsDetailTx(null)}
        onEdit={onEditSavingsTransfer}
        onDelete={onDeleteTransaction}
      />
      <TransactionDetailModal
        tx={detailTx}
        accounts={ledger.accounts}
        onClose={() => setDetailTx(null)}
        onEdit={editAnyTransaction}
        onDelete={onDeleteTransaction}
      />
      <BillPayModal
        payment={payingBill}
        template={payingBill ? billTemplates.find((bill) => bill.id === payingBill.billId) : undefined}
        accounts={spendableAccounts}
        defaultAccountId={defaultAccountId}
        today={outlookToday}
        onClose={() => setPayingBill(null)}
        onPay={onPayBill}
      />
      <SplitEntryModal
        isOpen={isSplitOpen}
        accounts={spendableAccounts}
        expenseCategories={expenseCategoryNames}
        today={outlookToday}
        onClose={() => setIsSplitOpen(false)}
        onSave={onSplitEntry}
        onSaveWithFriends={onSplitWithFriends}
        upiId={ledger.ledgerSettings[0]?.upiId}
        onSaveUpiId={(upiId) => ledger.onUpdateLedgerSettings({ upiId })}
      />

      {/* Ledger / Daily / Weekly / Monthly / Bills / Debts / Savings + Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative max-w-full">
          <div
            ref={tabStripRef}
            role="tablist"
            aria-label="Money sections"
            className="flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 max-w-full overflow-x-auto no-scrollbar"
          >
            {MONEY_TABS.map(({ mode: tab, label, icon: Icon }) => {
              const active = mode === tab;
              return (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={active}
                  data-active={active || undefined}
                  onClick={() => selectMode(tab)}
                  className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors shrink-0 ${
                    active
                      ? `bg-white dark:bg-slate-700 shadow-sm ${
                          tab === 'savings' ? 'text-emerald-700 dark:text-emerald-300' : 'text-indigo-700 dark:text-indigo-300'
                        }`
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
          {/* Fade at the right edge says the strip scrolls. */}
          <div className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-xl bg-gradient-to-l from-slate-100 dark:from-slate-800 to-transparent sm:hidden" aria-hidden="true" />
        </div>

        {mode !== 'debts' && mode !== 'bills' && mode !== 'savings' && mode !== 'ledger' && mode !== 'reports' && (
          <button
            onClick={() => setShowFilters((s) => !s)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition-colors ${
              showFilters || hasActiveFilters
                ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Search className="w-3.5 h-3.5" />
            Filters
            {hasActiveFilters && (
              <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-indigo-600 text-white text-[9px] font-black">
                {[typeFilter, categoryFilter, paymentFilter].filter((v) => v !== 'all').length + (searchQuery ? 1 : 0)}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Filter bar */}
      {showFilters && (
        <Card className="p-3 space-y-2.5">
          <div className="relative w-full">
            <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by category or note..."
              className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 rounded-xl pl-9 pr-8 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 min-h-[40px]"
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

          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 snap-x touch-pan-x">
            <Dropdown
              value={typeFilter}
              onChange={(v) => setTypeFilter(v as FilterType)}
              title="Filter by Type"
              options={[
                { value: 'all', label: 'All Types' },
                { value: 'expense', label: 'Expenses' },
                { value: 'income', label: 'Income' },
              ]}
            />
            <Dropdown
              value={categoryFilter}
              onChange={setCategoryFilter}
              title="Filter by Category"
              options={[
                { value: 'all', label: 'All Categories' },
                ...filterCategoryNames.map((c) => ({ value: c, label: c })),
              ]}
            />
            <Dropdown
              value={paymentFilter}
              onChange={(v) => setPaymentFilter(v as FilterPayment)}
              title="Filter by Payment"
              options={[
                { value: 'all', label: 'All Payments' },
                ...ALL_PAYMENT_METHODS.map((p) => ({ value: p.value, label: `${p.emoji} ${p.label}` })),
              ]}
            />
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-xs text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 underline shrink-0 px-1"
              >
                Clear all
              </button>
            )}
          </div>
        </Card>
      )}

      {/* ============ MONEY LEDGER ============ */}
      {mode === 'ledger' && <LedgerView {...ledger} />}

      {/* ============ REPORTS ============ */}
      {mode === 'reports' && (
        <MoneyReports
          transactions={transactions}
          allTransactions={allTransactions}
          accounts={ledger.accounts}
          debts={debts}
          billPayments={billPayments}
          today={outlookToday}
        />
      )}

      {/* ============ WEEKLY VIEW ============ */}
      {mode === 'weekly' && (
        <>
          {/* Week KPIs */}
          <div className="grid grid-cols-3 gap-3">
            <Card className="p-3 sm:p-4">
              <div className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400 text-[10px] sm:text-xs font-semibold mb-1">
                <ArrowDownCircle className="w-3.5 h-3.5" />
                7-day Spent
              </div>
              <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                {formatMoney(week7Expense)}
              </p>
            </Card>
            <Card className="p-3 sm:p-4">
              <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                Daily Avg
              </div>
              <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                {formatMoney(week7Avg)}
              </p>
            </Card>
            <Card className="p-3 sm:p-4">
              <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                vs previous 7 days
              </div>
              <p
                className={`text-base sm:text-xl font-black truncate ${
                  week7DeltaPct === null
                    ? 'text-slate-400'
                    : week7DeltaPct > 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : week7DeltaPct < 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {week7DeltaPct === null
                  ? '—'
                  : `${week7DeltaPct > 0 ? '+' : ''}${week7DeltaPct}%`}
              </p>
            </Card>
          </div>

          {/* 7-day bar chart */}
          <Card className="p-5">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Last 7 Days Spending</span>
            </h3>
            <div className="flex items-end justify-between gap-2 h-40 pt-2">
              {last7Days.map((d) => {
                const maxVal = Math.max(...last7Days.map((x) => x.expense), 1);
                const heightPercent = (d.expense / maxVal) * 100;
                return (
                  <div
                    key={d.dateStr}
                    className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end"
                  >
                    <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 font-bold">
                      {d.expense > 0 ? formatMoney(d.expense).replace('₹', '') : ''}
                    </span>
                    <div className="w-full max-w-[32px] bg-slate-100 dark:bg-slate-900 rounded-t-lg overflow-hidden flex flex-col justify-end h-full border border-slate-200 dark:border-slate-800">
                      <div
                        className="w-full bg-indigo-500 dark:bg-indigo-400 rounded-t-lg transition-all duration-300"
                        style={{ height: `${heightPercent}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 uppercase">
                      {d.dayLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Last 7 days transactions */}
          {last7Days.some((d) => d.expense > 0 || d.income > 0) ? (
            <div className="space-y-3">
              {[...last7Days].reverse().map((d) => {
                const dayTx = transactions
                  .filter((t) => t.date === d.dateStr)
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                if (dayTx.length === 0) return null;
                return (
                  <div key={d.dateStr} className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                        {new Date(d.dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                      <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                        {formatMoney(d.expense)} spent
                      </span>
                    </div>
                    {dayTx.map((tx) => (
                      <TransactionRow
                        key={tx.id}
                        tx={tx}
                        accountName={ledger.accounts.find((a) => a.id === tx.accountId)?.name}
                        destinationName={
                          ledger.accounts.find((a) => a.id === tx.destinationAccountId)?.name
                        }
                        onOpen={setDetailTx}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              message="No transactions in the last 7 days"
              hint="Start logging expenses to see your weekly trends."
              onAdd={onAddTransaction}
            />
          )}
        </>
      )}

      {/* ============ DAILY VIEW ============ */}
      {mode === 'daily' && (
        <>
          {/* Date navigator */}
          <Card className="p-3 flex items-center justify-between gap-2">
            <button
              onClick={() => onSelectDate(shiftDate(selectedDate, -1))}
              className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="text-center flex-1">
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => onSelectDate(e.target.value)}
                className="bg-transparent text-center font-bold text-sm text-slate-900 dark:text-white focus:outline-none"
              />
              {selectedDate === todayStr && (
                <span className="block text-[10px] uppercase tracking-wider font-bold text-indigo-600 dark:text-indigo-400">
                  Today
                </span>
              )}
            </div>
            <button
              onClick={() => onSelectDate(shiftDate(selectedDate, 1))}
              className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </Card>

          {/* Daily KPIs */}
          <div className="grid grid-cols-3 gap-3">
            <Card className="p-3 sm:p-4">
              <div className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400 text-[10px] sm:text-xs font-semibold mb-1">
                <ArrowDownCircle className="w-3.5 h-3.5" />
                Spent
              </div>
              <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                {formatMoney(dailyExpense)}
              </p>
            </Card>
            <Card className="p-3 sm:p-4">
              <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-[10px] sm:text-xs font-semibold mb-1">
                <ArrowUpCircle className="w-3.5 h-3.5" />
                Earned
              </div>
              <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                {formatMoney(dailyIncome)}
              </p>
            </Card>
            <Card className="p-3 sm:p-4">
              <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                Left over
              </div>
              <p
                className={`text-base sm:text-xl font-black truncate ${
                  dailyIncome - dailyExpense >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                {formatMoney(dailyIncome - dailyExpense)}
              </p>
            </Card>
          </div>

          {/* Quick-add shortcuts */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Quick add
              </span>
              {QUICK_ADD_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => {
                    if (recentCats[0]) onQuickAdd(amt, recentCats[0]);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
                  title={`Add ₹${amt} to ${recentCats[0] || 'category'}`}
                >
                  +₹{amt}
                </button>
              ))}
              <button
                onClick={onAddTransaction}
                className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-dashed border-slate-300 dark:border-slate-600 text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors"
              >
                Custom...
              </button>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Category
              </span>
              {recentCats.map((c) => (
                <button
                  key={c}
                  onClick={() => onQuickAdd(QUICK_ADD_AMOUNTS[1], c)}
                  className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
                  title={`Add ₹${QUICK_ADD_AMOUNTS[1]} to ${c}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* Daily transaction list */}
          {filteredDailyTx.length > 0 ? (
            <div className="space-y-2">
              {filteredDailyTx.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  accountName={ledger.accounts.find((a) => a.id === tx.accountId)?.name}
                  destinationName={
                    ledger.accounts.find((a) => a.id === tx.destinationAccountId)?.name
                  }
                  onOpen={setDetailTx}
                />
              ))}
            </div>
          ) : dailyTx.length > 0 ? (
            <div className="text-center py-8 px-4 bg-white/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-slate-800 rounded-2xl">
              <p className="text-sm font-bold text-slate-700 dark:text-slate-300">No matches</p>
              <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                Try clearing filters to see all transactions for this day.
              </p>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="mt-3 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <EmptyState
              message="No transactions for this day"
              hint="Log an expense or income to start tracking."
              onAdd={onAddTransaction}
            />
          )}
        </>
      )}

      {/* ============ MONTHLY VIEW ============ */}
      {mode === 'monthly' && (
        <>
          {/* Month navigator */}
          <Card className="p-3 flex items-center justify-between gap-2">
            <button
              onClick={() => setSelectedMonth(shiftMonth(selectedMonth, -1))}
              className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="text-center flex-1">
              <p className="font-bold text-sm text-slate-900 dark:text-white">
                {monthLabel(selectedMonth)}
              </p>
            </div>
            <button
              onClick={() => setSelectedMonth(shiftMonth(selectedMonth, 1))}
              className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </Card>

          {/* Monthly KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card className="p-4">
              <div className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400 text-xs font-semibold mb-1">
                <ArrowDownCircle className="w-4 h-4" />
                Expenses
              </div>
              <p className="text-xl font-black text-slate-900 dark:text-white">
                {formatMoney(monthlyExpense)}
              </p>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-semibold mb-1">
                <ArrowUpCircle className="w-4 h-4" />
                Income
              </div>
              <p className="text-xl font-black text-slate-900 dark:text-white">
                {formatMoney(monthlyIncome)}
              </p>
            </Card>
            <Card className="p-4">
              <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Left over</div>
              <p
                className={`text-xl font-black ${
                  monthlyNet >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                {formatMoney(monthlyNet)}
              </p>
            </Card>
            <Card className="p-4">
              <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                Entries
              </div>
              <p className="text-xl font-black text-slate-900 dark:text-white">{monthlyTx.length}</p>
            </Card>
          </div>

          <MonthlyReportCard transactions={transactions} accounts={ledger.accounts} month={selectedMonth} />

          {/* Daily spend chart */}
          {dailySpendMonth.some((d) => d.amount > 0) && (
            <Card className="p-5">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>Daily Spend — {monthLabel(selectedMonth)}</span>
              </h3>
              <div className="flex items-end justify-between gap-0.5 h-32 pt-2 overflow-x-auto no-scrollbar">
                {dailySpendMonth.map((d) => {
                  const heightPercent = (d.amount / maxDailySpend) * 100;
                  return (
                    <div
                      key={d.date}
                      className="flex-1 min-w-[6px] flex flex-col items-center justify-end h-full group relative"
                      title={`${d.date}: ${formatMoney(d.amount)}`}
                    >
                      <div
                        className="w-full bg-indigo-500 dark:bg-indigo-400 rounded-t transition-all duration-200 hover:bg-indigo-600"
                        style={{ height: `${heightPercent}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] text-slate-500 dark:text-slate-400 mt-2">
                <span>1</span>
                <span>{Math.ceil(dailySpendMonth.length / 2)}</span>
                <span>{dailySpendMonth.length}</span>
              </div>
            </Card>
          )}

          {/* Month-over-month compare */}
          {momCompare.overall.prev > 0 && (
            <Card className="p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>vs Last Month</span>
              </h3>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-400">Overall</span>
                <span
                  className={`font-bold ${
                    momCompare.overall.pctChange === null
                      ? 'text-slate-500'
                      : momCompare.overall.pctChange > 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : momCompare.overall.pctChange < 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-slate-500'
                  }`}
                >
                  {formatMoney(momCompare.overall.prev)} → {formatMoney(momCompare.overall.current)}
                  {momCompare.overall.pctChange !== null && (
                    <span className="ml-1">
                      ({momCompare.overall.pctChange > 0 ? '+' : ''}
                      {momCompare.overall.pctChange}%)
                    </span>
                  )}
                </span>
              </div>
              <div className="space-y-2">
                {momCompare.byCategory.slice(0, 3).map((c) => (
                  <div
                    key={c.category}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="font-semibold text-slate-700 dark:text-slate-300 truncate flex-1">
                      {c.category}
                    </span>
                    <span
                      className={`font-bold ${
                        c.pctChange === null
                          ? 'text-slate-500'
                          : c.pctChange > 0
                          ? 'text-rose-600 dark:text-rose-400'
                          : c.pctChange < 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-slate-500'
                      }`}
                    >
                      {formatMoney(c.prev)} → {formatMoney(c.current)}
                      {c.pctChange !== null && (
                        <span className="ml-1">
                          ({c.pctChange > 0 ? '+' : ''}
                          {c.pctChange}%)
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Savings goal card */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <PiggyBank className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                Savings Goal
              </h3>
              {!isEditingSavings && (
                <button
                  onClick={openSavingsEdit}
                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {savingsTarget > 0 ? 'Edit' : 'Set goal'}
                </button>
              )}
            </div>

            {isEditingSavings ? (
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-bold">
                    ₹
                  </span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={savingsInput}
                    onChange={(e) => setSavingsInput(e.target.value)}
                    placeholder="e.g. 15000"
                    className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    autoFocus
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={handleSaveSavingsGoal}>
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setIsEditingSavings(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : savingsTarget > 0 ? (
              <>
                <div className="flex items-end justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">
                    {formatMoney(savingsProgress.saved)} moved to savings of {formatMoney(savingsTarget)}
                  </span>
                  {savingsProgress.met ? (
                    <span className="font-bold text-emerald-600 dark:text-emerald-400">
                      Goal met
                    </span>
                  ) : (
                    <span className="font-bold text-slate-500 dark:text-slate-400">
                      {formatMoney(Math.max(0, savingsTarget - savingsProgress.saved))} to go
                    </span>
                  )}
                </div>
                <div className="h-2.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      savingsProgress.met
                        ? 'bg-emerald-500'
                        : 'bg-indigo-500'
                    }`}
                    style={{ width: `${savingsProgress.pct}%` }}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Set a monthly target for money you move into savings.
              </p>
            )}
          </Card>

          {/* Budget card */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Target className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                Monthly Budget
                {isCarriedOver(currentBudget, selectedMonth) && currentBudget && (
                  <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                    · from {new Date(`${currentBudget.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
                  </span>
                )}
              </h3>
              {!isEditingBudget && (
                <button
                  onClick={openBudgetEdit}
                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {budgetLimit > 0 ? 'Edit' : 'Set budget'}
                </button>
              )}
            </div>

            {isEditingBudget ? (
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-bold">
                    ₹
                  </span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    placeholder="e.g. 25000"
                    className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    autoFocus
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={handleSaveBudget}>
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setIsEditingBudget(false)}
                  >
                    Cancel
                  </Button>
                  {budgetLimit > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onSetBudget(selectedMonth, 0);
                        setIsEditingBudget(false);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ) : budgetLimit > 0 ? (
              <>
                <div className="flex items-end justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">
                    {formatMoney(monthlyExpense)} of {formatMoney(budgetLimit)}
                  </span>
                  <span
                    className={`font-bold ${
                      budgetRemaining >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {budgetRemaining >= 0
                      ? `${formatMoney(budgetRemaining)} left`
                      : `${formatMoney(Math.abs(budgetRemaining))} over`}
                  </span>
                </div>
                <div className="h-2.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      budgetUsedPct >= 100
                        ? 'bg-rose-500'
                        : budgetUsedPct >= 80
                        ? 'bg-amber-500'
                        : 'bg-indigo-500'
                    }`}
                    style={{ width: `${budgetUsedPct}%` }}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Set a monthly spending limit to track how much budget you have left.
              </p>
            )}
          </Card>

          {/* Category budgets */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Target className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                Category Budgets
              </h3>
              {!addingCatBudget && (
                <button
                  onClick={() => setAddingCatBudget(true)}
                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  + Add
                </button>
              )}
            </div>

            {addingCatBudget && (
              <div className="space-y-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                <div className="grid grid-cols-2 gap-2">
                  <CategorySelect
                    value={catBudgetCategory}
                    options={expenseCategoryNames}
                    onChange={setCatBudgetCategory}
                    onAdd={(name) => onAddFinanceCategory('expense', name)}
                    canDelete={isCustomFinanceCategory(catBudgetCategory, 'expense', financeCategories)}
                    onDelete={() => {
                      onDeleteFinanceCategory('expense', catBudgetCategory);
                      setCatBudgetCategory('Other');
                    }}
                    className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-bold">₹</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={catBudgetAmount}
                      onChange={(e) => setCatBudgetAmount(e.target.value)}
                      placeholder="Limit"
                      className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={handleAddCategoryBudget}>
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setAddingCatBudget(false);
                      setCatBudgetAmount('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {monthCategoryBudgets.length === 0 && !addingCatBudget ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Set category limits to see where you're over budget.
              </p>
            ) : (
              <div className="space-y-2.5">
                {monthCategoryBudgets.map((cb) => {
                  const spent = categoryBreakdown.find((c) => c.category === cb.category)?.amount || 0;
                  const pct = cb.limit > 0 ? Math.min(100, Math.round((spent / cb.limit) * 100)) : 0;
                  const over = spent > cb.limit;
                  const remaining = cb.limit - spent;
                  return (
                    <div key={cb.id}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          {cb.category}
                        </span>
                        <span className={`font-bold ${over ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
                          {formatMoney(spent)} / {formatMoney(cb.limit)}
                          {over
                            ? ` · ${formatMoney(Math.abs(remaining))} over`
                            : remaining > 0
                            ? ` · ${formatMoney(remaining)} left`
                            : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${over ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-indigo-500'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <button
                          onClick={() => onRemoveCategoryBudget(selectedMonth, cb.category)}
                          className="p-1 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                          title="Remove budget"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Category breakdown */}
          {categoryBreakdown.length > 0 && (
            <Card className="p-4 space-y-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Spending by Category
              </h3>
              <div className="space-y-2.5">
                {categoryBreakdown.map(({ category, amount }) => {
                  const pct = monthlyExpense > 0 ? Math.round((amount / monthlyExpense) * 100) : 0;
                  return (
                    <div key={category}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          {category}
                        </span>
                        <span className="text-slate-500 dark:text-slate-400">
                          {formatMoney(amount)} · {pct}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-indigo-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Monthly transaction list */}
          {filteredMonthlyTx.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white px-0.5">
                All Transactions
                {hasActiveFilters && (
                  <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
                    {filteredMonthlyTx.length} of {monthlyTx.length}
                  </span>
                )}
              </h3>
              {filteredMonthlyTx.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  showDate
                  accountName={ledger.accounts.find((a) => a.id === tx.accountId)?.name}
                  destinationName={
                    ledger.accounts.find((a) => a.id === tx.destinationAccountId)?.name
                  }
                  onOpen={setDetailTx}
                />
              ))}
            </div>
          ) : monthlyTx.length > 0 ? (
            <div className="text-center py-8 px-4 bg-white/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-slate-800 rounded-2xl">
              <p className="text-sm font-bold text-slate-700 dark:text-slate-300">No matches</p>
              <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                Try clearing filters to see all transactions this month.
              </p>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="mt-3 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <EmptyState
              message="No transactions this month"
              hint="Add daily expenses to see your monthly summary."
              onAdd={onAddTransaction}
            />
          )}
        </>
      )}

      {/* ============ BILLS VIEW ============ */}
      {mode === 'bills' && (
        <>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Receipt className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>Monthly Bills</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Recurring bills auto-generated each month. Tick as paid to log the expense.
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={onAddBillTemplate}>
              <Plus className="w-4 h-4" />
              Add Bill
            </Button>
          </div>

          {/* Sub-view toggle: Payments vs Templates */}
          <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <button
              onClick={() => setBillsSubView('payments')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                billsSubView === 'payments'
                  ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Payments
            </button>
            <button
              onClick={() => setBillsSubView('templates')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                billsSubView === 'templates'
                  ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Templates
            </button>
          </div>

          {billsSubView === 'payments' ? (
            <>
              {/* Month navigator */}
              <Card className="p-3 flex items-center justify-between gap-2">
                <button
                  onClick={() => setSelectedMonth(shiftMonth(selectedMonth, -1))}
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="text-center flex-1">
                  <p className="font-bold text-sm text-slate-900 dark:text-white">
                    {monthLabel(selectedMonth)}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedMonth(shiftMonth(selectedMonth, 1))}
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </Card>

              {/* Bills KPIs */}
              <div className="grid grid-cols-3 gap-3">
                <Card className="p-3 sm:p-4">
                  <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                    Total Due
                  </div>
                  <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                    {formatMoney(billsTotalDue)}
                  </p>
                </Card>
                <Card className="p-3 sm:p-4">
                  <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-[10px] sm:text-xs font-semibold mb-1">
                    <Check className="w-3.5 h-3.5" />
                    Paid
                  </div>
                  <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                    {formatMoney(billsPaidTotal)}
                  </p>
                </Card>
                <Card className="p-3 sm:p-4">
                  <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 text-[10px] sm:text-xs font-semibold mb-1">
                    <AlertCircle className="w-3.5 h-3.5" />
                    Unpaid
                  </div>
                  <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                    {billsUnpaidCount}
                  </p>
                </Card>
              </div>

              {/* Bills list */}
              {monthBillPayments.length > 0 ? (
                <div className="space-y-2">
                  {monthBillPayments.map((payment) => {
                    const template = billTemplates.find((t) => t.id === payment.billId);
                    const isOverdue = !payment.paid && payment.dueDate < todayStr;
                    return (
                      <Card
                        key={payment.id}
                        className={`p-3 flex items-center gap-3 transition-opacity ${
                          payment.paid ? 'opacity-60' : ''
                        }`}
                      >
                        <button
                          aria-label={payment.paid ? 'Mark unpaid' : 'Pay this bill'}
                          onClick={() => (payment.paid ? onToggleBillPaid(payment) : setPayingBill(payment))}
                          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border-2 transition-colors ${
                            payment.paid
                              ? 'bg-emerald-500 border-emerald-500 text-white'
                              : 'bg-slate-50 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-300 hover:border-emerald-400'
                          }`}
                          title={payment.paid ? 'Mark as unpaid' : 'Mark as paid'}
                        >
                          <Check className="w-5 h-5" strokeWidth={3} />
                        </button>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-slate-900 dark:text-white truncate flex items-center gap-1.5">
                            {template?.name || 'Unknown Bill'}
                            {isOverdue && (
                              <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
                                Overdue
                              </span>
                            )}
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                            Due {new Date(payment.dueDate + 'T00:00:00').toLocaleDateString('en-IN', {
                              day: 'numeric',
                              month: 'short',
                            })}
                            {template?.category && <span> · {template.category}</span>}
                            {payment.note && <span> · {payment.note}</span>}
                          </p>
                        </div>
                        <div className="text-right shrink-0 flex items-center gap-1">
                          {editingPaymentId === payment.id ? (
                            <div className="flex items-center gap-1">
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 font-bold text-xs">₹</span>
                                <input
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  value={paymentAmountInput}
                                  onChange={(e) => setPaymentAmountInput(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') submitPaymentAmount(payment);
                                    if (e.key === 'Escape') {
                                      setEditingPaymentId(null);
                                      setPaymentAmountInput('');
                                    }
                                  }}
                                  className="w-20 bg-slate-100 dark:bg-slate-800 border border-indigo-300 dark:border-indigo-700 rounded-lg pl-6 pr-2 py-1 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                  autoFocus
                                />
                              </div>
                              <button
                                onClick={() => submitPaymentAmount(payment)}
                                className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                                title="Save amount"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEditingPayment(payment)}
                              className="text-sm font-black text-slate-900 dark:text-white hover:text-indigo-600 dark:hover:text-indigo-400"
                              title="Tap to edit amount"
                            >
                              {formatMoney(payment.amount)}
                            </button>
                          )}
                          {editingPaymentId !== payment.id && (
                            <div className="flex items-center gap-0.5 ml-1">
                              {template && (
                                <button
                                  onClick={() => onEditBillTemplate(template)}
                                  className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                                  title="Edit template"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12 px-4 bg-white/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-slate-800 rounded-2xl">
                  <Receipt className="w-12 h-12 text-slate-400 dark:text-slate-600 mx-auto mb-3" />
                  <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">
                    No bills for {monthLabel(selectedMonth)}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-500 mt-1 max-w-xs mx-auto">
                    {billTemplates.length === 0
                      ? 'Add a bill template (e.g. Electricity, Rent) to auto-generate monthly bills.'
                      : 'No active bill templates generate bills for this month.'}
                  </p>
                  <div className="mt-4 flex justify-center">
                    <Button variant="primary" size="sm" onClick={onAddBillTemplate}>
                      <Plus className="w-4 h-4" />
                      Add Bill Template
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Templates sub-view */
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  Bill Templates ({billTemplates.length})
                </h3>
                <Button variant="primary" size="sm" onClick={onAddBillTemplate}>
                  <Plus className="w-4 h-4" />
                  New Template
                </Button>
              </div>
              {billTemplates.length > 0 ? (
                <div className="space-y-2">
                  {billTemplates.map((template) => (
                    <Card key={template.id} className="p-3 flex items-center gap-3">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          template.active
                            ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-400'
                        }`}
                      >
                        <Receipt className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-900 dark:text-white truncate flex items-center gap-1.5">
                          {template.name}
                          {!template.active && (
                            <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                              Paused
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          Due day {template.dueDayOfMonth} · {template.category}
                          {template.note && <span> · {template.note}</span>}
                        </p>
                      </div>
                      <div className="text-right shrink-0 flex items-center gap-1">
                        <p className="text-sm font-black text-slate-900 dark:text-white">
                          {formatMoney(template.amount)}
                        </p>
                        <div className="flex items-center gap-0.5">
                          <button
                            onClick={() => onEditBillTemplate(template)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDeleteBillTemplate(template.id)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 px-4 bg-white/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-slate-800 rounded-2xl">
                  <Receipt className="w-12 h-12 text-slate-400 dark:text-slate-600 mx-auto mb-3" />
                  <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">
                    No bill templates yet
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-500 mt-1 max-w-xs mx-auto">
                    Add a bill once (rent, phone…) and it repeats every month.
                  </p>
                  <div className="mt-4 flex justify-center">
                    <Button variant="primary" size="sm" onClick={onAddBillTemplate}>
                      <Plus className="w-4 h-4" />
                      Add Bill Template
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ============ SAVINGS VIEW ============ */}
      {mode === 'savings' && savingsDetailAccount && (
        <AccountDetailView
          account={savingsDetailAccount}
          accounts={ledger.accounts}
          transactions={allTransactions}
          financeCategories={ledger.financeCategories}
          onBack={() => setSavingsDetailId(null)}
          onEditAccount={ledger.onEditAccount}
          onAddIncome={(id) => ledger.onAddIncome(id)}
          onAddExpense={(id) => ledger.onAddExpense(id)}
          onEditTransaction={ledger.onEditTransaction}
          onEditTransfer={ledger.onEditTransfer}
          onDeleteTransaction={ledger.onDeleteTransaction}
        />
      )}

      {mode === 'savings' && !savingsDetailAccount && (
        <>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <PiggyBank className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>Savings Habit</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                A day counts when new money lands in savings, gold or stocks.
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={onAddSavings}>
              <Plus className="w-4 h-4" />
              Log Savings
            </Button>
          </div>

          {/* Streak card */}
          <Card className="p-4 bg-gradient-to-br from-emerald-50 to-indigo-50 dark:from-emerald-950/30 dark:to-indigo-950/30 border-emerald-200/60 dark:border-emerald-900/40">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="text-4xl">{currentStreak > 0 ? '🔥' : '🌱'}</div>
                <div>
                  <p className="text-2xl font-black text-slate-900 dark:text-white leading-none">
                    {currentStreak} {currentStreak === 1 ? 'day' : 'days'}
                  </p>
                  <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 mt-1">
                    Current streak
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500 dark:text-slate-400">Longest</p>
                <p className="text-lg font-bold text-slate-900 dark:text-white">
                  {longestStreak} {longestStreak === 1 ? 'day' : 'days'}
                </p>
                {savingsStreak.lastSavedDate && (
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Last saved {new Date(savingsStreak.lastSavedDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-emerald-200/60 dark:border-emerald-900/40">
              {savedToday ? (
                <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5" />
                  You saved today — streak is safe!
                </p>
              ) : (
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Log a saving today to keep your streak alive.
                </p>
              )}
            </div>
          </Card>

          {bucketBalances.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {bucketBalances.map(({ account, paise }) => {
                const meta = accountTypeMeta(account.type);
                return (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => setSavingsDetailId(account.id)}
                    className="text-left rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    aria-label={`Open ${account.name} history`}
                  >
                    <Card className="p-3 sm:p-4 h-full hover:border-emerald-300 dark:hover:border-emerald-800 transition-colors">
                      <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 truncate">
                        {meta.emoji} {account.savingsOnly ? 'Future savings' : meta.label}
                      </div>
                      <p className="text-sm font-bold text-slate-900 dark:text-white truncate">{account.name}</p>
                      <p className="text-base sm:text-lg font-black text-emerald-700 dark:text-emerald-400 truncate">
                        {formatPaise(paise)}
                      </p>
                    </Card>
                  </button>
                );
              })}
            </div>
          ) : (
            <Card className="p-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Add a savings, gold or stocks account in the ledger first.
              </p>
            </Card>
          )}

          {/* Named goals */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300">Goals</h4>
              <button
                type="button"
                onClick={() => setGoalForm('new')}
                className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
              >
                + Add goal
              </button>
            </div>
            {moneyGoals.length === 0 ? (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Name what you are saving for, like an emergency fund.
              </p>
            ) : (
              <div className="space-y-2">
                {sortGoals(moneyGoals).map((goal) => {
                  const p = goalProgress(goal, ledger.accounts, allTransactions, savingsToday);
                  const by = goal.targetDate
                    ? new Date(`${goal.targetDate}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
                    : null;
                  return (
                    <button
                      key={goal.id}
                      type="button"
                      onClick={() => setGoalForm(goal)}
                      className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2.5 hover:border-emerald-300 dark:hover:border-emerald-800"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-slate-900 dark:text-white truncate">{goal.name}</span>
                        <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 shrink-0">{p.percent}%</span>
                      </div>
                      <div className="h-2 mt-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(2, p.percent)}%` }} />
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {formatMoney(p.saved)} of {formatMoney(p.target)}
                        {p.done
                          ? ' · reached'
                          : p.late
                            ? ` · date passed, ${formatMoney(p.left)} to go`
                            : p.perMonth != null && by
                              ? ` · ${formatMoney(p.perMonth)}/month to reach it by ${by}`
                              : ` · ${formatMoney(p.left)} to go`}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Banks kept for future savings */}
          {savingsCandidates.length > 0 && (
            <Card className="p-4">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300">Banks for future savings</h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Picked banks leave the Money ledger and show only here.
              </p>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {savingsCandidates.map((account) => {
                  const on = Boolean(account.savingsOnly);
                  return (
                    <label
                      key={account.id}
                      className={`flex items-center gap-2.5 px-3 py-2.5 min-h-[44px] rounded-xl border cursor-pointer transition-colors ${
                        on
                          ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800'
                          : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => onSetSavingsOnly(account.id, e.target.checked)}
                        className="w-4 h-4 accent-emerald-600"
                      />
                      <span className="flex-1 min-w-0 text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
                        {account.name}
                      </span>
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
                        {accountTypeMeta(account.type).label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Quick-add chips */}
          <div>
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
              Quick add today's saving:
            </p>
            <div className="flex flex-wrap gap-2">
              {SAVINGS_QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => onQuickAddSavings(amt)}
                  className="px-3.5 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold text-slate-700 dark:text-slate-300 hover:border-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
                >
                  +₹ {amt}
                </button>
              ))}
              <button
                onClick={onAddSavings}
                className="px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              >
                Custom...
              </button>
            </div>
          </div>

          {/* 30-day heatmap */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300">
                Last 30 days
              </h4>
              <span className="text-[10px] text-slate-500 dark:text-slate-400">
                {savingsHeatmap.filter((d) => d.saved).length} / 30 days saved
              </span>
            </div>
            <div className="grid grid-cols-10 sm:grid-cols-15 gap-1">
              {savingsHeatmap.map((d) => {
                const intensity = heatmapIntensity(d.amount, heatmapMax);
                const bg = d.saved
                  ? intensity >= 4
                    ? 'bg-emerald-600'
                    : intensity === 3
                    ? 'bg-emerald-500'
                    : intensity === 2
                    ? 'bg-emerald-400'
                    : 'bg-emerald-300'
                  : 'bg-slate-100 dark:bg-slate-800';
                return (
                  <div
                    key={d.date}
                    title={`${d.date}: ${d.saved ? formatMoney(d.amount) : 'No saving'}`}
                    className={`aspect-square rounded ${bg} ${d.date === savingsToday ? 'ring-2 ring-indigo-400' : ''}`}
                  />
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-2">
              Ring = today. Moves between savings accounts don't count.
            </p>
          </Card>

          {/* Month KPIs */}
          <div className="grid grid-cols-3 gap-3">
            <Card className="p-3 sm:p-4">
              <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                Saved this month
              </div>
              <p className="text-base sm:text-xl font-black text-emerald-700 dark:text-emerald-400 truncate">
                {formatMoney(monthSavingsTotal)}
              </p>
            </Card>
            <Card className="p-3 sm:p-4">
              <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                Days saved
              </div>
              <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                {monthSavedDays} / {daysInMonth}
              </p>
            </Card>
            <Card className="p-3 sm:p-4">
              <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                Daily avg
              </div>
              <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                {formatMoney(monthSavedDays > 0 ? monthSavingsTotal / monthSavedDays : 0)}
              </p>
            </Card>
          </div>

          {/* Month navigator */}
          <Card className="p-3 flex items-center justify-between gap-2">
            <button
              onClick={() => setSelectedMonth(shiftMonth(selectedMonth, -1))}
              className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="text-center flex-1">
              <p className="font-bold text-sm text-slate-900 dark:text-white">
                {monthLabel(selectedMonth)}
              </p>
            </div>
            <button
              onClick={() => setSelectedMonth(shiftMonth(selectedMonth, 1))}
              className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </Card>

          {monthSavingsList.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 px-1">
                Savings in {monthLabel(selectedMonth)}
              </h4>
              {monthSavingsList.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="w-full text-left rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  onClick={async () => {
                    if (entry.kind !== 'legacy') {
                      setSavingsDetailTx(entry.transfer);
                      return;
                    }
                    const pick = await showChoice({
                      title: `Saving of ${formatMoney(entry.amount)}`,
                      choices: [
                        { value: 'edit', label: 'Edit' },
                        { value: 'delete', label: 'Delete' },
                      ],
                    });
                    if (pick === 'edit') onEditSavings(entry.entry);
                    if (pick === 'delete') onDeleteSavings(entry.id);
                  }}
                >
                <Card className="p-3 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400">
                    <PiggyBank className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-slate-900 dark:text-white">
                      {formatMoney(entry.amount)}
                      {entry.kind === 'reallocation' && (
                        <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Moved
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {new Date(entry.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                      {entry.kind === 'legacy' ? (
                        <span> · Not linked to an account</span>
                      ) : (
                        <span>
                          {' '}
                          · {entry.fromName} → {entry.toName}
                        </span>
                      )}
                      {entry.note && <span> · {entry.note}</span>}
                    </p>
                  </div>
                </Card>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-10 px-4 bg-white/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-slate-800 rounded-2xl">
              <PiggyBank className="w-12 h-12 text-slate-400 dark:text-slate-600 mx-auto mb-3" />
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">
                No savings logged for {monthLabel(selectedMonth)}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-500 mt-1 max-w-xs mx-auto">
                Move any amount into savings, gold or stocks. Even ₹50 keeps your streak.
              </p>
            </div>
          )}
        </>
      )}

      {/* ============ DEBTS VIEW ============ */}
      {mode === 'debts' && (
        <>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Wallet className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>Debt Tracker</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Money lent or owed, with a Paid tick when settled.
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={onAddDebt}>
              <Plus className="w-4 h-4" />
              Add Debt
            </Button>
          </div>

          {/* Debt KPIs */}
          <div className="grid grid-cols-3 gap-3">
            <Card className="p-3 sm:p-4">
              <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-[10px] sm:text-xs font-semibold mb-1">
                <ArrowUpRight className="w-3.5 h-3.5" />
                To get back
              </div>
              <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                {formatMoney(outstandingLent)}
              </p>
            </Card>
            <Card className="p-3 sm:p-4">
              <div className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400 text-[10px] sm:text-xs font-semibold mb-1">
                <ArrowDownRight className="w-3.5 h-3.5" />
                To pay
              </div>
              <p className="text-base sm:text-xl font-black text-slate-900 dark:text-white truncate">
                {formatMoney(outstandingOwed)}
              </p>
            </Card>
            <Card className="p-3 sm:p-4">
              <div className="text-[10px] sm:text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                Net
              </div>
              <p
                className={`text-base sm:text-xl font-black truncate ${
                  debtNet >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                {formatMoney(debtNet)}
              </p>
            </Card>
          </div>

          <DebtPayoffPlanner debts={debts} today={today} />

          {/* Filter pills */}
          <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            {(['outstanding', 'settled', 'all'] as DebtFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setDebtFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition-colors ${
                  debtFilter === f
                    ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Debts list */}
          {filteredDebts.length > 0 ? (
            <div className="space-y-2">
              {filteredDebts.map((debt) => (
                <div key={debt.id}>
                  <DebtRow
                    debt={debt}
                    onEdit={onEditDebt}
                    onDelete={onDeleteDebt}
                    onTogglePaid={onToggleDebtPaid}
                    onRemind={(d) => void remindFriend(d)}
                  />
                  <DebtLoanPanel debt={debt} today={today} accounts={spendableAccounts}
                    defaultAccountId={defaultAccountId} onAddPayment={onAddDebtPayment} />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 px-4 bg-white/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-slate-800 rounded-2xl">
              <Wallet className="w-12 h-12 text-slate-400 dark:text-slate-600 mx-auto mb-3" />
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">
                {debtFilter === 'outstanding'
                  ? 'No outstanding debts'
                  : debtFilter === 'settled'
                  ? 'No settled debts yet'
                  : 'No debts tracked'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-500 mt-1 max-w-xs mx-auto">
                {debtFilter === 'outstanding'
                  ? 'Add a debt to remember who owes you or who you owe.'
                  : 'Track money lent to friends or owed to others.'}
              </p>
              <div className="mt-4 flex justify-center">
                <Button variant="primary" size="sm" onClick={onAddDebt}>
                  <Plus className="w-4 h-4" />
                  Add Debt
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

interface TransactionRowProps {
  tx: FinanceTransaction;
  showDate?: boolean;
  accountName?: string;
  destinationName?: string;
  /** Opens the details sheet, where Edit and Delete live. */
  onOpen: (tx: FinanceTransaction) => void;
}

const TransactionRow: React.FC<TransactionRowProps> = ({
  tx,
  showDate,
  accountName,
  destinationName,
  onOpen,
}) => {
  const isExpense = tx.type === 'expense';
  const isTransfer = tx.type === 'transfer';
  return (
    <button
      type="button"
      onClick={() => onOpen(tx)}
      className="w-full text-left rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      aria-label={`Open ${isTransfer ? 'transfer' : tx.category} ${formatMoney(tx.amount)}`}
    >
    <Card className="p-3 flex items-center gap-3">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
          isTransfer
            ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300'
            : isExpense
            ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400'
            : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400'
        }`}
      >
        {isTransfer ? (
          <ArrowUpRight className="w-5 h-5" />
        ) : isExpense ? (
          <ArrowDownCircle className="w-5 h-5" />
        ) : (
          <ArrowUpCircle className="w-5 h-5" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-900 dark:text-white truncate flex items-center gap-1.5">
          {isTransfer ? 'Transfer' : tx.category}
          {tx.recurrence?.type && tx.recurrence.type !== 'none' && (
            <Repeat className="w-3 h-3 text-indigo-500 dark:text-indigo-400" />
          )}
        </p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
          {showDate && (
            <span>
              {new Date(tx.date + 'T00:00:00').toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
              })}
              {' · '}
            </span>
          )}
          {isTransfer ? (
            <span>
              {accountName || 'Unknown account'} → {destinationName || 'Unknown account'}
            </span>
          ) : (
            <>
              {tx.note && <span>{tx.note} · </span>}
              {tx.paymentMethod && isExpense && (
                <span>
                  {paymentEmoji(tx.paymentMethod)} {paymentLabel(tx.paymentMethod)}
                </span>
              )}
              {accountName && <span> · {accountName}</span>}
              {!tx.note && !(tx.paymentMethod && isExpense) && !accountName && (isExpense ? 'Expense' : 'Income')}
            </>
          )}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p
          className={`text-sm font-black ${
            isTransfer
              ? 'text-slate-600 dark:text-slate-300'
              : isExpense
              ? 'text-rose-600 dark:text-rose-400'
              : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {isTransfer ? '' : isExpense ? '−' : '+'}
          {formatMoney(tx.amount)}
        </p>
      </div>
    </Card>
    </button>
  );
};

interface EmptyStateProps {
  message: string;
  hint: string;
  onAdd: () => void;
}

const EmptyState: React.FC<EmptyStateProps> = ({ message, hint, onAdd }) => {
  return (
    <div className="text-center py-12 px-4 bg-white/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-slate-800 rounded-2xl">
      <Wallet className="w-12 h-12 text-slate-400 dark:text-slate-600 mx-auto mb-3" />
      <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">{message}</h3>
      <p className="text-xs text-slate-500 dark:text-slate-500 mt-1 max-w-xs mx-auto">{hint}</p>
      <div className="mt-4 flex justify-center">
        <Button variant="primary" size="sm" onClick={onAdd}>
          <Plus className="w-4 h-4" />
          Add Entry
        </Button>
      </div>
    </div>
  );
};

interface DebtRowProps {
  debt: Debt;
  onEdit: (debt: Debt) => void;
  onDelete: (id: string) => void;
  onTogglePaid: (id: string) => void;
  /** Lent and not paid back: send them a "pay me back" message. */
  onRemind?: (debt: Debt) => void;
}

const DebtRow: React.FC<DebtRowProps> = ({
  debt,
  onEdit,
  onDelete,
  onTogglePaid,
  onRemind,
}) => {
  const isLent = debt.direction === 'lent';
  // Still to pay or get back (part payments and EMIs counted); a settled debt shows its full amount.
  const left = debt.paid ? debt.amount : debtOutstanding(debt, todayString());
  return (
    <Card
      className={`p-3 flex items-center gap-3 transition-opacity ${
        debt.paid ? 'opacity-60' : ''
      }`}
    >
      <button
        onClick={() => onTogglePaid(debt.id)}
        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border-2 transition-colors ${
          debt.paid
            ? 'bg-emerald-500 border-emerald-500 text-white'
            : 'bg-slate-50 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-300 hover:border-emerald-400'
        }`}
        title={debt.paid ? 'Mark as unpaid' : 'Mark as paid'}
      >
        <Check className="w-5 h-5" strokeWidth={3} />
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-900 dark:text-white truncate flex items-center gap-1.5">
          {debt.personName}
          <span
            className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${
              isLent
                ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                : 'bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'
            }`}
          >
            {isLent ? 'Lent' : 'Owed'}
          </span>
        </p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
          {new Date(debt.date + 'T00:00:00').toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
          })}
          {debt.dueDate && (
            <span>
              {' · due '}
              {new Date(debt.dueDate + 'T00:00:00').toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
              })}
            </span>
          )}
          {debt.note && <span> · {debt.note}</span>}
        </p>
        {isLent && !debt.paid && onRemind && (
          <button
            type="button"
            onClick={() => onRemind(debt)}
            className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300"
          >
            Remind to pay
          </button>
        )}
      </div>
      <div className="text-right shrink-0 flex items-center gap-1">
        <p
          className={`text-sm font-black ${
            isLent
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-rose-600 dark:text-rose-400'
          }`}
        >
          {formatMoney(left)}
          {!debt.paid && toPaise(left) !== toPaise(debt.amount) && (
            <span className="block text-[10px] font-semibold text-slate-500 dark:text-slate-400">
              of {formatMoney(debt.amount)}
            </span>
          )}
        </p>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => onEdit(debt)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(debt.id)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </Card>
  );
};
