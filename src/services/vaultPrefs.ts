/**
 * Password vault preferences for this device only (not secret, not synced):
 * the auto-lock time and when an encrypted backup was last saved, per vault.
 */
const PREFS_KEY = 'dayflow_vault_prefs_v1';

export const AUTO_LOCK_CHOICES = [1, 5, 15] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_CHOICES)[number];
/** Remind about a backup when the last one is older than this. */
export const BACKUP_REMINDER_DAYS = 30;

interface VaultPrefs {
  autoLockMinutes: AutoLockMinutes;
  lastBackup: Record<string, string>;
}

const DEFAULTS: VaultPrefs = { autoLockMinutes: 5, lastBackup: {} };

export function readVaultPrefs(): VaultPrefs {
  try {
    const value = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<VaultPrefs> | null;
    if (!value || typeof value !== 'object') return DEFAULTS;
    const minutes = AUTO_LOCK_CHOICES.includes(value.autoLockMinutes as AutoLockMinutes)
      ? (value.autoLockMinutes as AutoLockMinutes)
      : DEFAULTS.autoLockMinutes;
    const lastBackup: Record<string, string> = {};
    if (value.lastBackup && typeof value.lastBackup === 'object') {
      for (const [id, at] of Object.entries(value.lastBackup)) {
        if (typeof at === 'string' && Number.isFinite(Date.parse(at))) lastBackup[id] = at;
      }
    }
    return { autoLockMinutes: minutes, lastBackup };
  } catch {
    return DEFAULTS;
  }
}

function writeVaultPrefs(prefs: VaultPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the defaults apply next time.
  }
}

export function setAutoLockMinutes(minutes: AutoLockMinutes): void {
  writeVaultPrefs({ ...readVaultPrefs(), autoLockMinutes: minutes });
}

export function markBackupSaved(vaultId: string, at: string): void {
  const prefs = readVaultPrefs();
  writeVaultPrefs({ ...prefs, lastBackup: { ...prefs.lastBackup, [vaultId]: at } });
}

export function backupIsDue(vaultId: string, now = Date.now()): boolean {
  const at = readVaultPrefs().lastBackup[vaultId];
  return !at || now - Date.parse(at) > BACKUP_REMINDER_DAYS * 86_400_000;
}
