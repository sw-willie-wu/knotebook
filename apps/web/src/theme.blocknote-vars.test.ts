import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * BlockNote 深色覆寫的 parity 守門測試。
 *
 * 背景見 `index.css` 覆寫區塊上方的註解：浮層（slash menu／formatting
 * toolbar／file panel 等）只有 `bn-root` 沒有 `bn-container`，且 BlockNote
 * 的 CSS 必晚於 `index.css` 載入，所以覆寫選擇器定死為
 * `.dark .bn-root[data-color-scheme="dark"]`（specificity (0,3,0) 才贏得過
 * 內建 `.bn-root[data-color-scheme=dark]` 的 (0,2,0)）。
 *
 * 這裡守兩件事：
 * 1. 覆寫的每個 `--bn-colors-*` 變數名都要在 BlockNote 目前安裝版本的深色
 *    區塊裡存在——升級改名會讓宣告靜默失效（CSS 自訂屬性名打錯不會報錯，
 *    只是套用不到），靠這條測試在改名當下就炸開。
 * 2. 覆寫選擇器的完整字面量（含 `.dark ` 前綴）確實出現在原始碼裡——拿掉
 *    前綴會讓 specificity 掉回 (0,2,0)，與內建打平、輸給後載的 lazy chunk。
 *
 * oracle 直接讀 node_modules 裡安裝的 `@blocknote/react/dist/style.css`
 * （BlockNote 是 MPL-2.0，本專案 MIT，刻意不複製進本專案）。
 */

function readIndexCssWithoutComments(): string {
  const path = `${process.cwd()}/src/index.css`;
  const css = readFileSync(path, "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const OVERRIDE_SELECTOR = /\.dark \.bn-root\[data-color-scheme="dark"\]\s*\{/;

function extractOverrideBlock(cssNoComments: string): string {
  const match = OVERRIDE_SELECTOR.exec(cssNoComments);
  expect(match, "index.css 找不到 .dark .bn-root[data-color-scheme=\"dark\"] 覆寫區塊").not.toBeNull();
  const start = match!.index;
  const end = cssNoComments.indexOf("}", start);
  expect(end, "覆寫區塊選擇器後找不到結尾 }").toBeGreaterThan(-1);
  return cssNoComments.slice(start, end + 1);
}

describe("BlockNote 深色覆寫 parity", () => {
  it("覆寫的每個 --bn-colors-* 變數名都存在於已安裝的 BlockNote 深色定義中", () => {
    const cssNoComments = readIndexCssWithoutComments();
    const overrideBlock = extractOverrideBlock(cssNoComments);

    const varNames = [...overrideBlock.matchAll(/(--bn-colors-[a-z-]+):/g)].map((m) => m[1]);
    expect(varNames.length).toBeGreaterThan(0);

    const blockNoteCssPath = `${process.cwd()}/node_modules/@blocknote/react/dist/style.css`;
    const blockNoteCss = readFileSync(blockNoteCssPath, "utf8");
    const darkSelector = /\.bn-root\[data-color-scheme=["']?dark["']?\]\s*\{/;
    const darkMatch = darkSelector.exec(blockNoteCss);
    expect(darkMatch, "@blocknote/react/dist/style.css 找不到 .bn-root[data-color-scheme=dark] 區塊").not.toBeNull();
    const darkStart = darkMatch!.index;
    const darkEnd = blockNoteCss.indexOf("}", darkStart);
    expect(darkEnd).toBeGreaterThan(-1);
    const darkBlock = blockNoteCss.slice(darkStart, darkEnd + 1);

    for (const varName of varNames) {
      expect(darkBlock, `${varName} 應存在於 BlockNote 深色定義中`).toContain(`${varName}:`);
    }
  });

  it("覆寫選擇器的完整字面量（含 .dark 前綴）出現在 index.css 中", () => {
    // 拿掉 `.dark ` 前綴會讓 specificity 掉回 (0,2,0)，與 BlockNote 內建的
    // `.bn-root[data-color-scheme=dark]` 打平，輸給後載的 lazy chunk CSS。
    const cssNoComments = readIndexCssWithoutComments();
    expect(cssNoComments).toMatch(OVERRIDE_SELECTOR);
  });
});
