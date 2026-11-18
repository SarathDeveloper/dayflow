import { Capacitor, registerPlugin } from '@capacitor/core';
import { isNativeAndroid } from '../lib/platform';

/**
 * Android-only helpers for the Document Vault (DocumentVaultPlugin.java):
 * rendering decrypted PDFs with PdfRenderer, and writing large exports through
 * a Storage Access Framework document in chunks.
 */
export interface DocumentVaultNativePlugin {
  beginPdf(): Promise<{ handle: string }>;
  /** `chunk` is base64, at most 1 MiB once decoded. */
  appendPdf(options: { handle: string; chunk: string }): Promise<void>;
  openPdf(options: { handle: string }): Promise<{ pageCount: number }>;
  /** `page` is 0-based and clamped to the document; `width` is clamped to 16..2000 px. */
  renderPdfPage(options: { handle: string; page: number; width: number }): Promise<{ png: string; width: number; height: number }>;
  /** Every page's size in PDF points (APK 1.2+). */
  pdfPageSizes(options: { handle: string }): Promise<{ sizes: { width: number; height: number }[] }>;
  /** Closing a handle that is already closed succeeds. */
  closePdf(options: { handle: string }): Promise<void>;
  closeAllPdfs(): Promise<void>;
  /** Opens the system "save as" picker. `saved` is false when the user cancelled. */
  beginExport(options: { filename: string; mimeType: string }): Promise<{ saved: boolean; token?: string }>;
  /** `chunk` is text, written as UTF-8. */
  appendExport(options: { token: string; chunk: string }): Promise<void>;
  finishExport(options: { token: string }): Promise<void>;
  /** Closes and deletes the partial document. Aborting an export that already ended succeeds. */
  abortExport(options: { token: string }): Promise<void>;
  // Files out (APK 1.2+): stream one decrypted document, then save, share or print it.
  beginFile(): Promise<{ handle: string }>;
  /** `chunk` is base64, at most 1 MiB once decoded. */
  appendFile(options: { handle: string; chunk: string }): Promise<void>;
  /** System "save as" screen. `saved` is false when the user cancelled. */
  saveFile(options: { handle: string; filename: string; mimeType: string }): Promise<{ saved: boolean }>;
  /** Share sheet. Resolves once it is shown. */
  shareFile(options: { handle: string; filename: string; mimeType: string; title: string }): Promise<void>;
  /** System print dialog. Resolves once it is shown. */
  printFile(options: { handle: string; mimeType: string; jobName: string }): Promise<void>;
  discardFile(options: { handle: string }): Promise<void>;
}

export type NativeFileAction =
  | { kind: 'save'; filename: string; mimeType: string }
  | { kind: 'share'; filename: string; mimeType: string; title: string }
  | { kind: 'print'; mimeType: string; jobName: string };

/** Capacitor rejects with this code when the installed app predates a native method. */
export function isUnimplemented(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'UNIMPLEMENTED';
}

export const UPDATE_APP_MESSAGE = 'Install the latest Dayflow app update to use this.';

export const DocumentVaultNative = registerPlugin<DocumentVaultNativePlugin>('DocumentVault');

/** Same limit as the plugin (and the vault's per-file limit). */
export const NATIVE_PDF_MAX_BYTES = 10 * 1024 * 1024;
/** Bytes per appendPdf call; the plugin accepts up to 1 MiB decoded. */
export const NATIVE_PDF_CHUNK_BYTES = 768 * 1024;
/** UTF-16 code units per appendExport call; the plugin accepts up to 4 Mi characters. */
export const NATIVE_EXPORT_CHUNK_CHARS = 512 * 1024;

export function hasDocumentVaultNative(): boolean {
  return isNativeAndroid() && Capacitor.isPluginAvailable('DocumentVault');
}

/** The plugin rejects with user-facing messages; keep them, and fall back to `fallback` otherwise. */
function userError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return new Error(message && message.trim() ? message : fallback);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/**
 * Splits text into chunks of at most `size` UTF-16 code units without cutting a
 * surrogate pair in half (each chunk is encoded to UTF-8 on its own).
 */
export function splitTextChunks(text: string, size: number = NATIVE_EXPORT_CHUNK_CHARS): string[] {
  if (!Number.isInteger(size) || size < 2) throw new Error('Chunk size must be an integer of at least 2.');
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + size);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

/** Testable core of {@link openNativePdf}. */
export async function openPdfWith(
  plugin: Pick<DocumentVaultNativePlugin, 'beginPdf' | 'appendPdf' | 'openPdf' | 'closePdf'>,
  bytes: Uint8Array,
): Promise<{ handle: string; pageCount: number }> {
  if (bytes.length === 0) throw new Error('This PDF is empty.');
  if (bytes.length > NATIVE_PDF_MAX_BYTES) throw new Error('This PDF is larger than 10 MB and cannot be shown.');
  let handle: string;
  try {
    ({ handle } = await plugin.beginPdf());
  } catch (error) {
    throw userError(error, 'Could not prepare the document on this device.');
  }
  try {
    for (let offset = 0; offset < bytes.length; offset += NATIVE_PDF_CHUNK_BYTES) {
      const chunk = bytesToBase64(bytes.subarray(offset, offset + NATIVE_PDF_CHUNK_BYTES));
      await plugin.appendPdf({ handle, chunk });
    }
    const { pageCount } = await plugin.openPdf({ handle });
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('This PDF has no pages.');
    return { handle, pageCount };
  } catch (error) {
    // Never leave a decrypted temp file behind.
    await plugin.closePdf({ handle }).catch(() => undefined);
    throw userError(error, 'Could not open this PDF.');
  }
}

/**
 * Streams decrypted PDF bytes to the native renderer. The caller owns the
 * returned handle and must `closePdf` it (or `closeAllPdfs`) on close, lock and
 * unmount. On failure the handle is already closed.
 */
export async function openNativePdf(bytes: Uint8Array): Promise<{ handle: string; pageCount: number }> {
  return openPdfWith(DocumentVaultNative, bytes);
}

/**
 * Testable core of {@link sendFileNative}: streams `bytes` to the plugin, then
 * runs `action`. On failure the prepared copy is discarded. Returns false only
 * when the user cancelled a save.
 */
export async function sendFileWith(
  plugin: Pick<DocumentVaultNativePlugin, 'beginFile' | 'appendFile' | 'saveFile' | 'shareFile' | 'printFile' | 'discardFile'>,
  bytes: Uint8Array,
  action: NativeFileAction,
): Promise<boolean> {
  if (bytes.length === 0) throw new Error('This document is empty.');
  if (bytes.length > NATIVE_PDF_MAX_BYTES) throw new Error('This document is larger than 10 MB.');
  let handle: string;
  try {
    ({ handle } = await plugin.beginFile());
  } catch (error) {
    if (isUnimplemented(error)) throw new Error(UPDATE_APP_MESSAGE);
    throw userError(error, 'Could not prepare the document on this device.');
  }
  try {
    for (let offset = 0; offset < bytes.length; offset += NATIVE_PDF_CHUNK_BYTES) {
      await plugin.appendFile({ handle, chunk: bytesToBase64(bytes.subarray(offset, offset + NATIVE_PDF_CHUNK_BYTES)) });
    }
  } catch (error) {
    await plugin.discardFile({ handle }).catch(() => undefined);
    throw userError(error, 'Could not prepare the document on this device.');
  }
  // From here the plugin owns the copy and deletes it, also when the action fails.
  try {
    if (action.kind === 'save') {
      const { saved } = await plugin.saveFile({ handle, filename: action.filename, mimeType: action.mimeType });
      return saved;
    }
    if (action.kind === 'share') {
      await plugin.shareFile({ handle, filename: action.filename, mimeType: action.mimeType, title: action.title });
      return true;
    }
    await plugin.printFile({ handle, mimeType: action.mimeType, jobName: action.jobName });
    return true;
  } catch (error) {
    throw userError(error, action.kind === 'print' ? 'Could not print the document.' : 'Could not hand over the document.');
  }
}

/** Saves, shares or prints one decrypted document through the Android app. */
export async function sendFileNative(bytes: Uint8Array, action: NativeFileAction): Promise<boolean> {
  return sendFileWith(DocumentVaultNative, bytes, action);
}

/** Page sizes in points, or null when the installed app cannot report them. */
export async function nativePdfPageSizes(handle: string): Promise<{ width: number; height: number }[] | null> {
  try {
    const { sizes } = await DocumentVaultNative.pdfPageSizes({ handle });
    return Array.isArray(sizes) && sizes.every((size) => size.width > 0 && size.height > 0) ? sizes : null;
  } catch {
    return null;
  }
}

/** Testable core of {@link exportTextNative}. */
export async function exportTextWith(
  plugin: Pick<DocumentVaultNativePlugin, 'beginExport' | 'appendExport' | 'finishExport' | 'abortExport'>,
  text: string,
  filename: string,
  mimeType: string,
): Promise<boolean> {
  if (!text) throw new Error('There is nothing to export.');
  let begun: { saved: boolean; token?: string };
  try {
    begun = await plugin.beginExport({ filename, mimeType });
  } catch (error) {
    throw userError(error, 'Could not open the file picker on this device.');
  }
  if (!begun.saved) return false;
  const token = begun.token;
  if (!token) throw new Error('Could not write the backup to that location.');
  try {
    for (const chunk of splitTextChunks(text)) {
      await plugin.appendExport({ token, chunk });
    }
    await plugin.finishExport({ token });
    return true;
  } catch (error) {
    // Remove the partial file so a broken backup is never left behind.
    await plugin.abortExport({ token }).catch(() => undefined);
    throw userError(error, 'Could not write the backup. Check the storage location and try again.');
  }
}

/**
 * Saves `text` to a file the user picks (system "save as" dialog), in chunks so
 * large backups fit through the bridge. Returns false if the user cancelled.
 * On failure the partial file is deleted and a user-facing Error is thrown.
 */
export async function exportTextNative(text: string, filename: string, mimeType: string): Promise<boolean> {
  return exportTextWith(DocumentVaultNative, text, filename, mimeType);
}
