import type { MaintenanceItem } from '../types';
import { LEGACY_MAINTENANCE_KEY, loadMaintenanceStore } from '../lib/maintenance';

export interface MaintenanceLoad {
  items: MaintenanceItem[];
  /** Shown in the Maintenance screen when stored data could not be read in full. */
  notice: string | null;
  /** Key holding a raw copy of the damaged data, for download. */
  damagedKey: string | null;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Loads maintenance items from `key`, migrating the old `dayflow_maintenance_v1`
 * list the first time. Damaged data is never thrown away silently: the raw text is
 * copied to `<key>__damaged` (an existing copy is kept) before anything can be saved
 * over it, and a notice tells the user.
 */
export function loadMaintenanceFromStorage(key: string): MaintenanceLoad {
  let source = key;
  let raw = read(key);
  if (raw === null) {
    raw = read(LEGACY_MAINTENANCE_KEY);
    source = LEGACY_MAINTENANCE_KEY;
  }
  const result = loadMaintenanceStore(raw, new Date().toISOString());
  if (!result.damaged && result.rejected === 0) return { items: result.items, notice: null, damagedKey: null };

  const damagedKey = `${source}__damaged`;
  let kept = read(damagedKey) !== null;
  if (!kept && raw !== null) {
    try {
      localStorage.setItem(damagedKey, raw);
      kept = true;
    } catch {
      kept = false;
    }
  }
  const lost = result.damaged && result.items.length === 0
    ? 'Saved maintenance records could not be read.'
    : `${result.rejected} saved maintenance ${result.rejected === 1 ? 'record was' : 'records were'} damaged and left out.`;
  const notice = kept
    ? `${lost} A copy of the original data was kept on this device; download it before clearing app data.`
    : `${lost} The original data could not be copied (storage is full).`;
  return { items: result.items, notice, damagedKey: kept ? damagedKey : null };
}

/** Saves the list; returns a user-facing error instead of throwing (e.g. storage full). */
export function saveMaintenanceToStorage(key: string, items: MaintenanceItem[]): string | null {
  try {
    localStorage.setItem(key, JSON.stringify(items));
    return null;
  } catch {
    return 'Could not save maintenance records: device storage is full. Your latest changes are kept on screen only; free some space and edit again.';
  }
}

export function readDamagedMaintenance(damagedKey: string): string | null {
  return read(damagedKey);
}

/** Starts a download of `text` (website and Android WebView with blob support). */
export function downloadTextFile(text: string, filename: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
