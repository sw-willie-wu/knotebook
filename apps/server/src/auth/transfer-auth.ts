import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { hasScope, type TokenScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens, transferTokens } from "../db/schema.js";
import { drainWithCap } from "../http/drain.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { hashToken, isAccessTokenShape, parseAuthorizationHeader } from "./api-token.js";
import { buildTransferChallenge } from "./challenge.js";
import type { UserGate } from "./session.js";
import { isTransferTokenShape, type TransferPurpose } from "./transfer-token.js";

/** 查無、過期、母憑證已撤銷或過期、已消費、使用者停權／需改密碼——同形同字（spec §12.2 時序側通道）。 */
export const TRANSFER_INVALID_MESSAGE = "transfer token 無效、已過期或已使用";
/** spec §4.5 第 1 步、Q1（M4）：有效形的 `knb_` PAT／OAuth access 打這兩支端點時的專屬訊息。 */
export const TRANSFER_PAT_MESSAGE = "這個端點不收 API token；請透過 MCP 的 create_transfer_token 取得 transfer token";

export interface TransferAuthDeps {
  db: Db;
  gate: UserGate;
  /** `app.authenticate`（cookie only）——沒帶 `Authorization` 時回退，行為與本功能之前完全相同。 */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** 與 `authenticateAny` 同一個實例（`app.ts` 的 `limiters` 物件）。 */
  limiters: { bearerMiss: FixedWindowLimiter };
}

/**
 * #200 spec §4.5：`POST /api/notes/:id/uploads`／`GET /api/uploads/:id` 的認證。
 *
 * - 沒有 `Authorization` → `app.authenticate`（session）；有 header 就**只走 transfer 路徑、不回退 cookie**。
 * - **一般 PAT／OAuth access 不收**（spec §5.1、Q1）：專屬 401 訊息指向 `create_transfer_token`。
 * - 到期一律在 SQL 以 DB `now()` 判（子 token 與母憑證兩者），與 POST 的原子消費同一個時鐘。
 * - **每一個早退都先 `drainWithCap`**（對 GET 無害、對 POST 是 spec B 的要求；`drainWithCap` 冪等）。
 * - **帶了 header 的每一個 401 都吃 per-IP `bearerMiss`**，桶滿改回 429 且不帶 `WWW-Authenticate`；沒帶 header 的
 *   401 由 `app.authenticate` 回、不吃；403 不吃。header 一律在 `sendError` 之前設（`auth/bearer.ts:75-83` 的理由）。
 * - 通過時 `request.tokenId` 設成**母憑證** id（`app.ts` 的錯誤 log 記得到是哪支）；不更新母憑證的 `last_used_at`。
 */
export function createTransferAuth(deps: TransferAuthDeps) {
  function reject401(request: FastifyRequest, reply: FastifyReply, withError: boolean, message: string): void {
    drainWithCap(request);
    if (!deps.limiters.bearerMiss.consume(request.ip)) {
      sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      return;
    }
    reply.header("www-authenticate", buildTransferChallenge(withError ? "invalid_token" : undefined));
    sendError(reply, 401, "unauthorized", message);
  }

  function rejectInvalid(request: FastifyRequest, reply: FastifyReply): void {
    reject401(request, reply, true, TRANSFER_INVALID_MESSAGE);
  }

  function require(purpose: TransferPurpose) {
    return async function transferPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const raw = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
      const parsed = parseAuthorizationHeader(raw);

      if (parsed.kind === "none") {
        await deps.authenticate(request, reply);
        if (!reply.sent) request.authKind = "session";
        return;
      }
      if (parsed.kind === "other-scheme") return reject401(request, reply, false, "未登入");
      if (isAccessTokenShape(parsed.token)) return reject401(request, reply, true, TRANSFER_PAT_MESSAGE);
      if (!isTransferTokenShape(parsed.token)) return rejectInvalid(request, reply);

      const [row] = await deps.db
        .select({
          id: transferTokens.id,
          noteId: transferTokens.noteId,
          purpose: transferTokens.purpose,
          consumedAt: transferTokens.consumedAt,
          parentId: apiTokens.id,
          userId: apiTokens.userId,
          scope: apiTokens.scope,
        })
        .from(transferTokens)
        .innerJoin(apiTokens, eq(apiTokens.id, transferTokens.parentTokenId))
        .where(
          and(
            eq(transferTokens.tokenHash, hashToken(parsed.token)),
            sql`${transferTokens.expiresAt} > now()`,
            sql`(${apiTokens.accessExpiresAt} is null or ${apiTokens.accessExpiresAt} > now())`
          )
        )
        .limit(1);
      if (row === undefined) return rejectInvalid(request, reply);
      // 快速路徑；真正的單次防線是 POST 的原子消費（routes/uploads.ts）。
      if (row.purpose === "upload" && row.consumedAt !== null) return rejectInvalid(request, reply);

      if (row.purpose !== purpose) {
        drainWithCap(request);
        sendError(reply, 403, "forbidden", "此 transfer token 不能用在這個動作");
        return;
      }

      const gateResult = await deps.gate.checkUser(row.userId);
      if (gateResult.status !== "ok" || gateResult.user.mustChangePassword) return rejectInvalid(request, reply);

      // 母憑證可經 `PATCH /api/auth/tokens/:id` 原地降權（#239），所以這條**可達**；每次使用都以母憑證當下的 scope 重驗。
      // 刻意不像 `bearer.ts` 那支帶 `WWW-Authenticate: … error="insufficient_scope"`：transfer token 沒有可要求的 scope，
      // 行為不改（spec §8）。守衛：`transfer-tokens.test.ts` 的 #239 T1。
      if (!hasScope(row.scope as TokenScope, purpose === "upload" ? "notes:write" : "notes:read")) {
        drainWithCap(request);
        sendError(reply, 403, "insufficient_scope", "此 token 沒有執行這個操作的權限");
        return;
      }

      request.user = gateResult.user;
      request.authKind = "transfer";
      request.transfer = { id: row.id, noteId: row.noteId, purpose, parentTokenId: row.parentId };
      request.tokenId = row.parentId;
    };
  }

  return { require, rejectInvalid };
}
