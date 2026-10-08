import { randomBytes } from "node:crypto";

/**
 * #200 spec §4.1：transfer token 的明文格式。
 *
 * transfer token 是 MCP 工具 `create_transfer_token` 簽給**模型**的短命、單篇、單用途憑證，模型用 `curl` 帶它打
 * `POST /api/notes/:id/uploads`／`GET /api/uploads/:id`（`auth/transfer-auth.ts`）。落庫只存 `hashToken()`。
 *
 * ⚠ `TRANSFER_TOKEN_PREFIX` **刻意不是** `ACCESS_TOKEN_PREFIX`（`knb_`）的延長：第 4 個字元是 `t` 而不是 `_`，
 * 所以 `isAccessTokenShape("knbt_…")` 為假——transfer token 送到任何 `authenticateAny` 路由都在前綴那關 401、
 * 不查 DB（同 `REFRESH_TOKEN_PREFIX` 的手法）。改前綴前先看 `test/unit/transfer-token.test.ts` 的守衛。
 */
export const TRANSFER_TOKEN_PREFIX = "knbt_";

/**
 * spec §4.3a：每支母憑證同時在外的**未消費、未過期** upload token 上限。只算 upload（download 不寫磁碟，受
 * `contentRead` 約束）。消費前被拒（403／429）的 token 仍佔名額直到過期。與 `tokenWrite`（速率）是兩件事。
 */
export const MAX_PENDING_UPLOAD_TOKENS = 5;

export type TransferPurpose = "upload" | "download";

/** 32 bytes＝256 bit 熵，base64url 43 字元，加前綴共 48。 */
export function generateTransferToken(): string {
  return TRANSFER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function isTransferTokenShape(token: string): boolean {
  return token.startsWith(TRANSFER_TOKEN_PREFIX);
}
