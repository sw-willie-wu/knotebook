import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { ZoomButton } from "./ZoomButton";
import { useMediaZoom } from "./context";
import { prefetchMediaLightbox } from "./lightbox-chunk";
import { selectedImageOf } from "./selected-image";

const IMAGE_SELECTOR = '.bn-block-content[data-content-type="image"] img.bn-visual-media';
/** Images inside a column's diff preview (e.g. an AI suggestion diff) are a read-only preview and get no zoom. */
const IN_DIFF = ".kb-diff";
const INSET = 4;
/** Half the height of the mid-side resize handle. */
const HANDLE_HALF = 15;

type Size = { width: number; height: number };

/**
 * Inside the image's top-right corner, 4px in; when the image is so short that the button would touch the mid-side resize
 * handle, it moves outside above the image (same horizontal position).
 */
export function zoomButtonPlacement(img: DOMRect, container: DOMRect, button: Size): { top: number; left: number } {
  const left = img.right - container.left - button.width - INSET;
  const tooShort = INSET + button.height > img.height / 2 - HANDLE_HALF - INSET;
  // Outside: bottom edge touches the image top so the pointer doesn't leave the image on its way up to the button.
  const top = tooShort ? img.top - container.top - button.height : img.top - container.top + INSET;
  return { top, left };
}

function isLoaded(img: HTMLImageElement): boolean {
  return img.isConnected && img.complete && img.naturalWidth > 0;
}

/**
 * Inside an image's resize frame, or the same image block's content/outer box (the gap between image and button): that
 * image. Inside another block: `null` (collapse). Outside every block (e.g. the zoom button itself): `undefined` (leave unchanged).
 */
function imageUnder(node: EventTarget | null): HTMLImageElement | null | undefined {
  const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (!el) return undefined;
  if (el.closest(IN_DIFF)) return undefined;
  const wrapper = el.closest(".bn-visual-media-wrapper");
  if (wrapper) {
    const img = wrapper.querySelector<HTMLImageElement>("img.bn-visual-media");
    if (img?.matches(IMAGE_SELECTOR)) return img;
  }
  const outer = el.closest(".bn-block-outer");
  if (!outer) return undefined;
  // The button can sit above a short image, so the block's padding (non-nested part) counts as the image.
  const group = el.closest(".bn-block-group");
  if (group && outer.contains(group)) return null;
  const own = outer.querySelector<HTMLImageElement>(`:scope > .bn-block > ${IMAGE_SELECTOR}`);
  return own ?? null;
}

function zoomSizeOf(img: HTMLImageElement): { naturalWidth: number; naturalHeight: number } {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const rect = img.getBoundingClientRect();
  // Zoom scale 1 must never be smaller than what the note already shows: a viewBox-only SVG reports a small default
  // naturalWidth (~267-300px) while filling the column, and a raster image can be stretched past its pixels.
  if (rect.width > 0 && rect.height > 0 && (rect.width > nw || rect.height > nh)) {
    const scale = Math.max(rect.width / nw, rect.height / nh);
    return { naturalWidth: nw * scale, naturalHeight: nh * scale };
  }
  return { naturalWidth: nw, naturalHeight: nh };
}

function sourceOf(img: HTMLImageElement) {
  const caption = img.closest(".bn-block-content")?.querySelector("figcaption.bn-file-caption")?.textContent ?? "";
  const { naturalWidth, naturalHeight } = zoomSizeOf(img);
  return {
    kind: "image" as const,
    src: img.currentSrc || img.src,
    alt: img.alt,
    caption,
    naturalWidth,
    naturalHeight,
  };
}

/**
 * Floating zoom button for BlockNote image blocks (#462), positioned on the column's `relative` wrapper (`container`).
 * Shown on mouse hover (touch pointers don't count) and when the block is NodeSelected. While zoom is open or the button
 * has focus, pointer/selection changes don't collapse it, so focus can return to the button on close.
 */
export function ImageZoomLayer({
  container,
  editable,
  editor,
}: {
  container: HTMLElement | null;
  editable: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; repo convention
  editor?: BlockNoteEditor<any, any, any>;
}): JSX.Element | null {
  const zoom = useMediaZoom();
  const active = zoom !== null;
  const [hover, setHover] = useState<HTMLImageElement | null>(null);
  const [selected, setSelected] = useState<HTMLImageElement | null>(null);
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((n) => n + 1), []);
  const layerRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Zoom is open, or just closed and focus hasn't returned to the button yet.
  const frozenRef = useRef(false);
  const isOpenNow = zoom?.isOpen === true;
  // Where the pointer actually is; the shown hover is frozen while zoom is open or the button has focus, then catches up to this.
  const pointerImgRef = useRef<HTMLImageElement | null>(null);
  // Image currently showing the button (null if none): content changes need a remeasure only while the button is shown.
  const shownRef = useRef<HTMLImageElement | null>(null);
  const buttonFocused = () => {
    const layer = layerRef.current;
    return layer !== null && layer.contains(document.activeElement);
  };
  const { t } = useTranslation();
  const zoomLabel = t("note.zoom.open");

  // Radix returns focus to the button one task after zoom closes (`onCloseAutoFocus`); a pointerover onto another block in
  // that gap would remove the button first and focus couldn't return to it. So stay frozen one more task, then catch up
  // with the pointer. This timeout always runs after Radix's: Radix schedules its timeout in the FocusScope unmount
  // cleanup, and React runs all unmount cleanups of a commit before new passive effects (this one).
  useEffect(() => {
    if (isOpenNow) {
      frozenRef.current = true;
      return;
    }
    if (!frozenRef.current) return;
    const timer = setTimeout(() => {
      frozenRef.current = false;
      if (!buttonFocused()) setHover(pointerImgRef.current);
    }, 0);
    return () => {
      clearTimeout(timer);
      frozenRef.current = false;
    };
  }, [isOpenNow]);

  useEffect(() => {
    if (!container || !active) return;
    const isOpen = () => zoomRef.current?.isOpen === true || frozenRef.current;
    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const found = imageUnder(e.target);
      if (found === undefined) return;
      pointerImgRef.current = found;
      if (found !== null) prefetchMediaLightbox(); // load the zoom chunk before the click
      // Zoom open: fully frozen. Button focused: only collapsing is blocked; switching to another image is allowed.
      if (isOpen() || (found === null && buttonFocused())) return;
      setHover(found);
      bump(); // ResizeObserver is silent when the same image is merely pushed (column divider, block move): remeasure on enter
    };
    const onPointerLeave = () => {
      pointerImgRef.current = null;
      if (!isOpen() && !buttonFocused()) setHover(null);
    };
    // Recompute on image load (or load error): a hovered image that just loaded needs its button.
    const onMediaEvent = (e: Event) => {
      if (e.target instanceof HTMLImageElement) bump();
    };
    container.addEventListener("pointerover", onPointerOver);
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("load", onMediaEvent, true);
    container.addEventListener("error", onMediaEvent, true);
    return () => {
      container.removeEventListener("pointerover", onPointerOver);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("load", onMediaEvent, true);
      container.removeEventListener("error", onMediaEvent, true);
    };
  }, [container, active, bump]);

  useEffect(() => {
    if (!editable || !editor || !active) return;
    const update = () => {
      if (zoomRef.current?.isOpen) return;
      setSelected(selectedImageOf(editor.prosemirrorView));
    };
    update();
    // Block moves and column divider drags don't resize the image, so ResizeObserver stays silent: while the button is
    // shown, remeasure on any content change (at most once per frame).
    let frame = 0;
    const onChange = () => {
      if (frame || shownRef.current === null) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        bump();
      });
    };
    const offSelection = editor.onSelectionChange(update);
    const offChange = editor.onChange(onChange);
    return () => {
      offSelection?.();
      offChange?.();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editable, editor, active, bump]);

  // Read-only: the image itself is focusable and clickable. The MutationObserver marks images inserted later (or replaced by
  // a re-render).
  useEffect(() => {
    if (!container || !active || editable) return;
    const mark = () => {
      container.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR).forEach((img) => {
        if (img.closest(IN_DIFF)) return;
        img.setAttribute("tabindex", "0");
        img.setAttribute("data-kb-zoomable", "");
        // Keyboard and screen reader users need to know the image opens a zoom view.
        img.setAttribute("aria-label", img.alt ? `${img.alt}, ${zoomLabel}` : zoomLabel);
      });
    };
    const open = (img: HTMLImageElement) => {
      if (!isLoaded(img)) return;
      zoomRef.current?.open(sourceOf(img), { button: null, media: img });
    };
    const imageOf = (e: Event): HTMLImageElement | null => {
      const found = e.target instanceof Element ? e.target.closest<HTMLImageElement>(IMAGE_SELECTOR) : null;
      return found && !found.closest(IN_DIFF) ? found : null;
    };
    const onClick = (e: MouseEvent) => {
      const img = imageOf(e);
      if (!img || (e.target as Element).closest("a") !== null) return;
      // A click also fires after drag-selecting text: don't open then.
      if (window.getSelection()?.isCollapsed === false) return;
      open(img);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const img = imageOf(e);
      if (!img || e.target !== img) return;
      e.preventDefault(); // Space must not scroll the page
      open(img);
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(container, { childList: true, subtree: true });
    container.addEventListener("click", onClick);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
      container.querySelectorAll<HTMLElement>("[data-kb-zoomable]").forEach((img) => {
        img.removeAttribute("tabindex");
        img.removeAttribute("data-kb-zoomable");
        img.removeAttribute("aria-label");
      });
    };
  }, [container, active, editable, zoomLabel]);

  const target = hover ?? selected;
  const shown = active && container !== null && target !== null && isLoaded(target) ? target : null;
  shownRef.current = shown;

  // Recompute on layout changes (column width, image resize, window resize) while shown. Coordinates are relative to the
  // column wrapper, which scrolls with the content, so scrolling needs no recompute.
  useEffect(() => {
    if (!container || !shown) return;
    const observer = new ResizeObserver(bump);
    observer.observe(container);
    observer.observe(shown);
    window.addEventListener("resize", bump);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", bump);
    };
  }, [container, shown, bump]);

  // The button size can't be measured before it first renders (treated as 0); measured here in a layout effect and
  // recomputed before paint, so it doesn't flash.
  useLayoutEffect(() => {
    const button = layerRef.current?.querySelector("button");
    if (!button) return;
    const { width, height } = button.getBoundingClientRect();
    if (width === sizeRef.current.width && height === sizeRef.current.height) return;
    sizeRef.current = { width, height };
    bump();
  });

  if (!shown || !container) return null;
  void rev; // bump() re-renders on layout changes so the position below is remeasured
  const style = zoomButtonPlacement(shown.getBoundingClientRect(), container.getBoundingClientRect(), sizeRef.current);
  return (
    <div
      ref={layerRef}
      data-kb-zoom-layer=""
      className="absolute z-10"
      style={style}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (!zoomRef.current?.isOpen) setHover(pointerImgRef.current);
      }}
    >
      <ZoomButton
        // Read-only: keyboard and screen readers use the image itself, so this button is mouse-only.
        {...(editable ? {} : { tabIndex: -1, "aria-hidden": true as const })}
        // Not focusable when read-only, so focus returns to the image after close.
        onClick={(event) => zoom?.open(sourceOf(shown), { button: editable ? event.currentTarget : null, media: shown })}
      />
    </div>
  );
}
