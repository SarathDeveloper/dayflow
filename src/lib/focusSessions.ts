/**
 * Finished Focus Room sessions: building the record and adding up minutes.
 * Only completed focus sessions are recorded; breaks and abandoned timers are not.
 */
import type { FocusSession } from '../types';
import { newLedgerId, todayString } from './ledger';

export function buildFocusSession(input: { minutes: number; startedAt: Date; taskId?: string }, now = new Date()): FocusSession {
  const stamp = now.toISOString();
  return {
    id: newLedgerId('focus'),
    date: todayString(now),
    startedAt: input.startedAt.toISOString(),
    minutes: Math.max(1, Math.round(input.minutes)),
    taskId: input.taskId || undefined,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** Focus minutes on one local day. */
export function focusMinutesOn(sessions: FocusSession[], date: string): number {
  return sessions.reduce((sum, session) => (session.date === date ? sum + (session.minutes || 0) : sum), 0);
}

/** Focus minutes from `from` to `to`, both inclusive (YYYY-MM-DD). */
export function focusMinutesBetween(sessions: FocusSession[], from: string, to: string): number {
  return sessions.reduce(
    (sum, session) => (session.date >= from && session.date <= to ? sum + (session.minutes || 0) : sum),
    0,
  );
}

/** "1 h 25 min", "40 min", "2 h". */
export function formatMinutes(total: number): string {
  const minutes = Math.max(0, Math.round(total));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
