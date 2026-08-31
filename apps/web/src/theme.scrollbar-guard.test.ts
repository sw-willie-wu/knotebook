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
    // `(?<![\w.-])` 排除「緊貼在 class／id／元素名後面」的形：index.css 另有
    // `.scrollbar-x-thin::-webkit-scrollbar{…}`（backlinks strip 的 6px 捲軸），
    // 未錨定的話那條會頂替全域規則命中——刪掉真正的全域宣告仍全綠（實測過）。
    // 邊界：擋不住以空白分隔的後代選擇器形（`.card ::-webkit-scrollbar{…}`），
    // 那不是自然會出現的寫法，不為它加複雜度。
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

/**
 * issue #111：select picker（`appearance: base-select` 展開的清單）的捲軸要與筆記那條
 * **同一組值**。
 *
 * 為什麼是「兩組規則、一份值」而不是併成一條：`::picker(select)` 在尚未支援的瀏覽器
 * 是無效選擇器，而**選擇器清單裡有一個無效就整條規則作廢**——併進全域那條的話，
 * Firefox 會連全 app 的捲軸樣式一起失去。這裡守的就是那個折衷沒有走鐘：picker 那組
 * 只准引用 `--scrollbar-*` 變數，一出現字面值就是又抄了一份（值會各走各的）。
 */
describe("select picker 的捲軸與全域共用同一組值", () => {
  const SHARED_VARS = ["--scrollbar-size", "--scrollbar-thumb", "--scrollbar-thumb-inset", "--scrollbar-thumb-hover"];

  /** picker 的四條捲軸規則（宣告內容）。 */
  function pickerScrollbarBodies(): string[] {
    const css = readIndexCssWithoutComments();
    return [...css.matchAll(/::picker\(select\)::-webkit-scrollbar[^{]*\{([^}]*)\}/g)].map((m) => m[1]!);
  }

  it("四個變數都定義了，且全域那組捲軸規則引用的是變數而不是字面值", () => {
    const css = readIndexCssWithoutComments();
    for (const name of SHARED_VARS) {
      expect(css, `index.css 缺共用變數 ${name}`).toContain(`${name}:`);
    }
    const globalThumb = /(?<![\w.-])::-webkit-scrollbar-thumb\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(globalThumb, "全域 thumb 的顏色要走共用變數").toContain("var(--scrollbar-thumb)");
    expect(globalThumb, "全域 thumb 不得再寫死 color-mix（那份值就會與 picker 各走各的）").not.toContain("color-mix");
  });

  it("picker 的捲軸規則齊全，且只引用共用變數、沒有字面值", () => {
    const bodies = pickerScrollbarBodies();
    expect(bodies.length, "index.css 缺 ::picker(select) 的捲軸規則——清單會用瀏覽器預設捲軸").toBeGreaterThanOrEqual(3);

    const joined = bodies.join(" ");
    expect(joined, "picker 的捲軸寬度要走 --scrollbar-size").toContain("var(--scrollbar-size)");
    expect(joined, "picker 的 thumb 顏色要走 --scrollbar-thumb").toContain("var(--scrollbar-thumb)");
    expect(joined, "picker 的 thumb 內縮要走 --scrollbar-thumb-inset").toContain("var(--scrollbar-thumb-inset)");
    expect(joined, "picker 的 hover 色要走 --scrollbar-thumb-hover").toContain("var(--scrollbar-thumb-hover)");

    // 字面值＝又抄了一份：px 尺寸與顏色都不准（`9999px` 圓角是形狀不是值，放行）。
    const literals = joined.replace(/9999px/g, "").match(/(?:\d+px|color-mix|#[0-9a-f]{3,8}|oklch\()/gi) ?? [];
    expect(literals, `picker 的捲軸出現字面值 ${literals.join(", ")}——改引用 --scrollbar-* 變數`).toEqual([]);
  });
});
