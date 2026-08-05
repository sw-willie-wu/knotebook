export const PG_UNIQUE_VIOLATION = "23505";

/**
 * pg 的 unique_violation（code 23505）在拋出時，可能是原始的 node-postgres
 * `DatabaseError`（`.code` 直接在最外層），也可能被 drizzle-orm 包成
 * `DrizzleQueryError`（原始 pg 錯誤落在 `.cause`）——兩種形狀都要認得，否則
 * 唯一鍵違反會被 `throw err` 一路冒到最外層變成未預期的 500。
 *
 * 共用處：`routes/setup.ts`（users.email）、`routes/admin-users.ts`（users.email）
 * 皆從這裡 import，不各自重複宣告一份判定邏輯。
 */
export function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): unknown => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  if (code(err) === PG_UNIQUE_VIOLATION) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return code(cause) === PG_UNIQUE_VIOLATION;
}
