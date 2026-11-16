import type { BillPayment, DiaryEntry, FinanceTransaction, Goal, Habit, HabitCheckIn, MonthlyBudget, Task } from '../types';
import { addDays, checkInOn, goalProgress, habitStreak, isComplete, isDueToday } from './habits';
import { addRupees } from './money';
import { buildWidgetSnapshot } from './widgetSnapshot';

/**
 * Consecutive days, ending today or yesterday, with at least one completed task.
 * A day that is not over yet does not break the streak.
 */
export function taskStreak(tasks: Pick<Task, 'date' | 'completed'>[], today: string): number {
  const doneDays = new Set(tasks.filter((task) => task.completed).map((task) => task.date));
  let day = doneDays.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (doneDays.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

/**
 * Habits the Streak page counts: not archived and not under a paused goal.
 * Habits of a completed goal still count (their run was earned).
 */
export function streakHabits(habits: Habit[], goals: Pick<Goal, 'id' | 'status'>[]): Habit[] {
  return habits.filter((habit) => {
    if (habit.archived) return false;
    if (!habit.goalId) return true;
    const goal = goals.find((item) => item.id === habit.goalId);
    return !goal || goal.status !== 'paused';
  });
}

/** The longest current streak among `streakHabits`, shared by Home and the Streak page. */
export function bestHabitStreak(
  habits: Habit[],
  goals: Pick<Goal, 'id' | 'status'>[],
  checkIns: HabitCheckIn[],
  today: string,
): { streak: number; unit: 'days' | 'weeks' } {
  let best = { streak: 0, unit: 'days' as 'days' | 'weeks' };
  for (const habit of streakHabits(habits, goals)) {
    const streak = habitStreak(habit, checkIns, today);
    if (streak > best.streak) {
      best = { streak, unit: habit.schedule.type === 'times_per_week' ? 'weeks' : 'days' };
    }
  }
  return best;
}

export interface HomeSummaryInput {
  today: string;
  tasks: Task[];
  habits: Habit[];
  checkIns: HabitCheckIn[];
  goals: Goal[];
  transactions: FinanceTransaction[];
  budgets: MonthlyBudget[];
  billPayments: BillPayment[];
  diaryEntries: DiaryEntry[];
}

export interface HomeSummary {
  tasks: {
    total: number;
    done: number;
    /** The first open task of the day, by time (untimed ones last). */
    next: { title: string; time?: string } | null;
  };
  habits: { due: number; done: number };
  streak: { taskDays: number; bestHabit: number; bestHabitUnit: 'days' | 'weeks' };
  money: {
    spentToday: number;
    spentMonth: number;
    /** 0 when no budget is set for this month. */
    monthBudget: number;
    unpaidBills: number;
    unpaidBillsAmount: number;
    overdueBills: number;
    /** Earliest due date among this month's unpaid bills. */
    nextBillDue: string | null;
  };
  /** Active goals, most recently started first. */
  goals: { id: string; title: string; percent: number; targetDate: string }[];
  diary: { notesToday: number };
}

export const HOME_MAX_GOALS = 3;

export function homeSummary(input: HomeSummaryInput): HomeSummary {
  const { today } = input;
  const snapshot = buildWidgetSnapshot(today, input.tasks, input.transactions, input.budgets);
  const next = snapshot.tasks.find((task) => !task.done);

  const dueHabits = input.habits.filter((habit) => isDueToday(habit, today, input.goals, input.checkIns));
  const doneHabits = dueHabits.filter((habit) => isComplete(habit, checkInOn(habit.id, input.checkIns, today)));

  const best = bestHabitStreak(input.habits, input.goals, input.checkIns, today);

  const month = today.slice(0, 7);
  const unpaid = input.billPayments
    .filter((payment) => payment.month === month && !payment.paid)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const goals = input.goals
    .filter((goal) => goal.status === 'active')
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .slice(0, HOME_MAX_GOALS)
    .map((goal) => ({
      id: goal.id,
      title: goal.title,
      percent: goalProgress(goal, input.habits, input.checkIns, today).percent,
      targetDate: goal.targetDate,
    }));

  return {
    tasks: {
      total: snapshot.total,
      done: snapshot.total - snapshot.remaining,
      next: next ? { title: next.title, time: next.time } : null,
    },
    habits: { due: dueHabits.length, done: doneHabits.length },
    streak: { taskDays: taskStreak(input.tasks, today), bestHabit: best.streak, bestHabitUnit: best.unit },
    money: {
      spentToday: snapshot.spentToday,
      spentMonth: snapshot.spentMonth,
      monthBudget: snapshot.monthBudget,
      unpaidBills: unpaid.length,
      unpaidBillsAmount: unpaid.reduce(addRupees, 0),
      overdueBills: unpaid.filter((payment) => payment.dueDate < today).length,
      nextBillDue: unpaid[0]?.dueDate ?? null,
    },
    goals,
    diary: { notesToday: input.diaryEntries.filter((entry) => entry.date === today).length },
  };
}
