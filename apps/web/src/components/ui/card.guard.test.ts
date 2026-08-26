import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cardSurface } from "./card";

/**
 * 來源層守衛（#81）：`cardSurface` 是卡片外觀 class 字面量的**唯一出處**——8 個
 * 呼叫端（AppShell／AiPanel ×2／NoteEditor／NotePage／HomePage／NotePageFallback／
 * ErrorBoundary）改成 `cn(cardSurface, "<其餘 class>")`，只有 3 個呼叫端有
 * rendered-class 斷言守著：`NoteEditor.layout.test.tsx` 一檔守 2 處（NoteEditor
 * 的內文卡、AiPanel 的展開卡），`NotePage.test.tsx` 守 1 處（NotePage 的佔位卡，
 * 用兩個不同狀態各斷言一次，不是兩個不同呼叫端）。其餘 5 處（AppShell aside、
 * AiPanel 收合軌、HomePage、NotePageFallback、ErrorBoundary）完全沒有測試釘住
 * rendered 輸出——這裡補的不是「渲染出來對不對」，是「字面量有沒有被抄回原始碼」。
 *
 * 掃描語意（**對 raw 原始碼全文、含註解**，刻意跟 `theme.*` 系列守衛的「剝註解」
 * 慣例相反）：字面量本身常常先被抄進註解（docs-as-spec-drift 的形），再被抄回
 * 實際 class——`NotePage.tsx` 曾經在註解裡完整抄過這串 contiguous 字面量，本守衛
 * 就是釘住它不被抄回來。只掃 `.tsx`：`ui/card.ts` 是刻意的唯一字面出處（`.ts`
 * 不掃即天然排除），本檔自己是 `.test.ts` 也不在掃描集內。
 *
 * 誠實邊界：只抓 contiguous 單行形的原樣抄寫。換行拆開（如
 * `` `rounded-xl border\n * border-border bg-card` ``）或簡寫形（如
 * `rounded-xl border bg-card`）的註解抄寫，本守衛抓不到——這類靠 code review 與
 * M4（改版時同步重寫指向 cardSurface 的註解）擋，不是這裡的職責。同樣抓不到的是
 * 「某處把 cardSurface 整個拿掉、改用別的視覺」——那要靠 diff review 與視覺驗證。
 * 另外，`.ts` 豁免是整個副檔名層級，不是只放過 `ui/card.ts` 這一檔——任何其他
 * 非測試 `.ts` 檔若抄了這串字面量，本守衛一樣掃不到；`ui/card.ts` 只是**預期**
 * 唯一該出現這個字面量的地方，不是被特別排除的例外。
 */

const CARD_SURFACE_LITERAL = "rounded-xl border border-border bg-card";

function listTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    files.push(`${entry.parentPath}/${entry.name}`.replace(/\\/g, "/"));
  }
  return files;
}

describe("cardSurface 來源層守衛（#81）", () => {
  it("(a) 常數字面本身未被改字", () => {
    expect(cardSurface).toBe(CARD_SURFACE_LITERAL);
  });

  it("(b) apps/web/src 底下的 .tsx（排除 .test. 檔）不含 cardSurface 字面量的原樣抄寫", () => {
    const root = `${process.cwd()}/src`;
    const tsxFiles = listTsxFiles(root);
    // 釘遞迴確實走到深層子目錄——只看 length > 0 太弱：掉了 { recursive: true }
    // 之後根層本來就還有幾個 .tsx，一樣能通過。AiPanel.tsx 在 components/ai/ 下，
    // 找得到它才代表真的遞迴了，不是只掃了根層。
    expect(tsxFiles.some((p) => p.replaceAll("\\", "/").endsWith("/components/ai/AiPanel.tsx"))).toBe(true);

    const offenders: string[] = [];
    for (const file of tsxFiles) {
      const source = readFileSync(file, "utf8");
      if (source.includes(CARD_SURFACE_LITERAL)) {
        offenders.push(file);
      }
    }

    expect(offenders, `不應在這些檔案裡原樣出現 cardSurface 字面量：${offenders.join(", ")}`).toEqual([]);
  });
});
