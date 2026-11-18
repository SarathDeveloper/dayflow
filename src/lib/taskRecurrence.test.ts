import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { isRecurring, nextOccurrence, nextOccurrenceId, nextOccurrenceOf, rescheduled, skipOccurrence } from './taskRecurrence';

const NOW = '2026-11-03T10:00:00.000Z';

function task(partial: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Water plants',
    completed: false,
    date: '2026-11-03',
    time: '08:00',
    priority: 'medium',
    category: 'Personal',
    subtasks: [{ id: 's1', title: 'Balcony', completed: true }],
    recurrence: { type: 'none' },
    reminder: { enabled: true, remindBeforeMinutes: 5, sound: 'chime', lastNotifiedAt: 'x', snoozedUntil: 'y' },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...partial,
  };
}

describe('nextOccurrenceOf', () => {
  it('uses weekly days and custom intervals', () => {
    expect(nextOccurrenceOf(task({ recurrence: { type: 'weekly', daysOfWeek: [1, 4] } }))).toBe('2026-11-05');
    expect(nextOccurrenceOf(task({ recurrence: { type: 'custom', intervalDays: 14 } }))).toBe('2026-11-17');
  });
});

describe('skipOccurrence', () => {
  it('moves a recurring task to its next date without completing it', () => {
    const skipped = skipOccurrence(task({ recurrence: { type: 'daily' } }), NOW);
    expect(skipped).toMatchObject({
      id: 'task-1',
      date: '2026-11-04',
      completed: false,
      updatedAt: NOW,
      subtasks: [{ id: 's1', completed: false }],
    });
    expect(skipped?.reminder.lastNotifiedAt).toBeUndefined();
    expect(skipped?.reminder.snoozedUntil).toBeUndefined();
  });

  it('returns null for one-off tasks and past the series end', () => {
    expect(skipOccurrence(task({}), NOW)).toBeNull();
    expect(skipOccurrence(task({ recurrence: { type: 'weekly', endDate: '2026-11-05' } }), NOW)).toBeNull();
  });
});

describe('rescheduled', () => {
  it('copies the task to a new date with steps reset', () => {
    const copy = rescheduled(task({ completed: true, completedAt: NOW }), '2026-11-10', NOW);
    expect(copy).toMatchObject({ date: '2026-11-10', completed: false, completedAt: undefined });
    expect(copy.subtasks[0].completed).toBe(false);
  });

  it('knows which tasks repeat', () => {
    expect(isRecurring(task({}))).toBe(false);
    expect(isRecurring(task({ recurrence: { type: 'monthly' } }))).toBe(true);
  });
});

describe('nextOccurrence', () => {
  it('gives the next copy an id from its series and date, the same on every device', () => {
    const first = task({ id: 'task-1795001593674-ab12cd34', recurrence: { type: 'daily' }, completed: true });
    const onPhone = nextOccurrence(first, '2026-11-04', NOW);
    const onLaptop = nextOccurrence(first, '2026-11-04', '2026-11-03T11:30:00.000Z');
    expect(onPhone.id).toBe('task-1795001593674-ab12cd34-on-2026-11-04');
    expect(onLaptop.id).toBe(onPhone.id);
    expect(onPhone).toMatchObject({ seriesId: first.id, date: '2026-11-04', completed: false, createdAt: NOW, updatedAt: NOW });
  });

  it('keeps the series id down the chain, so ids do not grow', () => {
    const first = task({ id: 'task-9', recurrence: { type: 'daily' } });
    const second = nextOccurrence(first, '2026-11-04', NOW);
    const third = nextOccurrence(second, '2026-11-05', NOW);
    expect(third.id).toBe('task-9-on-2026-11-05');
    expect(third.seriesId).toBe('task-9');
    expect(nextOccurrenceId(third, '2026-11-06')).toBe('task-9-on-2026-11-06');
  });
});
