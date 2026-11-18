/**
 * Page rendering for the document viewer, behind one interface:
 *   - Android app: the native PdfRenderer (DocumentVaultPlugin), which keeps the
 *     decrypted PDF in a private temp file and returns pages as PNG;
 *   - website: pdf.js, loaded only when a PDF is opened, rendering to a canvas.
 * Every rendered page is an object URL the caller revokes (or `close` does).
 */
import { DocumentVaultNative, hasDocumentVaultNative, nativePdfPageSizes, openNativePdf } from './documentVaultNative';

export interface PageSize {
  width: number;
  height: number;
}

export interface PdfPageSource {
  pageCount: number;
  /** Size of each page in points (or null when unknown until rendered). */
  sizes: (PageSize | null)[];
  /** Renders a page `width` pixels wide; resolves to an object URL and the rendered size. */
  render(page: number, width: number): Promise<{ url: string; width: number; height: number }>;
  /** Frees the document (native temp file, pdf.js worker). Safe to call twice. */
  close(): Promise<void>;
}

/** Largest bitmap width asked for; zooming further scales the image instead. */
export const MAX_RENDER_WIDTH = 3000;

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

async function openNative(bytes: Uint8Array): Promise<PdfPageSource> {
  const { handle, pageCount } = await openNativePdf(bytes);
  let closed = false;
  const sizes = (await nativePdfPageSizes(handle)) ?? Array.from({ length: pageCount }, () => null);
  return {
    pageCount,
    sizes: sizes.length === pageCount ? sizes : Array.from({ length: pageCount }, () => null),
    async render(page, width) {
      const result = await DocumentVaultNative.renderPdfPage({ handle, page, width: Math.min(MAX_RENDER_WIDTH, Math.round(width)) });
      return { url: URL.createObjectURL(base64ToBlob(result.png, 'image/png')), width: result.width, height: result.height };
    },
    async close() {
      if (closed) return;
      closed = true;
      await DocumentVaultNative.closePdf({ handle }).catch(() => undefined);
    },
  };
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]).then(([module, worker]) => {
    module.GlobalWorkerOptions.workerSrc = worker.default;
    return module;
  }).catch((error) => {
    pdfjs = null;
    throw error;
  });
  return pdfjs;
}

function pdfJsError(error: unknown): Error {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PasswordException') return new Error('This PDF is password-protected and cannot be shown here. Download it to open it.');
  if (name === 'InvalidPDFException') return new Error('This PDF is damaged or uses a format that cannot be shown.');
  return new Error('Could not open this PDF. Try downloading it instead.');
}

async function openWeb(bytes: Uint8Array): Promise<PdfPageSource> {
  let lib: PdfJs;
  try {
    lib = await loadPdfJs();
  } catch {
    throw new Error('The PDF viewer could not be loaded. Check your connection and try again.');
  }
  // pdf.js takes ownership of the buffer it is given: pass a copy.
  const task = lib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    useSystemFonts: true,
  });
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    void task.destroy();
    throw pdfJsError(error);
  }
  const sizes: (PageSize | null)[] = [];
  for (let index = 1; index <= document.numPages; index++) {
    try {
      const viewport = (await document.getPage(index)).getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
    } catch {
      sizes.push(null);
    }
  }
  let closed = false;
  return {
    pageCount: document.numPages,
    sizes,
    async render(page, width) {
      const pdfPage = await document.getPage(page + 1);
      const base = pdfPage.getViewport({ scale: 1 });
      const target = Math.max(16, Math.min(MAX_RENDER_WIDTH, Math.round(width)));
      const viewport = pdfPage.getViewport({ scale: target / base.width });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      try {
        await pdfPage.render({ canvas, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Could not show this page.');
        return { url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        pdfPage.cleanup();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await document.destroy().catch(() => undefined);
    },
  };
}

/** Opens decrypted PDF bytes for viewing. The caller must `close` the source. */
export function openPdfPages(bytes: Uint8Array): Promise<PdfPageSource> {
  return hasDocumentVaultNative() ? openNative(bytes) : openWeb(bytes);
}

/** Renders every page (for printing on the website) at `width` px; caller revokes the URLs. */
export async function renderAllPages(source: PdfPageSource, width: number): Promise<string[]> {
  const urls: string[] = [];
  try {
    for (let page = 0; page < source.pageCount; page++) urls.push((await source.render(page, width)).url);
    return urls;
  } catch (error) {
    for (const url of urls) URL.revokeObjectURL(url);
    throw error;
  }
}

/** Opens a PDF on the website with pdf.js, regardless of platform (printing). */
export const openWebPdfPages = openWeb;
