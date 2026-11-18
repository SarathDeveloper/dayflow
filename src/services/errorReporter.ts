/**
 * Sends crash reports to `public.dayflow_client_errors` (insert-only for the
 * signed-in user; nobody can read them back through the app). What a report
 * holds and when one is sent: lib/errorReport.ts.
 *
 * Reporting never throws and never reports its own failures. Reports made
 * before a session exists wait in memory and go out once one does; a report
 * that cannot be sent is dropped.
 */
import { admitReport, buildErrorReport, newSendLog, type ErrorKind, type ErrorReport } from '../lib/errorReport';
import { platformName } from '../lib/platform';
import { currentWebVersion } from './appUpdater';
import { getSupabase, hasStoredSession } from './cloudSyncService';

export const CLIENT_ERRORS_TABLE = 'dayflow_client_errors';
const MAX_WAITING = 5;
const RETRY_MS = 30_000;

const log = newSendLog();
const waiting: ErrorReport[] = [];
let installed = false;
let retryTimer: number | null = null;

function appVersion(): string {
  const commit = import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA?.trim().slice(0, 7);
  return commit ? `${currentWebVersion()}+${commit}` : currentWebVersion();
}

function safePlatform(): string {
  try {
    return platformName();
  } catch {
    return 'unknown';
  }
}

/** One attempt. A rejected batch (missing table, failed check) is dropped, not retried. */
async function send(reports: ErrorReport[]): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.from(CLIENT_ERRORS_TABLE).insert(
    reports.map((report) => ({
      kind: report.kind,
      message: report.message,
      stack: report.stack,
      path: report.path,
      app_version: report.appVersion,
      platform: report.platform,
    })),
  );
}

function scheduleFlush(delay: number): void {
  if (retryTimer !== null || typeof window === 'undefined') return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flush();
  }, delay);
}

async function flush(): Promise<void> {
  if (waiting.length === 0) return;
  if (!hasStoredSession() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    scheduleFlush(RETRY_MS);
    return;
  }
  const batch = waiting.splice(0, waiting.length);
  try {
    await send(batch);
  } catch {
    // Network failure: the reports are dropped rather than retried forever.
  }
}

/** Records an error. Safe to call from anywhere, including error handlers. */
export function reportError(kind: ErrorKind, error: unknown): void {
  try {
    const report = buildErrorReport(kind, error, {
      path: typeof window === 'undefined' ? '/' : window.location.pathname,
      appVersion: appVersion(),
      platform: safePlatform(),
    });
    if (!admitReport(log, report)) return;
    if (waiting.length >= MAX_WAITING) return;
    waiting.push(report);
    // Let the current call stack finish (a render crash is still unwinding).
    scheduleFlush(0);
  } catch {
    // Reporting must never cause a second error.
  }
}

/** Listens for uncaught errors and unhandled promise rejections. Call once at startup. */
export function installErrorReporter(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    // Resource load failures (an <img> 404) are not script errors.
    if (!(event instanceof ErrorEvent)) return;
    reportError('error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError('rejection', event.reason);
  });
  window.addEventListener('online', () => void flush());
}
