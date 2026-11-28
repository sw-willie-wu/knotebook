import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { BLOCK_ANCHOR_RE, TOP_SECTION_ID } from "@knotebook/shared";
import type { BlockAnchorApi } from "./block-anchor-context";
import { findMatchBlock, topUnits } from "./block-find";
import { onSearchMarkClear, watchSearchEscape } from "./search-mark";
import { scrollToTopOf, visibleHeightOf } from "@/lib/page-scroll";

// Search text travels in router state, not the URL, so copied links stay clean. history.state survives a reload,
// so a reload jumps again (as `#b-` scrolls again).
export const FIND_STATE_KEY = "kbFind";
export function findTextFromState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const v = (state as Record<string, unknown>)[FIND_STATE_KEY];
  return typeof v === "string" && v !== "" ? v : null;
}

export const ANCHOR_WAIT_MS = 2_000;
export const ANCHOR_FLASH_MS = 2_000;
/** Overlay class (animation in index.css) and attribute (value = block id; e2e locates the overlay by it). */
export const ANCHOR_FLASH_CLASS = "kn-anchor-flash";
export const ANCHOR_FLASH_ATTR = "data-anchor-flash";
/** Persistent mark for search jumps: the same overlay plus this class (animation flashes twice, then stays lit; index.css). */
export const ANCHOR_MARK_CLASS = "kn-anchor-mark";
/** Until scrolling settles; otherwise the flash animation would finish mid-scroll. */
export const ANCHOR_PENDING_CLASS = "kn-anchor-pending";
/** Stop waiting for scroll to settle after this and flash anyway, so the mark always appears. */
export const ANCHOR_SETTLE_MAX_MS = 1_000;

export function blockIdFromHash(hash: string): string | null {
  if (!hash.startsWith("#b-")) return null;
  const id = hash.slice(3);
  return BLOCK_ANCHOR_RE.test(id) ? id : null;
}

// Outside ProseMirror's DOM: in an editable editor any foreign attribute change on .bn-block-outer makes PM
// re-render and replace the element. Inside the scroller, so it scrolls with the content.
function overlayHost(root: HTMLElement, el: HTMLElement): HTMLElement {
  let node = (el.closest(".ProseMirror") ?? el).parentElement;
  while (node && node !== root && root.contains(node)) {
    if (getComputedStyle(node).position !== "static") return node;
    node = node.parentElement;
  }
  return root;
}

/** Measures from the overlay's own origin at (0,0), so it doesn't depend on the host being the containing block or on scroll position. */
function placeOverlay(overlay: HTMLElement, el: HTMLElement): void {
  overlay.style.top = "0px";
  overlay.style.left = "0px";
  const origin = overlay.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  overlay.style.top = `${rect.top - origin.top}px`;
  overlay.style.left = `${rect.left - origin.left}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

// Positioned once: a brief misalignment on reflow is acceptable for a flash. The search mark re-positions itself (startMark).
function mountFlashOverlay(root: HTMLElement, el: HTMLElement, blockId: string, pending: boolean): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = pending ? `${ANCHOR_FLASH_CLASS} ${ANCHOR_PENDING_CLASS}` : ANCHOR_FLASH_CLASS;
  overlay.setAttribute(ANCHOR_FLASH_ATTR, blockId);
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "absolute";
  overlayHost(root, el).appendChild(overlay);
  placeOverlay(overlay, el);
  return overlay;
}

function contentLine(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(":scope > .bn-block > .bn-block-content");
}
// Center the block's own line, not the outer: a parent list, open toggle or long code block can be taller than the
// scroller, and centering it would push the first line out. Fall back to `start` if the line itself is too tall.
function scrollPlan(root: HTMLElement, el: HTMLElement, align: ScrollLogicalPosition): { target: HTMLElement; block: ScrollLogicalPosition } {
  if (align !== "center") return { target: el, block: align };
  const line = contentLine(el);
  // On phones the document scrolls, not root, so compare with the visible height.
  const visible = visibleHeightOf(root);
  if (line === null) return { target: el, block: el.getBoundingClientRect().height > visible ? "start" : "center" };
  return { target: line, block: line.getBoundingClientRect().height > visible ? "start" : "center" };
}

type Resolved = { kind: "block"; el: HTMLElement } | { kind: "top" } | null;

function runScroll(root: HTMLElement, resolve: () => Resolved, align: ScrollLogicalPosition, persist: boolean, scrollOnly = false): () => void {
  let observer: MutationObserver | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let overlay: HTMLElement | null = null;
  let stopMark: (() => void) | null = null;
  const stopWaiting = () => {
    observer?.disconnect();
    observer = null;
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    waitTimer = undefined;
  };
  const removeOverlay = () => {
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashTimer = undefined;
    stopMark?.();
    stopMark = null;
    overlay?.remove();
    overlay = null;
  };
  // PM re-renders replace the block element (see overlayHost), so the mark re-finds it by data-id on mutations and resizes.
  const startMark = (host: HTMLElement, blockId: string) => {
    const ac = new AbortController();
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Flash only once the block's position is stable for two frames, or the animation plays during the scroll.
    // Starting only swaps the class and repositioning only moves the overlay, so the animation never restarts.
    let settleFrame: number | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let settleCap: ReturnType<typeof setTimeout> | undefined;
    const startFlashing = () => {
      if (settleFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(settleFrame);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (settleCap !== undefined) clearTimeout(settleCap);
      settleFrame = settleTimer = settleCap = undefined;
      host.classList.remove(ANCHOR_PENDING_CLASS);
      host.classList.add(ANCHOR_MARK_CLASS);
    };
    const pos = () => {
      const cur = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${blockId}"]`);
      const r = cur?.getBoundingClientRect();
      return r ? `${Math.round(r.top)}:${Math.round(r.left)}` : "";
    };
    let last = pos();
    let same = 0;
    const sample = () => {
      settleFrame = settleTimer = undefined;
      const now = pos();
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 2) {
        startFlashing();
        return;
      }
      if (typeof requestAnimationFrame === "function") settleFrame = requestAnimationFrame(sample);
      else settleTimer = setTimeout(sample, 16);
    };
    if (typeof requestAnimationFrame === "function") settleFrame = requestAnimationFrame(sample);
    else settleTimer = setTimeout(sample, 16);
    settleCap = setTimeout(startFlashing, ANCHOR_SETTLE_MAX_MS);
    const place = () => {
      frame = undefined;
      timer = undefined;
      const cur = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${blockId}"]`);
      if (!cur) {
        cancel();
        return;
      }
      placeOverlay(host, cur);
    };
    const schedule = () => {
      if (frame !== undefined || timer !== undefined) return;
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(place);
      else timer = setTimeout(place, 16);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    ro?.observe(root);
    const editor = root.querySelector(".ProseMirror");
    if (editor) ro?.observe(editor);
    window.addEventListener("resize", schedule, { signal: ac.signal });
    const offEsc = watchSearchEscape(() => cancel());
    stopMark = () => {
      if (settleFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(settleFrame);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (settleCap !== undefined) clearTimeout(settleCap);
      ac.abort();
      offEsc();
      mo.disconnect();
      ro?.disconnect();
      if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  };
  const hit = (target: Resolved) => {
    if (target === null) return;
    stopWaiting();
    if (target.kind === "top") {
      scrollToTopOf(root);
      return;
    }
    const el = target.el;
    const plan = scrollPlan(root, el, align);
    plan.target.scrollIntoView({ block: plan.block });
    if (scrollOnly) return; // search closed while waiting: scroll, but leave no mark
    const blockId = el.getAttribute("data-id") ?? "";
    const mark = persist && blockId !== "";
    overlay = mountFlashOverlay(root, el, blockId, mark);
    if (mark) {
      startMark(overlay, blockId);
      return;
    }
    overlay.addEventListener("animationend", removeOverlay, { once: true });
    flashTimer = setTimeout(removeOverlay, ANCHOR_FLASH_MS);
  };
  // Listen from the start of waiting, so closing search before the block appears doesn't leave a mark later.
  const offBus = persist ? onSearchMarkClear(() => cancel()) : null;
  function cancel() {
    offBus?.();
    stopWaiting();
    removeOverlay();
  }
  const found = resolve();
  if (found) hit(found);
  else {
    observer = new MutationObserver(() => hit(resolve()));
    observer.observe(root, { childList: true, subtree: true });
    waitTimer = setTimeout(stopWaiting, ANCHOR_WAIT_MS);
  }
  return cancel;
}

// Ids already match BLOCK_ANCHOR_RE (no CSS.escape). The timer covers prefers-reduced-motion, where no animationend fires.
// Callers cancel the previous job before requesting another anchor in the same note, so at most one overlay exists.
export function scrollToBlock(root: HTMLElement, blockId: string, findText?: string, scrollOnly = false): () => void {
  const align: ScrollLogicalPosition = findText === undefined ? "start" : "center";
  const persist = findText !== undefined && !scrollOnly;
  const selector = `.bn-block-outer[data-id="${blockId}"]`;
  if (blockId === TOP_SECTION_ID) {
    return runScroll(root, () => {
      if (topUnits(root) === null) return null;
      const m = findText === undefined ? null : findMatchBlock(root, TOP_SECTION_ID, findText);
      return m ? { kind: "block", el: m } : { kind: "top" };
    }, align, persist, scrollOnly);
  }
  return runScroll(root, () => {
    const heading = root.querySelector<HTMLElement>(selector);
    if (!heading) return null;
    const m = findText === undefined ? null : findMatchBlock(root, blockId, findText);
    return { kind: "block", el: m ?? heading };
  }, align, persist, scrollOnly);
}

// Requires this note to have synced: on A → B the first commit still carries A's `synced`.
export function memberAnchorReady(s: { syncedFor: string | null; noteId: string | undefined }): boolean {
  return s.syncedFor !== null && s.noteId !== undefined && s.syncedFor === s.noteId;
}

export interface MemberBlockAnchorOptions {
  noteId: string | undefined;
  /** `synced` is deliberately unused (see the "waits for syncedFor to name this note" test). */
  collab: { synced: boolean; syncedFor: string | null };
  root: HTMLElement | null;
  presenting: boolean;
}

export function useMemberBlockAnchor(opts: MemberBlockAnchorOptions): BlockAnchorApi {
  return useBlockAnchor({
    noteKey: opts.noteId,
    ready: memberAnchorReady({ syncedFor: opts.collab.syncedFor, noteId: opts.noteId }),
    root: opts.root,
    ignoreInitialAnchor: opts.presenting,
    currentNoteId: opts.noteId ?? null,
  });
}

export interface UseBlockAnchorOptions {
  /** Note id (undefined while resolving), or the public ref on public pages. */
  noteKey: string | undefined;
  ready: boolean;
  root: HTMLElement | null;
  /** True while presenting (?present): both the `#b-` hash and the search-hit find state from location.state are ignored. */
  ignoreInitialAnchor?: boolean;
  currentNoteId: string | null;
}

// The pending anchor is set only when noteKey changes (from location.hash) or by requestAnchor; other location changes
// don't re-scroll. NotePage isn't remounted per note, so a noteKey change, not mount, is the trigger.
export function useBlockAnchor(opts: UseBlockAnchorOptions): BlockAnchorApi {
  const location = useLocation();
  const hashRef = useRef(location.hash);
  hashRef.current = location.hash;
  const ignoreRef = useRef(opts.ignoreInitialAnchor ?? false);
  ignoreRef.current = opts.ignoreInitialAnchor ?? false;
  const noteKeyRef = useRef(opts.noteKey);
  noteKeyRef.current = opts.noteKey;
  const stateRef = useRef(location.state);
  stateRef.current = location.state;
  const [pending, setPending] = useState<{ noteKey: string; blockId: string; findText?: string } | null>(null);

  const lastKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (opts.noteKey === undefined) return;
    if (lastKeyRef.current === opts.noteKey) return;
    lastKeyRef.current = opts.noteKey;
    const findText = ignoreRef.current ? null : findTextFromState(stateRef.current);
    // A search hit in another note's `_top` section navigates with state but no hash.
    const id = ignoreRef.current ? null : (blockIdFromHash(hashRef.current) ?? (findText === null ? null : TOP_SECTION_ID));
    setPending(id === null ? null : { noteKey: opts.noteKey, blockId: id, ...(findText === null ? {} : { findText }) });
  }, [opts.noteKey]);

  // Separate slots, so wikilink or `#b-` clicks inside the note don't clear the search mark.
  const jobRef = useRef<(() => void) | null>(null);
  const markRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      jobRef.current?.();
      markRef.current?.();
    },
    [],
  );
  // NotePage isn't remounted per note, so clear the mark here when leaving it.
  useEffect(
    () => () => {
      markRef.current?.();
      markRef.current = null;
    },
    [opts.noteKey],
  );
  // No mark exists while waiting for sync; remember a close or Esc and scroll without a mark later.
  const abandonedRef = useRef(false);
  useEffect(() => {
    if (pending === null || pending.findText === undefined) return;
    abandonedRef.current = false;
    const abandon = () => {
      abandonedRef.current = true;
    };
    const offBus = onSearchMarkClear(abandon);
    const offEsc = watchSearchEscape(abandon);
    return () => {
      offBus();
      offEsc();
    };
  }, [pending]);
  useEffect(() => {
    if (pending === null || opts.noteKey === undefined || pending.noteKey !== opts.noteKey || !opts.ready || opts.root === null) return;
    if (pending.findText === undefined) {
      jobRef.current?.();
      jobRef.current = scrollToBlock(opts.root, pending.blockId);
    } else {
      // Another search result: drop the old mark and place a new one.
      markRef.current?.();
      markRef.current = scrollToBlock(opts.root, pending.blockId, pending.findText, abandonedRef.current);
      abandonedRef.current = false;
    }
    setPending(null);
  }, [pending, opts.noteKey, opts.ready, opts.root]);

  const requestAnchor = useCallback((blockId: string, findText?: string) => {
    const key = noteKeyRef.current;
    if (key === undefined || !BLOCK_ANCHOR_RE.test(blockId)) return;
    setPending({ noteKey: key, blockId, ...(findText === undefined || findText === "" ? {} : { findText }) });
  }, []);

  const rootRef = useRef(opts.root);
  rootRef.current = opts.root;
  const scrollToTop = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    scrollToTopOf(root);
  }, []);

  return useMemo(() => ({ currentNoteId: opts.currentNoteId, requestAnchor, scrollToTop }), [opts.currentNoteId, requestAnchor, scrollToTop]);
}
