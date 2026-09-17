import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 來源層守衛（N10，2026-09-17 審查）：`brandSolid`／`brandDeep` 是主色實心鈕的
 * 兩階，見 `ui/button.tsx` 規範——**依所在表面二選一、不得混用**：`brandSolid`
 * 給頁面層級的唯一主動作（登入、授權同意、全頁錯誤的主要出路），`brandDeep` 給
 * modal／panel 內部的唯一主動作。兩階刻意設計成「不會同時出現在同一個畫面」，
 * 但這個不變量目前只靠 code review 撐著——沒有東西擋住有人在第五個檔案裡也用
 * `brandSolid`，讓某個畫面同時看到兩種主色實心塊（審查探針指出的缺口）。
 *
 * 這裡機械釘住目前唯一合法的四個呼叫端；出現第五個就會在這裡先紅，逼著寫的人
 * 回頭想一次「這個畫面到底是頁面層級還是 modal/panel 內部」，而不是靜默疊加。
 *
 * 掃描語意刻意剝註解（跟 `theme.*` 系列同慣例，跟 `card.guard.test.ts` 的「含
 * 註解」相反）：`brandSolid` 這個名字本身常被拿來在別處的註解裡**解釋**兩階的
 * 差異（例如 `SettingsAccountSection.tsx` 說明 `ChangePasswordForm` 在
 * `/change-password` 整頁用 `brandSolid`）——那是文件、不是第二個呼叫端，剝掉
 * 註解才不會把說明性文字誤判成違規。真正要抓的是 `variant="brandSolid"`／
 * `variant={... "brandSolid" ...}` 這類會實際渲染出主色實心鈕的程式碼。
 *
 * `ui/button.tsx` 本身（定義 `brandSolid` 這個 variant 的地方）與 `.test.` 檔
 * 排除在掃描集之外——它們是定義與測試，不是「這個畫面渲染出一顆 brandSolid 鈕」
 * 的呼叫端。
 */

const ALLOWED_FILES = [
  "auth/ChangePasswordForm.tsx",
  "auth/guards.tsx",
  "pages/AuthorizePage.tsx",
  "pages/LoginPage.tsx",
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function listTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    const full = `${entry.parentPath}/${entry.name}`.replace(/\\/g, "/");
    if (full.endsWith("/components/ui/button.tsx")) continue; // 定義site，不是呼叫端
    files.push(full);
  }
  return files;
}

describe("brandSolid 呼叫端範圍守衛（N10）", () => {
  it("brandSolid（剝註解後）只出現在四個既知的頁面層級呼叫端", () => {
    const root = `${process.cwd()}/src`;
    const tsxFiles = listTsxFiles(root);
    // 釘遞迴確實走到深層子目錄（比照 card.guard.test.ts 的同款釘法）。
    expect(tsxFiles.some((p) => p.endsWith("/auth/guards.tsx"))).toBe(true);

    const offenders = tsxFiles
      .filter((file) => /\bbrandSolid\b/.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.slice(root.length + 1));

    expect(offenders.sort()).toEqual([...ALLOWED_FILES].sort());
  });
});
