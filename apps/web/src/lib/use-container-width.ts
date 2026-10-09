import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 量容器的 **content box** 寬（版本預覽的並排判斷，起草裁定 14）。初值與 ResizeObserver 一律量 content box（gate r1 M-5：
 * 初值用 border-box、之後用 contentRect 會差掉 padding，寬度接近門檻（`SPLIT_MIN_WIDTH`）時並排／單欄來回翻）。jsdom 的 ResizeObserver 是 no-op（`test/setup.ts`），測試以 vi.mock 注入。
 */
function contentWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
}

export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(contentWidth(el));
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
