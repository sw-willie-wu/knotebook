import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

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
