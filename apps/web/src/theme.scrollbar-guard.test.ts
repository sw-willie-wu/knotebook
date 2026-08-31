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
 *
 * **唯一例外（issue #111）**：`@supports (appearance: base-select)` 內、掛在
 * `::picker(select)` 上的標準屬性。那個偽元素上沒有 webkit 樣式可停用（那條選擇器鏈
 * 會被 Tailwind 的 Lightning CSS 在 build 時丟掉），所以只剩標準屬性可用。例外要
 * 「在該區塊內」＋「選擇器含 ::picker(select)」兩個條件同時成立，見下方斷言。
 */

function readIndexCssWithoutComments(): string {
  const path = `${process.cwd()}/src/index.css`;
  const css = readFileSync(path, "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const SUPPORTS_GUARD = /@supports \(-moz-appearance: none\)\s*\{/;

/** 從 `pattern` 命中處起，用花括號配對切出整個區塊（含頭尾大括號內的內容）。 */
function extractBlock(css: string, pattern: RegExp): string {
  const match = pattern.exec(css);
  expect(match, `index.css 找不到區塊：${pattern.source}`).not.toBeNull();
  let i = css.indexOf("{", match!.index);
  const from = i + 1;
  for (let depth = 1; depth > 0; ) {
    i += 1;
    expect(i, `區塊花括號不配對：${pattern.source}`).toBeLessThan(css.length);
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
  }
  return css.slice(from, i);
}

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
    // Firefox 這條也要吃共用的那份值（issue #111）——否則「一份值」名不副實：
    // 這裡寫死一個顏色，Firefox 的捲軸就會與 Chromium 那條各走各的（gate 審查
    // 突變實測：改成字面 rgba 原本全綠）。
    expect(inside, "Firefox 分支的 thumb 顏色要走 --scrollbar-thumb").toContain("var(--scrollbar-thumb)");

    // guard 外出現任何一個標準屬性，Chromium 121+ 會整組停用**該元素**下面的
    // ::-webkit-scrollbar 偽元素樣式（靜默、難以目視發現）。
    //
    // 唯一例外（issue #111）：`::picker(select)`（可自訂 select 展開的清單）。那個
    // 偽元素上**沒有** webkit 樣式可停用——`::picker(select)::-webkit-scrollbar` 這條
    // 鏈瀏覽器雖然吃得到，但 Tailwind v4 的 Lightning CSS 解析不了、build 時整條丟掉
    // （實測 dist 0 次，`cssMinify:false` 亦然），所以那裡只剩標準屬性可用。
    //
    // 例外要**兩個條件同時成立**才放行：規則在 `@supports (appearance: base-select)`
    // 區塊內，且選擇器含 `::picker(select)`。只看選擇器字串的話，
    // `.some-panel, .x::picker(select) { scrollbar-width: thin }` 這種寫法會連著把
    // `.some-panel`（真元素）放行——那個元素的 ::-webkit-scrollbar 樣式就被 Chromium
    // 靜默停用，正是本檔存在的理由（gate 審查突變實測抓到）。
    const baseSelect = extractBlock(outside, /@supports\s*\(\s*appearance:\s*base-select\s*\)\s*\{/);
    const rulesOf = (css: string) =>
      [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

    const offenders = rulesOf(outside.replace(baseSelect, "")).filter((r) =>
      /scrollbar-(?:width|color):/.test(r.body),
    );
    expect(
      offenders.map((r) => r.selector),
      "guard 外只有 @supports (appearance: base-select) 內的 ::picker(select) 可以用標準 scrollbar-width/color",
    ).toEqual([]);

    // base-select 區塊內也只准 picker 用——那裡同樣有真元素選擇器（select 本身）。
    const insideBaseSelect = rulesOf(baseSelect).filter(
      (r) => /scrollbar-(?:width|color):/.test(r.body) && !/::picker\(select\)/.test(r.selector),
    );
    expect(
      insideBaseSelect.map((r) => r.selector),
      "base-select 區塊內的標準 scrollbar 屬性只准掛在 ::picker(select) 上",
    ).toEqual([]);
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
  // 四個變數裡真正三邊共用的是 `--scrollbar-thumb`（全域 webkit、Firefox 分支、picker
  // 都吃它）；其餘三個只有全域那組用得到（picker 只能用標準屬性，給不了尺寸與內縮）。
  // 全部列出來是為了「有人把某個變數刪掉或改名」也會紅。
  const SHARED_VARS = ["--scrollbar-size", "--scrollbar-thumb", "--scrollbar-thumb-inset", "--scrollbar-thumb-hover"];

  /** picker 上與捲軸有關的宣告。 */
  function pickerScrollbarBodies(): string[] {
    const css = readIndexCssWithoutComments();
    return [...css.matchAll(/::picker\(select\)[^{]*\{([^}]*)\}/g)]
      .map((m) => m[1]!)
      .filter((body) => /scrollbar/.test(body));
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

  it("picker 的捲軸有設，且 thumb 顏色引用共用變數、沒有字面色", () => {
    const bodies = pickerScrollbarBodies();
    expect(bodies.length, "index.css 缺 ::picker(select) 的捲軸設定——清單會用瀏覽器預設捲軸（含 stepper 箭頭）").toBeGreaterThan(0);

    const joined = bodies.join(" ");
    expect(joined, "picker 的 thumb 顏色要走 --scrollbar-thumb（與筆記那條同一份值）").toContain(
      "var(--scrollbar-thumb)",
    );
    expect(joined, "picker 的軌道要透明，與全域一致").toContain("transparent");

    // 字面色＝又抄了一份，值會與全域各走各的。
    const literals = joined.match(/(?:color-mix|#[0-9a-f]{3,8}|oklch\()/gi) ?? [];
    expect(literals, `picker 的捲軸出現字面色 ${literals.join(", ")}——改引用 --scrollbar-* 變數`).toEqual([]);
  });
});
