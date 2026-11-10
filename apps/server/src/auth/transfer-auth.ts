import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { hasScope, type TokenScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens, transferTokens } from "../db/schema.js";
import { drainWithCap } from "../http/drain.js";
import { sendError } from "../http/errors.js";
import { retryAfterSeconds, type FixedWindowLimiter } from "../http/rate-limit.js";
import { hashToken, isAccessTokenShape, parseAuthorizationHeader } from "./api-token.js";
import { buildTransferChallenge } from "./challenge.js";
import type { UserGate } from "./session.js";
import { isTransferTokenShape, type BulkAccess, type BulkRange, type TransferPurpose } from "./transfer-token.js";

/** 查無、過期、母憑證已撤銷或過期、已消費、使用者停權／需改密碼——同形同字（時序側通道）。 */
export const TRANSFER_INVALID_MESSAGE = "The transfer token is invalid, expired or already used.";
/** 有效形的 `knb_` PAT／OAuth access 打這兩支端點時的專屬訊息。 */
export const TRANSFER_PAT_MESSAGE = "This endpoint doesn't accept API tokens. Get a transfer token from the MCP tool create_transfer_token.";
/** bulk transfer：bulk 端點的一般 PAT 401 另立一句（上一句指名 create_transfer_token，用在這裡會指錯工具）。 */
export const BULK_TRANSFER_PAT_MESSAGE = "This endpoint doesn't accept API tokens. Get a transfer token from the MCP tool create_bulk_transfer_token.";
/** bulk transfer：沒帶 `Authorization` 的 401（bulk 端點不回退 cookie）。 */
export const BULK_TRANSFER_REQUIRED_MESSAGE = "A transfer token is required.";
/**
 * bulk transfer：`requireBulk` 的三個無效出口（形狀不對、查無或過期〔含母憑證到期〕、
 * 使用者閘門不過〔停權、必須改密碼〕）同形同字。**不含「已使用」**：bulk 權杖到期前可重用；#200 的
 * `TRANSFER_INVALID_MESSAGE` 不動（`require()` 與 `routes/uploads.ts` 的已消費分支仍用它）。
 */
export const BULK_TRANSFER_INVALID_MESSAGE = "The transfer token is invalid, expired or revoked. Get a new one from the MCP tool create_bulk_transfer_token.";
/** 用途不符（upload／download 打 bulk 端點、bulk 打 upload／download 端點）的 403，兩邊同字。 */
export const TRANSFER_PURPOSE_MESSAGE = "This transfer token can't be used for this action.";

export interface TransferAuthDeps {
  db: Db;
  gate: UserGate;
  /** `app.authenticate`（cookie only）——沒帶 `Authorization` 時回退，行為與本功能之前完全相同。 */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** 與 `authenticateAny` 同一個實例（`app.ts` 的 `limiters` 物件）。 */
  limiters: { bearerMiss: FixedWindowLimiter };
}

/**
 * #200：`POST /api/notes/:id/uploads`／`GET /api/uploads/:id` 的認證。
 *
 * - 沒有 `Authorization` → `app.authenticate`（session）；有 header 就**只走 transfer 路徑、不回退 cookie**。
 * - **一般 PAT／OAuth access 不收**：專屬 401 訊息指向 `create_transfer_token`。
 * - 到期一律在 SQL 以 DB `now()` 判（子 token 與母憑證兩者），與 POST 的原子消費同一個時鐘。
 * - **每一個早退都先 `drainWithCap`**（對 GET 無害、對 POST 必要：不消費 body 會讓 client 收到 network error；`drainWithCap` 冪等）。
 * - **帶了 header 的每一個 401 都吃 per-IP `bearerMiss`**，桶滿改回 429 且不帶 `WWW-Authenticate`；沒帶 header 的
 *   401 由 `app.authenticate` 回、不吃；403 不吃。header 一律在 `sendError` 之前設（`auth/bearer.ts:75-83` 的理由）。
 * - 通過時 `request.tokenId` 設成**母憑證** id（`app.ts` 的錯誤 log 記得到是哪支）；不更新母憑證的 `last_used_at`。
 * - bearerMiss 桶滿改回的 429 **一律帶 `Retry-After`**（`require()` 與 `requireBulk()` 共用 `reject401`）。
 */
export function createTransferAuth(deps: TransferAuthDeps) {
  function reject401(request: FastifyRequest, reply: FastifyReply, withError: boolean, message: string): void {
    drainWithCap(request);
    if (!deps.limiters.bearerMiss.consume(request.ip)) {
      reply.header("retry-after", String(retryAfterSeconds(deps.limiters.bearerMiss.retryAfterMs(request.ip))));
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      return;
    }
    reply.header("www-authenticate", buildTransferChallenge(withError ? "invalid_token" : undefined));
    sendError(reply, 401, "unauthorized", message);
  }

  function rejectInvalid(request: FastifyRequest, reply: FastifyReply): void {
    reject401(request, reply, true, TRANSFER_INVALID_MESSAGE);
  }

  /** `requireBulk` 專用：與 `rejectInvalid` 同形，只換訊息。 */
  function rejectInvalidBulk(request: FastifyRequest, reply: FastifyReply): void {
    reject401(request, reply, true, BULK_TRANSFER_INVALID_MESSAGE);
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
      if (parsed.kind === "other-scheme") return reject401(request, reply, false, "Not signed in.");
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
        sendError(reply, 403, "forbidden", TRANSFER_PURPOSE_MESSAGE);
        return;
      }

      const gateResult = await deps.gate.checkUser(row.userId);
      if (gateResult.status !== "ok" || gateResult.user.mustChangePassword) return rejectInvalid(request, reply);

      // 母憑證可經 `PATCH /api/auth/tokens/:id` 原地降權（#239），所以這條**可達**；每次使用都以母憑證當下的 scope 重驗。
      // 刻意不像 `bearer.ts` 那支帶 `WWW-Authenticate: … error="insufficient_scope"`：transfer token 沒有可要求的 scope，
      // 行為不改。守衛：`transfer-tokens.test.ts` 的 #239 T1。
      if (!hasScope(row.scope as TokenScope, purpose === "upload" ? "notes:write" : "notes:read")) {
        drainWithCap(request);
        sendError(reply, 403, "insufficient_scope", "This token's scope doesn't allow this action.");
        return;
      }

      request.user = gateResult.user;
      request.authKind = "transfer";
      // `transfer_tokens_bulk_note_chk`：purpose ≠ bulk ⇒ note_id 非 NULL；bulk 列已在上面的用途比對回 403。
      // 結構上不可達，不加執行期分支（測不到）。
      request.transfer = { id: row.id, noteId: row.noteId!, purpose, parentTokenId: row.parentId };
      request.tokenId = row.parentId;
    };
  }

  /**
   * bulk transfer：`/api/transfer/*` 的認證。**不與 `require()` 共用流程**：
   * 沒帶 `Authorization` 一律 401（不回退 cookie、不吃 bearerMiss）；有 header 的 401 吃 bearerMiss（桶滿 429＋`Retry-After`）；
   * `purpose ≠ 'bulk'` → 403；無效、過期、停權／需改密碼 → 同形 401（`BULK_TRANSFER_INVALID_MESSAGE`）；讀取要母憑證當下有 `notes:read`。
   * `write`：read 的全部＋`access = 'write'`＋母憑證**當下**有 `notes:write`，缺一 → 403 `insufficient_scope`
   * （既有慣例：`require()` 與 `bearer.ts` 的 scope 不足都回這碼這句；`forbidden` 只用在用途不符）。兩者都排在使用者閘門之後
   * （停權的唯讀權杖 → 401，不是 403；`transfer-write-auth.test.ts` 的 W-A3b）。不帶 `WWW-Authenticate`（同 `require()` 的理由）。
   */
  function requireBulk(op: "read" | "write") {
    const needed = op === "read" ? "notes:read" : "notes:write";
    return async function bulkPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const raw = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
      const parsed = parseAuthorizationHeader(raw);
      if (parsed.kind === "none") {
        drainWithCap(request);
        reply.header("www-authenticate", buildTransferChallenge());
        sendError(reply, 401, "unauthorized", BULK_TRANSFER_REQUIRED_MESSAGE);
        return;
      }
      if (parsed.kind === "other-scheme") return reject401(request, reply, false, "Not signed in.");
      if (isAccessTokenShape(parsed.token)) return reject401(request, reply, true, BULK_TRANSFER_PAT_MESSAGE);
      if (!isTransferTokenShape(parsed.token)) return rejectInvalidBulk(request, reply);

      const [row] = await deps.db
        .select({
          id: transferTokens.id,
          purpose: transferTokens.purpose,
          access: transferTokens.access,
          range: transferTokens.range,
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
      if (row === undefined) return rejectInvalidBulk(request, reply);
      if (row.purpose !== "bulk") {
        drainWithCap(request);
        sendError(reply, 403, "forbidden", TRANSFER_PURPOSE_MESSAGE);
        return;
      }

      const gateResult = await deps.gate.checkUser(row.userId);
      if (gateResult.status !== "ok" || gateResult.user.mustChangePassword) return rejectInvalidBulk(request, reply);

      // read：實務上不可達（五種 scope 都含 notes:read）；保留與 `require()` 同形。write：母憑證可經 PATCH 原地降權（#239），可達（W-A4）。
      // write 另要權杖本身 `access = 'write'`（W-A3：唯讀母憑證簽的權杖）。
      if ((op === "write" && row.access !== "write") || !hasScope(row.scope as TokenScope, needed)) {
        drainWithCap(request);
        sendError(reply, 403, "insufficient_scope", "This token's scope doesn't allow this action.");
        return;
      }

      request.user = gateResult.user;
      request.authKind = "transfer";
      // `transfer_tokens_bulk_access_chk`／`_bulk_range_chk`：bulk 列兩欄必非 NULL。
      request.bulkTransfer = { id: row.id, parentTokenId: row.parentId, access: row.access as BulkAccess, range: row.range as BulkRange };
      request.tokenId = row.parentId;
    };
  }

  return { require, requireBulk, rejectInvalid };
}
