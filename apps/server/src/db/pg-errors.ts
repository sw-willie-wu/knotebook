export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_SERIALIZATION_FAILURE = "40001";
export const PG_DEADLOCK_DETECTED = "40P01";

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
 * 共用處：`routes/oidc.ts`（整-tx-重投的觸發判定）、`routes/admin-ai.ts`（model 唯一鍵）。
 * `routes/notes.ts`、`routes/admin-users.ts` 與 `routes/auth.ts` 自 #122 起改用下面的
 * `uniqueViolationConstraint`（各自的表有多把唯一鍵，需要 constraint 名分流）。
 */
export function isUniqueViolation(err: unknown): boolean {
  return matchesCode(err, PG_UNIQUE_VIOLATION);
}

function constraintOf(e: unknown): string | null {
  const value =
    typeof e === "object" && e !== null && "constraint" in e ? (e as { constraint?: unknown }).constraint : undefined;
  return typeof value === "string" ? value : null;
}

/**
 * unique violation 的 **constraint 名**（#122 判別契約 M4-2）：`users` 表如今有
 * email 與 handle 兩把唯一鍵、`handles` 表另有 PK——「任何 unique violation →
 * email_taken」的舊映射會把 handle 撞名誤報成「此 email 已被使用」。呼叫端依
 * constraint 名分流（`handles_pkey`/`users_handle_unique` → handle_taken、
 * `users_email_unique` → email_taken、`notes_owner_slug_idx` → slug_taken），
 * 其他名字一律 rethrow（不認識的唯一鍵違反不該被猜成任何一種 409）。非 unique
 * violation 回 null。
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (!isUniqueViolation(err)) return null;
  const direct = constraintOf(err);
  if (direct !== null) return direct;
  return constraintOf(err instanceof Error ? err.cause : undefined);
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

/**
 * pg 的 serialization_failure（40001）／deadlock_detected（40P01）——`notes/links.ts` 的
 * `writeNoteLinks` 用它辨識「交易本身沒有邏輯錯誤，純粹是併發衝突」的情況，映射成 409
 * `server_busy`（既有 code，setup/auth/admin-users 的 `HashBusyError` 已在用；此處是第二個
 * 發送點，語意皆為「請稍後重試」，code 與 HTTP status 本非一對一）。與 `isForeignKeyViolation`
 * 分開判定：FK violation 代表某個 target 筆記在授權查詢之後、寫入之前被刪除（可恢復——剔除
 * 該 target 重試一次），這兩個 40001/40P01 代表 DB 層級的交易衝突（不可恢復，直接回應
 * client 重試，不在 server 端重試第二次）。
 */
export function isTransientTransactionError(err: unknown): boolean {
  return matchesCode(err, PG_SERIALIZATION_FAILURE) || matchesCode(err, PG_DEADLOCK_DETECTED);
}
