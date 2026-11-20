/**
 * Splitting a bill with friends: you paid the whole amount, your share is
 * spending, and each friend's share becomes money you lent them (a "lent" debt
 * with its ledger entry, so it is not counted as spending). Plus the UPI link
 * and message for asking them to pay back. Pure; amounts in rupees, math in paise.
 */
import { formatRupees, fromPaise, toPaise } from './money';

export interface FriendShare {
  name: string;
  amount: number;
}

/**
 * Splits `total` equally between you and `friendCount` friends. Paise that do
 * not divide evenly go to your share, so the friends' shares are round.
 */
export function evenShares(total: number, friendCount: number): { mine: number; friends: number[] } {
  const totalPaise = Math.max(0, toPaise(total));
  const people = Math.max(1, friendCount + 1);
  const each = Math.floor(totalPaise / people);
  const mine = totalPaise - each * friendCount;
  return { mine: fromPaise(mine), friends: Array.from({ length: friendCount }, () => fromPaise(each)) };
}

/** What is wrong with a split, or null when it adds up. */
export function checkFriendSplit(total: number, mine: number, friends: FriendShare[]): string | null {
  if (!(toPaise(total) > 0)) return 'Enter the total you paid.';
  if (friends.length === 0) return 'Add at least one friend.';
  if (friends.some((f) => !f.name.trim())) return 'Give every friend a name.';
  if (friends.some((f) => !(toPaise(f.amount) > 0))) return 'Every friend needs a share above zero.';
  if (toPaise(mine) < 0) return 'Your share cannot be below zero.';
  const sum = toPaise(mine) + friends.reduce((paise, f) => paise + toPaise(f.amount), 0);
  const diff = toPaise(total) - sum;
  if (diff > 0) return `${formatRupees(fromPaise(diff))} is not assigned to anyone yet.`;
  if (diff < 0) return `The shares are ${formatRupees(fromPaise(-diff))} more than the total.`;
  return null;
}

/** A UPI ID like name@bank (letters, digits, dot, dash, underscore before the @). */
export function isValidUpiId(value: string): boolean {
  return /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.]{1,63}$/.test(value.trim());
}

/** upi://pay link that opens any UPI app with the payee, amount and note filled in. */
export function upiPayLink(input: { upiId: string; payeeName?: string; amount: number; note?: string }): string {
  const params = new URLSearchParams();
  params.set('pa', input.upiId.trim());
  if (input.payeeName?.trim()) params.set('pn', input.payeeName.trim());
  params.set('am', fromPaise(toPaise(input.amount)).toFixed(2));
  params.set('cu', 'INR');
  if (input.note?.trim()) params.set('tn', input.note.trim().slice(0, 50));
  return `upi://pay?${params.toString()}`;
}

/** The message sent to a friend: their share, what for, and how to pay you. */
export function reminderMessage(input: {
  personName: string;
  amount: number;
  note?: string;
  upiId?: string;
  payeeName?: string;
}): string {
  const what = input.note?.trim() ? ` for ${input.note.trim()}` : '';
  const lines = [`Hi ${input.personName.trim()}, your share${what} is ${formatRupees(input.amount)}.`];
  if (input.upiId && isValidUpiId(input.upiId)) {
    lines.push(`Pay by UPI to ${input.upiId.trim()}:`);
    lines.push(upiPayLink({ upiId: input.upiId, payeeName: input.payeeName, amount: input.amount, note: input.note }));
  }
  return lines.join('\n');
}
