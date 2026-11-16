import { describe, expect, it } from 'vitest';
import { createVault, generateVaultPassword, openVault, readVaultFile, sealEntries } from './passwordVault';

const passphrase = 'a strong example passphrase';
const replacement = 'a different example passphrase';
const entry = {
  id: 'example-id',
  title: 'Example ☀️',
  website: 'https://private.example',
  username: 'my-private-username',
  password: 'a private password',
  notes: 'private notes',
};

describe('password vault', () => {
  it('round-trips encrypted backups, rejects tampering, and rotates on passphrase change', async () => {
    const { file, key } = await createVault(passphrase);
    file.entries = await sealEntries(file.id, key, [entry]);
    const backup = JSON.stringify(file);
    for (const value of Object.values(entry)) expect(backup).not.toContain(value);
    expect(backup).not.toContain(passphrase);

    const restored = await openVault(readVaultFile(backup), passphrase);
    expect(restored.entries).toEqual([entry]);
    const rotated = await createVault(replacement, restored.entries);
    expect(rotated.file.id).not.toBe(file.id);
    expect(rotated.file.wrappedKey).not.toEqual(file.wrappedKey);
    await expect(openVault(rotated.file, passphrase)).rejects.toThrow('incorrect or');
    await expect(openVault(rotated.file, replacement)).resolves.toMatchObject({ entries: [entry] });

    const ciphertext = file.entries.ciphertext;
    const tampered = {
      ...file,
      entries: { ...file.entries, ciphertext: (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1) },
    };
    await expect(openVault(readVaultFile(JSON.stringify(tampered)), passphrase)).rejects.toThrow('altered');
  }, 30_000);

  it('rejects unsupported backups and short passphrases', async () => {
    expect(() => readVaultFile('{"format":"dayflow-password-vault","version":2}')).toThrow('unsupported');
    await expect(createVault('short')).rejects.toThrow('at least 15 characters');
  });

  it('honors the password generator options', () => {
    expect(generateVaultPassword(16, false, false)).toMatch(/^[A-Za-z]{16}$/);
    const mixed = generateVaultPassword(32, true, true);
    expect(mixed).toHaveLength(32);
    expect(mixed).toMatch(/[a-z]/);
    expect(mixed).toMatch(/[A-Z]/);
    expect(mixed).toMatch(/[0-9]/);
    expect(mixed).toMatch(/[^A-Za-z0-9]/);
  });
});
