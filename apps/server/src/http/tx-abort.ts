import type { ErrorCode } from "@knotebook/shared";

/**
 * 交易內的業務拒絕。drizzle 的 `db.transaction(cb)` **只在 cb throw 時 ROLLBACK**（正常 return 一律
 * COMMIT）——所以拒絕一律 throw 這個，由呼叫端在交易外 `instanceof` 判定後 `sendError`。
 * 欄位刻意叫 `errCode` 不叫 `code`：pg 錯誤的 SQLSTATE 也在 `.code`，同名會讓判定順序變成靠字面值不撞的巧合。
 */
export class TxAbort extends Error {
  constructor(
    readonly status: number,
    readonly errCode: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TxAbort";
  }
}
