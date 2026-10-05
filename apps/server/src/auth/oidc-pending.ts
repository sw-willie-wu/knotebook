import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { sealCookieJson, unsealCookieJson } from "./sealed-cookie.js";
import { OIDC_STATE_COOKIE_PATH } from "./oidc-state.js";

// #187 §7.5.1：「詢問是否連結」的待連結身分。callback 遇到 confirm_link 時封章、`/link-account` 頁經
// `GET/POST /api/auth/oidc/pending*` 讀。一個瀏覽器同時只有一顆（新的 confirm_link 覆蓋舊的；兩分頁形靠 pendingId，C18）。

export const OIDC_PENDING_COOKIE = "knotebook_oidc_link";
/** 15 分鐘：要容得下一段 600 秒的 OIDC 往返（SSO 證明，§7.5.3）。 */
export const OIDC_PENDING_TTL_SECONDS = 900;
/** 瀏覽器每顆約 4096，超過會被**靜默丟掉**；3800 留餘裕（spec §7.5.1，r2-M2）。量的是 `name=value`。 */
export const OIDC_PENDING_MAX_COOKIE_BYTES = 3800;
const NAMESPACE = "oidc-pending-link";

export interface PendingLinkPayload {
  /** 每次封章新產的 128-bit 隨機值：把「這一次待連結」綁到頁面送出與第二段 OIDC 往返（§7.5.3）。 */
  pendingId: string;
  /** 等待連結的新身分（＝IdP 的 serverMetadata().issuer）與 provider。 */
  issuer: string;
  sub: string;
  providerId: string;
  /** 要連到的既有帳號與封章當下它的 email（已正規化；鎖內以 lower(email) 再比一次）。 */
  userId: string;
  email: string;
  /** epoch 秒，server 端驗。 */
  exp: number;
  /** 已過 safeNextPath；使用前再過一次。 */
  next?: string;
}

export function newPendingId(): string {
  return randomBytes(16).toString("base64url");
}

export function sealPendingLink(appSecret: string, payload: PendingLinkPayload): string {
  return sealCookieJson(appSecret, NAMESPACE, payload);
}

export function unsealPendingLink(appSecret: string, sealed: string, nowEpochSeconds: number): PendingLinkPayload | null {
  const parsed = unsealCookieJson(appSecret, NAMESPACE, sealed);
  if (parsed === null || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  for (const key of ["pendingId", "issuer", "sub", "providerId", "userId", "email"] as const) {
    if (typeof p[key] !== "string") return null;
  }
  if (typeof p.exp !== "number") return null;
  if (p.next !== undefined && typeof p.next !== "string") return null;
  if (p.exp <= nowEpochSeconds) return null;
  return parsed as PendingLinkPayload;
}

export function pendingCookieBytes(sealed: string): number {
  return Buffer.byteLength(`${OIDC_PENDING_COOKIE}=${sealed}`, "utf8");
}

/**
 * §7.5.1 大小規則：封章後 `name=value` 超過 3800 就捨棄 `next` 重封（連結完落 `/`）；其餘欄位都有上限（issuer ≤512、sub ≤255、
 * email ≤254——callback 拒收超長的，§7.3 第 5 步），捨棄後最壞約 1671 bytes【驗：plan 複驗第 21 條】。仍超過（防禦縱深；
 * 例如 JSON 逸出把非 ASCII 字元撐大）→ null，呼叫端不封章、log.warn、導 oidc_claim_too_long。
 */
export function sealPendingLinkWithinLimit(appSecret: string, payload: PendingLinkPayload): { sealed: string; droppedNext: boolean } | null {
  const full = sealPendingLink(appSecret, payload);
  if (pendingCookieBytes(full) <= OIDC_PENDING_MAX_COOKIE_BYTES) return { sealed: full, droppedNext: false };
  const withoutNext: PendingLinkPayload = { ...payload };
  delete withoutNext.next;
  const trimmed = sealPendingLink(appSecret, withoutNext);
  if (pendingCookieBytes(trimmed) <= OIDC_PENDING_MAX_COOKIE_BYTES) return { sealed: trimmed, droppedNext: true };
  return null;
}

/** 同 state cookie：`Path=/api/auth/oidc`、HttpOnly、Lax、Secure 同 session。 */
export function setPendingCookie(reply: FastifyReply, config: Pick<AppConfig, "cookieSecure">, sealed: string): void {
  reply.setCookie(OIDC_PENDING_COOKIE, sealed, {
    httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: OIDC_STATE_COOKIE_PATH, maxAge: OIDC_PENDING_TTL_SECONDS,
  });
}

/** clearCookie 必須帶與 setCookie 相同的 path／sameSite／secure，否則瀏覽器不認得是同一顆。 */
export function clearPendingCookie(reply: FastifyReply, config: Pick<AppConfig, "cookieSecure">): void {
  reply.clearCookie(OIDC_PENDING_COOKIE, { path: OIDC_STATE_COOKIE_PATH, sameSite: "lax", secure: config.cookieSecure });
}

export function readPendingLink(request: FastifyRequest, appSecret: string): PendingLinkPayload | null {
  const raw = request.cookies[OIDC_PENDING_COOKIE];
  return raw === undefined ? null : unsealPendingLink(appSecret, raw, Math.floor(Date.now() / 1000));
}
