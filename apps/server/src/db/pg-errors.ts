export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";

// 兩種錯誤形狀都要認得（見下方個別 export 的說明）：原始的 node-postgres
// `DatabaseError`（`.code` 直接在最外層），或被 drizzle-orm 0.44 包成
// `DrizzleQueryError`（原始 pg 錯誤落在 `.cause`）。
function code(e: unknown): unknown {
  return typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined;
}

function matchesCode(err: unknown, target: string): boolean {
  if (code(err) === target) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return code(cause) === target;
}

/**
 * pg 的 unique_violation（code 23505）——否則唯一鍵違反會被 `throw err` 一路冒到
 * 最外層變成未預期的 500。
 *
 * 共用處：`routes/setup.ts`（users.email）、`routes/admin-users.ts`（users.email）
 * 皆從這裡 import，不各自重複宣告一份判定邏輯。
 */
export function isUniqueViolation(err: unknown): boolean {
  return matchesCode(err, PG_UNIQUE_VIOLATION);
}

/**
 * pg 的 foreign_key_violation（code 23503）——`collab/store.ts` 的 `onStoreDocument`
 * 用它辨識「筆記已被刪除，note_states 首次 insert 撞到外鍵」，據此丟棄該次寫入而不是
 * 讓錯誤一路冒到 Hocuspocus 的 hook 執行器（見 `store.ts` 對「筆記不存在 → 丟棄」硬規則
 * 的說明）。
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return matchesCode(err, PG_FOREIGN_KEY_VIOLATION);
}
