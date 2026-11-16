/**
 * A system file picker (or "save as" screen) is its own Android activity, so
 * opening one backgrounds Dayflow. Without a grace window the app lock and the
 * document vault would lock the moment the picker opens, and the picked file or
 * an unsaved form could be lost.
 *
 * `beginExternalActivity` opens a bounded window (at most `MAX_EXTERNAL_MS`).
 * A pause inside the window is not treated as the user leaving, and remembers the
 * window's end. The matching resume is covered only if it comes back before that
 * end, so a picker left open too long still counts as leaving.
 *
 * Android may deliver the picker's `change` event before or after the activity
 * resume, so ending the window (`endExternalActivity`) does not forget a pause
 * that already happened; `finishExternalResume` clears it once every listener
 * has handled the resume.
 */
export const MAX_EXTERNAL_MS = 3 * 60_000;

let activeUntil = 0;
let pauseCoveredUntil = 0;

export function beginExternalActivity(now = Date.now(), maxMs = MAX_EXTERNAL_MS): void {
  activeUntil = now + Math.min(Math.max(maxMs, 0), MAX_EXTERNAL_MS);
}

/** The picker reported back (change / cancel) or the flow finished: later pauses are real. */
export function endExternalActivity(): void {
  activeUntil = 0;
}

export function isExternalActivityActive(now = Date.now()): boolean {
  return activeUntil > now;
}

/** True when this pause is the picker opening, not the user leaving Dayflow. */
export function shouldIgnorePauseForExternal(now = Date.now()): boolean {
  if (!isExternalActivityActive(now)) {
    pauseCoveredUntil = 0;
    return false;
  }
  pauseCoveredUntil = activeUntil;
  return true;
}

/**
 * True when this resume returns from a covered pause in time, so no lock is needed.
 * Several listeners may ask about the same resume; nothing is cleared here.
 */
export function consumeExternalResume(now = Date.now()): boolean {
  return pauseCoveredUntil > 0 && now <= pauseCoveredUntil;
}

/** Call shortly after a resume, once every listener has checked it. */
export function finishExternalResume(): void {
  pauseCoveredUntil = 0;
  activeUntil = 0;
}

export function resetExternalActivity(): void {
  activeUntil = 0;
  pauseCoveredUntil = 0;
}
