import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// jsdom 沒有 `ResizeObserver`——`@blocknote/mantine` 的 `<BlockNoteView>` 掛載時，
// mantine 內部元件（`MantineProvider`／popover／tabs 一路)摸得到它就直接
// `ResizeObserver is not defined`。這裡補一個什麼都不做的假建構子，夠用（我們的測試
// 不斷言真實尺寸量測，只要它不炸）。
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom 沒有實作 `window.matchMedia`——`@blocknote/react` 的 `usePrefersColorScheme`
// 用 `window.matchMedia?.(...)` optional chaining 保護過，不掛；但 mantine 的
// `MantineProvider`／`ColorSchemeManager` 沒有這層保護，直接呼叫會炸
// `window.matchMedia is not a function`。補一個永遠回報「不符合」的假 MediaQueryList，
// `theme.test.tsx` 既有的「jsdom 沒有 matchMedia」假設不受影響（`matches: false`
// 的效果跟原本 `typeof window.matchMedia !== 'function'` 落到的分支一樣）。
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom 的 getBoundingClientRect() 回傳的物件沒有 toJSON，BlockNote 的
// SuggestionMenuView.update（wikilink autocomplete，Plan 3）呼叫時會直接炸掉。
// 這裡墊一個真正的 DOMRect（含 toJSON）當預設值；需要真實尺寸的測試請自行 spy 覆寫。
Element.prototype.getBoundingClientRect = function () {
  return new DOMRect(0, 0, 0, 0);
};

// jsdom 完全沒實作 Range.getClientRects()/getBoundingClientRect()（不是回傳空值，
// 是整個方法不存在）。真正掛載的 BlockNote 編輯器呼叫 `.focus()`/`scrollIntoView`
// 時，ProseMirror 的 coordsAtPos 會對游標位置的文字節點建一個 Range 來量測座標
// （wikilink autocomplete「建立並連結」流程的 `setTextSelection(...).run()`
// 會走到這裡），沒這兩支方法會直接丟 `range.getClientRects is not a function`。
Range.prototype.getBoundingClientRect = function () {
  return new DOMRect(0, 0, 0, 0);
};
Range.prototype.getClientRects = function () {
  return [] as unknown as DOMRectList;
};

afterEach(() => {
  cleanup();
});
