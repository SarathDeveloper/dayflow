import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BookOpen,
  CalendarClock,
  Check,
  ChevronDown,
  Compass,
  Gift,
  GraduationCap,
  Heart,
  Mountain,
  Pencil,
  PiggyBank,
  Plus,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Target,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import type { Account, BucketCategory, BucketItem, DiaryImage, FinanceTransaction, Goal, MoneyGoal } from '../../types';
import {
  bucketCategoryLabel,
  bucketSummary,
  bucketTargetLabel,
  BUCKET_CATEGORIES,
  groupByCategory,
  sortDoneItems,
  sortOpenItems,
} from '../../lib/bucketList';
import { goalProgress } from '../../lib/moneyGoals';
import { todayString } from '../../lib/ledger';
import { formatRupeesCompact } from '../../lib/money';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { BucketItemModal, type BucketItemInput } from './BucketItemModal';
import { BucketDoneModal } from './BucketDoneModal';

interface Props {
  items: BucketItem[];
  moneyGoals: MoneyGoal[];
  goals: Goal[];
  accounts: Account[];
  transactions: FinanceTransaction[];
  /** Why phone reminders may not fire here (website, notifications off), or null. */
  reminderNote: string | null;
  /** A reminder was tapped: open this item. */
  requestedItem: { id: string; at: number } | null;
  onSave: (input: BucketItemInput) => void;
  onDelete: (id: string) => void;
  onMarkDone: (id: string, done: { doneOn: string; memory?: string; photo?: DiaryImage }) => void;
  onReopen: (id: string) => void;
  onStartSaving: (id: string) => void;
  onMakeGoal: (id: string) => void;
  onOpenSavings: () => void;
  onOpenGoals: () => void;
  /** Android back closes an open dialog first. */
  onRegisterClose: (close: (() => void) | null) => void;
}

const CATEGORY_ICON: Record<BucketCategory, LucideIcon> = {
  travel: Compass,
  experience: Sparkles,
  buy: ShoppingBag,
  learn: GraduationCap,
  food: UtensilsCrossed,
  people: Heart,
  other: Gift,
};

export function BucketListView({
  items,
  moneyGoals,
  goals,
  accounts,
  transactions,
  reminderNote,
  requestedItem,
  onSave,
  onDelete,
  onMarkDone,
  onReopen,
  onStartSaving,
  onMakeGoal,
  onOpenSavings,
  onOpenGoals,
  onRegisterClose,
}: Props) {
  const today = todayString();
  const [filter, setFilter] = useState<BucketCategory | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<BucketItem | 'new' | null>(null);
  const [doneFor, setDoneFor] = useState<BucketItem | null>(null);
  const [showDone, setShowDone] = useState(false);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (editing) {
      onRegisterClose(() => setEditing(null));
      return () => onRegisterClose(null);
    }
    if (doneFor) {
      onRegisterClose(() => setDoneFor(null));
      return () => onRegisterClose(null);
    }
    return undefined;
  }, [editing, doneFor, onRegisterClose]);

  // A reminder was tapped: show that item.
  useEffect(() => {
    if (!requestedItem) return;
    const target = items.find((i) => i.id === requestedItem.id);
    if (!target) return;
    setFilter('all');
    setExpandedId(target.id);
    if (target.doneOn) setShowDone(true);
    const timer = setTimeout(() => cardRefs.current.get(target.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    return () => clearTimeout(timer);
    // Only when a new request arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedItem]);

  const summary = useMemo(() => bucketSummary(items), [items]);
  const open = useMemo(() => sortOpenItems(items), [items]);
  const done = useMemo(() => sortDoneItems(items), [items]);
  const usedCategories = useMemo(() => new Set(items.map((i) => i.category)), [items]);
  const visibleOpen = filter === 'all' ? open : open.filter((i) => i.category === filter);
  const visibleDone = filter === 'all' ? done : done.filter((i) => i.category === filter);
  const groups = filter === 'all' ? groupByCategory(visibleOpen) : [{ category: filter, items: visibleOpen }];
  const hasReminders = open.some((i) => i.remind && i.target);

  const renderCard = (item: BucketItem) => {
    const Icon = CATEGORY_ICON[item.category] ?? Gift;
    const expanded = expandedId === item.id;
    const when = item.doneOn ? null : bucketTargetLabel(item.target, today);
    const late = Boolean(when && /late|was for/.test(when));
    const moneyGoal = item.moneyGoalId ? moneyGoals.find((g) => g.id === item.moneyGoalId) : undefined;
    const progress = moneyGoal ? goalProgress(moneyGoal, accounts, transactions, today) : null;
    const goal = item.goalId ? goals.find((g) => g.id === item.goalId) : undefined;
    return (
      <div
        key={item.id}
        ref={(el) => {
          if (el) cardRefs.current.set(item.id, el);
          else cardRefs.current.delete(item.id);
        }}
      >
      <Card className={`overflow-hidden ${expanded ? 'ring-2 ring-indigo-500/40' : ''}`}>
        <button
          type="button"
          onClick={() => setExpandedId(expanded ? null : item.id)}
          aria-expanded={expanded}
          className="flex w-full items-start gap-3 p-3 text-left"
        >
          {item.doneOn && item.photo ? (
            <img src={item.photo.dataUrl} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover" />
          ) : (
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                item.doneOn
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                  : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300'
              }`}
            >
              {item.doneOn ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-slate-900 dark:text-white">{item.title}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              {item.doneOn ? (
                <span>Done {new Date(`${item.doneOn}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              ) : (
                when && (
                  <span className={`inline-flex items-center gap-1 ${late ? 'font-semibold text-amber-600 dark:text-amber-400' : ''}`}>
                    <CalendarClock className="h-3 w-3" />
                    {when}
                    {item.remind && <Bell className="h-3 w-3" aria-label="Reminder on" />}
                  </span>
                )
              )}
              {item.cost ? <span>{formatRupeesCompact(item.cost)}</span> : null}
              {goal && <span className="inline-flex items-center gap-0.5"><Target className="h-3 w-3" />Goal</span>}
            </span>
            {progress && !item.doneOn && (
              <span className="mt-1.5 flex items-center gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(2, progress.percent)}%` }} />
                </span>
                <span className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400">{progress.percent}%</span>
              </span>
            )}
          </span>
          <ChevronDown className={`mt-2 h-4 w-4 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        {expanded && (
          <div className="space-y-3 border-t border-slate-100 px-3 pb-3 pt-3 dark:border-slate-800">
            {item.doneOn && item.photo && <img src={item.photo.dataUrl} alt="" className="max-h-72 w-full rounded-xl object-cover" />}
            {item.doneOn && item.memory && <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{item.memory}</p>}
            {item.note && <p className="whitespace-pre-wrap text-xs text-slate-500 dark:text-slate-400">{item.note}</p>}
            {progress && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Saved {formatRupeesCompact(progress.saved)} of {formatRupeesCompact(progress.target)}
                {progress.perMonth != null && !progress.done ? `, ${formatRupeesCompact(progress.perMonth)}/month to stay on track` : ''}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {item.doneOn ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setDoneFor(item)}>
                    <BookOpen className="mr-1 h-3.5 w-3.5" /> Edit memory
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onReopen(item.id)}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" /> Not done yet
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="primary" onClick={() => setDoneFor(item)}>
                    <Check className="mr-1 h-3.5 w-3.5" /> Mark done
                  </Button>
                  {moneyGoal ? (
                    <Button size="sm" variant="secondary" onClick={onOpenSavings}>
                      <PiggyBank className="mr-1 h-3.5 w-3.5" /> Open savings
                    </Button>
                  ) : (
                    item.cost && item.cost > 0 ? (
                      <Button size="sm" variant="secondary" onClick={() => onStartSaving(item.id)}>
                        <PiggyBank className="mr-1 h-3.5 w-3.5" /> Start saving
                      </Button>
                    ) : null
                  )}
                  {goal ? (
                    <Button size="sm" variant="secondary" onClick={onOpenGoals}>
                      <Target className="mr-1 h-3.5 w-3.5" /> Open goal
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => onMakeGoal(item.id)}>
                      <Target className="mr-1 h-3.5 w-3.5" /> Make it a goal
                    </Button>
                  )}
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>
                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
              </Button>
            </div>
          </div>
        )}
      </Card>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-white">
            <Mountain className="h-5 w-5 text-indigo-600" /> Bucket List
          </h2>
          {items.length > 0 && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {summary.done} of {summary.total} done
              {summary.openCost > 0 ? ` · ${formatRupeesCompact(summary.openCost)} still to go` : ''}
            </p>
          )}
        </div>
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
          <Plus className="mr-1 h-4 w-4" /> Add
        </Button>
      </div>

      {items.length > 0 && usedCategories.size > 1 && (
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {[{ id: 'all' as const, label: 'All' }, ...BUCKET_CATEGORIES.filter((c) => usedCategories.has(c.id))].map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              aria-pressed={filter === c.id}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold ${
                filter === c.id
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {hasReminders && reminderNote && <p className="px-1 text-[11px] text-slate-500 dark:text-slate-400">{reminderNote}</p>}

      {items.length === 0 ? (
        <Card className="p-6 text-center">
          <Mountain className="mx-auto h-8 w-8 text-indigo-400" />
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Add the places, experiences and things you want someday.</p>
          <Button className="mt-4" variant="primary" onClick={() => setEditing('new')}>
            <Plus className="mr-1 h-4 w-4" /> Add the first one
          </Button>
        </Card>
      ) : visibleOpen.length === 0 ? (
        <p className="px-1 text-sm text-slate-500 dark:text-slate-400">
          {filter === 'all' ? 'Everything here is done. Time to dream up the next one.' : `Nothing open in ${bucketCategoryLabel(filter)}.`}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.category} className="space-y-2">
            {filter === 'all' && (
              <h3 className="px-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {bucketCategoryLabel(group.category)}
              </h3>
            )}
            {group.items.map(renderCard)}
          </section>
        ))
      )}

      {visibleDone.length > 0 && (
        <section className="space-y-2">
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
            className="flex w-full items-center justify-between rounded-xl px-1 py-2 text-left"
          >
            <span className="text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Done · {visibleDone.length}</span>
            <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${showDone ? 'rotate-180' : ''}`} />
          </button>
          {!showDone && visibleDone.some((i) => i.photo) && (
            <div className="flex gap-1.5 overflow-hidden px-1">
              {visibleDone
                .filter((i) => i.photo)
                .slice(0, 6)
                .map((i) => (
                  <img key={i.id} src={i.photo!.dataUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                ))}
            </div>
          )}
          {showDone && visibleDone.map(renderCard)}
        </section>
      )}

      <BucketItemModal
        isOpen={editing !== null}
        item={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSave={onSave}
        onDelete={(id) => {
          setExpandedId(null);
          onDelete(id);
        }}
      />
      <BucketDoneModal item={doneFor} onClose={() => setDoneFor(null)} onSave={onMarkDone} />
    </div>
  );
}
