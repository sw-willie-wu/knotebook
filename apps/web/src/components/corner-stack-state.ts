import { useCallback, useSyncExternalStore } from "react";

/** Site-wide, not per note: `"1"` = collapsed, a missing key = expanded (the default). */
export const CORNER_STACK_COLLAPSED_STORAGE_KEY = "cornerStack.collapsed";

// Only a failed write lands here, as in `sidebar/collapse.ts`: where `getItem` works but `setItem` throws (Safari private mode, a full
// quota), reading storage first would undo every toggle.
let overlay: boolean | null = null;
// Expanded without saving it, for as long as something needs the bubbles on screen (the tour's version history stop).
let forNow = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function isCornerStackCollapsed(): boolean {
  if (forNow) return false;
  if (overlay !== null) return overlay;
  try {
    return window.localStorage.getItem(CORNER_STACK_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCornerStackCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(CORNER_STACK_COLLAPSED_STORAGE_KEY, "1");
    else window.localStorage.removeItem(CORNER_STACK_COLLAPSED_STORAGE_KEY);
    overlay = null;
  } catch {
    overlay = collapsed;
  }
  forNow = false;
  notify();
}

export function showCornerStackForNow(on: boolean): void {
  if (forNow === on) return;
  forNow = on;
  notify();
}

export function useCornerStackExpanded(): [expanded: boolean, toggle: () => void] {
  const collapsed = useSyncExternalStore(subscribe, isCornerStackCollapsed, () => false);
  const toggle = useCallback(() => setCornerStackCollapsed(!isCornerStackCollapsed()), []);
  return [!collapsed, toggle];
}

export function focusCornerBubble(bubble: "comments-bubble" | "versions-bubble"): void {
  (document.querySelector<HTMLElement>(`[data-testid="${bubble}"]`) ?? document.querySelector<HTMLElement>('[data-testid="corner-toggle"]'))?.focus({ preventScroll: true });
}

/** Whether a panel that just opened takes focus: it was opened from the stack, or the other panel went away with the focus. */
export function focusFromCorner(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active.closest('[data-testid="corner-stack"]') !== null;
}

/** @internal tests only. */
export function __resetCornerStackForTests(): void {
  overlay = null;
  forNow = false;
}
