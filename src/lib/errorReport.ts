/**
 * Crash reports: what a client error is turned into before it leaves the
 * device, and when to send one. Pure; the sending lives in
 * services/errorReporter.ts and the table in
 * supabase/migrations/*_client_errors.sql.
 *
 * A report carries no app data: only the error text and stack (scrubbed of
 * email addresses, URL query strings and long digit runs), the screen's path,
 * the app version and the platform.
 */

export type ErrorKind = 'render' | 'error' | 'rejection';

export interface ErrorReport {
  kind: ErrorKind;
  message: string;
  stack: string | null;
  path: string;
  appVersion: string;
  platform: string;
}

export interface ReportContext {
  path: string;
  appVersion: string;
  platform: string;
}

/** Same limits as the table's CHECK constraints. */
export const MAX_MESSAGE_CHARS = 500;
export const MAX_STACK_CHARS = 4000;
export const MAX_PATH_CHARS = 200;
/** Reports a single app session may send; a crash loop must not flood the table. */
export const MAX_REPORTS_PER_SESSION = 10;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Query strings and fragments can carry tokens (password-reset links do).
const URL_TAIL = /(https?:\/\/[^\s?#)]*)[?#][^\s)]*/g;
// Account, card and phone numbers.
const LONG_DIGITS = /\d{6,}/g;

/** Removes personal data that error text may quote. */
export function scrubText(text: string): string {
  return text.replace(EMAIL, '[email]').replace(URL_TAIL, '$1').replace(LONG_DIGITS, '[number]');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The message and stack of anything thrown (an Error, a string, an object). */
function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
    return { message: `${name}${error.message || '(no message)'}`, stack: error.stack ?? null };
  }
  if (typeof error === 'string') return { message: error, stack: null };
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return { message: (error as { message: string }).message, stack: null };
  }
  try {
    return { message: `Non-error thrown: ${JSON.stringify(error) ?? String(error)}`, stack: null };
  } catch {
    return { message: `Non-error thrown: ${String(error)}`, stack: null };
  }
}

export function buildErrorReport(kind: ErrorKind, error: unknown, context: ReportContext): ErrorReport {
  const { message, stack } = describe(error);
  return {
    kind,
    message: clip(scrubText(message), MAX_MESSAGE_CHARS) || '(no message)',
    stack: stack ? clip(scrubText(stack), MAX_STACK_CHARS) : null,
    // Path only: the query string and hash are dropped.
    path: clip(context.path.split(/[?#]/)[0] || '/', MAX_PATH_CHARS),
    appVersion: clip(context.appVersion, 100),
    platform: clip(context.platform, 50),
  };
}

/**
 * Errors that say nothing about the app: browser extensions, cross-origin
 * scripts the browser hides ("Script error."), the ResizeObserver loop notice,
 * and network drops that sync already retries.
 */
export function isNoise(report: ErrorReport): boolean {
  const message = report.message;
  if (/^Script error\.?$/i.test(message)) return true;
  if (/ResizeObserver loop/i.test(message)) return true;
  if (/^(TypeError: )?(Failed to fetch|NetworkError when attempting to fetch resource|Load failed|The network connection was lost)/i.test(message)) return true;
  if (report.stack && /(chrome|moz|safari(-web)?)-extension:\/\//.test(report.stack)) return true;
  return false;
}

/** Two reports with the same fingerprint are the same bug: send it once per session. */
export function reportFingerprint(report: ErrorReport): string {
  const firstFrame = report.stack?.split('\n').find((line) => /\bat\b|@/.test(line))?.trim() ?? '';
  return `${report.kind}|${report.message}|${firstFrame}`;
}

export interface SendLog {
  sent: number;
  seen: Set<string>;
}

export function newSendLog(): SendLog {
  return { sent: 0, seen: new Set() };
}

/** Decides whether to send, and records the report in the log if so. */
export function admitReport(log: SendLog, report: ErrorReport): boolean {
  if (isNoise(report)) return false;
  if (log.sent >= MAX_REPORTS_PER_SESSION) return false;
  const fingerprint = reportFingerprint(report);
  if (log.seen.has(fingerprint)) return false;
  log.seen.add(fingerprint);
  log.sent += 1;
  return true;
}
