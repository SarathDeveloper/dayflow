import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDocument,
  addDocumentRevision,
  attachmentIds,
  buildDocumentBackup,
  checkVaultLimits,
  createDocumentVault,
  currentRevision,
  decryptAttachment,
  deleteDocumentRevision,
  DOCUMENT_LIMITS,
  documentReminderDates,
  documentReminderEntries,
  encryptAttachment,
  newDocumentId,
  parseDocumentBackup,
  parseDocumentIndex,
  readDocumentEnvelope,
  removeDocument,
  sealDocumentIndex,
  setShowReminderTitles,
  sniffDocumentType,
  unlockDocumentVault,
  updateDocumentDetails,
  validateDocumentFile,
  vaultUsageBytes,
  verifyDocumentBackup,
  WRONG_PASSPHRASE_MESSAGE,
  type DocumentIndex,
  type DocumentSession,
  type StoredBlob,
  type VaultDocument,
} from './documentVault';
import { bytesToBase64 } from './passwordVault';

const passphrase = 'correct horse battery staple vault';
const NOW = '2026-11-16T10:00:00.000Z';
const LATER = '2026-11-17T10:00:00.000Z';
const KDF_TIMEOUT = 120_000;

function bytesOf(prefix: number[], length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(prefix);
  for (let i = prefix.length; i < length; i++) bytes[i] = (i * 37) % 251;
  return bytes;
}

const PDF = bytesOf([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const JPEG = bytesOf([0xff, 0xd8, 0xff, 0xe0], 80);
const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 96);

function flipFirstChar(base64: string): string {
  return (base64[0] === 'A' ? 'B' : 'A') + base64.slice(1);
}

describe('file checks', () => {
  it('detects types by magic bytes, not by name', () => {
    expect(sniffDocumentType(PDF)).toBe('application/pdf');
    expect(sniffDocumentType(JPEG)).toBe('image/jpeg');
    expect(sniffDocumentType(PNG)).toBe('image/png');
    expect(sniffDocumentType(new TextEncoder().encode('hello world'))).toBeNull();
    expect(sniffDocumentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // truncated PNG signature
    expect(sniffDocumentType(new Uint8Array())).toBeNull();

    // A PDF renamed to .png is still a PDF; a text file renamed to .pdf is rejected.
    expect(validateDocumentFile({ name: 'passport.png', size: PDF.length, bytes: PDF }))
      .toEqual({ filename: 'passport.png', mimeType: 'application/pdf' });
    const text = new TextEncoder().encode('not really a pdf');
    expect(() => validateDocumentFile({ name: 'fake.pdf', size: text.length, bytes: text })).toThrow('Only PDF, JPEG and PNG');
  });

  it('rejects empty, oversized and partially read files and cleans names', () => {
    expect(() => validateDocumentFile({ name: 'a.pdf', size: 0, bytes: new Uint8Array() })).toThrow('empty');
    const big = new Uint8Array(DOCUMENT_LIMITS.maxFileBytes + 1);
    big.set(PDF.subarray(0, 8));
    expect(() => validateDocumentFile({ name: 'big.pdf', size: big.length, bytes: big })).toThrow('up to 10 MB');
    expect(() => validateDocumentFile({ name: 'a.pdf', size: PDF.length + 5, bytes: PDF })).toThrow('could not be read');

    const long = `${'x'.repeat(300)}.pdf`;
    const { filename } = validateDocumentFile({ name: long, size: PDF.length, bytes: PDF });
    expect(filename.length).toBe(DOCUMENT_LIMITS.maxFilename);
    expect(filename.endsWith('.pdf')).toBe(true);
    expect(validateDocumentFile({ name: '  ', size: PNG.length, bytes: PNG }).filename).toBe('document.png');
    expect(validateDocumentFile({ name: 'C:\\fakepath\\scan\u0007.jpg', size: JPEG.length, bytes: JPEG }).filename).toBe('scan.jpg');
  });
});

describe('expiry reminder dates', () => {
  it('uses local calendar arithmetic across month ends and leap years', () => {
    expect(documentReminderDates('2028-03-29', [30])).toEqual(['2028-02-28']);
    expect(documentReminderDates('2028-03-29', [29])).toEqual(['2028-02-29']);
    expect(documentReminderDates('2027-03-01', [1])).toEqual(['2027-02-28']);
    expect(documentReminderDates('2028-03-01', [1])).toEqual(['2028-02-29']);
    expect(documentReminderDates('2027-01-05', [7, 30, 0])).toEqual(['2026-12-06', '2026-12-29', '2027-01-05']);
    expect(documentReminderDates('2027-06-30', [7, 7])).toEqual(['2027-06-23']);
    expect(documentReminderDates('2027-06-30', [])).toEqual([]);
  });

  it('rejects invalid dates and offsets', () => {
    expect(() => documentReminderDates('2027-02-29', [1])).toThrow('valid expiry date');
    expect(() => documentReminderDates('2027-2-3', [1])).toThrow('valid expiry date');
    expect(() => documentReminderDates('2027-13-01', [1])).toThrow('valid expiry date');
    expect(() => documentReminderDates('2027-06-30', [366])).toThrow('between 0 and 365');
    expect(() => documentReminderDates('2027-06-30', [1.5])).toThrow('between 0 and 365');
    expect(() => documentReminderDates('2027-06-30', [1, 2, 3, 4, 5, 6])).toThrow('at most 5');
  });
});

function emptyIndex(): DocumentIndex {
  return { version: 1, showReminderTitles: false, documents: [] };
}

function fakeDocument(revisionSizes: number[], overrides: Partial<VaultDocument> = {}): VaultDocument {
  const revisions = revisionSizes.map((size) => ({
    id: newDocumentId(), filename: 'scan.pdf', mimeType: 'application/pdf' as const, size,
    attachmentId: newDocumentId(), addedAt: NOW,
  }));
  return {
    id: newDocumentId(), title: 'Document', category: 'Identity', reminderDays: [30, 7],
    reminderKey: 'a'.repeat(16) + newDocumentId().replace(/-/g, '').slice(0, 16),
    currentRevisionId: revisions[revisions.length - 1].id, revisions, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

describe('document index', () => {
  it('validates strictly and drops unknown fields', () => {
    const document = { ...fakeDocument([10]), secret: 'extra' };
    const parsed = parseDocumentIndex({ ...emptyIndex(), documents: [document], extra: true });
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed.documents[0]).not.toHaveProperty('secret');
    expect(() => parseDocumentIndex({ ...emptyIndex(), version: 2 })).toThrow('unsupported');
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [{ ...fakeDocument([1]), title: '  ' }] })).toThrow('cannot be empty');
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [{ ...fakeDocument([1]), title: 'x'.repeat(201) }] })).toThrow('200 characters');
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [{ ...fakeDocument([1]), category: 'x'.repeat(61) }] })).toThrow('60 characters');
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [{ ...fakeDocument([1]), currentRevisionId: 'nope' }] })).toThrow('no current revision');
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [{ ...fakeDocument([1]), id: 'bad:id' }] })).toThrow('invalid id');
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [{ ...fakeDocument([1]), serviceRecordId: 'r1' }] })).toThrow('needs its vehicle');
    const duplicate = fakeDocument([1]);
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [duplicate, { ...fakeDocument([1]), id: duplicate.id }] })).toThrow('duplicate id');
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [duplicate, { ...fakeDocument([1]), reminderKey: duplicate.reminderKey }] })).toThrow('duplicate reminder key');
  });

  it('enforces the vault limits', () => {
    const big = DOCUMENT_LIMITS.maxFileBytes;
    const sixFull = Array.from({ length: 6 }, () => fakeDocument([big]));
    expect(vaultUsageBytes({ ...emptyIndex(), documents: sixFull })).toBe(60 * 1024 * 1024);
    expect(() => checkVaultLimits({ ...emptyIndex(), documents: sixFull })).not.toThrow();
    expect(() => checkVaultLimits({ ...emptyIndex(), documents: [...sixFull, fakeDocument([1])] })).toThrow('up to 60 MB');
    const many = Array.from({ length: 201 }, () => fakeDocument([1]));
    expect(() => checkVaultLimits({ ...emptyIndex(), documents: many })).toThrow('up to 200 documents');
    const revisions = fakeDocument(Array.from({ length: 21 }, () => 1));
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [revisions] })).toThrow('up to 20 revisions');
  });

  it('edits documents and keeps reminders on the current revision only', () => {
    const file = { filename: 'licence.pdf', mimeType: 'application/pdf' as const, size: 100 };
    const first = addDocument(emptyIndex(), {
      title: '  Driving   licence ', category: 'Identity', attachmentId: newDocumentId(), file, expiresOn: '2027-01-31',
    }, NOW);
    expect(first.document.title).toBe('Driving licence');
    expect(first.document.reminderDays).toEqual([30, 7]);
    expect(documentReminderEntries(first.index)).toEqual([
      { key: first.document.reminderKey, date: '2027-01-01', expiresOn: '2027-01-31' },
      { key: first.document.reminderKey, date: '2027-01-24', expiresOn: '2027-01-31' },
    ]);

    // Renewal: a new revision with a later expiry replaces the reminders; the old file is kept.
    const renewedAttachment = newDocumentId();
    const renewed = addDocumentRevision(first.index, first.document.id, {
      attachmentId: renewedAttachment, file: { ...file, size: 200 }, expiresOn: '2032-01-31',
    }, LATER);
    const document = renewed.documents[0];
    expect(document.revisions).toHaveLength(2);
    expect(currentRevision(document).attachmentId).toBe(renewedAttachment);
    expect(document.updatedAt).toBe(LATER);
    expect(documentReminderEntries(renewed).map((entry) => entry.date)).toEqual(['2032-01-01', '2032-01-24']);
    expect(vaultUsageBytes(renewed)).toBe(300);

    // Titles appear only when the user opted in.
    expect(documentReminderEntries(setShowReminderTitles(renewed, true))[0].label).toBe('Driving licence');
    expect(documentReminderEntries(renewed)[0]).not.toHaveProperty('label');

    const edited = updateDocumentDetails(renewed, document.id, { reminderDays: [0, 90], assetId: 'car-1', serviceRecordId: 'svc-1' }, LATER);
    expect(edited.documents[0].reminderDays).toEqual([90, 0]);
    expect(edited.documents[0].assetId).toBe('car-1');
    const unlinked = updateDocumentDetails(edited, document.id, { assetId: null }, LATER);
    expect(unlinked.documents[0]).not.toHaveProperty('assetId');
    expect(unlinked.documents[0]).not.toHaveProperty('serviceRecordId');

    expect(() => deleteDocumentRevision(renewed, document.id, document.currentRevisionId, LATER)).toThrow('current revision');
    const pruned = deleteDocumentRevision(renewed, document.id, document.revisions[0].id, LATER);
    expect(pruned.removedAttachmentIds).toEqual([document.revisions[0].attachmentId]);
    expect(pruned.index.documents[0].revisions).toHaveLength(1);

    const removed = removeDocument(renewed, document.id);
    expect(removed.index.documents).toEqual([]);
    expect(new Set(removed.removedAttachmentIds)).toEqual(attachmentIds(renewed));
  });
});

describe('encryption', () => {
  let session: DocumentSession;
  let blob: StoredBlob;
  let attachmentId: string;

  beforeAll(async () => {
    const created = await createDocumentVault(passphrase);
    attachmentId = newDocumentId();
    const { index } = addDocument(created.index, {
      title: 'Passport secret title', category: 'Travel', attachmentId,
      file: { filename: 'passport-scan.pdf', mimeType: 'application/pdf', size: PDF.length }, expiresOn: '2030-05-01',
    }, NOW);
    blob = await encryptAttachment(created, attachmentId, PDF);
    const envelope = await sealDocumentIndex(created, index);
    session = { ...created, envelope, index };
  }, KDF_TIMEOUT);

  it('rejects short passphrases', async () => {
    await expect(createDocumentVault('too short')).rejects.toThrow('at least 15 characters');
  });

  it('round-trips the index and attachments without leaking plaintext', async () => {
    const stored = JSON.stringify(session.envelope);
    for (const secret of ['Passport secret title', 'passport-scan.pdf', 'Travel', '2030-05-01']) {
      expect(stored).not.toContain(secret);
    }
    const reopened = await unlockDocumentVault(readDocumentEnvelope(JSON.parse(stored)), passphrase);
    expect(reopened.index).toEqual(session.index);
    expect(await decryptAttachment(reopened, attachmentId, blob)).toEqual(PDF);
    expect(new TextDecoder().decode(blob.ciphertext)).not.toContain('%PDF');
  }, KDF_TIMEOUT);

  it('gives one generic error for a wrong passphrase or tampered index', async () => {
    await expect(unlockDocumentVault(session.envelope, 'a wrong passphrase entirely')).rejects.toThrow(WRONG_PASSPHRASE_MESSAGE);
    const tamperedCipher = { ...session.envelope, index: { ...session.envelope.index, ciphertext: flipFirstChar(session.envelope.index.ciphertext) } };
    await expect(unlockDocumentVault(tamperedCipher, passphrase)).rejects.toThrow(WRONG_PASSPHRASE_MESSAGE);
    const tamperedNonce = { ...session.envelope, index: { ...session.envelope.index, nonce: flipFirstChar(session.envelope.index.nonce) } };
    await expect(unlockDocumentVault(tamperedNonce, passphrase)).rejects.toThrow(WRONG_PASSPHRASE_MESSAGE);
  }, KDF_TIMEOUT);

  it('binds the index to its vault id', async () => {
    // Same data key, different vault id in the AAD: the index must not decrypt.
    const otherId = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    const forgedSession = { ...session, envelope: { ...session.envelope, header: { ...session.envelope.header, id: otherId } } };
    const forged = await sealDocumentIndex(forgedSession, session.index);
    await expect(unlockDocumentVault({ ...session.envelope, index: forged.index }, passphrase)).rejects.toThrow(WRONG_PASSPHRASE_MESSAGE);
  }, KDF_TIMEOUT);

  it('binds each attachment to its id and rejects altered blobs', async () => {
    const otherId = newDocumentId();
    const other = await encryptAttachment(session, otherId, PNG);
    expect(await decryptAttachment(session, otherId, other)).toEqual(PNG);
    // Blob A's ciphertext presented under id B (and vice versa) must fail.
    await expect(decryptAttachment(session, otherId, blob)).rejects.toThrow('could not be decrypted');
    await expect(decryptAttachment(session, attachmentId, other)).rejects.toThrow('could not be decrypted');
    const flipped = blob.ciphertext.slice();
    flipped[5] ^= 1;
    await expect(decryptAttachment(session, attachmentId, { ...blob, ciphertext: flipped })).rejects.toThrow('could not be decrypted');
    await expect(decryptAttachment(session, attachmentId, { ...blob, nonce: flipFirstChar(blob.nonce) })).rejects.toThrow('could not be decrypted');
    await expect(decryptAttachment(session, attachmentId, { ...blob, nonce: 'not base64!' })).rejects.toThrow('could not be decrypted');
  });

  it('refuses attachments with invalid ids or sizes', async () => {
    await expect(encryptAttachment(session, 'bad:id', PDF)).rejects.toThrow('not valid');
    await expect(encryptAttachment(session, newDocumentId(), new Uint8Array())).rejects.toThrow('empty');
  });

  describe('backups', () => {
    let backup: string;

    beforeAll(() => {
      backup = buildDocumentBackup(session.envelope, new Map([[attachmentId, blob]]), LATER);
    });

    function mutate(change: (value: Record<string, unknown>) => void): string {
      const value = JSON.parse(backup);
      change(value);
      return JSON.stringify(value);
    }

    it('round-trips a ciphertext-only backup', async () => {
      expect(backup).not.toContain('Passport secret title');
      expect(backup).not.toContain(passphrase);
      const parsed = parseDocumentBackup(backup);
      const verified = await verifyDocumentBackup(parsed, passphrase);
      expect(verified.index).toEqual(session.index);
      expect(await decryptAttachment(verified, attachmentId, parsed.blobs.get(attachmentId)!)).toEqual(PDF);
    }, KDF_TIMEOUT);

    it('rejects structurally invalid backups', () => {
      expect(() => parseDocumentBackup('')).toThrow('empty');
      expect(() => parseDocumentBackup('{not json')).toThrow('could not be read');
      expect(() => parseDocumentBackup(mutate((v) => { v.format = 'dayflow-password-vault'; }))).toThrow('not a Dayflow document vault backup');
      expect(() => parseDocumentBackup(mutate((v) => { v.version = 2; }))).toThrow('newer version');
      expect(() => parseDocumentBackup(mutate((v) => { v.createdAt = 'yesterday'; }))).toThrow('invalid date');
      expect(() => parseDocumentBackup(mutate((v) => { (v.envelope as Record<string, unknown>).header = {}; }))).toThrow('vault header');
      expect(() => parseDocumentBackup(mutate((v) => { delete v.blobs; }))).toThrow('file list');
      expect(() => parseDocumentBackup(mutate((v) => { (v.blobs as Array<Record<string, unknown>>)[0].ciphertext = '@@@@'; }))).toThrow('base64');
      // Non-canonical base64 (missing padding) is rejected too.
      expect(() => parseDocumentBackup(mutate((v) => {
        const item = (v.blobs as Array<Record<string, string>>)[0];
        item.ciphertext = item.ciphertext.replace(/=+$/, '') || `${item.ciphertext}A`;
      }))).toThrow(/base64|truncated/);
      expect(() => parseDocumentBackup(mutate((v) => { (v.blobs as Array<Record<string, unknown>>)[0].id = '../x'; }))).toThrow('invalid id');
      expect(() => parseDocumentBackup(mutate((v) => {
        const blobs = v.blobs as unknown[];
        blobs.push({ ...(blobs[0] as object) });
      }))).toThrow('appears twice');
      expect(() => parseDocumentBackup(mutate((v) => { (v.blobs as Array<Record<string, unknown>>)[0].nonce = bytesToBase64(new Uint8Array(8)); }))).toThrow('nonce');
      expect(() => parseDocumentBackup(mutate((v) => { (v.blobs as Array<Record<string, unknown>>)[0].ciphertext = bytesToBase64(new Uint8Array(10)); }))).toThrow('truncated');
    });

    it('handles a full-size 10 MB file in a backup', async () => {
      const large = new Uint8Array(DOCUMENT_LIMITS.maxFileBytes);
      large.set(PDF);
      large[large.length - 1] = 7;
      const largeId = newDocumentId();
      const sealed = await encryptAttachment(session, largeId, large);
      const text = buildDocumentBackup(session.envelope, new Map([[attachmentId, blob], [largeId, sealed]]), LATER);
      const parsed = parseDocumentBackup(text);
      expect([...parsed.blobs.keys()].sort()).toEqual([attachmentId, largeId].sort());
      const decrypted = await decryptAttachment(session, largeId, parsed.blobs.get(largeId)!);
      // Byte loop: deep equality on 10 MB arrays is very slow in the test runner.
      expect(decrypted.length).toBe(large.length);
      expect(decrypted.every((byte, index) => byte === large[index])).toBe(true);
    });

    it('rejects oversized backups and files', () => {
      expect(() => parseDocumentBackup(' '.repeat(DOCUMENT_LIMITS.maxBackupBytes + 1))).toThrow('larger than 96 MB');
      const huge = bytesToBase64(new Uint8Array(DOCUMENT_LIMITS.maxFileBytes + 64));
      expect(() => parseDocumentBackup(mutate((v) => { (v.blobs as Array<Record<string, unknown>>)[0].ciphertext = huge; }))).toThrow('larger than 10 MB');
    });

    it('rejects a missing blob, an extra blob, a wrong passphrase and an altered blob', async () => {
      await expect(verifyDocumentBackup(parseDocumentBackup(mutate((v) => { v.blobs = []; })), passphrase))
        .rejects.toThrow('1 file is missing');

      const extra = await encryptAttachment(session, newDocumentId(), JPEG);
      const withExtra = parseDocumentBackup(backup);
      withExtra.blobs.set(newDocumentId(), extra);
      await expect(verifyDocumentBackup(withExtra, passphrase)).rejects.toThrow('no document uses');

      await expect(verifyDocumentBackup(parseDocumentBackup(backup), 'definitely the wrong passphrase')).rejects.toThrow(WRONG_PASSPHRASE_MESSAGE);

      const altered = parseDocumentBackup(backup);
      const original = altered.blobs.get(attachmentId)!;
      const bytes = original.ciphertext.slice();
      bytes[bytes.length - 1] ^= 0xff;
      altered.blobs.set(attachmentId, { ...original, ciphertext: bytes });
      await expect(verifyDocumentBackup(altered, passphrase)).rejects.toThrow('damaged or has been altered');

      // A valid blob of another attachment swapped in under this id fails its AAD check.
      const swapped = parseDocumentBackup(backup);
      swapped.blobs.set(attachmentId, extra);
      await expect(verifyDocumentBackup(swapped, passphrase)).rejects.toThrow('damaged or has been altered');
    }, KDF_TIMEOUT * 2);
  });
});
