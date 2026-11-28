/**
 * Locks page scroll while a full-screen viewer is open: inline `overflow: hidden` on `<html>`, plus `scrollbar-gutter: stable` when there
 * was a reserved scrollbar, so the scrollbar space stays and the layout doesn't jump right. Neither is inherited, so only
 * `<html>` restyles, not the whole document. The returned function restores both original inline values (incl. `!important`).
 * Locks only when the primary pointer is a mouse/trackpad or the page has a reserved scrollbar (e.g. Windows in tablet
 * mode): touch devices without one are left alone. The zoom is `touch-none` across the screen. The file preview's panel fills a
 * phone screen; wider, the note scrolls in its own container, which the portalled preview isn't inside, so a swipe on the
 * backdrop has nothing to scroll.
 */
export function lockRootScroll(): () => void {
  const root = document.documentElement;
  const hasGutter = window.innerWidth - root.clientWidth > 0;
  const finePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
  if (!finePointer && !hasGutter) return () => undefined;
  const saved = (["overflow", "scrollbar-gutter"] as const).map(name => ({
    name,
    value: root.style.getPropertyValue(name),
    priority: root.style.getPropertyPriority(name),
  }));
  root.style.setProperty("overflow", "hidden");
  if (hasGutter) root.style.setProperty("scrollbar-gutter", "stable");
  return () => {
    for (const { name, value, priority } of saved) {
      if (value === "") root.style.removeProperty(name);
      else root.style.setProperty(name, value, priority);
    }
  };
}
