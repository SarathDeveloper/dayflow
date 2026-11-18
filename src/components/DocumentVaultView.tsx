import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ChevronLeft, Cloud, CloudOff, Download, Eye, FileLock2, FilePlus2, ImagePlus, Printer, RefreshCw, Settings2, Share2, Trash2, Upload, X,
} from 'lucide-react';
import type { MaintenanceItem } from '../types';
import {
  DEFAULT_DOCUMENT_REMINDER_DAYS, DOCUMENT_LIMITS, addDocument, addDocumentRevision, buildDocumentBackup,
  createDocumentVault, currentRevision, daysUntilExpiry, decryptAttachment, deleteDocumentRevision,
  documentReminderEntries, encryptAttachment, formatFileSize, newDocumentId, normalizeReminderDays,
  openDocumentVault, parseDocumentBackup, removeDocument, revisionSides, sealDocumentIndex, setRevisionBack, setShowReminderTitles, upgradeDocumentVault,
  updateDocumentDetails, updateRevisionDetails, validateDocumentFile, vaultUsageBytes, verifyDocumentBackup,
} from '../lib/documentVault';
import type {
  DocumentEnvelope, DocumentIndex, DocumentRevision, DocumentSession, DocumentSide, NewSideInput, StoredBlob, VaultDocument,
} from '../lib/documentVault';
import { MIN_VAULT_PASSPHRASE } from '../lib/passwordVault';
import {
  commitDocumentVault, readAllBlobs, readBlob, readDocumentVault, replaceDocumentVault, requestPersistentStorage,
} from '../services/documentStorage';
import { writeDocumentReminders } from '../services/documentReminderStore';
import { exportTextNative, hasDocumentVaultNative } from '../services/documentVaultNative';
import { openPdfPages } from '../services/documentPages';
import { printDocument, saveDocumentCopy, shareDocument } from '../services/documentFiles';
import {
  DOCUMENT_VAULT_CHANGED_EVENT, replaceAccountDocumentVault, switchToAccountDocumentVault, syncDocumentVault,
} from '../services/documentSync';
import type { DocumentSyncResult } from '../services/documentSync';
import { isCloudConfigured, storedAccount } from '../services/cloudSyncService';
import { hasNativePasswordVault, PasswordVault } from '../services/passwordVault';
import { downloadTextFile } from '../services/maintenanceStorage';
import {
  beginExternalActivity, endExternalActivity,
} from '../lib/externalActivity';
import { todayString } from '../lib/ledger';
import { formatShortDate } from '../lib/dateFormat';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { showConfirm } from './ui/AppDialog';
import type { ViewerContent } from './documents/DocumentViewer';

const DocumentViewer = lazy(() => import('./documents/DocumentViewer'));

export interface DocumentVaultIntent {
  assetId?: string;
  serviceRecordId?: string;
  action: 'view' | 'add';
}

export interface DocumentVaultViewProps {
  maintenanceItems: MaintenanceItem[];
  intent?: DocumentVaultIntent | null;
  onIntentHandled?: () => void;
  /** Null when reminders notify on this device; otherwise why they only show on Today. */
  reminderNote: string | null;
}

const SYNC_EVERY_MS = 2 * 60_000;
const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const CATEGORY_SUGGESTIONS = ['Identity', 'Vehicle', 'Insurance', 'Home', 'Receipts', 'Medical', 'Finance', 'Other'];
const inputClass = 'w-full min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white';
const labelClass = 'block space-y-1 text-sm font-semibold text-slate-700 dark:text-slate-200';
const LIMITS_TEXT = `PDF, JPEG or PNG · up to ${formatFileSize(DOCUMENT_LIMITS.maxFileBytes)} per file · ${formatFileSize(DOCUMENT_LIMITS.maxVaultBytes)} in total · ${DOCUMENT_LIMITS.maxDocuments} documents · ${DOCUMENT_LIMITS.maxRevisionsPerDocument} versions each`;

interface DocDraft {
  title: string;
  category: string;
  assetId: string;
  serviceRecordId: string;
  expiresOn: string;
  reminderText: string;
  note: string;
}

type View =
  | { kind: 'list' }
  | { kind: 'add'; draft: DocDraft; file: File | null; back: File | null }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string; draft: DocDraft }
  | { kind: 'renew'; id: string; draft: DocDraft; file: File | null; back: File | null }
  | { kind: 'settings' };

type Side = 'front' | 'back';
/** What the shared file input is choosing for. */
type PickTarget = 'front' | 'back' | 'existing-back';

interface Viewer {
  documentId: string;
  revisionId: string;
  side: Side;
  title: string;
  subtitle: string;
  content: ViewerContent;
}

type FileAction = 'download' | 'share' | 'print';

/** The file of one side of a revision (the front is the revision itself). */
function sideFile(revision: DocumentRevision, side: Side): DocumentSide | undefined {
  return side === 'back' ? revision.back : revision;
}

/** Frees what an open viewer holds: the image's object URL or the PDF renderer. */
function freeViewerContent(content: ViewerContent): void {
  if (content.kind === 'image') URL.revokeObjectURL(content.url);
  else void content.source.close();
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function emptyDraft(intent?: DocumentVaultIntent | null): DocDraft {
  return {
    title: '', category: '', assetId: intent?.assetId ?? '', serviceRecordId: intent?.serviceRecordId ?? '',
    expiresOn: '', reminderText: DEFAULT_DOCUMENT_REMINDER_DAYS.join(', '), note: '',
  };
}

function reminderDaysFrom(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return normalizeReminderDays(trimmed.split(/[\s,]+/).map(Number));
}

/** Saves the plaintext reminder schedule; returns an error message instead of throwing. */
function syncReminderStore(index: DocumentIndex): string | null {
  try {
    writeDocumentReminders({ version: 1, showTitles: index.showReminderTitles, entries: documentReminderEntries(index) });
    return null;
  } catch (cause) {
    return errorText(cause, 'Could not update the reminder schedule on this device.');
  }
}

function expiryBadge(revision: DocumentRevision, today: string): { text: string; className: string } | null {
  if (!revision.expiresOn) return null;
  const days = daysUntilExpiry(revision.expiresOn, today);
  if (days < 0) return { text: `Expired ${formatShortDate(revision.expiresOn)}`, className: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' };
  if (days === 0) return { text: 'Expires today', className: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' };
  if (days <= 30) return { text: `Expires in ${days} ${days === 1 ? 'day' : 'days'}`, className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' };
  return { text: `Expires ${formatShortDate(revision.expiresOn)}`, className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' };
}

export default function DocumentVaultView({ maintenanceItems, intent, onIntentHandled, reminderNote }: DocumentVaultViewProps) {
  const today = todayString();
  const [envelope, setEnvelope] = useState<DocumentEnvelope | null>();
  const [session, setSession] = useState<DocumentSession | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [backupRepeat, setBackupRepeat] = useState('');
  const [restoreSource, setRestoreSource] = useState<{ envelope: DocumentEnvelope; blobs: Map<string, StoredBlob>; name: string } | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [sync, setSync] = useState<DocumentSyncResult | null>(null);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [assetFilter, setAssetFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  /** Decrypted image previews of the open document (attachment id -> object URL). */
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const epoch = useRef(0);
  const mounted = useRef(false);
  const working = useRef(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const viewerRef = useRef<Viewer | null>(null);
  const plainCopyConfirmed = useRef(false);
  const creating = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const fileTarget = useRef<PickTarget>('front');
  /** The version an 'existing-back' pick adds its back side to. */
  const backTarget = useRef<{ documentId: string; revisionId: string } | null>(null);
  const signedIn = isCloudConfigured() && Boolean(storedAccount());

  const releaseViewer = useCallback(() => {
    const current = viewerRef.current;
    viewerRef.current = null;
    if (current) freeViewerContent(current.content);
    setViewer(null);
  }, []);

  const showViewer = (next: Viewer) => {
    const previous = viewerRef.current;
    viewerRef.current = next;
    if (previous) freeViewerContent(previous.content);
    setViewer(next);
  };

  /** Drops the open vault from memory (unmount, or the stored vault was replaced). */
  const closeSession = useCallback(() => {
    epoch.current++;
    releaseViewer();
    setSession(null);
    setView({ kind: 'list' });
    setPassphrase('');
    setBackupPassword('');
    setBackupRepeat('');
    setQuery('');
  }, [releaseViewer]);

  // Screen-capture protection while the screen is open; forget the vault on leaving it.
  useEffect(() => {
    mounted.current = true;
    if (hasNativePasswordVault()) void PasswordVault.setScreenProtected({ enabled: true }).catch(() => {});
    return () => {
      mounted.current = false;
      closeSession();
      if (hasNativePasswordVault()) void PasswordVault.setScreenProtected({ enabled: false }).catch(() => {});
    };
  }, [closeSession]);

  // Load the stored envelope (validated).
  useEffect(() => {
    let current = true;
    setEnvelope(undefined);
    readDocumentVault()
      .then((value) => current && setEnvelope(value ?? null))
      .catch((cause) => {
        if (!current) return;
        setEnvelope(null);
        setError(errorText(cause, 'Could not read the document vault on this device.'));
      });
    return () => { current = false; };
  }, [reload]);

  // Apply an intent from Maintenance / Today once the vault is open.
  useEffect(() => {
    if (!session || !intent) return;
    if (intent.action === 'add') setView({ kind: 'add', draft: emptyDraft(intent), file: null, back: null });
    else if (intent.assetId) setAssetFilter(intent.assetId);
    onIntentHandled?.();
  }, [session, intent, onIntentHandled]);

  // A decrypted file is only shown on its document's detail screen: leaving it closes the
  // viewer, revokes the object URL and closes any native PDF handle.
  useEffect(() => {
    if (view.kind !== 'detail') releaseViewer();
  }, [view.kind, releaseViewer]);

  // ------------------------------------------------------------------ cloud sync
  /** Syncs the encrypted vault with the account (signed in only). Never throws. */
  const runSync = useCallback(async (): Promise<DocumentSyncResult | null> => {
    if (!signedIn) return null;
    const result = await syncDocumentVault();
    if (mounted.current) setSync(result);
    return result;
  }, [signedIn]);

  // Sync on open, every few minutes while visible, and when the network returns.
  useEffect(() => {
    if (!signedIn) return;
    void runSync();
    const timer = window.setInterval(() => { if (!document.hidden) void runSync(); }, SYNC_EVERY_MS);
    const onOnline = () => void runSync();
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [signedIn, runSync]);

  // A sync changed the stored vault: show the new copy.
  useEffect(() => {
    const onChanged = () => {
      void readDocumentVault().then((stored) => {
        if (!mounted.current) return;
        const current = sessionRef.current;
        if (current && (!stored || stored.header.id !== current.envelope.header.id)) closeSession();
        setEnvelope(stored ?? null);
      }).catch(() => undefined);
    };
    window.addEventListener(DOCUMENT_VAULT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DOCUMENT_VAULT_CHANGED_EVENT, onChanged);
  }, [closeSession]);

  // Open the stored vault: no passphrase, so this happens by itself.
  useEffect(() => {
    if (!envelope || envelope.version !== 2) return;
    if (sessionRef.current?.envelope.revision === envelope.revision) return;
    let active = true;
    openDocumentVault(envelope).then((opened) => {
      if (!active || !mounted.current) return;
      setSession(opened);
      const reminderError = syncReminderStore(opened.index);
      if (reminderError) setError(reminderError);
    }).catch((cause) => {
      if (active && mounted.current) setError(errorText(cause, 'The document vault could not be opened.'));
    });
    return () => { active = false; };
  }, [envelope]);

  // No vault yet: create one, but only once it is clear the account has none
  // (a second vault could not sync). Signed out, it is created straight away.
  const accountChecked = !signedIn || sync?.status === 'no-vault' || sync?.status === 'local-only';
  useEffect(() => {
    if (envelope !== null || !accountChecked || creating.current) return;
    creating.current = true;
    void run(async (isCurrent) => {
      const stored = await readDocumentVault();
      if (stored) {
        if (mounted.current) setEnvelope(stored);
        return;
      }
      const created = await createDocumentVault();
      await commitDocumentVault({ envelope: created.envelope, expectedRevision: null });
      void requestPersistentStorage().catch(() => false);
      if (!mounted.current) return;
      setEnvelope(created.envelope);
      if (isCurrent()) setSession(created);
      syncReminderStore(created.index);
      void runSync();
    }).finally(() => {
      creating.current = false;
    });
    // `run` and `runSync` are stable enough here: the guard above prevents repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envelope, accountChecked]);

  /** Runs one vault action. `isCurrent()` turns false once the vault closes, so late work cannot reopen it. */
  const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const started = epoch.current;
    const isCurrent = () => mounted.current && started === epoch.current;
    try {
      await action(isCurrent);
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, 'The vault action failed. Your previous vault is intact.'));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /** Seals and commits `next`; updates state only while the vault is still open. */
  const commit = async (
    base: DocumentSession,
    next: DocumentIndex,
    isCurrent: () => boolean,
    blobs?: { put?: Map<string, StoredBlob>; remove?: string[] },
  ): Promise<boolean> => {
    const sealed = await sealDocumentIndex(base, next);
    if (!isCurrent()) return false;
    await commitDocumentVault({
      envelope: sealed, expectedRevision: base.envelope.revision, putBlobs: blobs?.put, deleteBlobIds: blobs?.remove,
    });
    // Saved. The schedule follows the saved index even if the vault closed meanwhile.
    const reminderError = syncReminderStore(next);
    if (mounted.current) setEnvelope(sealed);
    if (isCurrent()) {
      setSession({ ...base, envelope: sealed, index: next });
      if (reminderError) setError(reminderError);
    }
    void runSync();
    return true;
  };

  // ------------------------------------------------------------------ pickers
  const openPicker = (target: PickTarget | 'restore') => {
    if (target !== 'restore') fileTarget.current = target;
    beginExternalActivity();
    (target === 'restore' ? restoreInput : fileInput).current?.click();
  };

  const pickBackFor = (documentId: string, revisionId: string) => {
    backTarget.current = { documentId, revisionId };
    openPicker('existing-back');
  };

  useEffect(() => {
    const inputs = [fileInput.current, restoreInput.current].filter(Boolean) as HTMLInputElement[];
    const onCancel = () => endExternalActivity();
    for (const input of inputs) input.addEventListener('cancel', onCancel);
    return () => { for (const input of inputs) input.removeEventListener('cancel', onCancel); };
  });

  const onFilePicked = (file: File | undefined) => {
    endExternalActivity();
    if (!file) return;
    if (file.size > DOCUMENT_LIMITS.maxFileBytes) {
      setError(`That file is ${formatFileSize(file.size)}. The limit is ${formatFileSize(DOCUMENT_LIMITS.maxFileBytes)} per file.`);
      return;
    }
    if (!sessionRef.current) return;
    const target = fileTarget.current;
    if (target === 'existing-back') {
      const version = backTarget.current;
      backTarget.current = null;
      if (version) saveBackSide(version.documentId, version.revisionId, file);
      return;
    }
    setView((current) => (current.kind === 'add' || current.kind === 'renew'
      ? (target === 'back' ? { ...current, back: file } : { ...current, file })
      : current));
    setError('');
  };

  const onRestorePicked = async (file: File | undefined) => {
    endExternalActivity();
    if (!file) return;
    setError('');
    setNotice('');
    try {
      if (file.size > DOCUMENT_LIMITS.maxBackupBytes) throw new Error(`That file is larger than a document backup can be (${formatFileSize(DOCUMENT_LIMITS.maxBackupBytes)}).`);
      const parsed = parseDocumentBackup(await file.text());
      if (!mounted.current) return;
      setRestoreSource({ ...parsed, name: file.name });
      setPassphrase('');
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, 'Choose a Dayflow document backup.'));
    }
  };

  // ------------------------------------------------------------------ convert / restore
  /** A vault made with a passphrase (older app version): convert it once, then no passphrase is needed. */
  const submitUpgrade = (event: FormEvent) => {
    event.preventDefault();
    const pass = passphrase;
    setPassphrase('');
    void run(async (isCurrent) => {
      const stored = await readDocumentVault();
      if (!stored) throw new Error('There is no document vault on this device.');
      const upgraded = await upgradeDocumentVault(stored, pass);
      await commitDocumentVault({ envelope: upgraded.envelope, expectedRevision: stored.revision });
      if (!mounted.current) return;
      setEnvelope(upgraded.envelope);
      if (isCurrent()) {
        setSession(upgraded);
        setNotice('Vault updated. It now opens without a passphrase.');
      }
      syncReminderStore(upgraded.index);
      void runSync();
    });
  };

  const submitRestore = (event: FormEvent) => {
    event.preventDefault();
    const pass = passphrase;
    setPassphrase('');
    void run(async (isCurrent) => {
      if (!restoreSource) return;
      const restored = await verifyDocumentBackup(restoreSource, pass);
      if (!isCurrent()) return;
      const current = await readDocumentVault();
      const documents = sessionRef.current?.index.documents.length ?? 0;
      if (current && documents > 0) {
        const ok = await showConfirm({
          title: 'Replace your documents with the backup?',
          message: `The ${documents} ${documents === 1 ? 'document' : 'documents'} in the vault now${signedIn ? ' (on all your devices)' : ''} will be replaced by the backup. This cannot be undone.`,
          tone: 'danger',
          confirmLabel: 'Replace with backup',
        });
        if (!ok || !isCurrent()) return;
      }
      if (current && current.header.id !== restored.envelope.header.id) closeSession();
      await replaceDocumentVault(restored.envelope, restoreSource.blobs);
      void requestPersistentStorage().catch(() => false);
      setRestoreSource(null);
      if (!mounted.current) return;
      setEnvelope(restored.envelope);
      setSession(restored);
      syncReminderStore(restored.index);
      setNotice(`Backup restored: ${restored.index.documents.length} ${restored.index.documents.length === 1 ? 'document' : 'documents'}.`);
      void runSync();
    });
  };

  // ------------------------------------------------------------------ document actions
  /** Checks and encrypts one picked file under a new attachment id. */
  const encryptFile = async (base: DocumentSession, file: File): Promise<{ input: NewSideInput; blob: StoredBlob }> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const { filename, mimeType } = validateDocumentFile({ name: file.name, size: bytes.length, bytes });
      const attachmentId = newDocumentId();
      const blob = await encryptAttachment(base, attachmentId, bytes);
      return { input: { attachmentId, file: { filename, mimeType, size: bytes.length } }, blob };
    } finally {
      bytes.fill(0);
    }
  };

  /** Encrypts the front and (optional) back of a new version. */
  const encryptSides = async (base: DocumentSession, front: File, back: File | null) => {
    const encryptedFront = await encryptFile(base, front);
    const encryptedBack = back ? await encryptFile(base, back) : null;
    const put = new Map([[encryptedFront.input.attachmentId, encryptedFront.blob]]);
    if (encryptedBack) put.set(encryptedBack.input.attachmentId, encryptedBack.blob);
    return { front: encryptedFront.input, back: encryptedBack?.input, put };
  };

  const saveNew = (event: FormEvent) => {
    event.preventDefault();
    const current = view;
    if (current.kind !== 'add' || !session) return;
    void run(async (isCurrent) => {
      if (!current.file) throw new Error('Choose the file to add.');
      if (!current.draft.title.trim()) throw new Error('Enter a title.');
      const { front, back, put } = await encryptSides(session, current.file, current.back);
      const { index } = addDocument(session.index, {
        title: current.draft.title.trim(),
        category: current.draft.category.trim() || 'Other',
        assetId: current.draft.assetId || null,
        serviceRecordId: current.draft.assetId && current.draft.serviceRecordId ? current.draft.serviceRecordId : null,
        reminderDays: reminderDaysFrom(current.draft.reminderText),
        ...front,
        back,
        expiresOn: current.draft.expiresOn || undefined,
        note: current.draft.note,
      }, new Date().toISOString());
      if (await commit(session, index, isCurrent, { put }) && isCurrent()) {
        setView({ kind: 'list' });
        setNotice(back ? 'Document added with front and back, encrypted.' : 'Document added and encrypted.');
      }
    });
  };

  const saveRenewal = (event: FormEvent) => {
    event.preventDefault();
    const current = view;
    if (current.kind !== 'renew' || !session) return;
    void run(async (isCurrent) => {
      if (!current.file) throw new Error('Choose the renewed document file.');
      const { front, back, put } = await encryptSides(session, current.file, current.back);
      const index = addDocumentRevision(session.index, current.id, {
        ...front, back, expiresOn: current.draft.expiresOn || undefined, note: current.draft.note,
      }, new Date().toISOString());
      if (await commit(session, index, isCurrent, { put }) && isCurrent()) {
        setView({ kind: 'detail', id: current.id });
        setNotice('Renewed. The new version is current; earlier versions are kept, and reminders now follow the new expiry date.');
      }
    });
  };

  /** Adds or replaces the back side of an existing version. */
  const saveBackSide = (documentId: string, revisionId: string, file: File) => {
    const base = sessionRef.current;
    if (!base) return;
    void run(async (isCurrent) => {
      const back = await encryptFile(base, file);
      const { index, removedAttachmentIds } = setRevisionBack(base.index, documentId, revisionId, back.input, new Date().toISOString());
      const put = new Map([[back.input.attachmentId, back.blob]]);
      if (await commit(base, index, isCurrent, { put, remove: removedAttachmentIds }) && isCurrent()) {
        setNotice(removedAttachmentIds.length ? 'Back side replaced.' : 'Back side added.');
      }
    });
  };

  const removeBackSide = async (doc: VaultDocument, revision: DocumentRevision) => {
    const ok = await showConfirm({
      title: 'Remove the back side?',
      message: `The back side${revision.back ? ` (${revision.back.filename})` : ''} of "${doc.title}" will be deleted${signedIn ? ' from all your devices' : ''}. The front is kept.`,
      tone: 'danger',
      confirmLabel: 'Remove back side',
    });
    if (!ok || !session) return;
    void run(async (isCurrent) => {
      const { index, removedAttachmentIds } = setRevisionBack(session.index, doc.id, revision.id, null, new Date().toISOString());
      if (await commit(session, index, isCurrent, { remove: removedAttachmentIds }) && isCurrent()) setNotice('Back side removed.');
    });
  };

  const saveEdit = (event: FormEvent) => {
    event.preventDefault();
    const current = view;
    if (current.kind !== 'edit' || !session) return;
    void run(async (isCurrent) => {
      const document = session.index.documents.find((doc) => doc.id === current.id);
      if (!document) throw new Error('This document no longer exists.');
      const now = new Date().toISOString();
      let index = updateDocumentDetails(session.index, current.id, {
        title: current.draft.title.trim(),
        category: current.draft.category.trim() || 'Other',
        assetId: current.draft.assetId || null,
        serviceRecordId: current.draft.assetId && current.draft.serviceRecordId ? current.draft.serviceRecordId : null,
        reminderDays: reminderDaysFrom(current.draft.reminderText),
      }, now);
      index = updateRevisionDetails(index, current.id, document.currentRevisionId, { expiresOn: current.draft.expiresOn || null }, now);
      if (await commit(session, index, isCurrent) && isCurrent()) {
        setView({ kind: 'detail', id: current.id });
        setNotice('Document updated. Reminders were rescheduled.');
      }
    });
  };

  const deleteDocument = async (doc: VaultDocument) => {
    const ok = await showConfirm({
      title: 'Delete this document?',
      message: `"${doc.title}" and all ${doc.revisions.length} ${doc.revisions.length === 1 ? 'version' : 'versions'} will be deleted${signedIn ? ' from all your devices' : ' from this device'} and its reminders cancelled. Backups you saved earlier still contain it.`,
      tone: 'danger',
      confirmLabel: 'Delete document',
    });
    if (!ok || !session) return;
    void run(async (isCurrent) => {
      const { index, removedAttachmentIds } = removeDocument(session.index, doc.id, new Date().toISOString());
      if (await commit(session, index, isCurrent, { remove: removedAttachmentIds }) && isCurrent()) {
        setView({ kind: 'list' });
        setNotice('Document deleted.');
      }
    });
  };

  const deleteVersion = async (doc: VaultDocument, revision: DocumentRevision) => {
    const ok = await showConfirm({
      title: 'Delete this old version?',
      message: `${revision.filename} (added ${formatShortDate(revision.addedAt.slice(0, 10))}) will be deleted. The current version is not affected.`,
      tone: 'danger',
      confirmLabel: 'Delete version',
    });
    if (!ok || !session) return;
    void run(async (isCurrent) => {
      const { index, removedAttachmentIds } = deleteDocumentRevision(session.index, doc.id, revision.id, new Date().toISOString());
      if (await commit(session, index, isCurrent, { remove: removedAttachmentIds }) && isCurrent()) setNotice('Old version deleted.');
    });
  };

  /** Reads and decrypts one stored file. The caller zeroes the bytes when done. */
  const decryptRevision = async (base: DocumentSession, file: DocumentSide): Promise<Uint8Array> => {
    const blob = await readBlob(file.attachmentId);
    if (!blob) throw new Error(signedIn
      ? 'This file has not been downloaded to this device yet. Wait for the sync to finish and try again.'
      : 'This file is missing from the vault storage on this device.');
    return decryptAttachment(base, file.attachmentId, blob);
  };

  const openRevision = (doc: VaultDocument, revision: DocumentRevision, side: Side = 'front') => {
    const file = sideFile(revision, side);
    if (!session || !file) return;
    void run(async (isCurrent) => {
      releaseViewer();
      const bytes = await decryptRevision(session, file);
      try {
        if (!isCurrent()) return;
        const label = side === 'back' ? 'Back · ' : revision.back ? 'Front · ' : '';
        const base = { documentId: doc.id, revisionId: revision.id, side, title: doc.title, subtitle: `${label}${file.filename}` };
        if (file.mimeType === 'application/pdf') {
          const source = await openPdfPages(bytes);
          if (!isCurrent()) {
            void source.close();
            return;
          }
          showViewer({ ...base, content: { kind: 'pdf', source } });
        } else {
          showViewer({ ...base, content: { kind: 'image', url: URL.createObjectURL(new Blob([bytes.slice()], { type: file.mimeType })) } });
        }
      } finally {
        bytes.fill(0);
      }
    });
  };

  /** Download, share or print an unencrypted copy (asks once while the screen is open). */
  const fileAction = (doc: VaultDocument, revision: DocumentSide, action: FileAction) => {
    if (!session) return;
    const base = session;
    void (async () => {
      if (!plainCopyConfirmed.current) {
        const ok = await showConfirm({
          title: action === 'print' ? 'Print this document?' : action === 'share' ? 'Share an unencrypted copy?' : 'Save an unencrypted copy?',
          message: action === 'print'
            ? 'The document is decrypted and sent to the printer or print service you choose.'
            : 'The copy is not encrypted: anyone who gets the file can open it. The document in the vault stays encrypted.',
          confirmLabel: action === 'print' ? 'Print' : action === 'share' ? 'Share' : 'Save copy',
        });
        if (!ok) return;
        plainCopyConfirmed.current = true;
      }
      void run(async (isCurrent) => {
        const bytes = await decryptRevision(base, revision);
        // The system save, share and print screens background the app: keep the app lock from locking meanwhile.
        beginExternalActivity();
        let keepWindow = false;
        try {
          if (!isCurrent()) return;
          if (action === 'download') {
            const saved = await saveDocumentCopy(bytes, revision.filename, revision.mimeType);
            if (saved && isCurrent()) setNotice(hasDocumentVaultNative() ? 'Copy saved. It is not encrypted.' : 'Download started. The copy is not encrypted.');
          } else if (action === 'share') {
            const outcome = await shareDocument(bytes, revision.filename, revision.mimeType, doc.title);
            // The Android share sheet stays open after the call returns.
            keepWindow = hasDocumentVaultNative();
            if (outcome === 'downloaded' && isCurrent()) setNotice('This browser cannot share files, so the document was downloaded instead.');
          } else {
            await printDocument(bytes, revision.filename, revision.mimeType, doc.title);
            keepWindow = hasDocumentVaultNative();
          }
        } finally {
          if (!keepWindow) endExternalActivity();
          bytes.fill(0);
        }
      });
    })();
  };

  const viewerAction = (action: FileAction) => {
    const current = viewerRef.current;
    const doc = current && session?.index.documents.find((candidate) => candidate.id === current.documentId);
    const revision = doc?.revisions.find((candidate) => candidate.id === current?.revisionId);
    const file = revision && current && sideFile(revision, current.side);
    if (doc && file) fileAction(doc, file, action);
  };

  const confirmUseAccountVault = async () => {
    const ok = await showConfirm({
      title: 'Use your account\'s document vault here?',
      message: 'The document vault on this device is removed and the one in your account is downloaded. Documents that are only on this device are lost unless you saved a backup first (Vault settings → Save backup).',
      tone: 'danger',
      confirmLabel: 'Remove and download',
    });
    if (!ok) return;
    void run(async () => {
      const stored = await readDocumentVault();
      closeSession();
      const result = stored ? await switchToAccountDocumentVault(stored.revision) : await syncDocumentVault();
      if (mounted.current) {
        setSync(result);
        setEnvelope((await readDocumentVault()) ?? null);
        setNotice('This device now uses your account\'s document vault.');
      }
    });
  };

  const confirmReplaceAccountVault = async () => {
    const ok = await showConfirm({
      title: 'Replace the document vault in your account?',
      message: 'Your account will hold this device\'s vault instead, and your other devices switch to it. Documents that are only in the account\'s current vault are lost unless a backup of it exists.',
      tone: 'danger',
      confirmLabel: 'Replace account vault',
    });
    if (!ok) return;
    void run(async () => {
      const result = await replaceAccountDocumentVault();
      if (mounted.current) {
        setSync(result);
        if (result.status === 'synced') setNotice('Your account now holds this device\'s document vault.');
        else if (result.message) setError(result.message);
      }
    });
  };

  const toggleTitles = (show: boolean) => {
    if (!session) return;
    void run(async (isCurrent) => {
      const index = setShowReminderTitles(session.index, show, new Date().toISOString());
      if (await commit(session, index, isCurrent) && isCurrent()) {
        setNotice(show ? 'Reminders will now name the document.' : 'Reminders are generic again; titles were removed from the unencrypted schedule.');
      }
    });
  };

  const exportBackup = (event: FormEvent) => {
    event.preventDefault();
    const password = backupPassword;
    const again = backupRepeat;
    void run(async (isCurrent) => {
      if (password !== again) throw new Error('The two backup passwords do not match.');
      const stored = await readDocumentVault();
      if (!stored) throw new Error('There is no document vault to back up.');
      const text = await buildDocumentBackup(stored, await readAllBlobs(), new Date().toISOString(), password);
      setBackupPassword('');
      setBackupRepeat('');
      const filename = `dayflow-documents-${todayString()}.json`;
      if (hasDocumentVaultNative()) {
        beginExternalActivity();
        try {
          const saved = await exportTextNative(text, filename, 'application/json');
          if (saved && mounted.current) setNotice('Encrypted backup saved. It opens only with the backup password you just chose.');
        } finally {
          endExternalActivity();
        }
      } else {
        downloadTextFile(text, filename);
        if (isCurrent()) setNotice('Encrypted backup downloaded. It opens only with the backup password you just chose.');
      }
    });
  };

  // ------------------------------------------------------------------ derived
  const index = session?.index;
  const usage = index ? vaultUsageBytes(index) : 0;
  const categories = useMemo(
    () => [...new Set([...(index?.documents.map((doc) => doc.category) ?? []), ...CATEGORY_SUGGESTIONS])].sort(),
    [index],
  );
  const assetName = (id?: string) => {
    const item = maintenanceItems.find((candidate) => candidate.id === id);
    return item ? `${item.asset} · ${item.title}` : id ? 'Deleted maintenance item' : '';
  };
  const visible = useMemo(() => {
    if (!index) return [];
    const q = query.trim().toLowerCase();
    return index.documents
      .filter((doc) => !categoryFilter || doc.category === categoryFilter)
      .filter((doc) => !assetFilter || doc.assetId === assetFilter)
      .filter((doc) => !q || [doc.title, doc.category, currentRevision(doc).filename].some((value) => value.toLowerCase().includes(q)))
      .sort((a, b) => (currentRevision(a).expiresOn ?? '9999').localeCompare(currentRevision(b).expiresOn ?? '9999') || a.title.localeCompare(b.title));
  }, [index, query, categoryFilter, assetFilter]);

  // Image previews of the open document's current version (both sides).
  const previewFiles = useMemo(() => {
    if (view.kind !== 'detail' || !session) return [];
    const doc = session.index.documents.find((candidate) => candidate.id === view.id);
    if (!doc) return [];
    return revisionSides(currentRevision(doc)).map(({ file }) => file).filter((file) => file.mimeType !== 'application/pdf');
  }, [view, session]);
  const previewKey = `${session?.envelope.revision ?? ''}|${previewFiles.map((file) => file.attachmentId).join(',')}`;
  useEffect(() => {
    const base = sessionRef.current;
    if (!base || previewFiles.length === 0) return;
    let active = true;
    const urls: string[] = [];
    void (async () => {
      for (const file of previewFiles) {
        try {
          const blob = await readBlob(file.attachmentId);
          if (!blob || !active) continue;
          const bytes = await decryptAttachment(base, file.attachmentId, blob);
          try {
            if (!active) continue;
            const url = URL.createObjectURL(new Blob([bytes.slice()], { type: file.mimeType }));
            urls.push(url);
            setPreviews((current) => ({ ...current, [file.attachmentId]: url }));
          } finally {
            bytes.fill(0);
          }
        } catch {
          // A preview is optional: Open still reports the problem.
        }
      }
    })();
    return () => {
      active = false;
      for (const url of urls) URL.revokeObjectURL(url);
      setPreviews({});
    };
    // previewKey covers previewFiles (same ids) and a newer stored vault.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  // ------------------------------------------------------------------ render helpers
  const draftFields = (draft: DocDraft, update: (draft: DocDraft) => void, opts: { details: boolean; expiry: boolean; note: boolean }) => {
    const asset = maintenanceItems.find((item) => item.id === draft.assetId);
    return (
      <fieldset disabled={busy} className="space-y-3">
        {opts.details && <>
          <label className={labelClass}><span>Title</span>
            <input required maxLength={DOCUMENT_LIMITS.maxTitle} className={inputClass} placeholder="Passport, car insurance…" value={draft.title} onChange={(e) => update({ ...draft, title: e.target.value })} />
          </label>
          <label className={labelClass}><span>Category</span>
            <input list="document-categories" maxLength={DOCUMENT_LIMITS.maxCategory} className={inputClass} placeholder="Identity" value={draft.category} onChange={(e) => update({ ...draft, category: e.target.value })} />
            <datalist id="document-categories">{categories.map((category) => <option key={category} value={category} />)}</datalist>
          </label>
          <label className={labelClass}><span>Linked vehicle or home item (optional)</span>
            <select className={inputClass} value={draft.assetId} onChange={(e) => update({ ...draft, assetId: e.target.value, serviceRecordId: '' })}>
              <option value="">Not linked</option>
              {maintenanceItems.map((item) => <option key={item.id} value={item.id}>{item.asset} · {item.title}</option>)}
            </select>
          </label>
          {asset && asset.history.length > 0 && (
            <label className={labelClass}><span>Service record (for receipts)</span>
              <select className={inputClass} value={draft.serviceRecordId} onChange={(e) => update({ ...draft, serviceRecordId: e.target.value })}>
                <option value="">Whole item</option>
                {[...asset.history].sort((a, b) => b.date.localeCompare(a.date)).map((record) => (
                  <option key={record.id} value={record.id}>Service on {formatShortDate(record.date)}</option>
                ))}
              </select>
            </label>
          )}
        </>}
        {opts.expiry && (
          <label className={labelClass}><span>Expiry date (optional)</span>
            <input type="date" className={inputClass} value={draft.expiresOn} onChange={(e) => update({ ...draft, expiresOn: e.target.value })} />
          </label>
        )}
        {opts.details && (
          <label className={labelClass}><span>Remind me (days before expiry)</span>
            <input className={inputClass} inputMode="numeric" placeholder="30, 7" value={draft.reminderText} onChange={(e) => update({ ...draft, reminderText: e.target.value })} />
            <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">Up to 5 values from 0 to 365, at 9:00. Empty = no reminders. Used only when an expiry date is set.</span>
          </label>
        )}
        {opts.note && (
          <label className={labelClass}><span>Note for this version (optional)</span>
            <input maxLength={1000} className={inputClass} value={draft.note} onChange={(e) => update({ ...draft, note: e.target.value })} />
          </label>
        )}
      </fieldset>
    );
  };

  const clearBack = () => setView((current) => (current.kind === 'add' || current.kind === 'renew' ? { ...current, back: null } : current));
  const filePicker = (file: File | null, back: File | null) => (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Front side <span className="font-normal text-slate-500 dark:text-slate-400">(or the whole document)</span></p>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => openPicker('front')}>
          <Upload className="size-4" /> {file ? 'Choose a different file' : 'Choose file or photo'}
        </Button>
        {file && <p className="text-sm text-slate-700 dark:text-slate-200 break-all">{file.name} · {formatFileSize(file.size)}</p>}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Back side <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span></p>
        <p className="text-xs text-slate-500 dark:text-slate-400">For two-sided cards: Aadhaar, PAN, driving licence, voter ID, RC, bank and insurance cards.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => openPicker('back')}>
            <ImagePlus className="size-4" /> {back ? 'Choose a different back' : 'Add back side'}
          </Button>
          {back && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={clearBack}><X className="size-4" /> Remove</Button>}
        </div>
        {back && <p className="text-sm text-slate-700 dark:text-slate-200 break-all">{back.name} · {formatFileSize(back.size)}</p>}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{LIMITS_TEXT}</p>
    </div>
  );

  const alerts = (
    <>
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-indigo-50 p-3 text-sm text-indigo-800 dark:bg-indigo-950 dark:text-indigo-100">{notice}</p>}
    </>
  );

  const hiddenInputs = (
    <>
      <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        onFilePicked(file);
      }} />
      <input ref={restoreInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        void onRestorePicked(file);
      }} />
    </>
  );

  const syncBlocked = sync?.status === 'conflict' || sync?.status === 'other-account';
  const header = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-white"><FileLock2 className="size-5" /> Document Vault</h2>
        {session && (
          <Button size="sm" variant="ghost" aria-label="Vault settings" onClick={() => { releaseViewer(); setView({ kind: 'settings' }); }}><Settings2 className="size-4" /> Settings</Button>
        )}
      </div>
      <SyncLine signedIn={signedIn} hasVault={Boolean(envelope)} sync={sync} />
      {syncBlocked && (
        <Card className="space-y-3 p-4 text-sm text-slate-700 dark:text-slate-200">
          <p>
            {sync?.status === 'conflict'
              ? 'Your account already has a different document vault (made on another device), so this device\'s vault cannot sync.'
              : 'This device\'s document vault syncs with a different Dayflow account.'}
            {' '}To keep documents that are only here, save a backup first (Vault settings).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void confirmUseAccountVault()}>Use my account's vault here</Button>
            {sync?.status === 'conflict' && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void confirmReplaceAccountVault()}>Replace my account's vault with this one</Button>
            )}
          </div>
        </Card>
      )}
    </>
  );

  const restoreCard = restoreSource && (
    <Card className="p-4">
      <form className="space-y-3" onSubmit={submitRestore} autoComplete="off">
        <h3 className="font-bold text-slate-900 dark:text-white">Restore backup</h3>
        <p className="text-sm text-slate-700 dark:text-slate-200">Restoring <span className="font-semibold break-all">{restoreSource.name}</span>. Enter the password the backup was saved with. Every file is checked before anything is replaced.</p>
        <label className={labelClass}><span>Backup password</span>
          <input className={inputClass} type="password" required maxLength={256} autoComplete="off" value={passphrase} disabled={busy} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Check and restore'}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => { setRestoreSource(null); setPassphrase(''); setError(''); }}>Cancel</Button>
        </div>
      </form>
    </Card>
  );

  // ------------------------------------------------------------------ before the vault is open
  if (!session) {
    const waitingForAccount = envelope === null && !accountChecked;
    return (
      <section className="mx-auto max-w-2xl space-y-4">
        {header}
        {alerts}
        {hiddenInputs}
        {restoreCard}
        <Card className="space-y-4 p-4 text-sm text-slate-700 dark:text-slate-200">
          {envelope === undefined ? (
            error ? <Button variant="secondary" onClick={() => { setError(''); setReload((value) => value + 1); }}><RefreshCw className="size-4" /> Retry</Button> : <p role="status">Loading…</p>
          ) : envelope?.version === 1 ? (
            <form className="space-y-3" onSubmit={submitUpgrade} autoComplete="off">
              <p>This vault was made with a passphrase. Enter it once to update the vault; after that it opens without a passphrase and syncs with your account.</p>
              <label className={labelClass}><span>Vault passphrase</span>
                <input className={inputClass} type="password" required maxLength={256} autoComplete="off" value={passphrase} disabled={busy} onChange={(e) => setPassphrase(e.target.value)} />
              </label>
              <Button type="submit" disabled={busy}>{busy ? 'Updating…' : 'Update vault'}</Button>
            </form>
          ) : waitingForAccount ? (
            sync?.status === 'offline' ? (
              <div className="space-y-3">
                <p>Your documents could not be loaded from your account{sync.message ? ` (${sync.message})` : ''}. Connect to the internet and try again.</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={busy} onClick={() => void runSync()}><RefreshCw className="size-4" /> Try again</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => openPicker('restore')}><Upload className="size-4" /> Restore a backup…</Button>
                </div>
              </div>
            ) : <p role="status">Loading your documents…</p>
          ) : error ? (
            <Button variant="secondary" onClick={() => { setError(''); setReload((value) => value + 1); }}><RefreshCw className="size-4" /> Retry</Button>
          ) : (
            <p role="status">Opening your documents…</p>
          )}
        </Card>
        {reminderNote && <p className="text-xs text-slate-500 dark:text-slate-400">{reminderNote}</p>}
      </section>
    );
  }

  // ------------------------------------------------------------------ open
  const unlockedIndex = session.index;
  const detailDoc = view.kind === 'detail' || view.kind === 'edit' || view.kind === 'renew'
    ? unlockedIndex.documents.find((doc) => doc.id === view.id)
    : undefined;

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      {header}
      {alerts}
      {hiddenInputs}
      {restoreCard}

      {viewer && (
        <Suspense fallback={<div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950 text-white" role="status">Opening…</div>}>
          <DocumentViewer
            title={viewer.title}
            subtitle={viewer.subtitle}
            content={viewer.content}
            busy={busy}
            message={error ? { tone: 'error', text: error } : notice ? { tone: 'info', text: notice } : null}
            onClose={releaseViewer}
            onDownload={() => viewerAction('download')}
            onShare={() => viewerAction('share')}
            onPrint={() => viewerAction('print')}
          />
        </Suspense>
      )}

      {view.kind === 'list' && (
        <>
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => { releaseViewer(); setView({ kind: 'add', draft: emptyDraft(assetFilter ? { assetId: assetFilter, action: 'add' } : null), file: null, back: null }); }}>
                <FilePlus2 className="size-4" /> Add document
              </Button>
            </div>
            <input type="search" aria-label="Search documents" placeholder="Search title, category or file name" className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <select aria-label="Filter by category" className={inputClass} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                <option value="">All categories</option>
                {[...new Set(unlockedIndex.documents.map((doc) => doc.category))].sort().map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
              <select aria-label="Filter by vehicle or home item" className={inputClass} value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}>
                <option value="">All items</option>
                {maintenanceItems.map((item) => <option key={item.id} value={item.id}>{item.asset} · {item.title}</option>)}
              </select>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">{formatFileSize(usage)} of {formatFileSize(DOCUMENT_LIMITS.maxVaultBytes)} used · {unlockedIndex.documents.length} of {DOCUMENT_LIMITS.maxDocuments} documents</p>
          </Card>
          {visible.length === 0 && (
            <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
              <p>{unlockedIndex.documents.length ? 'No matching documents.' : 'No documents yet. Add your first one.'}</p>
              {unlockedIndex.documents.length === 0 && !restoreSource && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => openPicker('restore')}><Upload className="size-4" /> Restore a backup…</Button>
              )}
            </div>
          )}
          {visible.map((doc) => {
            const revision = currentRevision(doc);
            const badge = expiryBadge(revision, today);
            return (
              <button key={doc.id} type="button" onClick={() => { releaseViewer(); setView({ kind: 'detail', id: doc.id }); }}
                className="block w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-700">
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-bold text-slate-900 dark:text-white break-words">{doc.title}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{doc.category}{doc.assetId ? ` · ${assetName(doc.assetId)}` : ''}{revision.back ? ' · Front + back' : ''} · {doc.revisions.length} {doc.revisions.length === 1 ? 'version' : 'versions'}</span>
                  </span>
                  {badge && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>{badge.text}</span>}
                </span>
              </button>
            );
          })}
        </>
      )}

      {view.kind === 'add' && (
        <Card className="p-4">
          <form className="space-y-3" onSubmit={saveNew} autoComplete="off">
            <h3 className="font-bold text-slate-900 dark:text-white">Add document</h3>
            {filePicker(view.file, view.back)}
            {draftFields(view.draft, (draft) => setView({ ...view, draft }), { details: true, expiry: true, note: true })}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !view.file}>{busy ? 'Encrypting…' : 'Save document'}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setView({ kind: 'list' })}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}

      {detailDoc && view.kind === 'detail' && (() => {
        const revision = currentRevision(detailDoc);
        const badge = expiryBadge(revision, today);
        return (
          <Card className="space-y-4 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white break-words">{detailDoc.title}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">{detailDoc.category}{detailDoc.assetId ? ` · ${assetName(detailDoc.assetId)}` : ''}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {revision.expiresOn ? `Reminders: ${detailDoc.reminderDays.length ? detailDoc.reminderDays.map((d) => (d === 0 ? 'on the day' : `${d} days before`)).join(', ') : 'off'}` : 'No expiry date'}
                </p>
              </div>
              {badge && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}>{badge.text}</span>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {revisionSides(revision).map(({ side, file }) => (
                <div key={side} className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{revision.back ? (side === 'front' ? 'Front' : 'Back') : 'Document'}</p>
                  <button type="button" disabled={busy} aria-label={`Open ${side === 'back' ? 'back side' : revision.back ? 'front side' : 'document'}`} onClick={() => openRevision(detailDoc, revision, side)}
                    className="flex h-40 w-full items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-sm text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {previews[file.attachmentId]
                      ? <img src={previews[file.attachmentId]} alt="" className="h-full w-full object-contain" />
                      : <span className="flex flex-col items-center gap-1"><Eye className="size-5" />{file.mimeType === 'application/pdf' ? 'PDF · tap to open' : 'Tap to open'}</span>}
                  </button>
                  <p className="text-xs text-slate-500 dark:text-slate-400 break-all">{file.filename} · {formatFileSize(file.size)}</p>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" aria-label="Download" disabled={busy} onClick={() => fileAction(detailDoc, file, 'download')}><Download className="size-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Share" disabled={busy} onClick={() => fileAction(detailDoc, file, 'share')}><Share2 className="size-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label="Print" disabled={busy} onClick={() => fileAction(detailDoc, file, 'print')}><Printer className="size-4" /></Button>
                    {side === 'back' && <>
                      <Button size="sm" variant="ghost" aria-label="Replace back side" disabled={busy} onClick={() => pickBackFor(detailDoc.id, revision.id)}><Upload className="size-4" /></Button>
                      <Button size="sm" variant="ghost" aria-label="Remove back side" disabled={busy} onClick={() => void removeBackSide(detailDoc, revision)}><Trash2 className="size-4" /></Button>
                    </>}
                  </div>
                </div>
              ))}
              {!revision.back && (
                <button type="button" disabled={busy} onClick={() => pickBackFor(detailDoc.id, revision.id)}
                  className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 p-3 text-sm font-semibold text-slate-600 hover:border-indigo-400 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-600 dark:hover:text-indigo-300">
                  <ImagePlus className="size-5" /> Add back side
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">Aadhaar, PAN, licence, cards</span>
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setView({ kind: 'renew', id: detailDoc.id, draft: { ...emptyDraft(), expiresOn: '' }, file: null, back: null })}><RefreshCw className="size-4" /> Renew</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setView({
                kind: 'edit', id: detailDoc.id, draft: {
                  title: detailDoc.title, category: detailDoc.category, assetId: detailDoc.assetId ?? '', serviceRecordId: detailDoc.serviceRecordId ?? '',
                  expiresOn: revision.expiresOn ?? '', reminderText: detailDoc.reminderDays.join(', '), note: '',
                },
              })}>Edit</Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void deleteDocument(detailDoc)}><Trash2 className="size-4" /> Delete</Button>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-bold text-slate-900 dark:text-white">Versions</h4>
              <ul className="space-y-2">
                {[...detailDoc.revisions].reverse().map((rev) => (
                  <li key={rev.id} className="rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-800/60">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-all text-slate-800 dark:text-slate-100">
                        {rev.id === detailDoc.currentRevisionId && <span className="mr-1 rounded bg-indigo-100 px-1.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">Current</span>}
                        {rev.filename} · {formatFileSize(rev.size)}{rev.back ? ` · back: ${rev.back.filename} · ${formatFileSize(rev.back.size)}` : ''}
                      </span>
                      <span className="flex gap-1">
                        <Button size="sm" variant="ghost" aria-label={`Open ${rev.filename}`} disabled={busy} onClick={() => openRevision(detailDoc, rev)}><Eye className="size-4" /></Button>
                        {rev.back && <Button size="sm" variant="ghost" aria-label="Open back side" disabled={busy} onClick={() => openRevision(detailDoc, rev, 'back')}><ImagePlus className="size-4" /></Button>}
                        <Button size="sm" variant="ghost" aria-label={`Download ${rev.filename}`} disabled={busy} onClick={() => fileAction(detailDoc, rev, 'download')}><Download className="size-4" /></Button>
                        {rev.id !== detailDoc.currentRevisionId && <Button size="sm" variant="ghost" aria-label="Delete version" disabled={busy} onClick={() => void deleteVersion(detailDoc, rev)}><Trash2 className="size-4" /></Button>}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Added {formatShortDate(rev.addedAt.slice(0, 10))}{rev.expiresOn ? ` · expires ${formatShortDate(rev.expiresOn)}` : ''}{rev.note ? ` · ${rev.note}` : ''}</p>
                  </li>
                ))}
              </ul>
            </div>
            <Button size="sm" variant="ghost" onClick={() => { releaseViewer(); setView({ kind: 'list' }); }}><ChevronLeft className="size-4" /> All documents</Button>
          </Card>
        );
      })()}

      {detailDoc && view.kind === 'renew' && (
        <Card className="p-4">
          <form className="space-y-3" onSubmit={saveRenewal} autoComplete="off">
            <h3 className="font-bold text-slate-900 dark:text-white">Renew {detailDoc.title}</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300">The new file becomes the current version. Earlier versions are kept, and reminders switch to the new expiry date.</p>
            {filePicker(view.file, view.back)}
            {currentRevision(detailDoc).back && !view.back && (
              <p className="text-xs text-amber-700 dark:text-amber-300">The current version has a back side. Add the renewed back too, or the new version will have the front only.</p>
            )}
            {draftFields(view.draft, (draft) => setView({ ...view, draft }), { details: false, expiry: true, note: true })}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !view.file}>{busy ? 'Encrypting…' : 'Save renewal'}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setView({ kind: 'detail', id: detailDoc.id })}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}

      {detailDoc && view.kind === 'edit' && (
        <Card className="p-4">
          <form className="space-y-3" onSubmit={saveEdit} autoComplete="off">
            <h3 className="font-bold text-slate-900 dark:text-white">Edit document</h3>
            {draftFields(view.draft, (draft) => setView({ ...view, draft }), { details: true, expiry: true, note: false })}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setView({ kind: 'detail', id: detailDoc.id })}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}

      {(view.kind === 'detail' || view.kind === 'edit' || view.kind === 'renew') && !detailDoc && (
        <Card className="p-4 text-sm">This document no longer exists. <button type="button" className="font-semibold underline" onClick={() => setView({ kind: 'list' })}>Back to documents</button></Card>
      )}

      {view.kind === 'settings' && (
        <Card className="space-y-4 p-4">
          <h3 className="font-bold text-slate-900 dark:text-white">Vault settings</h3>
          <div className="space-y-2 text-sm text-slate-700 dark:text-slate-200">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={unlockedIndex.showReminderTitles} disabled={busy} onChange={(e) => toggleTitles(e.target.checked)} />
              <span><span className="font-semibold">Show document titles in reminders</span><br />
                <span className="text-xs text-slate-500 dark:text-slate-400">Off by default. When on, titles are copied into the unencrypted reminder schedule and appear on the lock screen and Today.</span></span>
            </label>
            <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              Titles, categories, links, file names, files and versions are encrypted. The reminder schedule (dates and expiry dates under a random key; titles only if the option above is on) is stored unencrypted on each device so reminders can fire.
              {signedIn
                ? ' The vault syncs to your Dayflow account and your other signed-in devices. Its key is kept with your account (no passphrase), so anyone who can sign in to your account can open it.'
                : ' Sign in to sync the vault between your devices.'}
            </p>
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">Encrypted backup</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">One file with every document, encrypted with a backup password you choose (at least {MIN_VAULT_PASSPHRASE} characters). It restores on any device with that password. Size: about {formatFileSize(Math.round(usage * 1.37))}.</p>
            <form className="space-y-2" onSubmit={exportBackup} autoComplete="off">
              <label className={labelClass}><span>Backup password</span>
                <input className={inputClass} type="password" required minLength={MIN_VAULT_PASSPHRASE} maxLength={256} autoComplete="new-password" value={backupPassword} disabled={busy} onChange={(e) => setBackupPassword(e.target.value)} />
              </label>
              <label className={labelClass}><span>Repeat backup password</span>
                <input className={inputClass} type="password" required minLength={MIN_VAULT_PASSPHRASE} maxLength={256} autoComplete="new-password" value={backupRepeat} disabled={busy} onChange={(e) => setBackupRepeat(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" type="submit" variant="secondary" disabled={busy}><Download className="size-4" /> Save backup</Button>
                <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => openPicker('restore')}><Upload className="size-4" /> Restore backup…</Button>
              </div>
            </form>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{LIMITS_TEXT}. Used: {formatFileSize(usage)}.</p>
          {reminderNote && <p className="text-xs text-slate-500 dark:text-slate-400">{reminderNote}</p>}
          <Button size="sm" variant="ghost" onClick={() => setView({ kind: 'list' })}><ChevronLeft className="size-4" /> All documents</Button>
        </Card>
      )}
    </section>
  );
}

function SyncLine({ signedIn, hasVault, sync }: {
  signedIn: boolean;
  hasVault: boolean;
  sync: DocumentSyncResult | null;
}) {
  if (!isCloudConfigured()) return null;
  let text: string;
  let ok = false;
  if (!signedIn) text = 'Signed out: documents stay on this device only.';
  else if (!sync) text = 'Checking your account…';
  else if (sync.status === 'synced') {
    ok = true;
    text = 'Synced with your account.';
  } else if (sync.status === 'no-vault') text = hasVault ? 'Not synced yet.' : 'No document vault in your account yet.';
  else if (sync.status === 'needs-upgrade') text = sync.message ?? 'Update the vault below to start syncing it.';
  else if (sync.status === 'offline') text = `Couldn't sync${sync.message ? ` (${sync.message})` : ''}. Changes stay on this device and sync later.`;
  else if (sync.status === 'local-only') text = `Documents stay on this device only${sync.message ? ` (${sync.message})` : ''}.`;
  else text = 'Not syncing: see below.';
  const Icon = ok ? Cloud : CloudOff;
  return (
    <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <Icon className="size-4 shrink-0" /> {text}
    </p>
  );
}
