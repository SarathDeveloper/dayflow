import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Download, Loader2, Maximize2, Printer, Share2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { pushBackHandler } from '../../lib/overlayBack';
import { MAX_RENDER_WIDTH, type PdfPageSource } from '../../services/documentPages';

export type ViewerContent =
  | { kind: 'image'; url: string }
  | { kind: 'pdf'; source: PdfPageSource };

interface DocumentViewerProps {
  title: string;
  subtitle?: string;
  content: ViewerContent;
  busy: boolean;
  /** Shown over the document (errors and notices from save, share, print). */
  message?: { tone: 'error' | 'info'; text: string } | null;
  onClose: () => void;
  onDownload: () => void;
  onShare: () => void;
  onPrint: () => void;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;
/** A4 portrait, used until a page's real size is known. */
const DEFAULT_ASPECT = 297 / 210;
const PAGE_GAP = 12;
const PAD = 16;
/** Pages wider than this on a big screen would be hard to read at a glance. */
const MAX_FIT_WIDTH = 920;
/** Rendered pages kept in memory; the farthest from view are dropped first. */
const MAX_CACHED_PAGES = 12;
const RERENDER_DELAY_MS = 220;

interface Rendered {
  url: string;
  width: number;
  aspect: number;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * Full-screen viewer for a decrypted document: every PDF page in one scroll,
 * zoom with the buttons, pinch, Ctrl + wheel, double-click or + / - / 0 keys.
 * PDF pages are drawn only near the visible area and re-drawn sharper after a zoom.
 * The caller owns the content (object URL / PDF source) and frees it on close.
 */
export default function DocumentViewer({ title, subtitle, content, busy, message, onClose, onDownload, onShare, onPrint }: DocumentViewerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [settledZoom, setSettledZoom] = useState(1);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([0]));
  const [rendered, setRendered] = useState<Map<number, Rendered>>(() => new Map());
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  const anchor = useRef<{ x: number; y: number; from: number } | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const pageCount = content.kind === 'pdf' ? content.source.pageCount : 1;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(3, window.devicePixelRatio || 1);

  // ------------------------------------------------------------ layout
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Page width at zoom 1: fit the width (PDF) or the whole image (contain). */
  const fitWidth = useMemo(() => {
    const available = Math.max(120, viewport.width - PAD * 2);
    if (content.kind === 'pdf') return Math.min(available, MAX_FIT_WIDTH);
    if (!imageSize) return available;
    const availableHeight = Math.max(120, viewport.height - PAD * 2);
    return Math.min(available, imageSize.width, availableHeight * (imageSize.width / imageSize.height));
  }, [content.kind, viewport, imageSize]);

  const pageWidth = Math.round(fitWidth * zoom);

  const aspectOf = useCallback((page: number) => {
    if (content.kind === 'image') return imageSize ? imageSize.height / imageSize.width : 1;
    const known = renderedRef.current.get(page)?.aspect;
    if (known) return known;
    const size = content.source.sizes[page];
    return size ? size.height / size.width : DEFAULT_ASPECT;
  }, [content, imageSize]);

  // ------------------------------------------------------------ zoom
  const zoomTo = useCallback((next: number, focus?: { x: number; y: number }) => {
    const element = scroller.current;
    const from = zoomRef.current;
    const target = clampZoom(next);
    if (!element || Math.abs(target - from) < 0.001) return;
    anchor.current = {
      x: focus?.x ?? element.clientWidth / 2,
      y: focus?.y ?? element.clientHeight / 2,
      from,
    };
    setZoom(target);
  }, []);

  // Keep the point under the fingers / cursor in place while zooming.
  useLayoutEffect(() => {
    const element = scroller.current;
    const pending = anchor.current;
    if (!element || !pending) return;
    anchor.current = null;
    const ratio = zoom / pending.from;
    element.scrollLeft = (element.scrollLeft + pending.x) * ratio - pending.x;
    element.scrollTop = (element.scrollTop + pending.y) * ratio - pending.y;
  }, [zoom]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledZoom(zoom), RERENDER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [zoom]);

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report the same way).
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoomTo(zoomRef.current * Math.exp(-event.deltaY * 0.0025), { x: event.clientX - box.left, y: event.clientY - box.top });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Two-finger pinch. touch-action keeps one-finger panning native and stops the page zooming itself.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let start: { distance: number; zoom: number } | null = null;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onStart = (event: TouchEvent) => {
      if (event.touches.length === 2) start = { distance: distance(event.touches), zoom: zoomRef.current };
    };
    const onMove = (event: TouchEvent) => {
      if (!start || event.touches.length !== 2) return;
      if (event.cancelable) event.preventDefault();
      const box = element.getBoundingClientRect();
      const x = (event.touches[0].clientX + event.touches[1].clientX) / 2 - box.left;
      const y = (event.touches[0].clientY + event.touches[1].clientY) / 2 - box.top;
      zoomTo(start.zoom * (distance(event.touches) / Math.max(1, start.distance)), { x, y });
    };
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) start = null;
    };
    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: false });
    element.addEventListener('touchend', onEnd);
    element.addEventListener('touchcancel', onEnd);
    return () => {
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
      element.removeEventListener('touchcancel', onEnd);
    };
  }, [zoomTo]);

  // ------------------------------------------------------------ open / close behaviour
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus({ preventScroll: true });
    const removeBack = pushBackHandler(() => closeRef.current());
    return () => {
      removeBack();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if ((event.key === '+' || event.key === '=') && !event.ctrlKey) {
      event.preventDefault();
      zoomTo(zoomRef.current * ZOOM_STEP);
    } else if (event.key === '-' && !event.ctrlKey) {
      event.preventDefault();
      zoomTo(zoomRef.current / ZOOM_STEP);
    } else if (event.key === '0') {
      event.preventDefault();
      zoomTo(1);
    } else if (event.key === 'Tab' && root.current) {
      // Keep focus inside the viewer (it is aria-modal).
      const focusable = Array.from(root.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')) as HTMLElement[];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  // ------------------------------------------------------------ which pages are near the view
  useEffect(() => {
    const element = scroller.current;
    if (!element || content.kind !== 'pdf') return;
    const observer = new IntersectionObserver((entries) => {
      setVisible((current) => {
        const next = new Set(current);
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) next.add(page);
          else next.delete(page);
        }
        return next;
      });
    }, { root: element, rootMargin: '800px 0px' });
    for (const page of pageRefs.current) if (page) observer.observe(page);
    return () => observer.disconnect();
  }, [content.kind, pageCount]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element || content.kind !== 'pdf') return;
    const line = element.scrollTop + element.clientHeight / 3;
    let page = 0;
    for (let index = 0; index < pageRefs.current.length; index++) {
      const node = pageRefs.current[index];
      if (node && node.offsetTop <= line) page = index;
    }
    setCurrentPage(page);
  };

  // ------------------------------------------------------------ rendering PDF pages
  const targetPixels = Math.min(MAX_RENDER_WIDTH, Math.round(fitWidth * settledZoom * dpr));

  // One worker renders pages one at a time (the native renderer is single-threaded),
  // always picking the visible page closest to the current one that needs drawing.
  const work = useRef({ running: false, alive: true });
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const wantRef = useRef({ visible, currentPage, targetPixels, ready: false });
  wantRef.current = { visible, currentPage, targetPixels, ready: viewport.width > 0 };

  const pump = useCallback(async () => {
    if (content.kind !== 'pdf' || work.current.running) return;
    const source = content.source;
    work.current.running = true;
    try {
      while (work.current.alive) {
        const want = wantRef.current;
        if (!want.ready) break;
        const page = [...want.visible]
          .sort((a, b) => Math.abs(a - want.currentPage) - Math.abs(b - want.currentPage))
          .find((candidate) => {
            if (failedRef.current.has(candidate)) return false;
            const have = renderedRef.current.get(candidate);
            return !have || have.width < want.targetPixels * 0.85 || have.width > want.targetPixels * 1.6;
          });
        if (page === undefined) break;
        try {
          const result = await source.render(page, want.targetPixels);
          if (!work.current.alive) {
            URL.revokeObjectURL(result.url);
            break;
          }
          const next = new Map<number, Rendered>(renderedRef.current);
          const old = next.get(page);
          if (old) URL.revokeObjectURL(old.url);
          next.set(page, { url: result.url, width: result.width, aspect: result.height / result.width });
          // Drop the pages farthest from the view.
          const far = (Array.from(next.keys()) as number[])
            .filter((candidate) => !wantRef.current.visible.has(candidate))
            .sort((a, b) => Math.abs(b - wantRef.current.currentPage) - Math.abs(a - wantRef.current.currentPage));
          while (next.size > MAX_CACHED_PAGES && far.length) {
            const drop = far.shift()!;
            URL.revokeObjectURL(next.get(drop)!.url);
            next.delete(drop);
          }
          renderedRef.current = next;
          setRendered(next);
        } catch {
          const next = new Set(failedRef.current).add(page);
          failedRef.current = next;
          setFailed(next);
        }
      }
    } finally {
      work.current.running = false;
    }
  }, [content]);

  useEffect(() => {
    void pump();
  }, [pump, visible, currentPage, targetPixels, viewport.width]);

  // Stop the worker and revoke every rendered page when the viewer closes.
  useEffect(() => {
    const state = work.current;
    state.alive = true;
    return () => {
      state.alive = false;
      for (const item of renderedRef.current.values()) URL.revokeObjectURL(item.url);
      renderedRef.current = new Map();
    };
  }, []);

  // ------------------------------------------------------------ render
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const toolButton = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-200 hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} viewer`}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[60] flex flex-col bg-slate-950 text-white"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/10 bg-slate-900/95 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 sm:px-3">
        <button ref={closeButton} type="button" onClick={onClose} aria-label="Close viewer" className={toolButton}>
          <X className="size-5" />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-xs text-slate-400">
            {subtitle}{subtitle && content.kind === 'pdf' ? ' · ' : ''}
            {content.kind === 'pdf' && `Page ${currentPage + 1} of ${pageCount}`}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => zoomTo(zoom / ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out" className={toolButton}>
            <ZoomOut className="size-5" />
          </button>
          <button type="button" onClick={() => zoomTo(1)} aria-label={`Zoom ${zoomLabel}, fit to screen`} title="Fit to screen" className={`${toolButton} px-2 text-xs font-semibold tabular-nums`}>
            {Math.abs(zoom - 1) < 0.01 ? <Maximize2 className="size-4" /> : zoomLabel}
          </button>
          <button type="button" onClick={() => zoomTo(zoom * ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" className={toolButton}>
            <ZoomIn className="size-5" />
          </button>
          <span className="mx-1 h-6 w-px bg-white/15" aria-hidden="true" />
          <button type="button" onClick={onDownload} disabled={busy} aria-label="Download a copy" title="Download a copy" className={toolButton}>
            <Download className="size-5" />
          </button>
          <button type="button" onClick={onShare} disabled={busy} aria-label="Share" title="Share" className={toolButton}>
            <Share2 className="size-5" />
          </button>
          <button type="button" onClick={onPrint} disabled={busy} aria-label="Print" title="Print" className={toolButton}>
            <Printer className="size-5" />
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        tabIndex={0}
        aria-label="Document"
        onScroll={onScroll}
        onDoubleClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          zoomTo(zoom > 1.05 ? 1 : 2, { x: event.clientX - box.left, y: event.clientY - box.top });
        }}
        className="relative flex-1 overflow-auto overscroll-contain outline-none"
        style={{ touchAction: 'pan-x pan-y' }}
      >
        <div
          className="mx-auto flex flex-col items-center"
          style={{ padding: PAD, gap: PAGE_GAP, width: Math.max(viewport.width, pageWidth + PAD * 2) }}
        >
          {content.kind === 'image' ? (
            <img
              src={content.url}
              alt={title}
              draggable={false}
              onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 })}
              className="block select-none bg-white shadow-xl"
              style={{ width: pageWidth, height: Math.round(pageWidth * aspectOf(0)), maxWidth: 'none' }}
            />
          ) : (
            Array.from({ length: pageCount }, (_, page) => {
              const item = rendered.get(page);
              const height = Math.round(pageWidth * aspectOf(page));
              return (
                <div
                  key={page}
                  ref={(node) => { pageRefs.current[page] = node; }}
                  data-page={page}
                  className="relative shrink-0 bg-white shadow-xl"
                  style={{ width: pageWidth, height }}
                >
                  {item ? (
                    <img src={item.url} alt={`Page ${page + 1}`} draggable={false} className="block size-full select-none" />
                  ) : failed.has(page) ? (
                    <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-slate-600">Could not show page {page + 1}.</p>
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center text-slate-400" role="status" aria-label={`Loading page ${page + 1}`}>
                      <Loader2 className="size-6 animate-spin" />
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`pointer-events-none absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] mx-auto max-w-lg rounded-xl px-4 py-3 text-sm shadow-xl ${
            message.tone === 'error' ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-100'
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
