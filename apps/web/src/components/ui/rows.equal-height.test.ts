import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SIDEBAR_ROW_HEIGHT } from "./rows";

/**
 * 側欄帳號列與內文卡 backlinks 列的**等高守衛**（原始碼結構層，體例比照
 * `theme.scrollbar-guard.test.ts`／`card.guard.test.ts`）。
 *
 * 兩列貼在各自卡片底緣、隔著卡間 gap 左右相鄰，高度不一致一眼看得出來，但
 * jsdom 不套 CSS、算不出實際高度——單元層唯一能守的是「兩邊都從 `ui/rows.ts`
 * 取同一個常數，沒有人自己寫死一個高度」。
 *
 * 守三件事：
 *   (a) 常數字面沒被改掉（改了下面兩個檔案就要一起看，不是默默各長各的）
 *   (b) 兩個檔案都 import 了這個常數
 *   (c) 兩個檔案都沒有自己寫死 `h-<數字>` 的列高（繞過常數的唯一寫法）
 *
 * 守不到的：把常數本身改成別的值——那會同時改兩邊，仍然等高，是合法操作。
 */

const ROW_HEIGHT_LITERAL = "h-9";

const CONSUMERS = [
  { label: "側欄帳號列", path: "src/components/UserMenu.tsx" },
  { label: "內文卡 backlinks 列", path: "src/components/BacklinksSection.tsx" },
] as const;

function readSource(relativePath: string): string {
  return readFileSync(`${process.cwd()}/${relativePath}`, "utf8");
}

/** 剝掉註解，避免註解裡提到 `h-9` 之類的字樣影響 (c) 的判斷。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("側欄帳號列與 backlinks 列等高", () => {
  it("(a) SIDEBAR_ROW_HEIGHT 常數字面固定", () => {
    expect(SIDEBAR_ROW_HEIGHT).toBe(ROW_HEIGHT_LITERAL);
  });

  it("(b) 兩個消費端都 import 並使用 SIDEBAR_ROW_HEIGHT", () => {
    for (const { label, path } of CONSUMERS) {
      const source = readSource(path);
      expect(source, `${label}（${path}）應 import SIDEBAR_ROW_HEIGHT`).toMatch(
        /import \{[^}]*SIDEBAR_ROW_HEIGHT[^}]*\} from "@\/components\/ui\/rows";/,
      );
      // import 之外還要真的用到（只 import 不用會被 lint 擋，這裡再釘一次）。
      const uses = stripComments(source).match(/SIDEBAR_ROW_HEIGHT/g) ?? [];
      expect(uses.length, `${label} 應在 className 中實際套用 SIDEBAR_ROW_HEIGHT`).toBeGreaterThanOrEqual(2);
    }
  });

  it("(c) 兩個消費端都沒有自己寫死列高 utility", () => {
    for (const { label, path } of CONSUMERS) {
      const code = stripComments(readSource(path));
      // 只抓固定高度（h-9／h-10／h-[52px]…）；h-3/h-4 之類的 icon 尺寸與
      // h-full/h-screen 不在此列，故限定「h- 後面接兩位數以上或方括號」。
      const hardcoded = code.match(/\bh-(?:\d{2,}|\[[^\]]+\])/g) ?? [];
      expect(hardcoded, `${label}（${path}）不得自己寫死列高，改用 SIDEBAR_ROW_HEIGHT`).toEqual([]);
    }
  });
});
