import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { focusCornerBubble } from "@/components/corner-stack-state";
import { useIsOverlay } from "@/lib/layout-tiers";
import { useComments } from "@/lib/comments-context";
import { isOverlayOpen, useVersions } from "@/lib/versions-context";

// `display: contents` node in NoteEditor wrapping the panel (including its load-failure error frame): the error frame has no panel testid, so this is recognised instead.
export const PANEL_SLOT = "[data-versions-panel-slot]";
// The comments panel's slot in the same place. Pressing outside doesn't close it: selecting a passage in the note is part of writing a comment.
export const COMMENTS_PANEL_SLOT = "[data-comments-panel-slot]";
// Panel (with its error frame), the menus and popper it opens (portalled outside the panel), the corner bubbles: pressing inside these doesn't count as "clicking the note area"
// (a bubble switches or closes the panel itself, and the toggle never closes it).
// Dialogs are covered by the "a dialog in document yields" check below.
const KEEP_OPEN = `${PANEL_SLOT}, [data-testid="corner-stack"], [role="menu"], [data-radix-popper-content-wrapper]`;

/**
 * 640–1279 floats the version panel over the note instead of a third column; the fixed segment (>= 1280) never gets these rules.
 * List only (no preview): pressing outside the panel, the corner stack and the menus and dialogs they open closes it, like the sidebar drawer. Diff view (preview open): clicking the note area doesn't close; only the panel's ✕ and Esc inside the panel close.
 * Esc in the panel closes it (and the preview); focus goes to the history bubble, or to the stack's toggle while the stack is collapsed.
 * The panel is non-modal, so a document `pointerdown` (capture) is used, not a backdrop. The returned `onKeyDown` goes on the row container (the panel is under it; React bubbling runs before the window preview-Esc listener).
 */
export function useFloatingPanelDismiss(): { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  const overlay = useIsOverlay();
  const { panelOpen, preview, dialog, close } = useVersions();
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!overlay || !panelOpen || preview !== null || dialog !== null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(KEEP_OPEN) !== null) return;
      // With a modal (including the sidebar drawer) open, clicking its backdrop closes only that modal; the panel stays.
      if (document.querySelector('[role="dialog"]') !== null) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [overlay, panelOpen, preview, dialog, close]);

  useEffect(() => {
    if (panelOpen || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    focusCornerBubble("versions-bubble");
  }, [panelOpen]);

  const comments = useComments();
  const commentsOpen = comments.panelOpen;
  const closeComments = comments.close;
  const restoreCommentsFocusRef = useRef(false);
  useEffect(() => {
    if (commentsOpen || !restoreCommentsFocusRef.current) return;
    restoreCommentsFocusRef.current = false;
    focusCornerBubble("comments-bubble");
  }, [commentsOpen]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!overlay || event.key !== "Escape" || event.defaultPrevented || !(event.target instanceof Element)) return;
      if (commentsOpen && event.target.closest(COMMENTS_PANEL_SLOT) !== null && !isOverlayOpen()) {
        // A draft being typed stays: Esc there would throw it away with the panel.
        if (event.target instanceof HTMLTextAreaElement && event.target.value !== "") return;
        event.preventDefault();
        restoreCommentsFocusRef.current = true;
        closeComments();
        return;
      }
      if (!panelOpen || event.target.closest(PANEL_SLOT) === null || isOverlayOpen()) return;
      event.preventDefault(); // Only closes the panel: the page-level "Esc leaves preview" listener yields on defaultPrevented
      restoreFocusRef.current = true;
      close();
    },
    [overlay, panelOpen, close, commentsOpen, closeComments],
  );

  return { onKeyDown };
}

/** Writes `headerEl`'s height as `--note-header-h` on the row container: the floating panel's top leaves room for the header. Written straight to the DOM, not state, so header height changes (wrapping, banner appearing) don't re-render `NoteEditor`. Measures the header plus the preview banner below it (in headerSlot): the banner's right-end side-by-side/single buttons must not be covered. */
export function useNoteHeaderHeight(rowRef: RefObject<HTMLElement | null>, headerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const row = rowRef.current;
    const header = headerRef.current;
    if (row === null || header === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) row.style.setProperty("--note-header-h", `${entry.contentRect.height}px`);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [rowRef, headerRef]);
}
