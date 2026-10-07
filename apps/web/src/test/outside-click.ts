import { act, fireEvent } from "@testing-library/react";

/** 讓 Radix 掛載後的 `setTimeout(0)` 訂閱與事件後處理跑完。 */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

/**
 * 在 jsdom 模擬「點對話框外面」。這版 Radix 的 DismissableLayer：
 * - 掛載後下一個 tick（`setTimeout 0`）才訂閱 document 的 pointerdown；
 * - button===0 的 pointerdown 會延後到 document 的 `click` 才派發 pointerDownOutside。
 * 所以先讓 timer 走完、再送完整 pointerdown→mousedown→pointerup→mouseup→click；只送 pointerdown 不會有任何作用
 * （守衛的「不關」斷言會空真）。基準行為（預設 dialog 點外面真的會關）由 `components/ui/dialog.test.tsx` 守。
 */
export async function clickOutside(): Promise<void> {
  await settle();
  fireEvent.pointerDown(document.body);
  fireEvent.mouseDown(document.body);
  fireEvent.pointerUp(document.body);
  fireEvent.mouseUp(document.body);
  fireEvent.click(document.body);
  await settle();
}
