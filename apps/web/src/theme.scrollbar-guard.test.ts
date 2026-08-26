import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 滾動條區塊的結構守門測試（比照 `theme.blocknote-vars.test.ts`：剝註解→
 * 定位塊→驗結構）。
 *
 * 背景見 `index.css` 滾動條區塊上方的註解：標準 `scrollbar-width`/
 * `scrollbar-color` 一旦在 Chromium 121+ 被設定，`::-webkit-scrollbar` 系列
 * 偽元素樣式整組停用（Chromium 實作規則）——所以標準屬性必須包在
 * `@supports (-moz-appearance: none)`（只有 Firefox 命中）內。
 *
 * 這條不變量壞掉時**幾乎看不出來**：Chromium 仍是 10px＋同色 thumb，只是
 * 靜默掉了圓角、content-box 內縮與 hover——肉眼 review 與整套單元測試都
 * 抓不到，只能靠這裡的原始碼結構守衛。
 */

function readIndexCssWithoutComments(): string {
  const path = `${process.cwd()}/src/index.css`;
  const css = readFileSync(path, "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const SUPPORTS_GUARD = /@supports \(-moz-appearance: none\)\s*\{/;

/** 抽出 @supports guard 區塊（含巢狀花括號，用計數配對），回傳 [區塊內容, 移除區塊後的其餘 css]。 */
function splitAtSupportsGuard(css: string): { inside: string; outside: string } {
  const match = SUPPORTS_GUARD.exec(css);
  expect(match, "index.css 找不到 @supports (-moz-appearance: none) guard 區塊").not.toBeNull();
  const braceStart = css.indexOf("{", match!.index);
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        return {
          inside: css.slice(braceStart + 1, i),
          outside: css.slice(0, match!.index) + css.slice(i + 1),
        };
      }
    }
  }
  expect.unreachable("@supports guard 區塊花括號不配對");
}

describe("滾動條 @supports guard 結構", () => {
  it("標準 scrollbar-width/scrollbar-color 只出現在 guard 內，且 guard 內兩者都有", () => {
    const { inside, outside } = splitAtSupportsGuard(readIndexCssWithoutComments());

    expect(inside, "guard 內應設 scrollbar-width").toContain("scrollbar-width:");
    expect(inside, "guard 內應設 scrollbar-color").toContain("scrollbar-color:");

    // guard 外出現任何一個標準屬性，Chromium 121+ 會整組停用下面的
    // ::-webkit-scrollbar 偽元素樣式（靜默、難以目視發現）。
    expect(outside, "guard 外不得出現 scrollbar-width").not.toContain("scrollbar-width:");
    expect(outside, "guard 外不得出現 scrollbar-color").not.toContain("scrollbar-color:");
  });

  it("::-webkit-scrollbar 偽元素規則在 guard 外，且 guard 內沒有", () => {
    const { inside, outside } = splitAtSupportsGuard(readIndexCssWithoutComments());

    // 基本組成都要在：底、track、thumb、thumb hover、corner。
    // `(?<![\w.-])` 錨定「**無前置選擇器**的全域規則」：本檔另有 class 限定的
    // `.scrollbar-x-thin::-webkit-scrollbar{…}`（backlinks strip 的 6px 捲軸），
    // 未錨定的話那條會頂替全域規則命中——刪掉真正的全域宣告仍全綠（實測過）。
    for (const selector of [
      /(?<![\w.-])::-webkit-scrollbar\s*\{/,
      /(?<![\w.-])::-webkit-scrollbar-track\s*\{/,
      /(?<![\w.-])::-webkit-scrollbar-thumb\s*\{/,
      /(?<![\w.-])::-webkit-scrollbar-thumb:hover\s*\{/,
      /(?<![\w.-])::-webkit-scrollbar-corner\s*\{/,
    ]) {
      expect(outside, `guard 外應有 ${selector.source} 規則`).toMatch(selector);
    }
    expect(inside, "guard 內不該有 ::-webkit-scrollbar 規則（Firefox 用不到、也會誤導維護者）").not.toContain("::-webkit-scrollbar");
  });
});
