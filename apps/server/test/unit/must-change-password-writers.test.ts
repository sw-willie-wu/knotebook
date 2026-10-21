/**
 * #285 V5：`must_change_password` 沒有寫入端——server 原始碼（剝掉註解後）不得出現把它設成 true 的寫法。
 * 註冊、接受邀請、OIDC 自動建帳、env bootstrap 皆為 false；只剩舊版代建、尚未改密碼的帳號帶著 true。
 * 保留的消費端（`ChangePasswordGate`、改密碼清旗標等）見 spec §2-4，不在此掃描。
 * 抓得到：drizzle 欄位 `mustChangePassword: true`（key 可帶引號）、`mustChangePassword: sql\`true\``（不分大小寫）、
 * 裸 SQL 字面 `must_change_password = true`。
 * 抓不到：變數間接（`const v = true`）、raw SQL 的 INSERT 欄位清單／別的 UPDATE 寫法、字串拼接；
 * 誤報：只讀查詢的 `where must_change_password = true`、回應 DTO／TS 型別裡的 `mustChangePassword: true`、字串字面值。靠 review 補，不追求窮舉。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

// walk／code 與 s14-structure.test.ts 同形（複製；該檔未 export）。
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}
function code(p: string): string {
  return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const WRITERS = [/["']?mustChangePassword["']?\s*:\s*(true\b|sql`\s*true\s*`)/i, /must_change_password\s*=\s*true/i];

describe("V5：must_change_password 沒有寫入端", () => {
  it("src 內沒有任何檔把它寫成 true", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(50); // walk 真的走到東西
    const hits = files.filter(p => WRITERS.some(re => re.test(code(p)))).map(p => path.relative(SRC, p).split(path.sep).join("/"));
    expect(hits).toEqual([]);
    // 正向對照：掃描真的讀得到寫入端（register.ts 顯式寫 false）——掃描空轉時這條會紅。
    expect(files.some(p => /mustChangePassword\s*:\s*false\b/.test(code(p)))).toBe(true);
  });

  it("兩條 regex 各自認得目標形（自檢，避免守衛空轉）", () => {
    expect(WRITERS[0].test("set({ mustChangePassword: true })")).toBe(true);
    expect(WRITERS[0].test("set({ mustChangePassword: sql`true` })")).toBe(true);
    expect(WRITERS[0].test("set({ mustChangePassword: false })")).toBe(false);
    expect(WRITERS[0].test('set({ "mustChangePassword": true })')).toBe(true);
    expect(WRITERS[0].test("set({ 'mustChangePassword': true })")).toBe(true);
    expect(WRITERS[0].test("set({ mustChangePassword: sql`TRUE` })")).toBe(true);
    expect(WRITERS[1].test("update users set must_change_password = true")).toBe(true);
    expect(WRITERS[1].test("update users set must_change_password = false")).toBe(false);
  });
});
