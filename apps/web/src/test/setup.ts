import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// jsdom 的 getBoundingClientRect() 回傳的物件沒有 toJSON，BlockNote 的
// SuggestionMenuView.update（wikilink autocomplete，Plan 3）呼叫時會直接炸掉。
// 這裡墊一個真正的 DOMRect（含 toJSON）當預設值；需要真實尺寸的測試請自行 spy 覆寫。
Element.prototype.getBoundingClientRect = function () {
  return new DOMRect(0, 0, 0, 0);
};

afterEach(() => {
  cleanup();
});
