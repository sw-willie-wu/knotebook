/**
 * 儲存配額的結構性守衛（spec 2026-10-08 §11.3）。剝註解後掃 `src/`（剝法同 s14-structure.test.ts 的 `code()`）。
 * 誠實：字面掃描——改名重匯出、別名呼叫、經另一模組轉手等刻意規避守不到；行為面由 storage-quota-race.test.ts 的 R1／R13 守。
 *   ① `insert(uploads)` 只在 U-tx 與 T4（新增 uploads 列的路徑必須進白名單——§6.7）
 *   ② `assertSpaceRoomInTx(` 呼叫形只在白名單四檔、各恰一次；delete-group.ts 那一次在 `transferGroupInTx` 函式體內；
 *      quota.ts 恰一次宣告形、0 次呼叫形；其他檔 0 次（Q-S1、Q-S3）
 *   ③ `pg_advisory` 只在 quota.ts
 *   ④ quota.ts 取鎖那個 `tx.execute(` 呼叫不含 `sum(`；之後另有 SUM 查詢（M3：兩句）
 *   ⑤ 白名單檔裡 `assertSpaceRoomInTx(` 早於同函式的 `writeSlugInTx(`／`insertNoteWithAutoSlug(`（Q-S7 的字面守衛）
 *   ⑥ quota.ts、白名單四檔與其路由檔不出現 isolationLevel／setTransaction／set transaction（限定範圍：#93 的
 *      search-query.ts 合法使用 setTransaction——跨 spec I-1，所以不掃整個 src/）
 *   ⑦ HTTP 409 的中文訊息「儲存空間已滿」只在 storage/space.ts（STORAGE_QUOTA_EXCEEDED_MESSAGE）——errors.ts 的 helper 與
 *      StorageQuotaExceeded 都引用它；字面散在兩處時，改一處另一處就漂（PR1 review 擱置項）
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}
function code(p: string): string {
  return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const at = (f: string) => code(path.join(SRC, f));

/** `src[open]` 是 `(` 或 `{`：回傳配對的內文。 */
function balanced(src: string, open: number): { body: string; end: number } {
  const o = src[open]!, c = o === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return { body: src.slice(open + 1, i), end: i };
  }
  throw new Error(`不配對：${open}`);
}
/** `function name(` 的函式體區間 [start, end]。 */
function fnBody(src: string, name: string): { start: number; end: number } {
  const m = new RegExp(`\\bfunction\\s+${name}\\b`).exec(src);
  if (!m) throw new Error(`找不到 function ${name}`);
  const paren = src.indexOf("(", m.index);
  const afterParams = balanced(src, paren).end;
  // 函式體的 `{`＝參數之後第一個「前一個非空白字元是 `)` 或 `>`」的 `{`——跳過回傳型別裡的物件型別
  // （`Promise<{ removedShareUserIds: string[] }>` 的 `{` 前一個字元是 `<`）。
  let brace = afterParams;
  for (;;) {
    brace = src.indexOf("{", brace + 1);
    if (brace < 0) throw new Error(`找不到 ${name} 的函式體`);
    const prev = src.slice(0, brace).trimEnd().slice(-1);
    if (prev === ")" || prev === ">") break;
  }
  return { start: brace, end: balanced(src, brace).end };
}

const WHITELIST = ["uploads/tx/insert-upload.ts", "notes/tx/copy.ts", "notes/tx/move.ts", "groups/tx/delete-group.ts"];
const CALL = /(?<!function\s+)\bassertSpaceRoomInTx\(/g;
const DECL = /\bfunction\s+assertSpaceRoomInTx\(/g;

describe("儲存配額結構性守衛（spec §11.3）", () => {
  const files = walk(SRC);

  it("① insert(uploads) 只在 uploads/tx/insert-upload.ts 與 notes/tx/copy.ts", () => {
    expect(files.length).toBeGreaterThan(50); // 非空洞：真的掃到了 src/
    const hits = files.filter(p => /\.insert\(\s*uploads\s*\)/.test(code(p))).map(rel).sort();
    expect(hits).toEqual(["notes/tx/copy.ts", "uploads/tx/insert-upload.ts"]);
  });

  it("② assertSpaceRoomInTx 呼叫形：白名單四檔各恰一次、其他 0 次；quota.ts 恰一次宣告形；delete-group 那次在 transferGroupInTx 內", () => {
    const counts: Record<string, number> = {};
    for (const p of files) {
      const n = [...code(p).matchAll(CALL)].length;
      if (n > 0) counts[rel(p)] = n;
    }
    expect(counts).toEqual(Object.fromEntries(WHITELIST.map(f => [f, 1])));
    expect([...at("storage/tx/quota.ts").matchAll(DECL)]).toHaveLength(1);
    expect([...at("storage/tx/quota.ts").matchAll(CALL)]).toHaveLength(0);
    const dg = at("groups/tx/delete-group.ts");
    const idx = dg.search(/(?<!function\s+)\bassertSpaceRoomInTx\(/);
    const t6 = fnBody(dg, "transferGroupInTx");
    expect(idx > t6.start && idx < t6.end).toBe(true);
  });

  it("③ pg_advisory 只在 storage/tx/quota.ts", () => {
    expect(files.filter(p => /pg_advisory/.test(code(p))).map(rel)).toEqual(["storage/tx/quota.ts"]);
  });

  it("④ quota.ts：取鎖那個 tx.execute( 不含 sum(；之後另有 SUM 查詢", () => {
    const q = at("storage/tx/quota.ts");
    const lockAt = q.indexOf("pg_advisory_xact_lock");
    expect(lockAt).toBeGreaterThan(-1);
    const execAt = q.lastIndexOf("tx.execute(", lockAt);
    expect(execAt).toBeGreaterThan(-1);
    const { body, end } = balanced(q, execAt + "tx.execute".length);
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).not.toMatch(/sum\(|sumUploadSizeSql/i);
    expect(q.slice(end)).toMatch(/sumUploadSizeSql\(\)/);
  });

  it("⑤ 空間鎖早於同函式的 slug 寫入（Q-S7）", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["notes/tx/copy.ts", "copyNoteInTx", /\binsertNoteWithAutoSlug\(/],
      ["notes/tx/move.ts", "moveNoteToGroupInTx", /\bwriteSlugInTx\(/],
      ["groups/tx/delete-group.ts", "transferGroupInTx", /\bwriteSlugInTx\(/],
    ];
    for (const [f, fn, write] of cases) {
      const src = at(f);
      const { start, end } = fnBody(src, fn);
      const body = src.slice(start, end);
      const lock = body.search(/(?<!function\s+)\bassertSpaceRoomInTx\(/);
      const w = body.search(write);
      expect(lock, `${f} 有空間鎖`).toBeGreaterThan(-1);
      expect(w, `${f} 有 slug 寫入`).toBeGreaterThan(-1);
      expect(lock < w, `${f}：assertSpaceRoomInTx 必須早於 slug 寫入`).toBe(true);
    }
  });

  it("⑥ 限定範圍不得設隔離等級", () => {
    const scoped = ["storage/tx/quota.ts", ...WHITELIST, "routes/uploads.ts", "routes/notes.ts", "routes/groups.ts", "notes/copy-note.ts"];
    // 非空洞：每個限定檔都讀得到內容（at 讀不到會 throw）
    for (const f of scoped) expect(at(f).length, `${f} 非空`).toBeGreaterThan(100);
    const bad = scoped.filter(f => /isolationLevel|setTransaction|set\s+transaction/i.test(at(f)));
    expect(bad).toEqual([]);
  });

  it("⑦ 「儲存空間已滿」字面只在 storage/space.ts（errors.ts 與 quota.ts 都引用常數）", () => {
    const hits = files.filter(p => code(p).includes("儲存空間已滿")).map(rel).sort();
    expect(hits).toEqual(["storage/space.ts"]);
    expect(at("http/errors.ts")).toContain("STORAGE_QUOTA_EXCEEDED_MESSAGE");
  });
});
