import { useEffect, type RefObject } from "react";

/** A table or formula scroller that can still scroll right carries this attribute; the phone's right-edge gradient (`index.css`) shows only while it is present. */
export const TABLE_MORE_RIGHT_ATTR = "data-kb-more-right";

/** Marks the scroller of a math block (set by MathView, matched in `index.css`): formulas get the same phone fade as tables. */
export const MATH_SCROLL_ATTR = "data-kb-math-scroll";

const TABLE_SCROLLER = `.tableWrapper, [${MATH_SCROLL_ATTR}]`;

export function supportsScrollTimeline(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: scroll(self inline)");
}

export function syncTableScrollHint(scroller: HTMLElement): void {
  const more = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1;
  // Do not write when unchanged, so rescans cause no attribute mutations.
  scroller.toggleAttribute(TABLE_MORE_RIGHT_ATTR, more);
}

/**
 * Fallback for browsers without scroll-driven animations. Event delegation on the editor's scroll container: `scroll`
 * does not bubble, so it is caught in the capture phase; rescans on container/content size changes (rotation, table edits,
 * images loading) so unscrolled tables get the hint immediately.
 */
export function useTableScrollHint(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null || supportsScrollTimeline()) return;
    const scrollers = () => root.querySelectorAll<HTMLElement>(TABLE_SCROLLER);
    const syncAll = () => scrollers().forEach(syncTableScrollHint);
    const onScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.matches(TABLE_SCROLLER)) syncTableScrollHint(event.target);
    };
    let frame = 0;
    const scheduleSync = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncAll();
      });
    };
    root.addEventListener("scroll", onScroll, true);
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleSync) : null;
    resize?.observe(root);
    const mutation = typeof MutationObserver === "function" ? new MutationObserver(scheduleSync) : null;
    // Expanding a collapsed block only changes data-show-children (that is when the tables inside get a width); the attribute this code writes is not observed.
    mutation?.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-show-children"] });
    // KaTeX fonts use font-display: block, so formula widths change once they load; no resize or mutation fires for that.
    document.fonts?.addEventListener("loadingdone", scheduleSync);
    syncAll();
    return () => {
      document.fonts?.removeEventListener("loadingdone", scheduleSync);
      root.removeEventListener("scroll", onScroll, true);
      resize?.disconnect();
      mutation?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      scrollers().forEach((scroller) => scroller.removeAttribute(TABLE_MORE_RIGHT_ATTR));
    };
  }, [rootRef, enabled]);
}
