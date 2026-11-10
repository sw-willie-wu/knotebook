import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLUMN_GAP_PX, COLUMN_MIN_IMAGE_PX, COLUMN_MIN_TEXT_PX } from "./layout";

/**
 * `index.css` 並排段落的源碼守衛。BlockNote 的 CSS 在 lazy chunk、晚於 `index.css`，
 * 兩邊都未分層——不錨 `.bn-editor` 的覆寫同特異度必輸、靜默不生效且 jsdom 全綠；數值要與 `layout.ts` 的常數同一份。
 * 守不到的：規則有沒有真的進 build 產物（Lightning CSS 會靜默丟掉解析不了的選擇器）——build 後 grep `dist/assets/*.css`。
 */

const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\r\n/g, "\n");

/** 選擇器清單逐字等於 `selector` 的規則區塊內容（取最後一個——CSS 也是後者生效）。 */
function block(selector: string): string | undefined {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selectors === selector) blocks.push(m[2]);
  }
  return blocks.at(-1);
}

const RULES: Array<[string, Record<string, string>]> = [
  [".bn-editor .bn-block-column-list", { gap: `${COLUMN_GAP_PX}px`, "align-items": "flex-start" }],
  [
    ".bn-editor .bn-block-column,\n.bn-editor .bn-block-column:first-child,\n.bn-editor .bn-block-column:last-child",
    { "padding-inline": "0", "min-width": `${COLUMN_MIN_TEXT_PX}px` },
  ],
  ['.bn-editor .bn-block-column[data-kb-col-kind="image"]', { "min-width": `${COLUMN_MIN_IMAGE_PX}px` }],
  [".bn-editor .bn-block-column-list[data-stacked]", { display: "block" }],
  [".bn-editor .bn-block-column-list[data-stacked] > .bn-block-column", { "min-width": "0" }],
  [".bn-editor .bn-block-column-list[data-stacked] > .bn-block-column + .bn-block-column", { "margin-top": "12px" }],
  [".bn-editor .bn-block-column [data-file-block] .bn-file-block-content-wrapper", { "max-width": "100%" }],
  [".bn-editor .bn-block-column [data-file-block] .bn-visual-media", { "max-width": "100%" }],
];

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

describe("index.css 並排段落", () => {
  it("CSS1 每條規則逐字存在，選擇器清單的每一項都以 `.bn-editor ` 開頭", () => {
    for (const [selector] of RULES) {
      expect(block(selector), selector).toBeDefined();
      for (const part of selector.split(",")) expect(part.trim().startsWith(".bn-editor "), part).toBe(true);
    }
  });

  it("CSS2 宣告值與 layout.ts 的常數相同（gap、兩個 min-width）", () => {
    for (const [selector, expected] of RULES) {
      const actual = declarations(block(selector) ?? "");
      for (const [prop, value] of Object.entries(expected)) expect(actual[prop], `${selector} ${prop}`).toBe(value);
    }
  });

  it("CSS2b 欄只歸零左右 padding、上下照 core 的 12px：欄規則不得有 `padding`／`padding-block` 等其他 padding 宣告", () => {
    const actual = declarations(block(RULES[1][0]) ?? "");
    expect(Object.keys(actual).filter((prop) => prop.startsWith("padding"))).toEqual(["padding-inline"]);
  });

  it("CSS3 段落在窄視窗段之後、版本 diff 樣式之前；image 欄規則排在欄的 200px 規則之後", () => {
    const at = css.indexOf(".bn-editor .bn-block-column-list {");
    expect(at).toBeGreaterThan(css.indexOf("@media (width < 48rem) {"));
    expect(at).toBeLessThan(css.indexOf(".kb-diff [data-diff="));
    expect(css.indexOf("@media (width < 48rem) {")).toBeGreaterThan(-1);
    // image 欄的 96px 與 `:first-child`／`:last-child` 的 200px 同特異度 (0,3,0)，只靠排在後面贏；兩欄列的兩欄必是首或尾。
    const textMin = css.indexOf(".bn-editor .bn-block-column:last-child {");
    expect(textMin).toBeGreaterThan(-1);
    expect(css.indexOf('.bn-editor .bn-block-column[data-kb-col-kind="image"] {')).toBeGreaterThan(textMin);
  });
});
