import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
 *   (c) 那 54px 是 `@blocknote/core` 的 dist CSS 給的，不是我們的碼——直接讀套件
 *       對值，升版改掉當場紅（否則只會靜默地又錯開，沒有任何測試看得出來）
 *   (d) 三個消費端都 import 並使用 ARTICLE_COLUMN，且沒有人自己寫一份 clamp 欄寬
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
    const require = createRequire(import.meta.url);
    const css = readFileSync(require.resolve("@blocknote/core/style.css"), "utf8");

    // dist 是 minify 過的單行；`.bn-editor{…}` 這一條規則（不是後代選擇器）裡的
    // padding-inline 才是欄內距本身。
    const rule = /\.bn-editor\{([^}]*)\}/.exec(css);
    expect(rule, "在 @blocknote/core 的 dist CSS 找不到 `.bn-editor{…}` 規則").not.toBeNull();
    expect(rule![1]).toContain(`padding-inline:${BN_EDITOR_INLINE_PADDING_PX}px`);
  });

  it("(d) 三個消費端都套共用常數，且沒有人自己寫一份 clamp 欄寬", () => {
    for (const { label, path } of CONSUMERS) {
      const source = readSource(path);
      expect(source, `${label}（${path}）應 import ARTICLE_COLUMN`).toMatch(
        /import \{[^}]*ARTICLE_COLUMN[^}]*\} from "@\/components\/ui\/article-column";/,
      );

      const code = stripComments(source);
      expect(code.includes("ARTICLE_COLUMN"), `${label} 應在 className 中實際套用 ARTICLE_COLUMN`).toBe(true);
      // 繞過共用欄的唯一寫法：自己再寫一次 clamp 的 max-w。
      expect(code, `${label} 不得自己寫死欄寬，改用 ARTICLE_COLUMN`).not.toMatch(/max-w-\[clamp\(/);
    }
  });
});
