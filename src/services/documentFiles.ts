/**
 * Getting one decrypted document out of the vault: save a copy, share, print.
 * The Android app hands the bytes to DocumentVaultPlugin (system save screen,
 * share sheet, print dialog). The website uses a download, the Web Share API
 * and the browser's print dialog.
 *
 * Every result is an UNENCRYPTED copy; the caller warns the user first.
 */
import type { DocumentMime } from '../lib/documentVault';
import { hasDocumentVaultNative, sendFileNative } from './documentVaultNative';
import { openWebPdfPages, renderAllPages } from './documentPages';

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

/** Width pages are rendered at for printing on the website (about 180 dpi on A4). */
const PRINT_RENDER_WIDTH = 1500;
const MAX_PRINT_PAGES = 100;
/** Fallback for removing the print frame when the browser never reports `afterprint`. */
const PRINT_CLEANUP_MS = 10 * 60_000;

function toBlob(bytes: Uint8Array, mimeType: DocumentMime): Blob {
  return new Blob([bytes.slice()], { type: mimeType });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before the URL goes away.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Saves a copy. Resolves false when the user cancelled the save screen (Android). */
export async function saveDocumentCopy(bytes: Uint8Array, filename: string, mimeType: DocumentMime): Promise<boolean> {
  if (hasDocumentVaultNative()) return sendFileNative(bytes, { kind: 'save', filename, mimeType });
  downloadBlob(toBlob(bytes, mimeType), filename);
  return true;
}

/** Shares through the system share sheet; on browsers without file sharing it downloads instead. */
export async function shareDocument(bytes: Uint8Array, filename: string, mimeType: DocumentMime, title: string): Promise<ShareOutcome> {
  if (hasDocumentVaultNative()) {
    await sendFileNative(bytes, { kind: 'share', filename, mimeType, title });
    return 'shared';
  }
  const file = new File([bytes.slice()], filename, { type: mimeType });
  if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === 'AbortError') return 'cancelled';
      throw new Error('Sharing failed. Try Download instead.');
    }
  }
  downloadBlob(file, filename);
  return 'downloaded';
}

/** Opens the print dialog for the document. */
export async function printDocument(bytes: Uint8Array, filename: string, mimeType: DocumentMime, title: string): Promise<void> {
  if (hasDocumentVaultNative()) {
    await sendFileNative(bytes, { kind: 'print', mimeType, jobName: filename || title });
    return;
  }
  if (mimeType === 'application/pdf' && navigator.pdfViewerEnabled) {
    // Desktop browsers print the PDF itself (sharp text, every page).
    await printInFrame((frame) => {
      frame.src = URL.createObjectURL(toBlob(bytes, mimeType));
      return [frame.src];
    });
    return;
  }
  let urls: string[];
  if (mimeType === 'application/pdf') {
    const source = await openWebPdfPages(bytes);
    try {
      if (source.pageCount > MAX_PRINT_PAGES) throw new Error(`Only PDFs of up to ${MAX_PRINT_PAGES} pages can be printed here. Download it and print from a PDF app.`);
      urls = await renderAllPages(source, PRINT_RENDER_WIDTH);
    } finally {
      await source.close();
    }
  } else {
    urls = [URL.createObjectURL(toBlob(bytes, mimeType))];
  }
  await printInFrame((frame) => {
    frame.srcdoc = printablePages(urls, title);
    return urls;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** A page per image, fitted to the paper. Only our own object URLs are referenced. */
function printablePages(urls: string[], title: string): string {
  const pages = urls.map((url) => `<div class="page"><img src="${escapeHtml(url)}" alt=""></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    @page { margin: 10mm; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .page { page-break-after: always; break-after: page; display: flex; align-items: center; justify-content: center; height: 100vh; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; }
  </style></head><body>${pages}</body></html>`;
}

/**
 * Loads content into a hidden frame and prints it. `fill` sets the frame's
 * content and returns the object URLs to revoke once printing is over.
 */
function printInFrame(fill: (frame: HTMLIFrameElement) => string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Off-screen rather than hidden: some browsers print a hidden frame blank.
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1000px;border:0';
    let urls: string[] = [];
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.clearTimeout(fallback);
      frame.remove();
      for (const url of urls) URL.revokeObjectURL(url);
    };
    const fallback = window.setTimeout(cleanup, PRINT_CLEANUP_MS);
    frame.addEventListener('load', () => {
      const view = frame.contentWindow;
      if (!view) {
        cleanup();
        reject(new Error('Printing is not available in this browser.'));
        return;
      }
      const images = Array.from(frame.contentDocument?.images ?? []);
      void Promise.all(images.map((image) => (image.complete ? Promise.resolve() : image.decode().catch(() => undefined)))).then(() => {
        try {
          view.addEventListener('afterprint', () => window.setTimeout(cleanup, 1000), { once: true });
          view.focus();
          view.print();
          resolve();
        } catch {
          cleanup();
          reject(new Error('Printing is not available in this browser. Download the document and print it from there.'));
        }
      });
    }, { once: true });
    document.body.appendChild(frame);
    urls = fill(frame);
  });
}
