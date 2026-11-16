import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { App as CapApp } from '@capacitor/app';
import {
  ChevronLeft, ChevronRight, Download, Eye, FileLock2, FilePlus2, LockKeyhole, RefreshCw, Settings2, Trash2, Upload, X,
} from 'lucide-react';
import type { MaintenanceItem } from '../types';
import {
  DEFAULT_DOCUMENT_REMINDER_DAYS, DOCUMENT_LIMITS, addDocument, addDocumentRevision, buildDocumentBackup,
  createDocumentVault, currentRevision, daysUntilExpiry, decryptAttachment, deleteDocumentRevision,
  documentReminderEntries, encryptAttachment, formatFileSize, newDocumentId, normalizeReminderDays,
  parseDocumentBackup, removeDocument, sealDocumentIndex, setShowReminderTitles, unlockDocumentVault,
  updateDocumentDetails, updateRevisionDetails, validateDocumentFile, vaultUsageBytes, verifyDocumentBackup,
} from '../lib/documentVault';
import type { DocumentEnvelope, DocumentIndex, DocumentRevision, DocumentSession, StoredBlob, VaultDocument } from '../lib/documentVault';
import { MIN_VAULT_PASSPHRASE } from '../lib/passwordVault';
import {
  commitDocumentVault, readAllBlobs, readBlob, readDocumentVault, replaceDocumentVault, requestPersistentStorage,
} from '../services/documentStorage';
import { writeDocumentReminders } from '../services/documentReminderStore';
import { DocumentVaultNative, exportTextNative, hasDocumentVaultNative, openNativePdf } from '../services/documentVaultNative';
import { hasPasswordVault, PasswordVault } from '../services/passwordVault';
import { downloadTextFile } from '../services/maintenanceStorage';
import {
  beginExternalActivity, consumeExternalResume, endExternalActivity, shouldIgnorePauseForExternal,
} from '../lib/externalActivity';
import { todayString } from '../lib/ledger';
import { formatShortDate } from '../lib/dateFormat';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { showConfirm } from './ui/AppDialog';

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

const IDLE_MS = 2 * 60_000;
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
  | { kind: 'add'; draft: DocDraft; file: File | null }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string; draft: DocDraft }
  | { kind: 'renew'; id: string; draft: DocDraft; file: File | null }
  | { kind: 'settings' };

type Viewer =
  | { revisionId: string; title: string; kind: 'image' | 'pdf-web'; url: string }
  | { revisionId: string; title: string; kind: 'pdf-native'; handle: string; pageCount: number; page: number };

type Mode = 'unlock' | 'create' | 'restore';

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
  const [mode, setMode] = useState<Mode>('unlock');
  const [passphrase, setPassphrase] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [restoreSource, setRestoreSource] = useState<{ envelope: DocumentEnvelope; blobs: Map<string, StoredBlob>; name: string } | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [pending, setPending] = useState<View | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [pagePng, setPagePng] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [assetFilter, setAssetFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  const epoch = useRef(0);
  const mounted = useRef(false);
  const working = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const urls = useRef(new Set<string>());
  const pdfHandles = useRef(new Set<string>());
  const pausedUnderGrace = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const fileTarget = useRef<'draft' | 'restore'>('draft');
  const viewerBox = useRef<HTMLDivElement>(null);

  const releaseViewer = useCallback(() => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    if (pdfHandles.current.size > 0 && hasDocumentVaultNative()) {
      for (const handle of pdfHandles.current) void DocumentVaultNative.closePdf({ handle }).catch(() => {});
    }
    pdfHandles.current.clear();
    setViewer(null);
    setPagePng(null);
  }, []);

  const lock = useCallback(() => {
    epoch.current++;
    releaseViewer();
    // Keep an unsaved form or picked file so it is never silently lost.
    const current = viewRef.current;
    if (current.kind === 'add' || current.kind === 'renew' || current.kind === 'edit') setPending(current);
    setSession(null);
    setView({ kind: 'list' });
    setPassphrase('');
    setNewPassphrase('');
    setRepeat('');
    setQuery('');
  }, [releaseViewer]);

  // Lifecycle: screen protection, lock on background / unmount, resume after pickers.
  useEffect(() => {
    mounted.current = true;
    if (hasPasswordVault()) void PasswordVault.setScreenProtected({ enabled: true }).catch(() => {});
    const onPause = () => {
      if (shouldIgnorePauseForExternal()) {
        pausedUnderGrace.current = true;
        return;
      }
      lock();
    };
    const onResume = () => {
      if (!pausedUnderGrace.current) return;
      pausedUnderGrace.current = false;
      // Back after the picker's time window ran out: treat it as having left.
      if (!consumeExternalResume()) lock();
    };
    const onVisibility = () => (document.hidden ? onPause() : onResume());
    document.addEventListener('visibilitychange', onVisibility);
    const listener = CapApp.addListener('appStateChange', ({ isActive }) => (isActive ? onResume() : onPause()));
    return () => {
      mounted.current = false;
      lock();
      document.removeEventListener('visibilitychange', onVisibility);
      void listener.then((handle) => handle.remove()).catch(() => {});
      if (hasPasswordVault()) void PasswordVault.setScreenProtected({ enabled: false }).catch(() => {});
    };
  }, [lock]);

  // Idle timeout while unlocked.
  useEffect(() => {
    if (!session) return;
    let timer = window.setTimeout(lock, IDLE_MS);
    const renew = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, IDLE_MS);
    };
    const events = ['pointerdown', 'keydown', 'input', 'scroll', 'touchmove'] as const;
    for (const name of events) window.addEventListener(name, renew, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, renew);
    };
  }, [session, lock]);

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

  // Apply an intent from Maintenance / Today once unlocked.
  useEffect(() => {
    if (!session || !intent) return;
    if (intent.action === 'add') setView({ kind: 'add', draft: emptyDraft(intent), file: null });
    else if (intent.assetId) setAssetFilter(intent.assetId);
    onIntentHandled?.();
  }, [session, intent, onIntentHandled]);

  // A decrypted file is only shown on its document's detail screen: leaving it closes the
  // viewer, revokes the object URL and closes any native PDF handle.
  useEffect(() => {
    if (view.kind !== 'detail') releaseViewer();
  }, [view.kind, releaseViewer]);

  // Render the current page of a native PDF.
  useEffect(() => {
    if (!viewer || viewer.kind !== 'pdf-native') return;
    let active = true;
    const started = epoch.current;
    const cssWidth = viewerBox.current?.clientWidth ?? 360;
    const width = Math.min(2000, Math.max(320, Math.round(cssWidth * (window.devicePixelRatio || 1))));
    setPagePng(null);
    DocumentVaultNative.renderPdfPage({ handle: viewer.handle, page: viewer.page, width })
      .then(({ png }) => {
        if (active && started === epoch.current) setPagePng(`data:image/png;base64,${png}`);
      })
      .catch((cause) => {
        if (active && started === epoch.current) setError(errorText(cause, 'Could not show this page.'));
      });
    return () => { active = false; };
  }, [viewer]);

  /** Runs one vault action. `isCurrent()` turns false once the vault locks, so late work cannot reopen it. */
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

  /** Seals and commits `next`; updates state only while still unlocked. */
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
    // Saved. The schedule follows the saved index even if the vault locked meanwhile.
    const reminderError = syncReminderStore(next);
    if (mounted.current) setEnvelope(sealed);
    if (isCurrent()) {
      setSession({ ...base, envelope: sealed, index: next });
      if (reminderError) setError(reminderError);
    }
    return true;
  };

  // ------------------------------------------------------------------ pickers
  const openPicker = (target: 'draft' | 'restore') => {
    fileTarget.current = target;
    beginExternalActivity();
    (target === 'restore' ? restoreInput : fileInput).current?.click();
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
    const attach = (target: View): View =>
      target.kind === 'add' || target.kind === 'renew' ? { ...target, file } : target;
    if (!sessionRef.current) {
      // The vault locked while the picker was open: keep the file for after unlock.
      setPending((current) => (current ? attach(current) : current));
      return;
    }
    setView((current) => attach(current));
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
      setMode('restore');
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, 'Choose a Dayflow document backup.'));
    }
  };

  // ------------------------------------------------------------------ unlock / create / restore
  const submitPassphrase = (event: FormEvent) => {
    event.preventDefault();
    const pass = passphrase;
    const next = newPassphrase;
    const again = repeat;
    setPassphrase('');
    setNewPassphrase('');
    setRepeat('');
    void run(async (isCurrent) => {
      if (mode === 'create') {
        if (next !== again) throw new Error('The two passphrases do not match.');
        const created = await createDocumentVault(next);
        if (!isCurrent()) return;
        await commitDocumentVault({ envelope: created.envelope, expectedRevision: null });
        void requestPersistentStorage().catch(() => false);
        setEnvelope(created.envelope);
        const reminderError = syncReminderStore(created.index);
        if (isCurrent()) {
          setSession(created);
          setMode('unlock');
          setNotice('Vault created. Save an encrypted backup once you have added documents.');
          if (reminderError) setError(reminderError);
        }
        return;
      }
      if (mode === 'restore') {
        if (!restoreSource) return;
        const restored = await verifyDocumentBackup(restoreSource, pass);
        if (!isCurrent()) return;
        if (envelope) {
          const ok = await showConfirm({
            title: 'Replace the document vault on this device?',
            message: 'Every document currently in the vault on this device will be replaced by the backup. This cannot be undone.',
            tone: 'danger',
            confirmLabel: 'Replace vault',
          });
          if (!ok || !isCurrent()) return;
        }
        await replaceDocumentVault(restoreSource.envelope, restoreSource.blobs);
        void requestPersistentStorage().catch(() => false);
        setEnvelope(restoreSource.envelope);
        const reminderError = syncReminderStore(restored.index);
        setRestoreSource(null);
        if (isCurrent()) {
          setSession(restored);
          setMode('unlock');
          setNotice(`Backup restored: ${restored.index.documents.length} ${restored.index.documents.length === 1 ? 'document' : 'documents'}. The vault passphrase is now the backup's passphrase.`);
          if (reminderError) setError(reminderError);
        }
        return;
      }
      // Unlock against the latest stored envelope.
      const stored = await readDocumentVault();
      if (!stored) throw new Error('There is no document vault on this device.');
      const opened = await unlockDocumentVault(stored, pass);
      if (!isCurrent()) return;
      setEnvelope(stored);
      setSession(opened);
      const reminderError = syncReminderStore(opened.index);
      if (reminderError) setError(reminderError);
    });
  };

  // ------------------------------------------------------------------ document actions
  const saveNew = (event: FormEvent) => {
    event.preventDefault();
    const current = view;
    if (current.kind !== 'add' || !session) return;
    void run(async (isCurrent) => {
      if (!current.file) throw new Error('Choose the file to add.');
      if (!current.draft.title.trim()) throw new Error('Enter a title.');
      const bytes = new Uint8Array(await current.file.arrayBuffer());
      try {
        const { filename, mimeType } = validateDocumentFile({ name: current.file.name, size: bytes.length, bytes });
        const attachmentId = newDocumentId();
        const blob = await encryptAttachment(session, attachmentId, bytes);
        const { index } = addDocument(session.index, {
          title: current.draft.title.trim(),
          category: current.draft.category.trim() || 'Other',
          assetId: current.draft.assetId || null,
          serviceRecordId: current.draft.assetId && current.draft.serviceRecordId ? current.draft.serviceRecordId : null,
          reminderDays: reminderDaysFrom(current.draft.reminderText),
          attachmentId,
          file: { filename, mimeType, size: bytes.length },
          expiresOn: current.draft.expiresOn || undefined,
          note: current.draft.note,
        }, new Date().toISOString());
        if (await commit(session, index, isCurrent, { put: new Map([[attachmentId, blob]]) }) && isCurrent()) {
          setView({ kind: 'list' });
          setNotice('Document added and encrypted.');
        }
      } finally {
        bytes.fill(0);
      }
    });
  };

  const saveRenewal = (event: FormEvent) => {
    event.preventDefault();
    const current = view;
    if (current.kind !== 'renew' || !session) return;
    void run(async (isCurrent) => {
      if (!current.file) throw new Error('Choose the renewed document file.');
      const bytes = new Uint8Array(await current.file.arrayBuffer());
      try {
        const { filename, mimeType } = validateDocumentFile({ name: current.file.name, size: bytes.length, bytes });
        const attachmentId = newDocumentId();
        const blob = await encryptAttachment(session, attachmentId, bytes);
        const index = addDocumentRevision(session.index, current.id, {
          attachmentId, file: { filename, mimeType, size: bytes.length },
          expiresOn: current.draft.expiresOn || undefined, note: current.draft.note,
        }, new Date().toISOString());
        if (await commit(session, index, isCurrent, { put: new Map([[attachmentId, blob]]) }) && isCurrent()) {
          setView({ kind: 'detail', id: current.id });
          setNotice('Renewed. The new version is current; earlier versions are kept, and reminders now follow the new expiry date.');
        }
      } finally {
        bytes.fill(0);
      }
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
      message: `"${doc.title}" and all ${doc.revisions.length} ${doc.revisions.length === 1 ? 'version' : 'versions'} will be deleted from this device and its reminders cancelled. Backups you saved earlier still contain it.`,
      tone: 'danger',
      confirmLabel: 'Delete document',
    });
    if (!ok || !session) return;
    void run(async (isCurrent) => {
      const { index, removedAttachmentIds } = removeDocument(session.index, doc.id);
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

  const openRevision = (doc: VaultDocument, revision: DocumentRevision) => {
    if (!session) return;
    void run(async (isCurrent) => {
      releaseViewer();
      const blob = await readBlob(revision.attachmentId);
      if (!blob) throw new Error('This file is missing from the vault storage on this device.');
      const bytes = await decryptAttachment(session, revision.attachmentId, blob);
      try {
        if (!isCurrent()) return;
        const title = `${doc.title} · ${revision.filename}`;
        if (revision.mimeType === 'application/pdf' && hasDocumentVaultNative()) {
          const { handle, pageCount } = await openNativePdf(bytes);
          if (!isCurrent()) {
            void DocumentVaultNative.closePdf({ handle }).catch(() => {});
            return;
          }
          pdfHandles.current.add(handle);
          setViewer({ revisionId: revision.id, title, kind: 'pdf-native', handle, pageCount, page: 0 });
        } else {
          const url = URL.createObjectURL(new Blob([bytes], { type: revision.mimeType }));
          urls.current.add(url);
          setViewer({ revisionId: revision.id, title, kind: revision.mimeType === 'application/pdf' ? 'pdf-web' : 'image', url });
        }
      } finally {
        bytes.fill(0);
      }
    });
  };

  const toggleTitles = (show: boolean) => {
    if (!session) return;
    void run(async (isCurrent) => {
      const index = setShowReminderTitles(session.index, show);
      if (await commit(session, index, isCurrent) && isCurrent()) {
        setNotice(show ? 'Reminders will now name the document.' : 'Reminders are generic again; titles were removed from the unencrypted schedule.');
      }
    });
  };

  const exportBackup = () => {
    void run(async (isCurrent) => {
      const stored = await readDocumentVault();
      if (!stored) throw new Error('There is no document vault to back up.');
      const text = buildDocumentBackup(stored, await readAllBlobs(), new Date().toISOString());
      const filename = `dayflow-documents-${todayString()}.json`;
      if (hasDocumentVaultNative()) {
        beginExternalActivity();
        try {
          const saved = await exportTextNative(text, filename, 'application/json');
          if (saved && mounted.current) setNotice('Encrypted backup saved. It opens only with the vault passphrase.');
        } finally {
          endExternalActivity();
        }
      } else {
        downloadTextFile(text, filename);
        if (isCurrent()) setNotice('Encrypted backup downloaded. It opens only with the vault passphrase.');
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

  const filePicker = (file: File | null) => (
    <div className="space-y-1">
      <Button type="button" variant="secondary" disabled={busy} onClick={() => openPicker('draft')}>
        <Upload className="size-4" /> {file ? 'Choose a different file' : 'Choose file'}
      </Button>
      {file && <p className="text-sm text-slate-700 dark:text-slate-200 break-all">{file.name} · {formatFileSize(file.size)}</p>}
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

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-white"><FileLock2 className="size-5" /> Document Vault</h2>
      {session && (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" aria-label="Vault settings" onClick={() => { releaseViewer(); setView({ kind: 'settings' }); }}><Settings2 className="size-4" /></Button>
          <Button size="sm" variant="secondary" onClick={lock}><LockKeyhole className="size-4" /> Lock</Button>
        </div>
      )}
    </div>
  );

  // ------------------------------------------------------------------ locked screens
  if (!session) {
    const passphraseField = (label: string, value: string, set: (value: string) => void) => (
      <label className={labelClass}><span>{label}</span>
        <input className={inputClass} type="password" required maxLength={256} autoComplete="off" value={value} disabled={busy} onChange={(e) => set(e.target.value)} />
      </label>
    );
    return (
      <section className="mx-auto max-w-2xl space-y-4">
        {header}
        {alerts}
        {hiddenInputs}
        {!hasPasswordVault() && <p className="text-xs text-slate-500 dark:text-slate-400">Files are encrypted on this device. Screen-capture protection is only available in the Android app.</p>}
        {pending && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            The vault locked while you were adding a document. {pending.kind !== 'edit' && 'file' in pending && pending.file ? '1 picked file is waiting. ' : ''}Unlock to continue, or{' '}
            <button type="button" className="font-semibold underline" onClick={() => setPending(null)}>discard it</button>.
          </p>
        )}
        <Card className="space-y-4 p-4">
          {envelope === undefined ? (
            error ? <Button variant="secondary" onClick={() => { setError(''); setReload((value) => value + 1); }}><RefreshCw className="size-4" /> Retry</Button> : <p role="status">Loading…</p>
          ) : mode === 'unlock' && envelope === null ? (
            <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
              <p>Keep passports, insurance, warranties and receipts encrypted with their own passphrase. Titles, files and history are encrypted; only reminder dates are stored unencrypted so reminders can fire while the vault is locked.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => { setError(''); setMode('create'); }}>Create vault</Button>
                <Button variant="secondary" disabled={busy} onClick={() => openPicker('restore')}><Upload className="size-4" /> Restore backup</Button>
              </div>
            </div>
          ) : (
            <form className="space-y-3" onSubmit={submitPassphrase} autoComplete="off">
              {mode === 'create' && <p className="text-sm text-slate-700 dark:text-slate-200">Use a unique passphrase of at least {MIN_VAULT_PASSPHRASE} characters. It cannot be recovered: without it the documents and backups cannot be opened.</p>}
              {mode === 'restore' && restoreSource && <p className="text-sm text-slate-700 dark:text-slate-200">Restoring <span className="font-semibold break-all">{restoreSource.name}</span>. Enter the passphrase the vault had when this backup was saved. Every file is checked before anything is replaced.</p>}
              {mode === 'create' ? <>
                {passphraseField('New vault passphrase', newPassphrase, setNewPassphrase)}
                {passphraseField('Repeat passphrase', repeat, setRepeat)}
              </> : passphraseField(mode === 'restore' ? 'Backup passphrase' : 'Vault passphrase', passphrase, setPassphrase)}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>{busy ? 'Working…' : { unlock: 'Unlock', create: 'Create vault', restore: 'Restore backup' }[mode]}</Button>
                {mode !== 'unlock' && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setMode('unlock'); setRestoreSource(null); setError(''); }}>Cancel</Button>}
                {mode === 'unlock' && envelope && <Button type="button" variant="ghost" disabled={busy} onClick={() => openPicker('restore')}>Restore a backup…</Button>}
              </div>
            </form>
          )}
        </Card>
        {reminderNote && <p className="text-xs text-slate-500 dark:text-slate-400">{reminderNote}</p>}
      </section>
    );
  }

  // ------------------------------------------------------------------ unlocked
  const unlockedIndex = session.index;
  const detailDoc = view.kind === 'detail' || view.kind === 'edit' || view.kind === 'renew'
    ? unlockedIndex.documents.find((doc) => doc.id === view.id)
    : undefined;

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      {header}
      {alerts}
      {hiddenInputs}
      {pending && (
        <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p>A document you were adding before the vault locked is waiting{pending.kind !== 'edit' && 'file' in pending && pending.file ? ` (${pending.file.name})` : ''}.</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { setView(pending); setPending(null); }}>Continue</Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Discard</Button>
          </div>
        </div>
      )}

      {viewer && (
        <Card className="space-y-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-white">{viewer.title}</p>
            <Button size="sm" variant="ghost" aria-label="Close document" onClick={releaseViewer}><X className="size-4" /></Button>
          </div>
          <div ref={viewerBox} className="overflow-auto rounded-lg bg-slate-100 dark:bg-slate-800">
            {viewer.kind === 'image' && <img src={viewer.url} alt={viewer.title} className="mx-auto max-h-[70vh] w-auto max-w-full" />}
            {viewer.kind === 'pdf-web' && (
              <>
                <iframe src={viewer.url} title={viewer.title} className="h-[70vh] w-full bg-white" />
                <a href={viewer.url} target="_blank" rel="noreferrer" className="block p-2 text-center text-xs font-semibold text-indigo-600 dark:text-indigo-400">Open in a new tab</a>
              </>
            )}
            {viewer.kind === 'pdf-native' && (pagePng ? <img src={pagePng} alt={`Page ${viewer.page + 1}`} className="w-full bg-white" /> : <p role="status" className="p-6 text-center text-sm">Rendering page…</p>)}
          </div>
          {viewer.kind === 'pdf-native' && viewer.pageCount > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button size="sm" variant="secondary" disabled={viewer.page === 0} onClick={() => setViewer({ ...viewer, page: viewer.page - 1 })}><ChevronLeft className="size-4" /></Button>
              <span className="text-sm">Page {viewer.page + 1} of {viewer.pageCount}</span>
              <Button size="sm" variant="secondary" disabled={viewer.page >= viewer.pageCount - 1} onClick={() => setViewer({ ...viewer, page: viewer.page + 1 })}><ChevronRight className="size-4" /></Button>
            </div>
          )}
        </Card>
      )}

      {view.kind === 'list' && (
        <>
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => { releaseViewer(); setView({ kind: 'add', draft: emptyDraft(assetFilter ? { assetId: assetFilter, action: 'add' } : null), file: null }); }}>
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
          {visible.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-300">{unlockedIndex.documents.length ? 'No matching documents.' : 'The vault is empty. Add your first document.'}</p>}
          {visible.map((doc) => {
            const revision = currentRevision(doc);
            const badge = expiryBadge(revision, today);
            return (
              <button key={doc.id} type="button" onClick={() => { releaseViewer(); setView({ kind: 'detail', id: doc.id }); }}
                className="block w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-700">
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-bold text-slate-900 dark:text-white break-words">{doc.title}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{doc.category}{doc.assetId ? ` · ${assetName(doc.assetId)}` : ''} · {doc.revisions.length} {doc.revisions.length === 1 ? 'version' : 'versions'}</span>
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
            {filePicker(view.file)}
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
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => openRevision(detailDoc, revision)}><Eye className="size-4" /> Open</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setView({ kind: 'renew', id: detailDoc.id, draft: { ...emptyDraft(), expiresOn: '' }, file: null })}><RefreshCw className="size-4" /> Renew</Button>
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
                        {rev.filename} · {formatFileSize(rev.size)}
                      </span>
                      <span className="flex gap-1">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => openRevision(detailDoc, rev)}><Eye className="size-4" /></Button>
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
            {filePicker(view.file)}
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
              What is stored unencrypted on this device: each document's reminder dates and expiry date, under a random key (not the title), so reminders can fire and Today can show a count while the vault is locked. Titles only if the option above is on. Everything else (titles, categories, links, file names, files and versions) is encrypted. The vault never syncs to your account.
            </p>
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">Encrypted backup</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">One file with every document, still encrypted. It restores on a new phone with the vault passphrase. Size: about {formatFileSize(Math.round(usage * 1.37))}.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={exportBackup}><Download className="size-4" /> Save backup</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => openPicker('restore')}><Upload className="size-4" /> Restore backup…</Button>
            </div>
            {restoreSource && mode === 'restore' && (
              <form className="space-y-2" onSubmit={submitPassphrase} autoComplete="off">
                <p className="text-xs text-slate-600 dark:text-slate-300">Restoring {restoreSource.name}. This replaces the vault on this device after you confirm.</p>
                <label className={labelClass}><span>Backup passphrase</span>
                  <input className={inputClass} type="password" required maxLength={256} value={passphrase} disabled={busy} onChange={(e) => setPassphrase(e.target.value)} />
                </label>
                <div className="flex gap-2">
                  <Button size="sm" type="submit" disabled={busy}>Check and restore</Button>
                  <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => { setRestoreSource(null); setMode('unlock'); }}>Cancel</Button>
                </div>
              </form>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{LIMITS_TEXT}. Used: {formatFileSize(usage)}.</p>
          {reminderNote && <p className="text-xs text-slate-500 dark:text-slate-400">{reminderNote}</p>}
          <Button size="sm" variant="ghost" onClick={() => setView({ kind: 'list' })}><ChevronLeft className="size-4" /> All documents</Button>
        </Card>
      )}
    </section>
  );
}
