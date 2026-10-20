/**
 * #286 無登入的重設密碼端點（spec §4.3）：inspect（不消耗連結）與完成（設定新密碼、登出其他瀏覽器、簽新 session）。
 *
 * - 無登入：持有連結的人就是本人。token 只從 POST body 收（spec §3.2，網址上只在 fragment），所以不需要 log 遮罩；
 *   log 與回應絕不含 token 明文或 `token_hash`。
 * - 無效 token 一律 410 `reset_link_invalid`，不區分原因；交易外的「連結無效」出口都經 `sendInvalidLink`，
 *   交易內（並發造成）的 410 刻意不經過它。
 * - 帳密開關（有效值）只在交易外判斷，交易內不重讀（spec §4.3 末【推】）：關閉時 403，連結不動。
 * - 登出手段與改密碼相同（`token_version + 1`＋`gate.invalidate`＋`onUserRevoked`），PAT／OAuth 不受影響（spec §4.4）。
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { UserDto } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { oneTimeLinks, users } from "../db/schema.js";
import { hashToken } from "../auth/api-token.js";
import { setSessionCookie } from "../auth/cookies.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";
import { touchLastLogin } from "../auth/last-login.js";
import { activeOneTimeLink, isOneTimeTokenShape } from "../auth/one-time-link.js";
import { hashPassword, HashBusyError } from "../auth/password.js";
import { isPasswordLoginAccepted, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../auth/password-login.js";
import { signSession, type UserGate } from "../auth/session.js";
import { completePasswordResetInTx, RESET_LINK_INVALID_MESSAGE } from "../auth/tx/password-reset.js";
import type { CollabHooks } from "../collab/hooks.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { redactDbError } from "../lib/redact-db-error.js";

const inspectBodySchema = z.object({ token: z.string() }).strict();
const completeBodySchema = z.object({ token: z.string(), newPassword: z.string() }).strict();

export interface PasswordResetRouteDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  collabHooks: CollabHooks;
}

/**
 * 交易外、不鎖地以雜湊查有效的重設連結（spec §3.5 完成的第一步）。形狀不合或查無 → null。
 * 參數帶 `token_hash`：非預期的 DB 錯誤一律遮蔽，不讓雜湊隨 drizzle 錯誤進 log（§3.8）。
 */
async function findActiveResetLink(
  db: Db,
  token: string,
  log: FastifyBaseLogger,
): Promise<{ id: string; targetUserId: string; email: string; expiresAt: Date } | null> {
  if (!isOneTimeTokenShape("password_reset", token)) return null;
  let row: { id: string; targetUserId: string | null; email: string; expiresAt: Date } | undefined;
  try {
    [row] = await db
      .select({ id: oneTimeLinks.id, targetUserId: oneTimeLinks.targetUserId, email: users.email, expiresAt: oneTimeLinks.expiresAt })
      .from(oneTimeLinks)
      .innerJoin(users, eq(users.id, oneTimeLinks.targetUserId))
      .where(and(eq(oneTimeLinks.tokenHash, hashToken(token)), activeOneTimeLink("password_reset")))
      .limit(1);
  } catch (err) {
    throw redactDbError(log, err, "查詢重設密碼連結");
  }
  if (!row || row.targetUserId === null) return null;
  return { id: row.id, targetUserId: row.targetUserId, email: row.email, expiresAt: row.expiresAt };
}

function sendInvalidLink(reply: FastifyReply): FastifyReply {
  return sendError(reply, 410, "reset_link_invalid", RESET_LINK_INVALID_MESSAGE);
}

export function passwordResetRoutes(deps: PasswordResetRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/api/auth/password-reset/inspect", async (request, reply) => {
      const parsed = inspectBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      const link = await findActiveResetLink(deps.db, parsed.data.token, request.log);
      if (!link) return sendInvalidLink(reply);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      return reply.send({ email: link.email, expiresAt: link.expiresAt.toISOString() });
    });

    // 順序（spec §4.3）：body → 連結 → 帳密有效值 → 長度 → argon2 → 交易。argon2 之前能判的都先判（A-13）。
    app.post("/api/auth/password-reset", async (request, reply) => {
      const parsed = completeBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      const { token, newPassword } = parsed.data;
      const link = await findActiveResetLink(deps.db, token, request.log);
      if (!link) return sendInvalidLink(reply);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `密碼至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
      }
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(newPassword);
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        throw err;
      }
      const input = { linkId: link.id, targetUserId: link.targetUserId, passwordHash };
      let updated: Awaited<ReturnType<typeof completePasswordResetInTx>>;
      try {
        updated = await deps.db.transaction(tx => completePasswordResetInTx(tx, input));
      } catch (err) {
        // 交易內的 410 都是並發造成（這發已以有效 token 通過上面的查詢），不經 sendInvalidLink。
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // UPDATE 的參數帶 password hash：drizzle 的錯誤會把參數串進 message。
        throw redactDbError(request.log, err, "重設密碼");
      }
      // 登出其他瀏覽器（同改密碼）：gate 快取立即失效、共編連線重驗。
      deps.gate.invalidate(updated.id);
      deps.collabHooks.onUserRevoked(updated.id);
      request.log.info({ targetUserId: updated.id, linkId: link.id }, "重設密碼連結已使用");
      await touchLastLogin(deps.db, updated.id, request.log); // #247 §9.5 寫入點 6：重設密碼連結
      const session = await signSession(deps.config.appSecret, { userId: updated.id, tv: updated.tokenVersion });
      setSessionCookie(reply, deps.config, session);
      const dto: UserDto = {
        id: updated.id,
        email: updated.email,
        handle: updated.handle,
        displayName: updated.displayName,
        isAdmin: updated.isAdmin,
        mustChangePassword: updated.mustChangePassword,
        hasPassword: true,
        autoVersions: updated.autoVersions,
      };
      return reply.send(dto);
    });
  };
}
