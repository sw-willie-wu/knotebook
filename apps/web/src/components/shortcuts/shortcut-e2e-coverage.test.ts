import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "./shortcut-list";

/**
 * 清單 id ⇔ e2e 標籤的雙向核對（plan 2026-11-02-shortcuts-modal K15、T9）。
 *
 * 快捷鍵介紹頁列的每一條，都要有一支在真瀏覽器跑過的 e2e：test 名稱尾端帶 `[sc:<id>]`（`e2e/tests/*.spec.ts`）。
 * 本檔掃那些檔的原始文字：①每個 `SHORTCUTS` id 至少出現在一個 test 標題；②標題裡沒有清單沒有的孤兒標籤；
 * ③每個檔裡 `[sc:` 的總出現次數＝標題裡的次數（擋：寫在註解、template literal 標題、`test.skip`／`test.fixme`／describe 標題裡的標籤）；
 * ④掃到的檔數 ≥ 40（防路徑寫錯而空真）；⑤沒有 `.skip(`、`.fixme(`、`.only(`（擋 `test.describe.skip` 包住、body 內 `test.skip()`）。
 *
 * 守的是「有一支被標記、會跑的 e2e」。**不守**那支 e2e 真的斷言了說明裡的每個字——那由 t1-facts 的「說明子句 → 斷言」對照與 reviewer 逐句核。
 * 也**看不到條件式註冊**：寫在 `if (...) test("… [sc:x]")` 或迴圈裡的 test 照樣被算進去，但環境不符時它根本不會跑；
 * 這個守衛只做靜態文字核對，那一形要靠 review（現在 e2e 目錄沒有這種寫法）。
 * 標籤只認 `test("…")` 的第一個字串引數（純字串字面）；借用既有 spec 的條目就在那些 test 名稱尾端補標籤。
 */

const E2E_DIR = path.resolve(process.cwd(), "../../e2e/tests");

/** 剝掉註解（同 i18n/management-copy.test.ts；`//` 前是 `:` 的當 URL 不剝）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const TITLE_RE = /\btest\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
const TAG_RE = /\[sc:([A-Za-z0-9]+)\]/g;

export interface ScanResult {
  files: string[];
  /** 每個檔：標題裡的標籤、全檔 `[sc:` 次數 */
  perFile: Array<{ file: string; titleTags: string[]; totalOccurrences: number; banned: string[] }>;
}

export function scanE2e(dir: string = E2E_DIR): ScanResult {
  let files: string[];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith(".spec.ts")).sort();
  } catch {
    files = []; // 路徑寫錯：交給 ④ 紅在斷言上（而不是整個檔在收集階段炸掉）
  }
  const perFile = files.map((file) => {
    const source = stripComments(readFileSync(path.join(dir, file), "utf8"));
    const titleTags: string[] = [];
    for (const m of source.matchAll(TITLE_RE)) for (const t of m[2]!.matchAll(TAG_RE)) titleTags.push(t[1]!);
    return {
      file,
      titleTags,
      totalOccurrences: (source.match(/\[sc:/g) ?? []).length,
      banned: [".skip(", ".fixme(", ".only("].filter((s) => source.includes(s)),
    };
  });
  return { files, perFile };
}

describe("清單 id ⇔ e2e 標籤", () => {
  const scan = scanE2e();
  const tagged = new Set(scan.perFile.flatMap((f) => f.titleTags));

  it("④ 掃得到足夠多的 spec 檔（防路徑寫錯而空真）", () => {
    expect(scan.files.length).toBeGreaterThanOrEqual(40);
  });

  it("① 每個 SHORTCUTS id 至少出現在一個 test 標題", () => {
    const missing = SHORTCUTS.map((e) => e.id).filter((id) => !tagged.has(id));
    expect(missing, `沒有 e2e 標籤的條目：${missing.join(", ")}`).toEqual([]);
  });

  it("② 標題裡沒有清單沒有的孤兒標籤", () => {
    const known = new Set(SHORTCUTS.map((e) => e.id));
    const orphans = [...tagged].filter((id) => !known.has(id));
    expect(orphans, `孤兒標籤：${orphans.join(", ")}`).toEqual([]);
  });

  it("③ 每個檔的 `[sc:` 總出現次數＝標題裡的次數（註解、template literal、skip／fixme／describe 標題裡的標籤都會讓總數多出來）", () => {
    const bad = scan.perFile.filter((f) => f.totalOccurrences !== f.titleTags.length).map((f) => `${f.file}: 全檔 ${f.totalOccurrences}、標題 ${f.titleTags.length}`);
    expect(bad).toEqual([]);
  });

  it("⑤ 沒有 .skip(、.fixme(、.only(", () => {
    const bad = scan.perFile.filter((f) => f.banned.length > 0).map((f) => `${f.file}: ${f.banned.join(" ")}`);
    expect(bad).toEqual([]);
  });
});
