import { randomBytes } from "node:crypto";

/**
 * #200：transfer token 的明文格式。
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
 * 每支母憑證同時在外的**未消費、未過期** upload token 上限。只算 upload（download 不寫磁碟，受
 * `contentRead` 約束）。消費前被拒（403／429，及配額落地後第 4a 步的 409 空間已滿）的
 * token 仍佔名額直到過期。與 `tokenWrite`（速率）是兩件事。
 */
export const MAX_PENDING_UPLOAD_TOKENS = 5;

export type TransferPurpose = "upload" | "download";

/**
 * bulk transfer：每支母憑證同時在外的**未過期** bulk 權杖上限（upload／download 不佔）。
 * `TOO_MANY_BULK_TOKENS_MESSAGE` 的「3」是寫死的字面值，對齊由 `bulk-transfer-strings.test.ts` S3 守。
 */
export const MAX_ACTIVE_BULK_TOKENS = 3;

/** bulk transfer：bulk 權杖的壽命上限（另不超過母憑證到期）。 */
export const BULK_TRANSFER_TTL_MINUTES = 30;

/**
 * bulk transfer：`purpose='bulk'` 列的 `access`——簽發當下母憑證有 `notes:write` → `write`。
 */
export type BulkAccess = "read" | "write";

/**
 * bulk transfer：`purpose='bulk'` 列的 `range`（jsonb）。id 一律小寫；範圍在每次使用時重算。
 */
export type BulkRange =
  | { kind: "all" }
  | { kind: "personal" }
  | { kind: "shared" }
  | { kind: "group"; groupId: string }
  | { kind: "folder"; folderId: string };

/** 32 bytes＝256 bit 熵，base64url 43 字元，加前綴共 48。 */
export function generateTransferToken(): string {
  return TRANSFER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function isTransferTokenShape(token: string): boolean {
  return token.startsWith(TRANSFER_TOKEN_PREFIX);
}

/**
 * 簽發交易的兩種「預期內」DB 錯誤，呼叫端在交易外依約束名映射：
 * - note FK（23503）：`resolveNoteAccess` 之後、INSERT 之前筆記被刪 → `not_found`。
 * - expiry CHECK（23514）：母憑證恰在 `now()` 到期，`least(…)` 給出 ≤ `created_at` 的值 → 視同 revoked。
 * 值抄自 migration SQL（drizzle 生成的實名）；`test/migrate.test.ts` 的 cascade 案與 `transfer-token-issue.test.ts` 釘住。
 */
export const TRANSFER_TOKENS_NOTE_FK = "transfer_tokens_note_id_notes_id_fk";
export const TRANSFER_TOKENS_EXPIRY_CHK = "transfer_tokens_expiry_chk";
