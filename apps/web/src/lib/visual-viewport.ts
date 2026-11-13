import { useEffect, useState } from "react";

/**
 * 螢幕鍵盤升起時，視覺視窗比版面視窗矮；超過這個高度差就當作鍵盤開著。
 * 門檻要高於捲軸寬度與網址列收放動畫中暫時的高度差，又低於任何螢幕鍵盤的高度；
 * 這是設計取捨，沒有在實機上量過。
 */
export const KEYBOARD_OPEN_THRESHOLD_PX = 80;

/** 版面視窗底邊到視覺視窗底邊的距離（px，下限 0）。沒有 `visualViewport` 回 0。 */
export function readKeyboardInset(): number {
  if (typeof window === "undefined") return 0;
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  // 雙指放大會讓視覺視窗變小，但不是鍵盤。
  if (Math.abs(viewport.scale - 1) > 0.01) return 0;
  return Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop));
}

/** 這個高度差是不是鍵盤造成的。 */
export function isKeyboardOpen(inset: number): boolean {
  return inset > KEYBOARD_OPEN_THRESHOLD_PX;
}

/**
 * 鍵盤佔掉的高度：把 `position: fixed` 的元素設 `bottom: inset`，就會貼在鍵盤正上方。
 * 監聽 `visualViewport` 的 `resize` 與 `scroll`（iOS 鍵盤升起時兩者先後不定），
 * 同一幀內的多次事件合併成一次讀值。沒有 `visualViewport` 時恆為 0（固定在底部）。
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(readKeyboardInset);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setInset(readKeyboardInset());
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    // 掛上監聽前若已變動，補讀一次。
    setInset(readKeyboardInset());
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return inset;
}
