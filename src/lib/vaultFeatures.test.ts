import { describe, expect, it } from 'vitest';
import { applyEntryEdit, checkVaultEntry, createVaultHeader, entryRowId, importVaultKey, openVaultRecord, sealVaultRecord, vaultKeyBytes } from './passwordVault';
import type { VaultEntry } from './passwordVault';
import { passwordStrength, vaultHealth } from './vaultHealth';
import { decodeBase32, isValidTotp, parseTotp, totpCode } from './totp';
import { importPasswordCsv, parseCsv } from './vaultImport';

const base: VaultEntry = { id: 'a', title: 'Site', website: '', username: 'me', password: 'Correct-Horse-Battery-9', notes: '' };
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-06-01T00:00:00.000Z';

describe('vault items', () => {
  it('validates per kind: notes and cards need no password, logins and Wi-Fi do', () => {
    expect(checkVaultEntry({ ...base, kind: 'note', password: '' })).toMatchObject({ kind: 'note' });
    expect(checkVaultEntry({ ...base, kind: 'card', password: '', card: { holder: 'A', number: '4111', expiry: '12/29', cvv: '123' } }))
      .toMatchObject({ card: { number: '4111' } });
    expect(() => checkVaultEntry({ ...base, password: '' })).toThrow('Enter a password');
    expect(() => checkVaultEntry({ ...base, kind: 'wifi', password: '' })).toThrow('Wi-Fi');
    expect(() => checkVaultEntry({ ...base, title: '  ' })).toThrow('title');
    expect(() => checkVaultEntry({ ...base, category: 'x'.repeat(41) })).toThrow('too long');
  });

  it('drops unset optional fields so old items read back unchanged', () => {
    expect(checkVaultEntry({ ...base, kind: 'login', favorite: false, category: '' })).toEqual(base);
  });

  it('keeps the last five passwords, newest first, when the password changes', () => {
    let entry = applyEntryEdit(undefined, base, T1);
    expect(entry.passwordChangedAt).toBe(T1);
    for (let index = 1; index <= 6; index++) entry = applyEntryEdit(entry, { ...entry, password: `pass-${index}-long-enough` }, T2);
    expect(entry.history).toHaveLength(5);
    expect(entry.history?.[0].password).toBe('pass-5-long-enough');
    expect(entry.passwordChangedAt).toBe(T2);
    const same = applyEntryEdit(entry, { ...entry, notes: 'edited' }, '2026-07-01T00:00:00.000Z');
    expect(same.passwordChangedAt).toBe(T2);
    // Going back to an old password removes it from the history.
    const back = applyEntryEdit(entry, { ...entry, password: 'pass-3-long-enough' }, T2);
    expect(back.history?.map((item) => item.password)).not.toContain('pass-3-long-enough');
  });

  it('round-trips every new field through a sealed record', async () => {
    const { header, key } = await createVaultHeader('a strong example passphrase', T1);
    const full: VaultEntry = {
      ...base, kind: 'login', category: 'Banking', favorite: true, totp: 'JBSWY3DPEHPK3PXP',
      history: [{ password: 'old-password-here', changedAt: T1 }], passwordChangedAt: T2, trashedAt: T2,
    };
    const clean = checkVaultEntry(full);
    const sealed = await sealVaultRecord(header.vaultId, key, clean, T2);
    expect(await openVaultRecord(header.vaultId, key, entryRowId(base.id), sealed)).toEqual(clean);

    // The raw key released for fingerprint / passkey unlock opens the same records.
    const raw = await vaultKeyBytes(header, 'a strong example passphrase');
    const copy = new Uint8Array(raw);
    const imported = await importVaultKey(raw);
    expect(raw.every((byte) => byte === 0)).toBe(true);
    expect(copy.length).toBe(32);
    expect(await openVaultRecord(header.vaultId, imported, entryRowId(base.id), sealed)).toEqual(clean);
  }, 30_000);
});

describe('password health', () => {
  it('rates strength', () => {
    expect(passwordStrength('password')).toBe('weak');
    expect(passwordStrength('Passw0rd!')).toBe('weak');
    expect(passwordStrength('abc12345')).toBe('weak');
    expect(passwordStrength('aaaaaaaaaaaaaaaa')).toBe('weak');
    expect(passwordStrength('Tr0ub4dor&3x')).not.toBe('weak');
    expect(passwordStrength('k#9Lq2!vZ8@wP4$mR7^t')).toBe('very-strong');
  });

  it('finds weak, reused and old passwords and ignores trash, notes and cards', () => {
    const now = Date.parse('2027-06-01T00:00:00.000Z');
    const entries: VaultEntry[] = [
      { ...base, id: '1', password: 'Shared-Strong-Pass-77' },
      { ...base, id: '2', password: 'Shared-Strong-Pass-77', passwordChangedAt: '2025-01-01T00:00:00.000Z' },
      { ...base, id: '3', password: 'password' },
      { ...base, id: '4', password: 'password', trashedAt: T1 },
      { ...base, id: '5', kind: 'note', password: '' },
      { ...base, id: '6', password: 'Unique-Strong-Pass-88', passwordChangedAt: '2027-05-01T00:00:00.000Z' },
    ];
    const health = vaultHealth(entries, now);
    expect(health.checked).toBe(4);
    expect(health.weak).toEqual(['3']);
    expect(health.reused.sort()).toEqual(['1', '2']);
    expect(health.old).toEqual(['2']);
    expect(health.score).toBeGreaterThan(0);
    expect(health.score).toBeLessThan(100);
    expect(vaultHealth([]).score).toBe(100);
  });
});

describe('2FA codes', () => {
  // RFC 6238 appendix B test vectors.
  const sha1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const sha256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';

  it('matches the RFC test vectors', async () => {
    const config = { ...parseTotp(sha1), digits: 8 as const };
    expect((await totpCode(config, 59_000)).code).toBe('94287082');
    expect((await totpCode(config, 1_111_111_109_000)).code).toBe('07081804');
    const uri = `otpauth://totp/Example:me?secret=${sha256}&algorithm=SHA256&digits=8&period=30`;
    expect((await totpCode(uri, 59_000)).code).toBe('46119246');
  });

  it('reports seconds left and rejects bad secrets', async () => {
    expect((await totpCode('JBSWY3DPEHPK3PXP', 61_000)).remaining).toBe(29);
    expect(decodeBase32('jbsw y3dp')).toEqual(decodeBase32('JBSWY3DP'));
    expect(isValidTotp('not base32!')).toBe(false);
    expect(isValidTotp('otpauth://hotp/x?secret=JBSWY3DP')).toBe(false);
    expect(isValidTotp('otpauth://totp/x?secret=JBSWY3DP&digits=9')).toBe(false);
  });
});

describe('CSV import', () => {
  it('parses quoted fields with commas, quotes and newlines', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  });

  it('reads a Chrome export', () => {
    let next = 0;
    const csv = 'name,url,username,password,note\nGmail,https://accounts.google.com,me@gmail.com,Secret-Pass-1,\n,https://www.bank.example/login,u,p@ss-word-2,"two\nlines"\nempty,https://x.example,u,,\n';
    const result = importPasswordCsv(csv, () => `id-${next++}`);
    expect(result.format).toBe('chrome');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]).toMatchObject({ title: 'bank.example', notes: 'two\nlines' });
    expect(result.skipped).toBe(1);
  });

  it('reads a Bitwarden export with folders, favourites, 2FA and notes', () => {
    const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
      'Banking,1,login,HDFC,,,0,https://netbanking.hdfc.example,me,Bank-Pass-123,JBSWY3DPEHPK3PXP\n' +
      ',,note,Recovery codes,abc def,,0,,,,\n' +
      ',,card,Visa,,,0,,,,\n';
    const result = importPasswordCsv(csv, () => crypto.randomUUID());
    expect(result.format).toBe('bitwarden');
    expect(result.entries[0]).toMatchObject({ category: 'Banking', favorite: true, totp: 'JBSWY3DPEHPK3PXP' });
    expect(result.entries[1]).toMatchObject({ kind: 'note', notes: 'abc def' });
    expect(result.skipped).toBe(1);
  });

  it('rejects other files', () => {
    expect(() => importPasswordCsv('title,amount\nx,1\n')).toThrow('Chrome');
  });
});

describe('account-key vaults (no passphrase)', () => {
  it('creates, opens and validates an account vault', async () => {
    const { isVaultHeader, createAccountVault, openAccountVault, accountKeyBytes } = await import('./passwordVault');
    const { header, key } = await createAccountVault(T1);
    expect(isVaultHeader(header)).toBe(true);
    expect(header.salt).toBeUndefined();
    const sealed = await sealVaultRecord(header.vaultId, key, base, T2);
    const reopened = await openAccountVault(header);
    expect(await openVaultRecord(header.vaultId, reopened, entryRowId(base.id), sealed)).toEqual(base);
    expect(accountKeyBytes(header)).toHaveLength(32);
    // A header cannot mix a plain key with a passphrase wrapping.
    expect(isVaultHeader({ ...header, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' })).toBe(false);
  });

  it('converts a passphrase vault to account mode without re-encrypting items', async () => {
    const { accountHeader, openAccountVault } = await import('./passwordVault');
    const { header, key } = await createVaultHeader('a strong example passphrase', T1);
    const sealed = await sealVaultRecord(header.vaultId, key, base, T2);
    const raw = await vaultKeyBytes(header, 'a strong example passphrase');
    const converted = accountHeader(header.vaultId, raw, T2);
    const opened = await openAccountVault(converted);
    expect(await openVaultRecord(header.vaultId, opened, entryRowId(base.id), sealed)).toEqual(base);
    await expect(vaultKeyBytes(converted, 'anything at all here')).rejects.toThrow('no passphrase');
  }, 30_000);
});
