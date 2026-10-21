/**
 * #286 管理員替使用者產生／取消一次性重設密碼連結（spec §4.2，`requireAdmin`）。
 *
 * 不放進 `admin-users.ts`：本檔列在 `test/unit/s14-structure.test.ts` 的 `ROUTE_FILES`，兩支交易都受 ④⑤ 掃描。
 * log 與回應絕不含 token 明文或 `token_hash`（201 回應的 `token` 除外，I1）；產生交易的非預期錯誤一律遮蔽（§3.8）。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { hashToken } from "../auth/api-token.js";
import { generateOneTimeToken } from "../auth/one-time-link.js";
import { deleteEndedOneTimeLinks } from "../auth/one-time-link-cleanup.js";
import { isPasswordLoginAccepted, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../auth/password-login.js";
import { cancelPasswordResetsInTx, issuePasswordResetInTx } from "../auth/tx/password-reset.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { UUID_RE } from "../notes/service.js";

const issueBodySchema = z.object({ expiresInHours: z.number().int().min(1).max(24) }).strict();

export interface AdminPasswordResetRouteDeps {
  db: Db;
  config: Pick<AppConfig, "passwordLoginForceEnable">;
}

export function adminPasswordResetRoutes(deps: AdminPasswordResetRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // 判斷順序（spec §4.2 N-5）：UUID → body → 帳密有效值 → 交易（404／409）。帳密關閉時打不存在的 id → 403。
    app.post("/api/admin/users/:id/password-reset", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "user_not_found", "找不到此使用者");
      const id = rawId.toLowerCase();
      const parsed = issueBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      const token = generateOneTimeToken("password_reset");
      const input = { targetUserId: id, createdById: request.user!.id, tokenHash: hashToken(token), expiresInHours: parsed.data.expiresInHours };
      let issued: { linkId: string; expiresAt: Date; replaced: number };
      try {
        issued = await deps.db.transaction(tx => issuePasswordResetInTx(tx, input));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // INSERT 的參數帶 token_hash：drizzle 的錯誤會把參數串進 message，原樣交給全域 handler 就進 log。
        throw redactDbError(request.log, err, "產生重設密碼連結");
      }
      const { linkId, expiresAt, replaced } = issued;
      request.log.info({ userId: request.user!.id, targetUserId: id, linkId, expiresAt, replaced }, "產生重設密碼連結");
      // spec §3.7：清理沒有排程，產生成功後機會性執行；失敗不影響回應。
      void deleteEndedOneTimeLinks(deps.db).catch((err: unknown) => request.log.warn({ err }, "清理一次性連結失敗"));
      return reply.code(201).send({ token, expiresAt: expiresAt.toISOString() });
    });

    // 取消永遠允許：不看帳密開關、不看停用（spec §4.2）。本來就沒有也是 204。
    app.delete("/api/admin/users/:id/password-reset", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "user_not_found", "找不到此使用者");
      const input = { targetUserId: rawId.toLowerCase() };
      let revoked: number;
      try {
        ({ revoked } = await deps.db.transaction(tx => cancelPasswordResetsInTx(tx, input)));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // 這一句不帶 token_hash 參數，但動的是含雜湊欄的列——不讓錯誤本體進 log（同 admin-auth.ts 刪除登入服務）。
        throw redactDbError(request.log, err, "取消重設密碼連結");
      }
      request.log.info({ userId: request.user!.id, targetUserId: input.targetUserId, revoked }, "取消重設密碼連結");
      return reply.code(204).send();
    });
  };
}
