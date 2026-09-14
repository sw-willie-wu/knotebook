/**
 * #108：`list_notes`／`search_notes` 的查詢**組裝**（只組不執行——呼叫端自己 `await`）。
 *
 * ⚠ **兩支 branch select 是單次使用的一次性物件**：drizzle 的 select builder 可變，同一組
 * 拿去組第二個 `unionAll(...)` 會產出多一段 `union all` 的畸形查詢、**不報錯**，而且污染是
 * **回溯的**（回頭對第一個 query 物件 `toSQL()` 也變形）。所以每一個 `unionAll(...)` 都要
 * 自己現造一組——守衛是 `test/unit/mcp-query-builders.test.ts`。
 * 要判「還有沒有下一頁」就 `.limit(limit + 1)`，**不要發第二個查詢**。
 *
 * ⚠ 集合運算的 ORDER BY **只收輸出欄位名**：`orderBy(rankExpr, …)`（把 CASE 運算式直接放
 * 進去）drizzle 產得出 SQL 但 pg 直接拒（`invalid UNION/INTERSECT/EXCEPT ORDER BY clause`），
 * 所以 rank 要先 `.as("rank")` 成為輸出欄、再 `orderBy(asc(rank))`。
 *
 * 可見性語意（owned ∪ shared）不在這裡——它只有一份，在 `notes/list-query.ts`（D-H）。
 */
import { asc, desc, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { visibleNoteBranches } from "../notes/list-query.js";

/** `list_notes` 的 keyset 游標解出來的值（`(updatedAt, id)` 的元組）。 */
export interface NoteListCursor {
  updatedAt: Date;
  id: string;
}

/**
 * **排序鍵刻意降到毫秒**，理由是一個會靜默漏列的精度落差：`notes.updated_at` 是
 * `timestamptz`（pg 的 `now()` ＝**微秒**），而 cursor 走 JS `Date` → `toISOString()`
 * ＝**毫秒**。排序鍵若留在微秒，`(updated_at, id) < (cursor.ts, cursor.id)` 會把「同一毫秒
 * 內、微秒較小」的列整批切掉——不報錯、不重複，就是不見。曝險是常態面：**生產路徑上所有
 * 筆記的 `updated_at` 都是 pg 的 `now()`**，全是微秒精度。
 * 降到毫秒之後排序鍵＝模型看得到的 `updatedAt`，語意自洽；REST 側一個字都不改。
 * ⚠ 集合運算的 ORDER BY 只收輸出欄位名，所以它必須是一個具名輸出欄（`updated_at_ms`）。
 * ⚠ **`.mapWith(notes.updatedAt)` 不可省**（實測，不是推論）：drizzle 覆寫掉 node-postgres 對
 * 日期／時間戳的解析器、改由**欄位**自己 `mapFromDriverValue`，而 raw `sql` 運算式沒有欄位
 * ——不 `mapWith` 拿到的是 pg 的原始字串 `"2026-04-01 00:00:00.123+00"`（不是 `Date`、也不是
 * ISO 形），`toISOString()` 直接 throw。`sql<Date>` 只是**型別標註**，tsc 不會抓到。
 * 數值不受影響（node-postgres 自己的 int 解析器仍在）——所以下面 `search` 的 `rank`
 * 在執行期真的是 `number`，**不需要**也不該替它加 `mapWith`。
 */
const updatedAtMsExpr = sql`date_trunc('milliseconds', ${notes.updatedAt})`.mapWith(notes.updatedAt);

export function buildNoteListQuery(
  db: Db,
  opts: { userId: string; cursor: NoteListCursor | null; limit: number }
) {
  // 元組比較（不是兩個 AND 條件）——與 `order by … desc, id desc` 是同一把尺，
  // 拆成 AND 就會在時間戳相同的邊界上漏列。**左側必須與排序鍵同精度。**
  const keyset: SQL | undefined =
    opts.cursor === null
      ? undefined
      : sql`(${updatedAtMsExpr}, ${notes.id}) < (${opts.cursor.updatedAt}, ${opts.cursor.id})`;
  const updatedAtMs = updatedAtMsExpr.as("updated_at_ms");
  const { owned, shared } = visibleNoteBranches(db, opts.userId, {
    extraWhere: keyset,
    extra: { updatedAtMs },
  });
  // 多取一列：第 `limit + 1` 列只用來算 `nextCursor`，不回給模型。
  return unionAll(owned, shared)
    .orderBy(desc(updatedAtMs), desc(notes.id))
    .limit(opts.limit + 1);
}

export function buildNoteSearchQuery(db: Db, opts: { userId: string; query: string; limit: number }) {
  const q = opts.query;
  // **非 pattern 判定**：`LIKE`／`ILIKE` 會把 `%`／`_` 當萬用字元，要正確處理就得加 `ESCAPE`
  // 與跳脫——那條路寫錯了只會「搜尋結果怪怪的」不會變紅。`position()` 完全沒有這個面。
  const match = sql`position(lower(${q}) in lower(${notes.title})) > 0`;
  // 兩支 select 餵**同一個** `rank`（union 兩支的 select shape 必須逐欄同形）。
  const rank = sql<number>`case
    when lower(${notes.title}) = lower(${q}) then 0
    when position(lower(${q}) in lower(${notes.title})) = 1 then 1
    else 2 end`.as("rank");
  const { owned, shared } = visibleNoteBranches(db, opts.userId, { extraWhere: match, extra: { rank } });
  return unionAll(owned, shared)
    .orderBy(asc(rank), desc(notes.updatedAt), desc(notes.id))
    .limit(opts.limit + 1);
}
