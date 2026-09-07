/**
 * #108：`mcp/queries.ts` 的「每次呼叫現造一組 branch select」守衛。
 *
 * **為什麼需要它**（plan Step 1 實跑）：drizzle 的 select builder 是**可變且單次使用**的。
 * 同一組 `owned`／`shared` 拿去組第二個 `unionAll(...)`，產出的是一個多一段 `union all`
 * 的畸形查詢，**不丟例外**；而且污染是**回溯的**——建完第二個之後，回頭對第一個 query
 * 物件 `toSQL()` 也變成畸形形。
 *
 * ⚠ 這裡守的是**我們的組裝函式每次現造**，不是 drizzle 的行為；drizzle 哪天修好了這一族
 * 照樣綠，那正是我們要的。
 *
 * 不連線、只 `.toSQL()`：`pg.Pool` 到一個不可能連上的位址（port 1），從頭到尾不發連線。
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDb } from "../../src/db/index.js";
import { buildNoteListQuery, buildNoteSearchQuery } from "../../src/mcp/queries.js";

const pool = new pg.Pool({ connectionString: "postgres://u:p@127.0.0.1:1/none" });
const db = createDb(pool);

afterAll(async () => {
  await pool.end();
});

const USER = randomUUID();
const CURSOR = { updatedAt: new Date("2026-09-07T00:00:00.000Z"), id: randomUUID() };

const countUnionAll = (sql: string): number => sql.split("union all").length - 1;

describe("#108 buildNoteListQuery", () => {
  it("連呼兩次，兩次的 SQL 都恰含一次 union all", () => {
    const first = buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 });
    const second = buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 });
    expect(countUnionAll(first.toSQL().sql)).toBe(1);
    expect(countUnionAll(second.toSQL().sql)).toBe(1);
  });

  it("建完第二個之後，回頭對第一個物件 toSQL() 仍恰含一次 union all（回溯污染）", () => {
    const first = buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 });
    buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 });
    expect(countUnionAll(first.toSQL().sql)).toBe(1);
  });

  // ⚠ 這一條同時守住那個**靜默漏列**的精度落差：cursor 只有毫秒（JS `Date.toISOString()`），
  // 所以排序鍵與 keyset 述詞的左側都必須先 `date_trunc('milliseconds', …)`。留在微秒的話
  // 「同一毫秒內、微秒較小」的列會被整批切掉，不報錯也不重複——只是不見（整合側有端到端案）。
  it("SQL 含毫秒精度的 keyset 述詞與 union 上的決定性排序", () => {
    const sql = buildNoteListQuery(db, { userId: USER, cursor: CURSOR, limit: 50 }).toSQL().sql;
    // keyset 在**兩支** select 的 where 裡各出現一次，左側是截到毫秒的運算式。
    expect(sql.split(`(date_trunc('milliseconds', "notes"."updated_at"), "notes"."id") <`).length - 1).toBe(2);
    // 殺「keyset 左側直接用原欄位」——那樣寫與 cursor 不同精度。
    expect(sql).not.toContain(`("notes"."updated_at", "notes"."id") <`);
    // 集合運算的 ORDER BY 只收輸出欄位名，所以排序鍵必須是具名輸出欄。
    expect(sql).toContain(`date_trunc('milliseconds', "notes"."updated_at") as "updated_at_ms"`);
    expect(sql).toContain(`order by "updated_at_ms" desc, "id" desc`);
    expect(sql).toMatch(/limit \$\d+$/);
  });

  it("不帶 cursor 時沒有 keyset 述詞，其餘形狀不變", () => {
    const sql = buildNoteListQuery(db, { userId: USER, cursor: null, limit: 50 }).toSQL().sql;
    expect(sql).not.toContain(`"notes"."id") <`);
    expect(countUnionAll(sql)).toBe(1);
    expect(sql).toContain(`order by "updated_at_ms" desc, "id" desc`);
  });
});

describe("#108 buildNoteSearchQuery", () => {
  it("連呼兩次各恰一次 union all，且回頭對第一個物件仍恰一次", () => {
    const first = buildNoteSearchQuery(db, { userId: USER, query: "hello", limit: 20 });
    const second = buildNoteSearchQuery(db, { userId: USER, query: "hello", limit: 20 });
    expect(countUnionAll(first.toSQL().sql)).toBe(1);
    expect(countUnionAll(second.toSQL().sql)).toBe(1);
    expect(countUnionAll(first.toSQL().sql)).toBe(1);
  });

  it("以輸出欄位名 rank 排序，且比對用的是非 pattern 的 position() 不是 like", () => {
    const { sql, params } = buildNoteSearchQuery(db, { userId: USER, query: "50%", limit: 20 }).toSQL();
    // ⚠ `orderBy(rankExpr)`（把 CASE 運算式直接放進 ORDER BY）drizzle 產得出來但 pg 直接拒
    // （`invalid UNION/INTERSECT/EXCEPT ORDER BY clause`）——集合運算的 ORDER BY 只收輸出欄位名。
    expect(sql).toContain(`order by "rank" asc, "updated_at" desc, "id" desc`);
    expect(sql).not.toMatch(/order by[\s\S]*case when/);
    // 非 pattern 判定：`%` 不會被當萬用字元，所以不需要 ESCAPE，也不得出現 like／ilike。
    expect(sql.toLowerCase()).not.toContain(" like ");
    expect(sql.toLowerCase()).not.toContain(" ilike ");
    expect(sql).toContain("position(");
    // 第三關：查詢字串以參數送出，不進 SQL 文字。
    expect(sql).not.toContain("50%");
    expect(params).toContain("50%");
  });
});
