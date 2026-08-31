import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING, BN_EDITOR_INLINE_PADDING_PX } from "./article-column";

/**
 * 文章欄的**共用守衛**（#115 改版後；體例比照 `rows.equal-height.test.ts`）。
 *
 * #115 起頁首／頁尾回到滿卡寬（置左置右），文章欄常數只剩內文（BlockNote 置中
 * wrapper）一個消費端。jsdom 不套 CSS、算不出左緣座標，單元層能守的三件事：
 *
 *   (a) 常數字面固定（消費端的斷言是從常數推導的同義反覆，鑑別力全靠這一條）
 *   (c) BlockNote 那 54px 是升版哨兵——54 已無生產端消費者，但 `<md` 的
 *       `.bn-editor.bn-editor{padding-inline:1.25rem}` 覆寫（index.css）是以
 *       「原值 54」為前提做的設計，升版改掉要紅給人重新評估，不是靜默錯開
 *   (d) 內文是唯一消費端；頁首（NotePage）／頁尾（BacklinksSection）**不得**把
 *       欄加回去，也沒有人自己寫一份 clamp 欄寬
 *
 *   (e) `<md` 的對齊耦合：index.css 覆寫的 `1.25rem`（20px）＝頁首/頁尾的 `px-5`
 *       （20px）。#88 時代這種推導由案 (b) 釘住（70 = 16 + 54），拆掉 (b) 之後
 *       這條 20↔20 就是新的無守衛缺口——這裡把三邊的字面綁在一起。
 *
 * 守不到的（誠實邊界）：
 *   - 把常數本身改成別的值——單一消費端下仍是合法操作。
 *   - `<md` 覆寫是否真的進 build 產物——jsdom 讀不到 dist，(e) 只讀 src；靠
 *     build 後 `grep "bn-editor.bn-editor" apps/web/dist/assets/*.css`（見
 *     index.css 註解）。
 */

/** 唯一消費端（內文置中 wrapper）。 */
const CONSUMER = { label: "內文（置中 wrapper）", path: "src/components/NoteEditor.tsx" } as const;

/** 不得把欄加回去的兩個舊消費端（#115 前是頁首／頁尾）。 */
const NON_CONSUMERS = [
  { label: "頁首（NotePage）", path: "src/pages/NotePage.tsx" },
  { label: "頁尾（BacklinksSection）", path: "src/components/BacklinksSection.tsx" },
] as const;

function readSource(relativePath: string): string {
  return readFileSync(`${process.cwd()}/${relativePath}`, "utf8");
}

/** 剝掉註解，避免註解裡提到的 class 字樣影響結構判斷。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("文章欄守衛（#115：內文單一消費端）", () => {
  it("(a) 常數字面固定", () => {
    expect(ARTICLE_COLUMN).toBe("mx-auto w-full max-w-[clamp(42.5rem,85%,66rem)]");
    expect(ARTICLE_COLUMN_PADDING).toBe("px-4 max-md:px-0");
  });

  it("(c) BlockNote `.bn-editor` 的 padding-inline 仍是常數宣告的 54px（升版哨兵）", () => {
    // 讀**實際載入的那一份**：`NoteEditor.tsx` 只 import `@blocknote/mantine/style.css`，
    // 它 `@import` 進 `@blocknote/react/style.css`（後者再帶進 core 的樣式）。core 的
    // dist 只是其中一層，單讀它的話「mantine／react 那層覆寫了 padding」會靜默漏掉
    // ——而那正是這條要防的情境。讀 react bundle 的路徑寫法比照
    // `theme.blocknote-vars.test.ts` 的既有慣例。
    const cssPath = `${process.cwd()}/node_modules/@blocknote/react/dist/style.css`;
    const css = readFileSync(cssPath, "utf8");

    // dist 是 minify 過的單行。只取**選擇器就是 `.bn-editor` 本身**的規則：前一個
    // 字元必須是規則邊界（`}`／`,`／檔首），否則 `.bn-comment-editor .bn-editor{padding:0}`
    // 這種後代形也會被算進來（那條是留言編輯器的，與文章欄無關）。
    const bareRules = [...css.matchAll(/(?:^|[},])\s*\.bn-editor\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(bareRules.length, `${cssPath} 找不到裸 \`.bn-editor{…}\` 規則`).toBeGreaterThan(0);

    // 跨所有裸規則收集 padding 宣告：**恰好一條、且就是 54px**。多一條（後面某層加了
    // 覆寫、由後者勝出）或值變了都會紅——只斷「有出現 54px」的話，後面補一條
    // `padding-inline:16px` 依然全綠而版面靜默錯開。
    const paddings = bareRules.flatMap((decls) => [...decls.matchAll(/padding(?:-inline)?\s*:\s*[^;]+/g)].map((m) => m[0]));
    expect(paddings).toEqual([`padding-inline:${BN_EDITOR_INLINE_PADDING_PX}px`]);
  });

  it("(d) 內文套共用常數；頁首/頁尾不得把欄加回去，也沒有人自己寫 clamp 欄寬", () => {
    // ⚠ 邊界必要：`_` 是 word char，`\bARTICLE_COLUMN\b` 不會誤配 `ARTICLE_COLUMN_PADDING`
    // 這種帶後綴的名字（`N` 與 `_` 之間沒有邊界）——歷史教訓見 #88 的審查紀錄：
    // 子字串比對曾讓「只套 inset、沒套欄」全綠放行。
    const usesColumn = /\bARTICLE_COLUMN\b/;

    const consumerSource = readSource(CONSUMER.path);
    const importLine = /import \{([^}]*)\} from "@\/components\/ui\/article-column";/.exec(consumerSource);
    expect(importLine, `${CONSUMER.label}（${CONSUMER.path}）應從 ui/article-column import`).not.toBeNull();
    expect(usesColumn.test(importLine![1]), `${CONSUMER.label} 的 import 應含 ARTICLE_COLUMN 本身`).toBe(true);
    expect(usesColumn.test(stripComments(consumerSource)), `${CONSUMER.label} 應實際套用 ARTICLE_COLUMN`).toBe(true);

    for (const { label, path } of NON_CONSUMERS) {
      const code = stripComments(readSource(path));
      // #115 定案：頁首/頁尾滿卡寬。把欄（或自寫 clamp）加回去＝回到 #88 前後那種
      // 「三處對齊」布局，是刻意拆掉的行為，不得靜默復活。
      expect(code, `${label}（${path}）不得 import/使用文章欄常數`).not.toMatch(/article-column/);
      expect(code, `${label} 不得自己寫死欄寬`).not.toMatch(/max-w-\[clamp\(/);
    }
    // 唯一消費端自己也不得繞過常數再寫一份 clamp（欄寬的單一真相在 article-column.ts）。
    expect(stripComments(consumerSource), `${CONSUMER.label} 不得在常數之外自寫欄寬`).not.toMatch(/max-w-\[clamp\(/);
  });

  it("(e) `<md` 對齊耦合：index.css 覆寫的 20px ＝ 頁首/頁尾的 px-5", () => {
    // index.css 那半：`@media (width < 48rem)` 內的 `.bn-editor.bn-editor` 覆寫。
    // 只認疊 class 形——寫回裸 `.bn-editor` 會輸給 BlockNote 的 (0,1,0)（載入順序
    // 必晚於本檔），這條斷言讓「降級成裸選擇器」當場紅，而不是靜默不生效。
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
    const override = /@media \(width < 48rem\)\s*\{[^{}]*\.bn-editor\.bn-editor\s*\{([^}]*)\}/.exec(css);
    expect(override, "index.css 應有 `<md` 的 `.bn-editor.bn-editor` 疊 class 覆寫").not.toBeNull();
    const value = /padding-inline:\s*([\d.]+)rem/.exec(override![1]);
    expect(value, "覆寫應宣告 padding-inline（rem）").not.toBeNull();
    const overridePx = Number(value![1]) * 16;

    // 頁首/頁尾那半：兩個非消費端都用 `px-5`（Tailwind spacing scale：5 × 4 = 20px）。
    for (const { label, path } of NON_CONSUMERS) {
      expect(/\bpx-5\b/.test(stripComments(readSource(path))), `${label} 應用 px-5 滿卡寬內距`).toBe(true);
    }
    expect(overridePx, "`<md` 內文左緣應與頁首/頁尾的 px-5（20px）共線").toBe(5 * 4);
  });
});
