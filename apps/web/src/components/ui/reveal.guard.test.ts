import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 來源層守衛（側欄 UX Task 5）：hover 浮出（`ui/reveal.ts` 的 `BASE`／`SCOPE`）與側欄拖曳把手的線
 * （`AppShell.tsx` 的 `SidebarResizeHandle`）的 class 必須是**完整字面**。
 *
 * 守的是：完整字面被改成樣板拼接（`` `group-hover/${scope}:…` ``）——Tailwind v4 靜態掃描原始碼
 * 產生 CSS，拼出來的 class 撈不到、靜默不產生；jsdom 測試只斷言 class 字串，照綠；而 build 產物
 * grep 也是盲的，因為 Tailwind 連測試檔一起掃，測試檔逐字寫著同一批 class 會把它們補回產物
 * （Task 2 審查 M2 實測）。所以只有讀原始碼的守衛看得到這個形。也因為會被補回，樣板化在今天的產物裡
 * 其實還是對的——它是**潛伏回歸**：等哪天測試改寫、刪掉那些字面（本檔自己也逐字寫著幾條），才會靜默壞掉。
 *
 * 守不到的：字面本身打錯字、或 class 名不存在（照樣是完整字面，這裡放行）；用 `+` 串接字串拼出來
 * 的形（本檔只找 `${` 與反引號）；`BASE`／`SCOPE`／把手線以外的地方。
 *
 * 掃描語意：對 raw 原始碼切出片段——`reveal.ts` 從 `const BASE =` 到 `SCOPE` 物件字面的結尾
 * `};`；`AppShell.tsx` 取含 `w-0.5 rounded-full` 錨點的那一行。錨點失效會先紅（reveal.ts：錨點索引
 * 斷言；AppShell：含錨點的行恰好 1 行——錨點消失或被抄進註解多出一行都紅），不會因為改了寫法就默默變成
 * 掃空字串。
 */

const root = `${process.cwd()}/src`;

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `找不到錨點：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `找不到結尾：${end}`).toBeGreaterThan(from);
  return source.slice(from, to + end.length);
}

describe("hover 浮出與拖曳把手的 class 來源層守衛", () => {
  it("reveal.ts 的 BASE 與 SCOPE 是完整字面（沒有樣板拼接）", () => {
    const source = readFileSync(`${root}/components/ui/reveal.ts`, "utf8").replace(/\r\n/g, "\n");
    const segment = between(source, "const BASE =", "\n};");
    // 片段真的涵蓋三個 scope（錨點沒漂走）。
    for (const scope of ["section", "grouprow", "noterow"]) {
      expect(segment).toContain(`group-hover/${scope}:opacity-100`);
    }
    expect(segment).toContain("data-[state=open]:opacity-100");
    expect(segment).not.toContain("${");
    expect(segment).not.toContain("`");
  });

  it("AppShell.tsx 把手線的 class 是完整字面（沒有樣板拼接）", () => {
    const source = readFileSync(`${root}/components/AppShell.tsx`, "utf8").replace(/\r\n/g, "\n");
    const lines = source.split("\n").filter((line) => line.includes("w-0.5 rounded-full"));
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("group-focus-visible/resize:bg-ring");
    expect(line).toContain("group-data-[dragging]/resize:bg-ring");
    expect(line).not.toContain("${");
    expect(line).not.toContain("`");
  });
});
