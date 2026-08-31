import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ARTICLE_COLUMN,
  ARTICLE_COLUMN_INSET,
  ARTICLE_COLUMN_PADDING,
  BN_EDITOR_INLINE_PADDING_PX,
} from "./article-column";

/**
 * 文章欄的**共用守衛**（issue #88，體例比照 `rows.equal-height.test.ts`）。
 *
 * jsdom 不套 CSS、算不出左緣座標，單元層唯一能守的是「頁首／內文／頁尾三處都從
 * `ui/article-column.ts` 取同一條欄，沒有人自己寫死一份」，加上那條欄本身的算式
 * 沒有默默走鐘。四件事：
 *
 *   (a) 常數字面固定（消費端的斷言是從常數推導的同義反覆，鑑別力全靠這一條）
 *   (b) 頁首／頁尾的 inset ＝ 置中 wrapper 的 `px-4` ＋ BlockNote 的 `padding-inline`
 *   (c) 那 54px 是 BlockNote 給的，不是我們的碼——直接讀**實際載入的那份** dist CSS
 *       （`@blocknote/react`，見該案註解）對值，升版或某一層加了覆寫都當場紅
 *       （否則只會靜默地又錯開，沒有任何測試看得出來）
 *   (d) 三個消費端都 import 並使用 ARTICLE_COLUMN 本身（不是只有 _INSET），且沒有
 *       人自己寫一份 clamp 欄寬
 *
 * ⚠ (d) 只證明「頁首有套欄」，證明不了它套在**對的節點**上——那一半由
 * `NotePage.test.tsx` 的頁首內容列 class 斷言補（另兩個消費端各自的 layout test
 * 早就有）。兩邊缺一，頁首就會留下「悄悄退出文章欄、全套測試仍綠」的洞。
 *
 * 守不到的（誠實邊界）：
 *   - 把常數本身改成別的值——那會同時改三邊，仍然共線，是合法操作。
 *   - 消費端把 inset 套在錯的節點上（例如套在 border-b 的外層而不是內容列）：
 *     那是 class 位置問題，由各元件自己的節點鏈斷言守。
 *   - 捲軸造成的 5px 殘差（見 `article-column.ts` 註解）——jsdom 沒有捲軸幾何。
 */

const CONSUMERS = [
  { label: "內文（置中 wrapper）", path: "src/components/NoteEditor.tsx" },
  { label: "頁首（標題列）", path: "src/pages/NotePage.tsx" },
  { label: "頁尾（backlinks strip）", path: "src/components/BacklinksSection.tsx" },
] as const;

function readSource(relativePath: string): string {
  return readFileSync(`${process.cwd()}/${relativePath}`, "utf8");
}

/** 剝掉註解，避免註解裡提到的 class 字樣影響結構判斷。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("文章欄三處共用（#88）", () => {
  it("(a) 常數字面固定", () => {
    expect(ARTICLE_COLUMN).toBe("mx-auto w-full max-w-[clamp(42.5rem,85%,66rem)]");
    expect(ARTICLE_COLUMN_PADDING).toBe("px-4");
    expect(ARTICLE_COLUMN_INSET).toBe("px-[70px]");
  });

  it("(b) 頁首/頁尾的 inset ＝ 置中 wrapper 的內距 ＋ BlockNote 的 padding-inline", () => {
    // Tailwind 的 spacing scale：`px-4` ＝ 4 × 4px ＝ 16px。
    const wrapperPaddingPx = Number(ARTICLE_COLUMN_PADDING.replace("px-", "")) * 4;
    expect(wrapperPaddingPx).toBe(16);
    expect(ARTICLE_COLUMN_INSET).toBe(`px-[${wrapperPaddingPx + BN_EDITOR_INLINE_PADDING_PX}px]`);
  });

  it("(c) BlockNote `.bn-editor` 的 padding-inline 仍是常數宣告的 54px（升版改掉要當場紅）", () => {
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

  it("(d) 三個消費端都套共用常數，且沒有人自己寫一份 clamp 欄寬", () => {
    // ⚠ 邊界必要：`"ARTICLE_COLUMN_INSET".includes("ARTICLE_COLUMN")` 為真，用子字串
    // 比對的話「只套 inset、沒套置中欄」會全綠通過——那正是 #88 的病灶本身（頁首
    // 縮排對了但欄沒對，標題左緣回到卡片邊緣）。`\b` 在這裡管用：`_` 是 word char，
    // 所以 `ARTICLE_COLUMN_INSET` 的 `N` 與 `_` 之間沒有邊界，`\bARTICLE_COLUMN\b`
    // 不會誤配。
    const usesColumn = /\bARTICLE_COLUMN\b/;
    for (const { label, path } of CONSUMERS) {
      const source = readSource(path);
      const importLine = /import \{([^}]*)\} from "@\/components\/ui\/article-column";/.exec(source);
      expect(importLine, `${label}（${path}）應從 ui/article-column import`).not.toBeNull();
      expect(usesColumn.test(importLine![1]), `${label} 的 import 應含 ARTICLE_COLUMN 本身`).toBe(true);

      const code = stripComments(source);
      expect(usesColumn.test(code), `${label} 應在 className 中實際套用 ARTICLE_COLUMN`).toBe(true);
      // 繞過共用欄的唯一寫法：自己再寫一次 clamp 的 max-w。
      expect(code, `${label} 不得自己寫死欄寬，改用 ARTICLE_COLUMN`).not.toMatch(/max-w-\[clamp\(/);
    }
  });
});
