import { describe, expect, it } from 'vitest';
import { dismissTopDialog, isDialogOpen, showAlert, showConfirm } from './AppDialog';

describe('AppDialog queue', () => {
  it('shows one dialog at a time, in order, and back/escape counts as cancel', async () => {
    expect(isDialogOpen()).toBe(false);
    expect(dismissTopDialog()).toBe(false);

    const order: string[] = [];
    const first = showConfirm({ title: 'Delete?', tone: 'danger' }).then((ok) => order.push(`confirm:${ok}`));
    const second = showAlert({ title: 'Saved' }).then(() => order.push('alert'));
    expect(isDialogOpen()).toBe(true);

    expect(dismissTopDialog()).toBe(true);
    await first;
    expect(isDialogOpen()).toBe(true);
    expect(dismissTopDialog()).toBe(true);
    await second;

    expect(order).toEqual(['confirm:false', 'alert']);
    expect(isDialogOpen()).toBe(false);
  });

  it('accepts a plain string as an alert title', async () => {
    const done = showAlert('Backup imported');
    expect(isDialogOpen()).toBe(true);
    dismissTopDialog();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('AppDialog suspension', () => {
  it('hides dialogs under the lock or alarm screen and brings them back', async () => {
    const { setDialogsSuspended } = await import('./AppDialog');
    const answer = showConfirm({ title: 'Delete?' });
    setDialogsSuspended(true);
    expect(isDialogOpen()).toBe(false);
    // The back button belongs to the lock / alarm screen meanwhile.
    expect(dismissTopDialog()).toBe(false);
    setDialogsSuspended(false);
    expect(isDialogOpen()).toBe(true);
    dismissTopDialog();
    await expect(answer).resolves.toBe(false);
  });
});
