import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * block 選取外框（node selection）覆寫的結構守門（比照 `theme.scrollbar-guard.test.ts`）。
 *
 * BlockNote 內建把 node selection 畫成寫死的 `outline: 4px solid #64a0ff`。我們在
 * `index.css` 用 (0,3,0) 的選擇器把**所有** block 蓋成主題色細框——**祖先錨點
 * `.bn-editor` 一旦被拿掉**（選擇器掉回 (0,2,0)），BlockNote 的 CSS 在 NotePage
 * lazy chunk、載入順序必晚於 index.css，同 specificity 我們就輸了，藍框**靜默**
 * 回來：單元測試與 jsdom 都看不到 layout/cascade。
 */

function readIndexCss(): string {
  return readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 抽出選取外框那條規則的兩個選擇器與宣告內容。 */
function selectionRule(): { selectors: string[]; body: string } {
  const css = readIndexCss();
  // 全檔掃描而不是只取第一條：日後若有人在前面又加一條 selectednode 規則，
  // 只取第一條的寫法會改去驗那條、對真正的覆寫規則失去鑑別力。
  const matches = [...css.matchAll(/([^}]*ProseMirror-selectednode[^{}]*)\{([^}]*)\}/g)];
  expect(matches, "index.css 應**只有一條** ProseMirror-selectednode 的覆寫規則").toHaveLength(1);
  const match = matches[0]!;
  return {
    selectors: match[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    body: match[2]!,
  };
}

describe("block 選取外框覆寫", () => {
  it("兩種 selectednode 落點都要蓋到（可能在 .bn-block-content 自己身上或外層）", () => {
    const { selectors } = selectionRule();
    expect(selectors).toHaveLength(2);
    expect(selectors.some((s) => /\.bn-block-content\.ProseMirror-selectednode\s*>\s*\*/.test(s))).toBe(true);
    expect(selectors.some((s) => /\.ProseMirror-selectednode\s*>\s*\.bn-block-content\s*>\s*\*/.test(s))).toBe(true);
  });

  it("每個選擇器都以 .bn-editor 為錨（specificity 要贏內建的 (0,2,0)）", () => {
    for (const selector of selectionRule().selectors) {
      expect(selector, `少了 .bn-editor 錨點就墊不到 (0,3,0)：${selector}`).toMatch(/^\.bn-editor\s/);
    }
  });

  it("套用到所有 block，不綁單一 block 型別", () => {
    for (const selector of selectionRule().selectors) {
      expect(selector, `選取外框要全 app 統一，不該只挑某種 block：${selector}`).not.toContain("[data-content-type");
    }
  });

  it("外框用主題色 token、且外框本身不得被移除（選取態要看得見）", () => {
    const { body } = selectionRule();
    expect(body).toContain("var(--color-brand)");
    expect(body).not.toMatch(/outline:\s*none/);
    expect(body, "不該把 BlockNote 寫死的藍抄過來").not.toContain("#64a0ff");
  });
});
