import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { oneTimeLinks } from "../db/schema.js";

/**
 * #286 spec §3.1、§3.4：一次性連結（`one_time_links`）的明文格式與有效述詞。落庫只存 `hashToken()`。
 *
 * ⚠ `RESET_TOKEN_PREFIX` **刻意不是** `ACCESS_TOKEN_PREFIX`（`knb_`）的延長：第 4 個字元是 `p` 而不是 `_`，
 * 所以 `isAccessTokenShape("knbp_…")` 為假——重設 token 送到任何 `authenticateAny` 路由都在前綴那關 401、
 * 不查 DB（同 `knbr_`／`knbt_` 的手法）。改前綴前先看 `test/unit/one-time-link.test.ts` 的守衛。
 */
export const RESET_TOKEN_PREFIX = "knbp_";

/** 邀請 PR 擴充成 `| "invite"`（連同 migration 的 `one_time_links_kind_chk`）。 */
export type OneTimeLinkKind = "password_reset";

const PREFIX: Record<OneTimeLinkKind, string> = { password_reset: RESET_TOKEN_PREFIX };

/** 32 bytes＝256 bit 熵，base64url 43 字元，加前綴共 48。 */
export function generateOneTimeToken(kind: OneTimeLinkKind): string {
  return PREFIX[kind] + randomBytes(32).toString("base64url");
}

/** 前綴相符，其後恰好 43 個 base64url 字元。 */
export function isOneTimeTokenShape(kind: OneTimeLinkKind, token: string): boolean {
  const prefix = PREFIX[kind];
  return token.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length));
}

/**
 * spec §3.4 有效述詞的**唯一**定義：kind 相符、未用、未撤銷、未過期（時間一律用 DB 的 `now()`）。
 * `token_hash` 或 `id` 的比對由呼叫端另外 `and` 上。帳密登入開關**不**進這個述詞（由端點另外判斷），
 * 列本身的狀態不受開關影響，重新開啟後自然恢復。
 */
export function activeOneTimeLink(kind: OneTimeLinkKind): SQL {
  return and(
    eq(oneTimeLinks.kind, kind),
    isNull(oneTimeLinks.usedAt),
    isNull(oneTimeLinks.revokedAt),
    sql`${oneTimeLinks.expiresAt} > now()`,
  )!;
}

/**
 * 某人「還沒結束」的重設連結：未用、未撤銷，**不看到期**——再產生、取消、停用都要把過期未用的列一起撤
 * （spec §4.2 N-3；過期未用的列仍佔 I3 的索引位置）。
 */
export function pendingPasswordResetsOf(targetUserId: string): SQL {
  return and(
    eq(oneTimeLinks.kind, "password_reset"),
    eq(oneTimeLinks.targetUserId, targetUserId),
    isNull(oneTimeLinks.usedAt),
    isNull(oneTimeLinks.revokedAt),
  )!;
}
