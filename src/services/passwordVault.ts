/**
 * Password Vault platform code: where the encrypted vault is kept on this
 * device, clipboard and backup helpers, and the sync of its encrypted rows.
 *
 * - Android: the native PasswordVault plugin (a file in noBackupFilesDir,
 *   screen-capture protection, a sensitive clipboard entry, a save screen).
 * - Website: localStorage, the browser clipboard (cleared after a while), and
 *   a download for backups.
 *
 * Everything stored or synced is ciphertext; see lib/passwordVault.ts.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { isNativeAndroid } from '../lib/platform';
import { pullStart } from '../lib/cloudRecords';
import {
  adoptRemoteVault, advanceVaultCursor, markVaultPushed, mergeRemoteRows, parseStoredVault, remoteHeader,
  serializeVault, VAULT_COLLECTION, VAULT_HEADER_ROW, vaultIdsToDownload, vaultPushRows,
} from '../lib/passwordVaultSync';
import type { LocalVaultState } from '../lib/passwordVaultSync';
import { fetchRows, isCloudConfigured, pullRowMeta, pushRows, storedAccount } from './cloudSyncService';
import { downloadTextFile } from './maintenanceStorage';

interface PasswordVaultPlugin {
  read(): Promise<{ contents?: string }>;
  write(options: { contents: string; previous?: string }): Promise<void>;
  setScreenProtected(options: { enabled: boolean }): Promise<void>;
  copySecret(options: { text: string }): Promise<void>;
  exportBackup(options: { contents: string; filename: string }): Promise<{ saved: boolean }>;
}

export const PasswordVault = registerPlugin<PasswordVaultPlugin>('PasswordVault');

const WEB_VAULT_KEY = 'dayflow_password_vault_v2';
const CLIPBOARD_CLEAR_MS = 30_000;

/** The Android app's native vault plugin (screen protection, device file). */
export function hasNativePasswordVault(): boolean {
  return isNativeAndroid() && Capacitor.isPluginAvailable('PasswordVault');
}

function webStorageWorks(): boolean {
  try {
    const probe = '__dayflow_vault_probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** True where the vault can be used: the Android app, or a browser with WebCrypto and storage. */
export function hasPasswordVault(): boolean {
  if (hasNativePasswordVault()) return true;
  if (Capacitor.isNativePlatform()) return false;
  return typeof crypto !== 'undefined' && Boolean(crypto.subtle) && webStorageWorks();
}

/** Reads the stored vault text (null when there is none). */
export async function readVaultStore(): Promise<string | null> {
  if (hasNativePasswordVault()) {
    const { contents } = await PasswordVault.read();
    return contents || null;
  }
  try {
    return localStorage.getItem(WEB_VAULT_KEY) || null;
  } catch {
    throw new Error('Could not read the vault in this browser.');
  }
}

/**
 * Compare-and-swap write: fails when the stored text is no longer `previous`
 * (another tab, the background sync). An empty `contents` removes the vault.
 */
export async function writeVaultStore(contents: string, previous: string | null): Promise<void> {
  if (hasNativePasswordVault()) {
    await PasswordVault.write({ contents, previous: previous ?? undefined });
    return;
  }
  let current: string | null;
  try {
    current = localStorage.getItem(WEB_VAULT_KEY) || null;
  } catch {
    throw new Error('Could not read the vault in this browser.');
  }
  if (current !== previous) throw new Error('The vault changed. Reopen it and try again.');
  try {
    if (contents) localStorage.setItem(WEB_VAULT_KEY, contents);
    else localStorage.removeItem(WEB_VAULT_KEY);
  } catch {
    throw new Error('Could not save the vault: this browser’s storage is full or blocked.');
  }
}

/** Android blocks screenshots while the vault is open. A browser cannot. */
export async function setVaultScreenProtected(enabled: boolean): Promise<void> {
  if (hasNativePasswordVault()) await PasswordVault.setScreenProtected({ enabled });
}

let clipboardTimer: number | undefined;

export async function copyVaultSecret(text: string): Promise<void> {
  if (hasNativePasswordVault()) {
    await PasswordVault.copySecret({ text });
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error('This browser cannot copy to the clipboard.');
  await navigator.clipboard.writeText(text);
  // Clear it after a while, but only if it still holds this password (never wipe
  // something the person copied since). Browsers that refuse readText keep it.
  window.clearTimeout(clipboardTimer);
  clipboardTimer = window.setTimeout(() => {
    void navigator.clipboard.readText?.()
      .then((current) => (current === text ? navigator.clipboard.writeText('') : undefined))
      .catch(() => undefined);
  }, CLIPBOARD_CLEAR_MS);
}

export async function exportVaultBackup(contents: string, filename: string): Promise<{ saved: boolean }> {
  if (hasNativePasswordVault()) return PasswordVault.exportBackup({ contents, filename });
  downloadTextFile(contents, filename);
  return { saved: true };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export type VaultSyncStatus =
  /** Pulled and pushed; nothing left to upload. */
  | 'synced'
  /** Not signed in, or this build has no cloud: the vault stays on this device. */
  | 'local-only'
  /** Neither this device nor the account has a vault. */
  | 'no-vault'
  /** A pre-sync Android vault: unlock once to convert it, then it syncs. */
  | 'needs-upgrade'
  /** This device's vault syncs with a different account. */
  | 'other-account'
  /** The account already has a different vault (made on another device). */
  | 'conflict'
  /** The network or server failed; changes are kept and sent next time. */
  | 'offline';

export interface VaultSyncResult {
  status: VaultSyncStatus;
  /** True when this sync changed the stored vault. */
  changed: boolean;
  message?: string;
}

let running: Promise<VaultSyncResult> | null = null;
let again = false;

/**
 * Pulls and pushes the vault's encrypted rows for the signed-in account. Safe to
 * call often: calls made while one runs share a single follow-up run.
 */
export function syncPasswordVault(): Promise<VaultSyncResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let result: VaultSyncResult;
    let changed = false;
    do {
      again = false;
      result = await syncWithRetry();
      changed ||= result.changed;
    } while (again);
    return { ...result, changed };
  })().finally(() => {
    running = null;
  });
  return running;
}

async function syncWithRetry(): Promise<VaultSyncResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncOnce();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // The vault changed locally while the network calls ran: start over.
      if (attempt < 2 && /vault changed/i.test(message)) continue;
      return { status: 'offline', changed: false, message };
    }
  }
}

async function syncOnce(): Promise<VaultSyncResult> {
  const userId = storedAccount()?.id;
  if (!isCloudConfigured() || !userId || !hasPasswordVault()) return { status: 'local-only', changed: false };

  const text = await readVaultStore();
  const stored = parseStoredVault(text);
  if (stored.kind === 'legacy') return { status: 'needs-upgrade', changed: false };
  const local = stored.kind === 'synced' ? stored.state : null;
  if (local?.ownerId && local.ownerId !== userId) return { status: 'other-account', changed: false };

  const incremental = Boolean(local?.ownerId && local.cursor);
  const meta = await pullRowMeta(userId, incremental ? pullStart(local!.cursor) : null, VAULT_COLLECTION);
  // Always read the header when the server has one: it names the vault the rows belong to.
  const ids = new Set(vaultIdsToDownload(local, meta));
  if (meta.some((row) => row.id === VAULT_HEADER_ROW && !row.deleted)) ids.add(VAULT_HEADER_ROW);
  const rows = await fetchRows(userId, [...ids]);
  const header = remoteHeader(rows);
  const cursor = advanceVaultCursor(local?.cursor, meta);

  if (!local) {
    if (!header) return { status: 'no-vault', changed: false };
    // A full pull is needed to adopt the account's vault.
    const full = incremental ? await pullRowMeta(userId, null, VAULT_COLLECTION) : meta;
    const fullRows = incremental
      ? await fetchRows(userId, full.filter((row) => !row.deleted).map((row) => row.id))
      : rows;
    const adopted = adoptRemoteVault(header, full, fullRows, userId, advanceVaultCursor(undefined, full));
    await writeVaultStore(serializeVault(adopted), text);
    return { status: 'synced', changed: true };
  }

  if (header && header.vaultId !== local.header.vaultId) {
    return {
      status: 'conflict',
      changed: false,
      message: 'This account already has a password vault from another device.',
    };
  }

  let { state, changed } = mergeRemoteRows(local, meta, rows);

  if (!state.ownerId) {
    // First sync of this vault. Claim the account with the header alone and
    // check it landed, so two devices that each made a vault cannot mix logins
    // encrypted with different keys.
    if (!header) {
      const headerRow = vaultPushRows({ ...state, dirty: [VAULT_HEADER_ROW] });
      await pushRows(userId, headerRow);
      const check = remoteHeader(await fetchRows(userId, [VAULT_HEADER_ROW]));
      if (!check || check.vaultId !== state.header.vaultId) {
        return { status: 'conflict', changed: false, message: 'Another device created a vault for this account at the same time.' };
      }
    }
    state = { ...state, ownerId: userId };
    changed = true;
  }

  const push = vaultPushRows(state);
  await pushRows(userId, push);
  state = markVaultPushed({ ...state, cursor }, push);
  if (push.length || cursor !== local.cursor) changed = true;
  if (changed) await writeVaultStore(serializeVault(state), text);
  return { status: 'synced', changed };
}

/**
 * At sign-out: sync, then remove this device's vault copy (it holds the key)
 * if the server has every change. Unsynced changes keep the copy until the
 * same account signs in again.
 */
export async function forgetSyncedVault(): Promise<void> {
  if (!hasPasswordVault()) return;
  await syncPasswordVault();
  const text = await readVaultStore();
  let stored: ReturnType<typeof parseStoredVault>;
  try {
    stored = parseStoredVault(text);
  } catch {
    return;
  }
  if (stored.kind === 'synced' && stored.state.ownerId && stored.state.dirty.length === 0) {
    await writeVaultStore('', text);
  }
}

/**
 * Removes this device's vault copy (after a conflict or account change, once
 * the person saved a backup), then syncs so the account's vault comes down.
 */
export async function discardLocalVault(previous: string | null): Promise<VaultSyncResult> {
  await writeVaultStore('', previous);
  return syncPasswordVault();
}

/** Saves `next` over `previous` and returns the stored text. The caller syncs afterwards. */
export async function saveVaultState(next: LocalVaultState, previous: string | null): Promise<string> {
  const contents = serializeVault(next);
  await writeVaultStore(contents, previous);
  return contents;
}
