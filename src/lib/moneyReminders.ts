/**
 * Phone reminders for money that falls due: unpaid bills (loan EMIs are bills
 * too), this and next month's bills before the app creates them, credit card
 * dues, and debts with a due date. Each fires 2 days before and on the due day,
 * at 09:00 local, through the extra-reminder sync (negative notification ids,
 * see extraReminders.ts). Pure: the caller passes today's local date.
 */
import type { Account, BillPayment, BillTemplate, Debt } from '../types';
import { clampDueDate } from './billMaterializer';
import { debtOutstanding } from './debtPlanner';
import { shiftMonthKey } from './ledger';
import { formatRupees } from './money';

/** Days before the due day that a reminder fires (0 = on the day). */
export const MONEY_REMINDER_OFFSETS = [2, 0] as const;

/** Routes delivered with a money reminder: they open that Money section. */
export const MONEY_BILLS_ROUTE = 'money:bills';
export const MONEY_DEBTS_ROUTE = 'money:debts';
export const MONEY_LEDGER_ROUTE = 'money:ledger';

export type MoneySection = 'bills' | 'debts' | 'ledger';

export function moneySectionFromRoute(route: string): MoneySection | null {
  if (route === MONEY_BILLS_ROUTE) return 'bills';
  if (route === MONEY_DEBTS_ROUTE) return 'debts';
  if (route === MONEY_LEDGER_ROUTE) return 'ledger';
  return null;
}

export interface MoneyReminderEntry {
  /** Stable per due item and day; the notification id is derived from it. */
  key: string;
  /** Day the reminder fires, YYYY-MM-DD local. */
  date: string;
  title: string;
  body: string;
  route: string;
}

/** A credit card's next payment due, worked out by the caller (see creditCard.ts). */
export interface CardDue {
  account: Pick<Account, 'id' | 'name'>;
  dueDate: string;
  amount: number;
}

const DAY_MS = 86_400_000;

function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + days, 12);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

function daysUntil(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / DAY_MS);
}

function whenPhrase(daysLeft: number): string {
  if (daysLeft <= 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  return `in ${daysLeft} days`;
}

function inRange(template: BillTemplate, month: string): boolean {
  if (template.startMonth && month < template.startMonth) return false;
  if (template.endMonth && month > template.endMonth) return false;
  return true;
}

interface Due {
  id: string;
  dueDate: string;
  title: string;
  /** Body for a reminder `daysLeft` days before the due day. */
  body: (daysLeft: number) => string;
  route: string;
}

export interface MoneyReminderInput {
  billTemplates: BillTemplate[];
  billPayments: BillPayment[];
  debts: Debt[];
  cards?: CardDue[];
  today: string;
}

/** Everything that falls due: unpaid bills, bills not created yet, card dues and debts. */
function dueItems(input: MoneyReminderInput): Due[] {
  const { billTemplates, billPayments, debts, today } = input;
  const items: Due[] = [];
  const active = new Map(billTemplates.filter((t) => t.active).map((t) => [t.id, t]));

  const billDue = (template: BillTemplate, id: string, dueDate: string, amount: number): Due => ({
    id,
    dueDate,
    title: template.debtId ? 'EMI due' : 'Bill due',
    body: (daysLeft) => `${template.name}: ${formatRupees(amount)} is due ${whenPhrase(daysLeft)}.`,
    route: MONEY_BILLS_ROUTE,
  });

  // Unpaid bills already created for a month.
  const created = new Set<string>();
  for (const payment of billPayments) {
    created.add(`${payment.billId}:${payment.month}`);
    const template = active.get(payment.billId);
    if (!template || payment.paid) continue;
    items.push(billDue(template, payment.id, payment.dueDate, payment.amount));
  }

  // This and next month's bills the app has not created yet (it creates them when opened).
  const thisMonth = today.slice(0, 7);
  for (const month of [thisMonth, shiftMonthKey(thisMonth, 1)]) {
    for (const template of active.values()) {
      if (!inRange(template, month) || created.has(`${template.id}:${month}`)) continue;
      items.push(billDue(template, `${template.id}:${month}`, clampDueDate(month, template.dueDayOfMonth), template.amount));
    }
  }

  for (const card of input.cards ?? []) {
    if (!(card.amount > 0)) continue;
    items.push({
      id: `card-${card.account.id}:${card.dueDate}`,
      dueDate: card.dueDate,
      title: 'Card bill due',
      body: (daysLeft) => `${card.account.name}: ${formatRupees(card.amount)} is due ${whenPhrase(daysLeft)}.`,
      route: MONEY_LEDGER_ROUTE,
    });
  }

  // Debts with a due date (loans remind through their EMI bill).
  for (const debt of debts) {
    if (debt.paid || debt.loan || !debt.dueDate) continue;
    const left = debtOutstanding(debt, today);
    if (!(left > 0)) continue;
    const owed = debt.direction === 'owed';
    items.push({
      id: debt.id,
      dueDate: debt.dueDate,
      title: owed ? 'Debt to repay' : 'Money to get back',
      body: (daysLeft) =>
        owed
          ? `Repay ${debt.personName} ${formatRupees(left)} ${whenPhrase(daysLeft)}.`
          : `${debt.personName} owes you ${formatRupees(left)}, due ${whenPhrase(daysLeft)}.`,
      route: MONEY_DEBTS_ROUTE,
    });
  }
  return items;
}

/** Reminder days for everything due: 2 days before and on the day, today or later only. */
export function buildMoneyReminders(input: MoneyReminderInput): MoneyReminderEntry[] {
  const out: MoneyReminderEntry[] = [];
  for (const item of dueItems(input)) {
    for (const offset of MONEY_REMINDER_OFFSETS) {
      const date = shiftDay(item.dueDate, -offset);
      if (date < input.today) continue;
      out.push({
        key: `${item.id}:${date}`,
        date,
        title: item.title,
        body: item.body(daysUntil(date, item.dueDate)),
        route: item.route,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}
