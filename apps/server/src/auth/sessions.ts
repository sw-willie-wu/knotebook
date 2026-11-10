import { and, eq, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import type { CollabHooks } from "../collab/hooks.js";
import { setSessionCookie } from "./cookies.js";
import { signSession, verifySession, type UserGate } from "./session.js";
import { newSessionValues } from "./tx/sessions.js";

/**
 * #388：網頁登入的伺服器端 session（`sessions` 表）。發登入 cookie 的地方**一律**經這裡，不直接 `signSession`＋`setSessionCookie`：
 *
 * - 一般登入（帳密、註冊、接受邀請、OIDC 登入／首登建帳、SSO 證明連結、密碼證明連結）→ `startSession`：先刪掉這台瀏覽器
 *   帶來的同帳號舊 session 的列（若有），再建一列、簽、發 cookie。
 * - 會 bump `tokenVersion` 的本人操作 → bump 與換列（刪光該使用者的列、給本機新的一列）在同一個交易：改密碼、加上密碼
 *   （`tx/change-password.ts`）、以重設連結設新密碼（`tx/password-reset.ts`），交易後 `setSessionCookieFor`。
 * - 停用帳號 → `disableUserInTx` 同交易刪光。
 * - 登出 → `deleteSessionFromCookie`（只刪這一列）＋ `collabHooks.onSessionRevoked`（`routes/auth.ts`）。
 *
 * 真正「立刻踢掉其他裝置」的仍是 tv bump＋`gate.invalidate`（照舊）；刪列讓那些 JWT 就算 tv 對得上也沒有列可用。
 */

export interface SessionDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
}

/**
 * 同一個帳號在同一台瀏覽器重新登入、作廢了舊 session 之後，等多久才重驗由舊 sid 換得的共編連線（見 `startSession`）。
 * 要夠長，讓瀏覽器在重驗前就存好新 cookie；也是「被複製走的舊 cookie 開著的連線」被關的時間上限的主要部分
 * （再加既有的重驗 deadline `COLLAB_REVERIFY_DEADLINE_MS`，5 秒）。
 */
export const RELOGIN_REVERIFY_DELAY_MS = 10_000;

/** `startSession` 多要的兩樣：重驗用的 hooks，以及延遲（只給測試縮短；未設＝`RELOGIN_REVERIFY_DELAY_MS`）。 */
export interface StartSessionDeps extends SessionDeps {
  collabHooks: CollabHooks;
  reloginReverifyDelayMs?: number;
}

/** 建一列 session，回 `sid`。 */
export async function insertSession(db: Db, userId: string): Promise<string> {
  const [row] = await db.insert(sessions).values(newSessionValues(userId)).returning({ id: sessions.id });
  return row!.id;
}

/** 簽 session JWT（帶 `sid`）並發 cookie。列必須已經建好。 */
export async function setSessionCookieFor(
  reply: FastifyReply,
  config: AppConfig,
  session: { userId: string; tv: number; sid: string },
): Promise<void> {
  const jwt = await signSession(config.appSecret, session);
  setSessionCookie(reply, config, jwt);
}

/**
 * 刪掉請求帶來的那張 session cookie 的列：簽章對（不看 tv／停用／列是否過期）就刪那一列、清 gate 的 session 快取，回傳被刪的
 * `{ userId, sid }`（共編連線要不要立刻重驗由呼叫端決定：登出要，登入不要——見 `startSession`）。沒帶 cookie、簽章壞、沒有 `sid` 的
 * 舊 JWT：什麼都不做、回 null。JWT 本身過期（`exp` 過了）也不做——那一列同樣已經過期，等清理。
 * `onlyUserId`：給了就只在那張 cookie 屬於這個帳號時才動（`startSession` 用，理由見那裡）。
 *
 * 列早已不在（登出過、被換掉、過期被清掉）也回 null：沒有東西要作廢，不清快取、不重驗、不排延遲重驗。
 * **永不拋錯**：刪列撞到 DB 錯誤只記 error log、回 null（登出照樣清 cookie、登入照樣發新的；那一列留到過期）。
 * ⚠ 順序：先 DELETE 再 `invalidateSession`（反過來，中間那一發會把「列還在」寫回快取，見 `UserGate` 的 class 註解）；
 * DELETE 失敗就不清快取（列還在）。
 */
export async function deleteSessionFromCookie(
  deps: SessionDeps,
  request: FastifyRequest,
  onlyUserId?: string,
): Promise<{ userId: string; sid: string } | null> {
  const token = request.cookies[SESSION_COOKIE];
  const session = token ? await verifySession(deps.config.appSecret, token) : null;
  if (!session) return null;
  if (onlyUserId !== undefined && session.userId !== onlyUserId) return null;
  let deleted: Array<{ id: string }>;
  try {
    // `userId` 一併比對：JWT 驗過簽章才走到這裡，這只是防禦縱深。
    deleted = await deps.db
      .delete(sessions)
      .where(and(eq(sessions.id, session.sid), eq(sessions.userId, session.userId)))
      .returning({ id: sessions.id });
  } catch (err) {
    request.log.error({ err, userId: session.userId }, "failed to delete session row");
    return null;
  }
  if (deleted.length === 0) return null;
  deps.gate.invalidateSession(session.sid);
  return { userId: session.userId, sid: session.sid };
}

/**
 * 一般登入：這台瀏覽器若帶著**同一個帳號**先前那張 session cookie，先作廢它（同一台重新登入後，舊 cookie 的副本也跟著失效），
 * 再建列、簽、發 cookie，最後機會性清過期列（fire-and-forget，失敗只 warn——比照 `transfer-cleanup.ts`。沒有排程：登入是最自然
 * 的時機，每次登入最多清一批，積壓會隨之後的登入清完）。
 *
 * 只限同一個帳號：#187 的 RF4（`oidc-pending.test.ts`）定過「瀏覽器已登入另一個帳號 V，完成連結登入目標帳號後，V 的 session
 * 不受影響」。那張別人的 cookie 在這台瀏覽器上會被新 cookie 蓋掉，但它的列（與副本）照舊留到 V 自己登出或過期。
 *
 * **延遲重驗舊 session 的共編連線**（與登出的立即重驗不同）：同一台瀏覽器重登時，舊分頁若立刻被要求重驗，它取 token 可能早於
 * 瀏覽器存好新 cookie → 401 → 被導到登入頁。所以這裡只刪列＋清快取，再排一個 `RELOGIN_REVERIFY_DELAY_MS`（10 秒）後的
 * `onSessionRevoked(userId, 舊 sid)`：那時這台瀏覽器早已存好新 cookie，舊分頁用新 cookie 換到新 sid 的 token、連線留著（handle 的
 * sid 隨之更新）；被複製走的舊 cookie 開著的連線取不到 token（舊 sid 已不在），最晚約 10 秒＋重驗 deadline（5 秒）被關。
 * 不排的話沒有上限：collab token 的 120 秒 TTL 只在握手與重驗時檢查，server 不會定期重驗已建立的連線。
 * timer `unref()`：不讓它撐住 process 的關閉；關閉期間才 fire 也安全（hooks 不拋錯）。
 */
export async function startSession(
  deps: StartSessionDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  user: { userId: string; tv: number },
): Promise<void> {
  const replaced = await deleteSessionFromCookie(deps, request, user.userId);
  if (replaced) {
    const timer = setTimeout(() => deps.collabHooks.onSessionRevoked(replaced.userId, replaced.sid), deps.reloginReverifyDelayMs ?? RELOGIN_REVERIFY_DELAY_MS);
    timer.unref();
  }
  const sid = await insertSession(deps.db, user.userId);
  await setSessionCookieFor(reply, deps.config, { ...user, sid });
  void deleteExpiredSessions(deps.db).catch((err: unknown) => {
    request.log.warn({ err }, "failed to delete expired sessions");
  });
}

/** 一批的上限：清理跑在登入請求之後（不 await），不讓積壓很久的一次清理變成一句很大的 DELETE。 */
const EXPIRED_SESSION_BATCH = 1000;

/**
 * 過期 session 列的清理。⚠ `for update skip locked` 承重（同 `transfer-cleanup.ts`）：換列、停用、刪使用者的 cascade 可能正鎖著
 * 同一批列，跳過被鎖的列就沒有等待、沒有循環（那些列正在被刪）。
 */
export async function deleteExpiredSessions(db: Db): Promise<void> {
  await db.execute(
    sql`delete from ${sessions} where ${sessions.id} in (select ${sessions.id} from ${sessions} where ${sessions.expiresAt} < now() limit ${EXPIRED_SESSION_BATCH} for update skip locked)`,
  );
}
