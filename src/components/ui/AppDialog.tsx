/**
 * Branded replacement for window.alert / window.confirm.
 *
 *   await showAlert({ title: 'Backup imported' });
 *   if (!(await showConfirm({ title: 'Delete this debt?', tone: 'danger', confirmLabel: 'Delete' }))) return;
 *
 * Callable from any handler (no hook needed). `<AppDialogHost />` is mounted
 * once at the root and shows one dialog at a time; later calls wait in a queue.
 * Escape and the Android back button cancel, Enter activates the focused
 * button, focus stays inside the dialog and returns to where it was.
 */
import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Info, Trash2 } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../../lib/cn';

export type DialogTone = 'info' | 'success' | 'warning' | 'danger';

export interface AlertOptions {
  title: string;
  message?: string;
  tone?: DialogTone;
  okLabel?: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  tone?: DialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface QueuedDialog {
  id: number;
  kind: 'alert' | 'confirm';
  title: string;
  message?: string;
  tone: DialogTone;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (confirmed: boolean) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let queue: QueuedDialog[] = [];
let nextId = 1;
/** True while the app-lock or alarm-ring screen covers everything. */
let suspended = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The dialog to show now: none while suspended (the queue is kept). */
function current(): QueuedDialog | null {
  return suspended ? null : (queue[0] ?? null);
}

/**
 * Hide dialogs while the app-lock or alarm-ring screen is up. Those screens
 * sit above dialogs; a hidden dialog must not take keys or the back button,
 * and must not show the app's content over the lock screen. Queued dialogs
 * come back when this is turned off.
 */
export function setDialogsSuspended(value: boolean): void {
  if (suspended === value) return;
  suspended = value;
  emit();
}

function enqueue(dialog: Omit<QueuedDialog, 'id' | 'resolve'>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { ...dialog, id: nextId++, resolve }];
    emit();
  });
}

function settle(id: number, confirmed: boolean) {
  const dialog = queue.find((item) => item.id === id);
  if (!dialog) return;
  queue = queue.filter((item) => item.id !== id);
  emit();
  dialog.resolve(confirmed);
}

/** Shows a message with one button. Resolves when it is closed. */
export function showAlert(options: AlertOptions | string): Promise<void> {
  const opts = typeof options === 'string' ? { title: options } : options;
  return enqueue({
    kind: 'alert',
    title: opts.title,
    message: opts.message,
    tone: opts.tone ?? 'info',
    confirmLabel: opts.okLabel ?? 'OK',
    cancelLabel: '',
  }).then(() => undefined);
}

/**
 * Shows an alert that code can close later (e.g. "Downloading…"). `close`
 * removes exactly this alert, wherever it is in the queue, and never touches
 * other dialogs; it does nothing once the person has closed it.
 */
export function openAlert(options: AlertOptions): { closed: Promise<void>; close: () => void } {
  const id = nextId; // enqueue takes nextId synchronously
  const closed = showAlert(options);
  return { closed, close: () => settle(id, false) };
}

/** Asks a yes/no question. Resolves true only when the confirm button is chosen. */
export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  return enqueue({
    kind: 'confirm',
    title: options.title,
    message: options.message,
    tone: options.tone ?? 'info',
    confirmLabel: options.confirmLabel ?? 'Confirm',
    cancelLabel: options.cancelLabel ?? 'Cancel',
  });
}

/** True while a dialog is showing. */
export function isDialogOpen(): boolean {
  return current() !== null;
}

/**
 * Closes the front dialog as if cancelled (an alert counts as acknowledged).
 * Returns false when none was open. Back-button handlers call this first.
 */
export function dismissTopDialog(): boolean {
  const dialog = current();
  if (!dialog) return false;
  settle(dialog.id, false);
  return true;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

const TONE_STYLES: Record<DialogTone, { icon: React.ElementType; badge: string }> = {
  info: { icon: Info, badge: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300' },
  success: { icon: CheckCircle2, badge: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300' },
  warning: { icon: AlertTriangle, badge: 'bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-300' },
  danger: { icon: Trash2, badge: 'bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-300' },
};

export const AppDialogHost: React.FC = () => {
  const dialog = useSyncExternalStore(subscribe, current, current);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Focus: a destructive question starts on Cancel, so a stray Enter is safe.
  useEffect(() => {
    if (!dialog) return;
    if (!restoreFocusRef.current) restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const target = dialog.kind === 'confirm' && dialog.tone === 'danger' ? cancelRef.current : confirmRef.current;
    target?.focus();
  }, [dialog]);

  // Give focus back once the last queued dialog closes.
  useEffect(() => {
    if (dialog || !restoreFocusRef.current) return;
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (document.contains(previous)) previous.focus();
  }, [dialog]);

  // Keys are handled in the capture phase so modals underneath never see them.
  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        settle(dialog.id, false);
        return;
      }
      if (event.key === 'Tab') {
        const buttons = [cancelRef.current, confirmRef.current].filter(
          (button): button is HTMLButtonElement => button !== null,
        );
        if (buttons.length === 0) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
        event.preventDefault();
        event.stopPropagation();
        buttons[next].focus();
        return;
      }
      if (event.key === 'Enter') {
        // Enter belongs to the dialog's focused button, not to a form behind it.
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dialog]);

  if (!dialog) return null;

  const { icon: Icon, badge } = TONE_STYLES[dialog.tone];
  const titleId = `app-dialog-title-${dialog.id}`;
  const messageId = `app-dialog-message-${dialog.id}`;
  const isConfirm = dialog.kind === 'confirm';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 pb-[max(1rem,env(safe-area-inset-bottom))] animate-in fade-in duration-150"
      onMouseDown={(event) => {
        // Clicking the backdrop cancels (acknowledges an alert).
        if (event.target === event.currentTarget) settle(dialog.id, false);
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={dialog.message ? messageId : undefined}
        className="w-full max-w-sm rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl animate-in zoom-in-95 duration-150"
      >
        <div className="flex items-start gap-3.5">
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', badge)} aria-hidden="true">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1 pt-0.5">
            <h2 id={titleId} className="text-base font-bold leading-snug text-slate-900 dark:text-slate-50">
              {dialog.title}
            </h2>
            {dialog.message && (
              <p id={messageId} className="whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                {dialog.message}
              </p>
            )}
          </div>
        </div>
        <div className={cn('mt-5 flex gap-2', isConfirm ? 'flex-col-reverse sm:flex-row sm:justify-end' : 'justify-end')}>
          {isConfirm && (
            <Button
              ref={cancelRef}
              variant="secondary"
              className="w-full sm:w-auto justify-center"
              onClick={() => settle(dialog.id, false)}
            >
              {dialog.cancelLabel}
            </Button>
          )}
          <Button
            ref={confirmRef}
            variant={dialog.tone === 'danger' && isConfirm ? 'destructive' : 'primary'}
            className={cn('justify-center', isConfirm ? 'w-full sm:w-auto' : 'min-w-24')}
            onClick={() => settle(dialog.id, true)}
          >
            {dialog.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};
