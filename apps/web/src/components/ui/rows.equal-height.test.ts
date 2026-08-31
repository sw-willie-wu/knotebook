import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BACKLINKS_SCROLL_ROW, SIDEBAR_ROW_HEIGHT } from "./rows";

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
 * 守不到的（誠實邊界）：
 *   - 把常數本身改成別的值——那會同時改兩邊，仍然等高，是合法操作。
 *   - 兩邊容器的垂直內距（`p-2`／`py-2`）與上緣 `border-t`：那是等高的另一半，
 *     由各自元件的 class 斷言守（`BacklinksSection.test.tsx` 的守衛案斷了 footer 外層
 *     的 `py-2`——#115 之後左右內距是內容列自己的 `px-5`，外層那條同時斷「不含
 *     `px-`」；側欄那側是 `AppShell.tsx` 的 `p-2` 容器）。
 *   - `cn()` 裡在常數之後再塞一個 `h-*`（twMerge 取後者）——(c) 會抓到寫死值，
 *     但若那個值恰好與常數同值就無從分辨，也無害。
 *   - 寫死的列高若剛好也配了同值的 `w-*`（如 `h-9 w-9`），(c) 會當成方形圖示
 *     放過——這是為了不誤報 avatar／icon 尺寸付出的代價。
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

  it("(a2) BACKLINKS_SCROLL_ROW 字面固定，且容器高＝列高＋捲軸高", () => {
    // 字面釘死：消費端的斷言是 `toHaveClass(...BACKLINKS_SCROLL_ROW.split(" "))`，
    // 期望值從常數推導，改常數不會讓那邊紅（同義反覆）——鑑別力全靠這一條。
    expect(BACKLINKS_SCROLL_ROW).toBe("h-[42px] -mb-1.5 scrollbar-x-thin");

    // 「42 ＝ 36 ＋ 6」這個換算過去只寫在註解裡，這裡讓它可執行：容器高由列高
    // 推出、負邊距抵銷掉多出來的捲軸高（否則會撐高那一列）。
    const rowHeightPx = Number(ROW_HEIGHT_LITERAL.replace("h-", "")) * 4;
    const scrollbarPx = 6;
    expect(rowHeightPx).toBe(36);
    expect(BACKLINKS_SCROLL_ROW).toContain(`h-[${rowHeightPx + scrollbarPx}px]`);
    expect(BACKLINKS_SCROLL_ROW).toContain(`-mb-${scrollbarPx / 4}`);
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
      // 抓固定高度 `h-<數字>`／`h-[任意值]`，含一位數（h-8／h-9 正是最可能被
      // 寫死的替代列高）。`(?<![\w-])` 排除 `max-h-*`／`min-h-*` 前綴——`\b` 在
      // `max-h-` 的 `-h` 之間會成立，用它會把合法的 `max-h-48` 誤報成列高。
      const heights = [...code.matchAll(/(?<![\w-])h-(\d+(?:\.\d+)?|\[[^\]]+\])/g)].map((m) => m[1]);
      // 有成對 `w-<同值>` 的是方形（avatar、icon）不是列高，排除；列高只設 h。
      const hardcoded = heights.filter((value) => {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return !new RegExp(`(?<![\\w-])w-${escaped}(?![\\w.-])`).test(code);
      });
      expect(hardcoded, `${label}（${path}）不得自己寫死列高，改用 SIDEBAR_ROW_HEIGHT`).toEqual([]);
    }
  });
});
