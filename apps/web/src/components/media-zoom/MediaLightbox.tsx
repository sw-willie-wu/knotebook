import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { hideOthers } from "aria-hidden";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import { X } from "@/components/ui/icons";
import { nextMermaidId, rewriteMermaidId } from "@/lib/mermaid";
import type { ZoomSource } from "./context";
import { ZoomSkeleton } from "./LightboxFallback";
import { lockRootScroll } from "./root-scroll-lock";
import { fitView, panBy, toggleZoom, wheelFactor, zoomAt, type Point, type Size, type ZoomView } from "./zoom-math";

/** Zoom factor per `+`/`-` press. */
const KEY_ZOOM_STEP = 1.2;
const KEY_PAN_STEP = 40;
const KEY_PAN_STEP_SHIFT = 200;
/** Max total movement (px) from press to release that still counts as a tap rather than a drag. */
const TAP_SLOP = 4;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 24;
/** Keys that scroll the page behind (the arrows have another use, see `ARROW_PAN`). */
const PAGE_SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", " "]);
/** Keys that scroll the page behind with Ctrl/⌘. */
const MODIFIED_PAGE_SCROLL_KEYS = new Set(["Home", "End", "ArrowUp", "ArrowDown"]);
/** Keys that scroll the page behind with Alt/Option (page turning on macOS/iPadOS); Alt+Left/Right is browser history, so it is not listed. */
const ALT_PAGE_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown"]);

/** Arrow = the direction you want to look: Right means see further right, so the content moves left. */
const ARROW_PAN: Record<string, Point> = {
  ArrowRight: { x: -1, y: 0 },
  ArrowLeft: { x: 1, y: 0 },
  ArrowDown: { x: 0, y: -1 },
  ArrowUp: { x: 0, y: 1 },
};

interface Geometry {
  viewport: Size;
  view: ZoomView;
}

interface Gesture {
  start: Point;
  /** Total movement in this gesture (any finger). */
  travel: number;
  /** A second finger went down during it: a pinch, not a tap. */
  multi: boolean;
  /** Pressed on the content (image/diagram). Needed because the pointer is captured on the viewport element, so the release target no longer shows what was pressed. */
  onContent: boolean;
}

function finite(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function positiveSize(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Replaces the SVG root id (mermaid prefixes its styles and markers with it) so the zoomed copy doesn't share ids with the
 * diagram on the page. Without a root id the SVG is used as is.
 */
function withFreshRootId(svg: string): string {
  // First `<svg>` tag only: without a root id, an inner svg's id must not be rewritten.
  const rootTag = /<svg\b[^>]*>/.exec(svg)?.[0];
  const id = rootTag === undefined ? undefined : /\sid="([^"]+)"/.exec(rootTag)?.[1];
  return id === undefined ? svg : rewriteMermaidId(svg, id, nextMermaidId());
}

/**
 * Fullscreen zoom for images and mermaid diagrams (#462). Loaded only through `lightbox-chunk.ts`'s dynamic `import()`
 * (shared by `MediaZoomProvider`'s `lazy()` and the prefetch).
 * Zooms via width/height rather than `transform: scale()`, which scales a raster snapshot and blurs SVG; only panning uses `translate`.
 */
export function MediaLightbox({
  source,
  onClose,
  restoreFocus,
}: {
  source: ZoomSource;
  onClose: () => void;
  restoreFocus: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const natural = useMemo<Size>(
    () => ({ width: source.naturalWidth, height: source.naturalHeight }),
    [source.naturalWidth, source.naturalHeight],
  );
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  // Images replace the gray placeholder only once loaded and decoded (inline SVG needn't wait).
  const [imageReady, setImageReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const markImageReady = useCallback((img: HTMLImageElement) => {
    const decoding = typeof img.decode === "function" ? img.decode() : undefined;
    if (decoding === undefined) setImageReady(true);
    else void decoding.then(
      () => setImageReady(true),
      () => setImageReady(true),
    );
  }, []);
  const setContent = useCallback(
    (el: HTMLElement | null) => {
      contentRef.current = el;
      // Already cached (same URL as the image on the page): ready at once, not even one frame of placeholder.
      if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) setImageReady(true);
    },
    [],
  );
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  /** Touch/pen tap on the backdrop: close on the following `click`, see `handlePointerUp`. */
  const closeOnClick = useRef(false);

  // The string is the page's own mermaid output; the safeguards for injecting it are in `lib/mermaid.ts`.
  const svgMarkup = useMemo(() => (source.kind === "svg" ? withFreshRootId(source.svg) : ""), [source]);
  // Stable object: a fresh one per render makes React reset innerHTML, replacing the pressed svg node (focus drops to body)
  // and reparsing the whole diagram every drag frame.
  const svgHtml = useMemo(() => ({ __html: svgMarkup }), [svgMarkup]);

  // No content renders until the viewport is measured. On a size change (phone rotation, window resize) the view resets to
  // fit the new size.
  useLayoutEffect(() => {
    if (viewportNode === null || !positiveSize(natural)) return;
    const measure = (force: boolean) => {
      const viewport = { width: viewportNode.clientWidth, height: viewportNode.clientHeight };
      if (!positiveSize(viewport)) return;
      setGeo(g =>
        !force && g !== null && g.viewport.width === viewport.width && g.viewport.height === viewport.height
          ? g
          : { viewport, view: fitView(natural, viewport) },
      );
    };
    measure(true);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(viewportNode);
    return () => observer.disconnect();
  }, [viewportNode, natural]);

  // Native listener: the wheel must preventDefault (not scroll the page behind) and React's onWheel is passive.
  useEffect(() => {
    if (viewportNode === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewportNode.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const { deltaY, deltaMode, ctrlKey } = event;
      if (!finite(anchor)) return;
      setGeo(g => {
        if (g === null) return g;
        const next = g.view.scale * wheelFactor(deltaY, deltaMode, ctrlKey, g.viewport.height);
        if (!(Number.isFinite(next) && next > 0)) return g;
        return { ...g, view: zoomAt(g.view, next, anchor, natural, g.viewport) };
      });
    };
    viewportNode.addEventListener("wheel", onWheel, { passive: false });
    return () => viewportNode.removeEventListener("wheel", onWheel);
  }, [viewportNode, natural]);

  // Hide the page behind from assistive technology (as Radix's modal mode does with `hideOthers`).
  useEffect(() => (contentNode === null ? undefined : hideOthers(contentNode)), [contentNode]);

  // Layout effect: lock before first paint so the scrollbar doesn't flash.
  useLayoutEffect(() => lockRootScroll(), []);

  // Pressing the scrollbar (target `<html>`) must not move focus out; with focus on body the +/-/0/arrow keys stop working.
  useEffect(() => {
    const keepFocus = (event: MouseEvent) => {
      if (event.target === document.documentElement) event.preventDefault();
    };
    document.addEventListener("mousedown", keepFocus);
    return () => document.removeEventListener("mousedown", keepFocus);
  }, []);

  // Wheel outside the viewport (close button, caption bar) must not scroll the page behind either; inside the viewport
  // the listener above handles it (zoom).
  useEffect(() => {
    if (contentNode === null) return;
    const stop = (event: WheelEvent) => event.preventDefault();
    contentNode.addEventListener("wheel", stop, { passive: false });
    return () => contentNode.removeEventListener("wheel", stop);
  }, [contentNode]);

  function local(p: Point): Point {
    const rect = viewportNode?.getBoundingClientRect();
    return rect ? { x: p.x - rect.left, y: p.y - rect.top } : p;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Radix's FocusScope (loop) cycles Tab/Shift+Tab among the focusable elements (the close button and links from mermaid
    // `click … href`), but not Shift+Tab when focus is on the viewport itself (after clicking or dragging the content): the
    // browser would move focus to the page behind and scroll a container there, too late to undo. So send focus to the
    // close button, the last focusable element.
    if (event.key === "Tab" && event.shiftKey && event.target === event.currentTarget) {
      event.preventDefault();
      closeRef.current?.focus();
      return;
    }
    // Ctrl/⌘ + Home, End, Up, Down and Alt + Up, Down would scroll the page behind: block them.
    if (
      ((event.ctrlKey || event.metaKey) && MODIFIED_PAGE_SCROLL_KEYS.has(event.key)) ||
      (event.altKey && ALT_PAGE_SCROLL_KEYS.has(event.key))
    ) {
      event.preventDefault();
      return;
    }
    // Other modifier combos (e.g. Ctrl/⌘ + `+`/`-` page zoom) are left to the browser; Esc goes to Radix.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // The scroll lock covers only `<html>`, and is skipped on touch devices without a scrollbar, so PageUp/PageDown,
    // Home/End and Space (when not on a button) must not scroll the page behind. Space on a button still presses it.
    if (PAGE_SCROLL_KEYS.has(event.key)) {
      if (event.key !== " " || !(event.target instanceof HTMLButtonElement)) event.preventDefault();
      return;
    }
    const arrow = ARROW_PAN[event.key];
    if (arrow !== undefined) {
      event.preventDefault();
      const step = event.shiftKey ? KEY_PAN_STEP_SHIFT : KEY_PAN_STEP;
      setGeo(g => (g === null ? g : { ...g, view: panBy(g.view, arrow.x * step, arrow.y * step, natural, g.viewport) }));
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      setGeo(g => (g === null ? g : { ...g, view: fitView(natural, g.viewport) }));
      return;
    }
    const factor = event.key === "+" || event.key === "=" ? KEY_ZOOM_STEP : event.key === "-" ? 1 / KEY_ZOOM_STEP : 0;
    if (factor === 0) return;
    event.preventDefault();
    setGeo(g => {
      if (g === null) return g;
      const center = { x: g.viewport.width / 2, y: g.viewport.height / 2 };
      return { ...g, view: zoomAt(g.view, g.view.scale * factor, center, natural, g.viewport) };
    });
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    closeOnClick.current = false;
    if (geo === null || event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!finite(point)) return;
    pointers.current.set(event.pointerId, point);
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture can fail (e.g. the pointer already ended); dragging still works.
    }
    if (pointers.current.size === 1) {
      const target = event.target instanceof Node ? event.target : null;
      gesture.current = {
        start: point,
        travel: 0,
        multi: false,
        onContent: target !== null && contentRef.current?.contains(target) === true,
      };
    } else if (gesture.current !== null) {
      gesture.current.multi = true;
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    const current = { x: event.clientX, y: event.clientY };
    if (!finite(current)) return;
    if (gesture.current !== null) gesture.current.travel += distance(previous, current);

    if (pointers.current.size === 1) {
      pointers.current.set(event.pointerId, current);
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      setGeo(g => (g === null ? g : { ...g, view: panBy(g.view, dx, dy, natural, g.viewport) }));
      return;
    }

    // Two fingers: zoom by midpoint and distance ratio, the content under the old midpoint follows to the new one. Further
    // fingers are ignored.
    const [idA, idB] = [...pointers.current.keys()] as [number, number];
    if (event.pointerId !== idA && event.pointerId !== idB) {
      pointers.current.set(event.pointerId, current);
      return;
    }
    const a = pointers.current.get(idA)!;
    const b = pointers.current.get(idB)!;
    const nextA = event.pointerId === idA ? current : a;
    const nextB = event.pointerId === idB ? current : b;
    pointers.current.set(event.pointerId, current);
    const before = distance(a, b);
    const after = distance(nextA, nextB);
    if (!(before > 0 && after > 0)) return;
    const ratio = after / before;
    const oldMid = local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const newMid = local({ x: (nextA.x + nextB.x) / 2, y: (nextA.y + nextB.y) / 2 });
    setGeo(g => {
      if (g === null) return g;
      const next = g.view.scale * ratio;
      if (!(Number.isFinite(next) && next > 0)) return g;
      const zoomed = zoomAt(g.view, next, oldMid, natural, g.viewport);
      return { ...g, view: panBy(zoomed, newMid.x - oldMid.x, newMid.y - oldMid.y, natural, g.viewport) };
    });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) setDragging(false);
    const g = gesture.current;
    const end = { x: event.clientX, y: event.clientY };
    if (g !== null && finite(end)) g.travel += distance(previous, end);
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (g === null || g.multi || g.travel > TAP_SLOP) return;

    if (!g.onContent) {
      lastTap.current = null;
      // Touch/pen: the browser sends a click after pointerup; closing now would let it land on the page underneath (ghost
      // click). So close when that click lands on the viewport (as Radix's click-outside does); a mouse closes on release.
      if (event.pointerType === "touch" || event.pointerType === "pen") closeOnClick.current = true;
      else onClose();
      return;
    }
    const now = Date.now();
    const last = lastTap.current;
    if (last !== null && now - last.at <= DOUBLE_TAP_MS && distance(last.point, g.start) <= DOUBLE_TAP_DISTANCE) {
      lastTap.current = null;
      const anchor = local(g.start);
      setGeo(geom => (geom === null ? geom : { ...geom, view: toggleZoom(geom.view, anchor, natural, geom.viewport) }));
      return;
    }
    lastTap.current = { at: now, point: g.start };
  }

  /** Pointer cancelled or capture lost (e.g. a system gesture took over): untrack it, or a leftover pointer makes a later one-finger drag a pinch. */
  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setDragging(false);
    }
  }

  function handleClick(): void {
    if (!closeOnClick.current) return;
    closeOnClick.current = false;
    onClose();
  }

  const title =
    source.kind === "image" ? source.caption || source.alt || t("note.zoom.imageTitle") : t("note.zoom.diagramTitle");
  const caption = source.kind === "image" ? source.caption : "";

  // Pannable only when the content exceeds the viewport on either axis (grab/grabbing cursor). The viewport carries the same
  // cursor because the pointer is captured on it, so backdrop and edges match the content.
  const canPan =
    geo !== null &&
    (natural.width * geo.view.scale > geo.viewport.width + 0.5 || natural.height * geo.view.scale > geo.viewport.height + 0.5);
  const panCursor = canPan ? (dragging ? "grabbing" : "grab") : undefined;

  let content: JSX.Element | null = null;
  if (geo !== null) {
    const { scale, offset } = geo.view;
    const style = {
      width: `${natural.width * scale}px`,
      height: `${natural.height * scale}px`,
      transform: `translate(${offset.x}px, ${offset.y}px)`,
      ...(panCursor !== undefined ? { cursor: panCursor } : {}),
    };
    // Same card surface as in the note (`bg-card`): mermaid's light theme draws dark gray lines and text with no root
    // background, invisible on the translucent black backdrop; for images it only shows through transparent pixels.
    content =
      source.kind === "image" ? (
        <img
          ref={setContent}
          src={source.src}
          alt={source.alt}
          draggable={false}
          className={`absolute left-0 top-0 max-w-none bg-card${imageReady ? "" : " opacity-0"}`}
          style={style}
          onLoad={event => markImageReady(event.currentTarget)}
          onError={() => setImageReady(true)}
        />
      ) : (
        <div
          ref={setContent}
          className="absolute left-0 top-0 rounded-md bg-card p-2 [&>svg]:block [&>svg]:h-full [&>svg]:w-full [&>svg]:max-w-none!"
          style={style}
          dangerouslySetInnerHTML={svgHtml}
        />
      );
  }

  return (
    // Not Radix's modal mode: toggling it changes inherited styles on body (pointer-events, scroll-lock CSS variables) and
    // inserts a stylesheet, restyling every element, so long notes open and close slowly. Its duties are done here instead:
    // `hideOthers` for assistive technology, Tab kept inside, wheel and page keys not scrolling the page behind, `<html>`
    // not scrolling with a mouse or a scrollbar (`lockRootScroll`), and `touch-none` for touch.
    // The overlay covers the viewport minus the scrollbar: the scrollbar strip stays clickable, and presses there are
    // neither "outside" (`onPointerDownOutside`) nor focus-stealing.
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* No fade-in: same opacity as LightboxFallback, so the handover doesn't flash. */}
        <div aria-hidden="true" className="fixed inset-0 z-50 bg-black/80" />
        <DialogPrimitive.Content
          ref={setContentNode}
          aria-modal="true"
          className="fixed inset-0 z-50 touch-none outline-none"
          onKeyDown={handleKeyDown}
          onPointerDownOutside={event => {
            // A press on the scrollbar (or its reserved space) targets `<html>`: not a request to close.
            if (event.detail.originalEvent.target === document.documentElement) event.preventDefault();
          }}
          onFocusOutside={event => {
            // Focus moved to the page behind (e.g. a programmatic focus()): don't close, pull it back to the close button.
            event.preventDefault();
            closeRef.current?.focus();
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{t("note.zoom.hint")}</DialogPrimitive.Description>
          <div
            ref={setViewportNode}
            data-zoom-viewport=""
            className="absolute inset-0 touch-none select-none overflow-hidden"
            style={panCursor !== undefined ? { cursor: panCursor } : undefined}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
            onClick={handleClick}
          >
            {content}
            {content === null || (source.kind === "image" && !imageReady) ? <ZoomSkeleton natural={natural} viewport={geo?.viewport} /> : null}
          </div>
          {caption && (
            <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/50 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-sm text-white">
              {caption}
            </p>
          )}
          <DialogPrimitive.Close
            ref={closeRef}
            aria-label={t("note.zoom.close")}
            className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] rounded-full bg-black/50 p-2 text-white/90 transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5 pointer-coarse:after:content-['']"
          >
            <X className="h-5 w-5" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
