/**
 * Password health for the vault: strength of one password, and weak, reused
 * and old passwords across the vault, rolled into a 0-100 score. Pure and
 * offline: nothing here leaves the device.
 */
import { needsPassword } from './passwordVault';
import type { VaultEntry } from './passwordVault';

export type Strength = 'weak' | 'fair' | 'strong' | 'very-strong';

export const STRENGTH_LABEL: Record<Strength, string> = {
  weak: 'Weak',
  fair: 'Fair',
  strong: 'Strong',
  'very-strong': 'Very strong',
};

/** A password older than this counts as old. */
export const OLD_PASSWORD_DAYS = 365;
const DAY_MS = 86_400_000;

const COMMON = new Set([
  'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey',
  'dragon', 'football', 'baseball', 'abc123', 'abcd1234', 'master', 'sunshine', 'princess', 'shadow',
  'trustno1', 'superman', 'india123', 'password1', 'login', 'starwars', 'whatever', 'freedom',
]);

/** Rough entropy in bits: character pool size, minus penalties for patterns. */
export function passwordBits(password: string): number {
  if (!password) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;
  const unique = new Set(password).size;
  // Repeats ("aaaa1111") count by their distinct characters, not their length.
  const effectiveLength = Math.min(password.length, unique * 2);
  let bits = effectiveLength * Math.log2(Math.max(pool, 2));
  const lower = password.toLowerCase();
  // "Passw0rd!" is still "password": undo common letter swaps, then drop the rest.
  const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
  const core = lower.replace(/[013457@$]/g, (char) => LEET[char]).replace(/[^a-z]/g, '');
  if (COMMON.has(lower) || COMMON.has(core)) bits = Math.min(bits, 10);
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv)/.test(lower)) bits -= 10;
  if (/^(19|20)\d\d$/.test(password.slice(-4))) bits -= 6;
  return Math.max(0, Math.round(bits));
}

export function passwordStrength(password: string): Strength {
  const bits = passwordBits(password);
  if (password.length < 8 || bits < 40) return 'weak';
  if (bits < 60) return 'fair';
  if (bits < 85) return 'strong';
  return 'very-strong';
}

export interface VaultHealth {
  /** 0-100; 100 when there is nothing to check. */
  score: number;
  checked: number;
  weak: string[];
  /** Ids whose password is used by another item too. */
  reused: string[];
  old: string[];
}

/** Items that hold a password and are not in the trash. */
function checkable(entries: VaultEntry[]): VaultEntry[] {
  return entries.filter((entry) => !entry.trashedAt && needsPassword(entry.kind) && entry.password);
}

export function vaultHealth(entries: VaultEntry[], now = Date.now()): VaultHealth {
  const items = checkable(entries);
  const byPassword = new Map<string, string[]>();
  for (const entry of items) byPassword.set(entry.password, [...(byPassword.get(entry.password) ?? []), entry.id]);
  const weak = items.filter((entry) => passwordStrength(entry.password) === 'weak').map((entry) => entry.id);
  const reused = [...byPassword.values()].filter((ids) => ids.length > 1).flat();
  const old = items.filter((entry) => {
    const changed = entry.passwordChangedAt ? Date.parse(entry.passwordChangedAt) : NaN;
    return Number.isFinite(changed) && now - changed > OLD_PASSWORD_DAYS * DAY_MS;
  }).map((entry) => entry.id);
  if (items.length === 0) return { score: 100, checked: 0, weak, reused, old };
  // Weak and reused passwords weigh most; old ones a little.
  const penalty = (weak.length * 1 + reused.length * 0.8 + old.length * 0.3) / items.length;
  const score = Math.max(0, Math.round(100 * (1 - Math.min(penalty, 1))));
  return { score, checked: items.length, weak, reused, old };
}
