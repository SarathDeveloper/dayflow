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
  decryptDocumentIndex,
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
  revisionSides,
  sealDocumentIndex,
  setRevisionBack,
  setShowReminderTitles,
  sniffDocumentType,
  openDocumentVault,
  unlockDocumentVault,
  upgradeDocumentVault,
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
    expect(documentReminderEntries(setShowReminderTitles(renewed, true, LATER))[0].label).toBe('Driving licence');
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

    const removed = removeDocument(renewed, document.id, LATER);
    expect(removed.index.documents).toEqual([]);
    expect(removed.index.deletedDocuments).toEqual({ [document.id]: LATER });
    expect(new Set(removed.removedAttachmentIds)).toEqual(attachmentIds(renewed));
  });
});

describe('front and back sides', () => {
  const file = { filename: 'aadhaar-front.jpg', mimeType: 'image/jpeg' as const, size: 100 };
  const backFile = { filename: 'aadhaar-back.jpg', mimeType: 'image/jpeg' as const, size: 40 };

  it('stores a back side with the version and counts both files', () => {
    const front = newDocumentId();
    const back = newDocumentId();
    const { index, document } = addDocument(emptyIndex(), {
      title: 'Aadhaar', category: 'Identity', attachmentId: front, file, back: { attachmentId: back, file: backFile },
    }, NOW);
    const revision = currentRevision(document);
    expect(revision.back).toEqual({ ...backFile, attachmentId: back });
    expect(revisionSides(revision).map((entry) => entry.side)).toEqual(['front', 'back']);
    expect(attachmentIds(index)).toEqual(new Set([front, back]));
    expect(vaultUsageBytes(index)).toBe(140);
    expect(parseDocumentIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);

    const removed = removeDocument(index, document.id, LATER);
    expect(new Set(removed.removedAttachmentIds)).toEqual(new Set([front, back]));
  });

  it('adds, replaces and removes the back of an existing version', () => {
    const { index, document } = addDocument(emptyIndex(), { title: 'PAN', category: 'Identity', attachmentId: newDocumentId(), file }, NOW);
    const revisionId = document.currentRevisionId;
    expect(() => setRevisionBack(index, document.id, revisionId, null, LATER)).toThrow('no back side');

    const firstBack = newDocumentId();
    const added = setRevisionBack(index, document.id, revisionId, { attachmentId: firstBack, file: backFile }, LATER);
    expect(added.removedAttachmentIds).toEqual([]);
    expect(currentRevision(added.index.documents[0]).back?.attachmentId).toBe(firstBack);
    expect(added.index.documents[0].updatedAt).toBe(LATER);

    const secondBack = newDocumentId();
    const replaced = setRevisionBack(added.index, document.id, revisionId, { attachmentId: secondBack, file: backFile }, LATER);
    expect(replaced.removedAttachmentIds).toEqual([firstBack]);
    expect(attachmentIds(replaced.index).has(firstBack)).toBe(false);

    const cleared = setRevisionBack(replaced.index, document.id, revisionId, null, LATER);
    expect(cleared.removedAttachmentIds).toEqual([secondBack]);
    expect(currentRevision(cleared.index.documents[0])).not.toHaveProperty('back');
  });

  it('rejects a back side that reuses an id or is invalid', () => {
    const document = fakeDocument([10]);
    const revision = document.revisions[0];
    const reuse = { ...document, revisions: [{ ...revision, back: { ...backFile, attachmentId: revision.attachmentId } }] };
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [reuse] })).toThrow('duplicate id');
    const badType = { ...document, revisions: [{ ...revision, back: { ...backFile, mimeType: 'text/plain', attachmentId: newDocumentId() } }] };
    expect(() => parseDocumentIndex({ ...emptyIndex(), documents: [badType] })).toThrow('unsupported file type');
  });

  it('deletes both sides with an old version', () => {
    const { index, document } = addDocument(emptyIndex(), { title: 'Licence', category: 'Identity', attachmentId: newDocumentId(), file }, NOW);
    const back = newDocumentId();
    const withBack = setRevisionBack(index, document.id, document.currentRevisionId, { attachmentId: back, file: backFile }, NOW).index;
    const renewed = addDocumentRevision(withBack, document.id, { attachmentId: newDocumentId(), file }, LATER);
    const pruned = deleteDocumentRevision(renewed, document.id, document.currentRevisionId, LATER);
    expect(pruned.removedAttachmentIds).toEqual([currentRevision(document).attachmentId, back]);
  });
});

describe('encryption', () => {
  let session: DocumentSession;
  let blob: StoredBlob;
  let attachmentId: string;

  beforeAll(async () => {
    const created = await createDocumentVault();
    attachmentId = newDocumentId();
    const { index } = addDocument(created.index, {
      title: 'Passport secret title', category: 'Travel', attachmentId,
      file: { filename: 'passport-scan.pdf', mimeType: 'application/pdf', size: PDF.length }, expiresOn: '2030-05-01',
    }, NOW);
    blob = await encryptAttachment(created, attachmentId, PDF);
    const envelope = await sealDocumentIndex(created, index);
    session = { ...created, envelope, index };
  }, KDF_TIMEOUT);

  it('creates a vault that opens without a passphrase and keeps contents encrypted', async () => {
    expect(session.envelope.version).toBe(2);
    const stored = JSON.stringify(session.envelope);
    for (const secret of ['Passport secret title', 'passport-scan.pdf', 'Travel', '2030-05-01']) {
      expect(stored).not.toContain(secret);
    }
    const reopened = await openDocumentVault(readDocumentEnvelope(JSON.parse(stored)));
    expect(reopened.index).toEqual(session.index);
    expect(await decryptAttachment(reopened, attachmentId, blob)).toEqual(PDF);
    expect(new TextDecoder().decode(blob.ciphertext)).not.toContain('%PDF');
  });

  it('refuses a tampered index', async () => {
    const tamperedCipher = { ...session.envelope, index: { ...session.envelope.index, ciphertext: flipFirstChar(session.envelope.index.ciphertext) } };
    await expect(openDocumentVault(tamperedCipher)).rejects.toThrow('damaged');
    const tamperedNonce = { ...session.envelope, index: { ...session.envelope.index, nonce: flipFirstChar(session.envelope.index.nonce) } };
    await expect(openDocumentVault(tamperedNonce)).rejects.toThrow('damaged');
  });

  it('binds the index to its vault id', async () => {
    // Same data key, different vault id in the AAD: the index must not decrypt.
    const otherId = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    const forgedSession = { ...session, envelope: { ...session.envelope, header: { ...session.envelope.header, id: otherId } } } as DocumentSession;
    const forged = await sealDocumentIndex(forgedSession, session.index);
    await expect(openDocumentVault({ ...session.envelope, index: forged.index })).rejects.toThrow('damaged');
  });

  it('converts a passphrase vault once, keeping its id, key and files', async () => {
    // A passphrase envelope, as older devices store it, is what a backup carries.
    const legacy = parseDocumentBackup(await buildDocumentBackup(session.envelope, new Map([[attachmentId, blob]]), LATER, passphrase)).envelope;
    expect(legacy.version).toBe(1);
    await expect(openDocumentVault(legacy)).rejects.toThrow('passphrase');
    await expect(upgradeDocumentVault(legacy, 'a wrong passphrase entirely')).rejects.toThrow(WRONG_PASSPHRASE_MESSAGE);
    const upgraded = await upgradeDocumentVault(legacy, passphrase);
    expect(upgraded.envelope.version).toBe(2);
    expect(upgraded.envelope.header.id).toBe(session.envelope.header.id);
    expect(upgraded.envelope.revision).not.toBe(legacy.revision);
    expect(upgraded.index).toEqual(session.index);
    expect(await decryptAttachment(upgraded, attachmentId, blob)).toEqual(PDF);
    expect((await unlockDocumentVault(legacy, passphrase)).index).toEqual(session.index);
  }, KDF_TIMEOUT * 2);

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

    beforeAll(async () => {
      backup = await buildDocumentBackup(session.envelope, new Map([[attachmentId, blob]]), LATER, passphrase);
    }, KDF_TIMEOUT);

    function mutate(change: (value: Record<string, unknown>) => void): string {
      const value = JSON.parse(backup);
      change(value);
      return JSON.stringify(value);
    }

    it('round-trips a password-protected backup', async () => {
      expect(backup).not.toContain('Passport secret title');
      expect(backup).not.toContain(passphrase);
      // The vault's own key is wrapped by the backup password, never stored as is.
      if (session.envelope.version === 2) expect(backup).not.toContain(session.envelope.header.key);
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
      const text = await buildDocumentBackup(session.envelope, new Map([[attachmentId, blob], [largeId, sealed]]), LATER, passphrase);
      const parsed = parseDocumentBackup(text);
      expect([...parsed.blobs.keys()].sort()).toEqual([attachmentId, largeId].sort());
      const decrypted = await decryptAttachment(session, largeId, parsed.blobs.get(largeId)!);
      // Byte loop: deep equality on 10 MB arrays is very slow in the test runner.
      expect(decrypted.length).toBe(large.length);
      expect(decrypted.every((byte, index) => byte === large[index])).toBe(true);
    }, KDF_TIMEOUT);

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

describe('sync decryption', () => {
  it('opens another copy of the same vault with its key, and only that vault', async () => {
    const vault = await createDocumentVault();
    const added = addDocument(vault.index, {
      title: 'Passport', category: 'Identity', attachmentId: newDocumentId(),
      file: { filename: 'passport.pdf', mimeType: 'application/pdf', size: 10 },
    }, NOW).index;
    const sealed = await sealDocumentIndex(vault, added);
    expect((await decryptDocumentIndex(vault.key, sealed)).documents[0].title).toBe('Passport');
    const other = await createDocumentVault();
    await expect(decryptDocumentIndex(other.key, sealed)).rejects.toThrow('could not be decrypted');
  }, KDF_TIMEOUT);
});
