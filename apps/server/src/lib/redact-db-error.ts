import { pgErrorSummary } from "../db/pg-errors.js";

/**
 * 寫入密文欄時遇到**非預期**的 DB 錯誤（#187 PR2 Task 3 審查 m1）。
 *
 * drizzle-orm 0.44 的 `DrizzleQueryError` 把整條 SQL 與 `params` 串進 `message`、也把 `params` 掛成可列舉屬性；全域 error
 * handler（`app.ts` 的 `setErrorHandler`）會把整個 err 交給 pino——寫 `client_secret_encrypted` 的那一句一旦非預期失敗，log 就帶走
 * jsonb 的 `ct`／`iv`／`tag`。pg 原生錯誤的 `detail`（例如 CHECK 的「Failing row contains (…)」）同理。
 *
 * 用法：呼叫端先處理自己認得的錯誤（`TxAbort`、已知 constraint 名），**其餘一律** `throw redactDbError(request.log, err, 情境)`；
 * `context` 是呼叫端的動作描述（例如「修改登入服務」），log 訊息寫成「<context>時發生非預期的資料庫錯誤」。
 * 這裡只記 `{ code, constraint, context }`（不含 message／detail／params／cause）；不是 pg 錯誤（沒有 SQLSTATE）時另記錯誤的
 * `name` 方便除錯——仍不記 message（非 pg 錯誤也可能是包了 params 的 drizzle 錯誤）。回一個不帶 cause 的新錯誤，讓全域 handler 照舊回 500。
 */
export function redactDbError(log: { error(obj: object, msg: string): void }, err: unknown, context: string): Error {
  const { code, constraint } = pgErrorSummary(err);
  const summary = code === null ? { code, constraint, name: err instanceof Error ? err.name : typeof err } : { code, constraint };
  log.error({ ...summary, context }, `${context}時發生非預期的資料庫錯誤（錯誤本體已遮蔽）`);
  return new Error(`${context}：資料庫錯誤（code ${code ?? "unknown"}；細節已遮蔽）`);
}
