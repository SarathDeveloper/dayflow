import { describe, expect, it } from 'vitest';
import { checkFriendSplit, evenShares, isValidUpiId, reminderMessage, upiPayLink } from './friendSplit';

describe('split with friends', () => {
  it('splits evenly and gives odd paise to your share', () => {
    expect(evenShares(1000, 2)).toEqual({ mine: 333.34, friends: [333.33, 333.33] });
    expect(evenShares(900, 2)).toEqual({ mine: 300, friends: [300, 300] });
  });

  it('checks that the shares add up to the total', () => {
    expect(checkFriendSplit(1000, 400, [{ name: 'Ravi', amount: 600 }])).toBeNull();
    expect(checkFriendSplit(1000, 300, [{ name: 'Ravi', amount: 600 }])).toContain('not assigned');
    expect(checkFriendSplit(1000, 500, [{ name: 'Ravi', amount: 600 }])).toContain('more than the total');
    expect(checkFriendSplit(1000, 400, [{ name: ' ', amount: 600 }])).toContain('name');
    expect(checkFriendSplit(1000, 1000, [])).toContain('friend');
  });

  it('builds a UPI pay link and a reminder message', () => {
    expect(isValidUpiId('sarath@okaxis')).toBe(true);
    expect(isValidUpiId('not an id')).toBe(false);
    const link = upiPayLink({ upiId: 'sarath@okaxis', payeeName: 'Sarath', amount: 333.3, note: 'Dinner' });
    expect(link).toBe('upi://pay?pa=sarath%40okaxis&pn=Sarath&am=333.30&cu=INR&tn=Dinner');
    const message = reminderMessage({ personName: 'Ravi', amount: 333.3, note: 'Dinner', upiId: 'sarath@okaxis' });
    expect(message).toContain('Hi Ravi, your share for Dinner is ₹333.30.');
    expect(message).toContain('upi://pay?');
    expect(reminderMessage({ personName: 'Ravi', amount: 500 })).not.toContain('upi://');
  });
});
