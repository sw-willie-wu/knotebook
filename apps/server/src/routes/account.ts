import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  MAX_REGISTER_DISPLAY_NAME_LENGTH,
  MAX_REGISTER_EMAIL_LENGTH,
  normalizeEmail,
  type AuthProviderTemplate,
  type IdentitiesDto,
  type IdentityDto,
  type UserDto,
} from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { oneTimeLinks, userIdentities, users } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { foreignKeyViolationConstraint, notNullViolationColumn, uniqueViolationConstraint } from "../db/pg-errors.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { CollabHooks } from "../collab/hooks.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";
import { hashToken } from "../auth/api-token.js";
import { activeOneTimeLink, isOneTimeTokenShape } from "../auth/one-time-link.js";
import { HashBusyError, hashPassword } from "../auth/password.js";
import { signSession, type UserGate } from "../auth/session.js";
import { setSessionCookie } from "../auth/cookies.js";
import { touchLastLogin } from "../auth/last-login.js";
import { isStorableText, sendInvalidBody } from "../auth/admin-provider-input.js";
import {
  effectivePasswordLogin,
  isPasswordLoginAccepted,
  PASSWORD_LOGIN_DISABLED_MESSAGE,
  PASSWORD_LOGIN_SETTINGS_MISSING_LOG,
  readPasswordLoginSetting,
} from "../auth/password-login.js";
import { canUnlinkIdentity, enabledProvidersWithIssuer, usableIdentityIds } from "../auth/sign-in-methods.js";
import { readRegistrationEnabled, REGISTRATION_DISABLED_MESSAGE } from "../auth/site-settings.js";
import { IDENTITY_NOT_FOUND_MESSAGE, unlinkIdentityInTx } from "../auth/tx/identities.js";
import { registerUserInTx, type RegisteredUser } from "../auth/tx/register.js";
import { acceptInviteInTx, INVITE_INVALID_MESSAGE } from "../auth/tx/accept-invite.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../auth/tx/admin-site-settings.js";

export interface AccountRouteDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  collabHooks: CollabHooks;
  limiters: { register: FixedWindowLimiter; oneTimeLinkMiss: FixedWindowLimiter; oneTimeLinkAttempt: FixedWindowLimiter };
}

const TOO_MANY_REQUESTS_MESSAGE = "請求太頻繁，請稍後再試";

const MAX_DERIVE_ATTEMPTS = 3;

// 上限（總管裁定疑點 4）：email 對齊 SSO 那條的 254（`routes/oidc.ts` 的 `MAX_EMAIL_CLAIM_LENGTH`），以 JS `.length` 計；
// 顯示名 100 個 code point。以 refine 給中文訊息（`sendInvalidBody` 只取自訂 issue 的訊息）。註冊與接受邀請共用（#285 spec §5.3）。
const emailField = z
  .string()
  .trim()
  .email()
  .refine(s => s.length <= MAX_REGISTER_EMAIL_LENGTH, `email 不得超過 ${MAX_REGISTER_EMAIL_LENGTH} 個字元`);
const displayNameField = z
  .string()
  .trim()
  .refine(isStorableText, "顯示名稱含有無法儲存的字元")
  .refine(s => s.length > 0, "顯示名稱不得為空")
  .refine(s => [...s].length <= MAX_REGISTER_DISPLAY_NAME_LENGTH, `顯示名稱不得超過 ${MAX_REGISTER_DISPLAY_NAME_LENGTH} 個字`)
  .optional();

const registerBodySchema = z.object({ email: emailField, password: z.string(), displayName: displayNameField }).strict();
// strict：沒有可改 is_admin／must_change_password 的欄位（V3）。
const acceptInviteBodySchema = z.object({ token: z.string(), email: emailField, password: z.string(), displayName: displayNameField }).strict();
const inspectInviteBodySchema = z.object({ token: z.string() }).strict();

/** 不填顯示名 → email local-part，截到上限個 code point（local-part 可長到 242 字元，不截就繞過上限；以 code point 切，不切斷代理對）。 */
function defaultDisplayName(email: string): string {
  return Array.from(email.split("@")[0]!).slice(0, MAX_REGISTER_DISPLAY_NAME_LENGTH).join("");
}

/**
 * #285 交易外、不鎖地以雜湊查有效的邀請（spec §5.3 第 2 步）。形狀不合或查無 → null。
 * 參數帶 `token_hash`：非預期的 DB 錯誤一律遮蔽，不讓雜湊隨 drizzle 錯誤進 log（同 `routes/password-reset.ts`）。
 */
async function findActiveInvite(db: Db, token: string, log: FastifyBaseLogger): Promise<{ id: string; expiresAt: Date } | null> {
  if (!isOneTimeTokenShape("invite", token)) return null;
  try {
    const [row] = await db
      .select({ id: oneTimeLinks.id, expiresAt: oneTimeLinks.expiresAt })
      .from(oneTimeLinks)
      .where(and(eq(oneTimeLinks.tokenHash, hashToken(token)), activeOneTimeLink("invite")))
      .limit(1);
    return row ?? null;
  } catch (err) {
    throw redactDbError(log, err, "查詢邀請");
  }
}

/**
 * #187 PR3：自己帳號的路由——帳密註冊（§9.1）、登入方式（§8.2／§8.3，Task 5）、加上密碼（§8.4，Task 6）。
 * #285：無登入的邀請 inspect 與接受邀請（spec §5.3）——無效一律 410 `invite_invalid`、不區分原因；不看「允許用帳號密碼自行註冊」、
 * 不扣 `REGISTER_LIMIT`（E2、E5——邀請本身就是授權，有效 token 的接受不該被同 IP 的註冊額度擋住）；帳密開關只在交易外判；
 * log 與回應絕不含 token 明文或 `token_hash`。HTTP 層訊息中文。
 * 兩顆桶與 `routes/password-reset.ts` 共用同一組實例：miss 桶（key=ip）只在交易外查無有效邀請時扣、有效 token 不預檢（不擋有效 token），
 * 帳密 403 與交易內 410 都不扣；嘗試桶（key=`link:${id}`）只在 accept、帳密有效值為開之後才扣，inspect 不扣。
 */
export function accountRoutes(deps: AccountRouteDeps) {
  /** 交易外「邀請無效」的唯一出口（交易內並發造成的 410 刻意不經過它，N-4）：先扣 miss 桶（key=ip），超限 429，否則 410。 */
  function sendInvalidInvite(reply: FastifyReply, ip: string): FastifyReply {
    if (!deps.limiters.oneTimeLinkMiss.consume(ip)) return sendError(reply, 429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
    return sendError(reply, 410, "invite_invalid", INVITE_INVALID_MESSAGE);
  }

  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/api/auth/register", async (request, reply) => {
      // §9.1 第 1 步：per-IP 限流，每個請求都扣（無 userId）。
      if (!deps.limiters.register.consume(request.ip)) return sendError(reply, 429, "too_many_requests", "註冊太頻繁，請稍後再試");
      // 第 2、2a 步（快速路徑；權威判斷在交易內 FOR SHARE）。讀不到列：註冊視同關（§4.3）。
      const registrationEnabled = await readRegistrationEnabled(deps.db);
      if (registrationEnabled === null) request.log.error("site_settings 讀不到列：註冊視同關閉（#187 §4.3）");
      if (registrationEnabled !== true) return sendError(reply, 403, "registration_disabled", REGISTRATION_DISABLED_MESSAGE);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      const parsed = registerBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const email = normalizeEmail(parsed.data.email);
      const displayName = parsed.data.displayName ?? defaultDisplayName(email);
      if (parsed.data.password.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `密碼至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
      }
      // 第 4 步：先 hash 再碰 DB（交易外，S14）。
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(parsed.data.password);
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        throw err;
      }

      // 第 5 步：registry-first，重試契約（註冊與接受邀請共用，`insertPasswordUserInTx`）：派生撞名 → 整 tx 重跑，第 4 次退 user-<uuid8>。
      let created: RegisteredUser | undefined;
      for (let attempt = 1; created === undefined && attempt <= MAX_DERIVE_ATTEMPTS + 1; attempt += 1) {
        const input = {
          id: randomUUID(),
          email,
          displayName,
          passwordHash,
          useFallbackHandle: attempt > MAX_DERIVE_ATTEMPTS,
          passwordLoginForced: deps.config.passwordLoginForceEnable,
        };
        try {
          created = await deps.db.transaction(tx => registerUserInTx(tx, input));
        } catch (err) {
          if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
          const constraint = uniqueViolationConstraint(err);
          // 第 6 步：並發形的最後防線。
          if (constraint === "users_email_unique") return sendError(reply, 409, "email_taken", "此 email 已被使用");
          if ((constraint === "handles_pkey" || constraint === "users_handle_unique") && attempt <= MAX_DERIVE_ATTEMPTS) continue;
          // INSERT 帶 password hash，非預期 DB 錯誤不得讓 params 進 log（spec §5.6）。
          throw redactDbError(request.log, err, "註冊");
        }
      }
      if (created === undefined) throw new Error("註冊：handle 配置重試耗盡");

      // 第 7 步：成功即登入（B9）。
      await touchLastLogin(deps.db, created.id, request.log); // #247 §9.5 寫入點 5：註冊（建帳即自動登入）
      const token = await signSession(deps.config.appSecret, { userId: created.id, tv: created.tokenVersion });
      setSessionCookie(reply, deps.config, token);
      const dto: UserDto = {
        id: created.id,
        email: created.email,
        handle: created.handle,
        displayName: created.displayName,
        isAdmin: false,
        mustChangePassword: false,
        hasPassword: true,
        // 新帳號取 DB 預設 `users.auto_versions = true`。
        autoVersions: true,
      };
      return reply.code(201).send(dto);
    });

    // #285 spec §5.3：檢查邀請（不消耗）。順序：body → 邀請（無效扣 miss 桶）→ 帳密有效值（403 不扣桶）。
    app.post("/api/auth/invite/inspect", async (request, reply) => {
      const parsed = inspectInviteBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      const invite = await findActiveInvite(deps.db, parsed.data.token, request.log);
      if (!invite) return sendInvalidInvite(reply, request.ip);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      return reply.send({ expiresAt: invite.expiresAt.toISOString() });
    });

    // #285 spec §5.3：接受邀請。順序：body → 邀請（無效扣 miss 桶）→ 帳密有效值（403 不動列、不扣桶，D2）→ 嘗試桶 → 長度 → email 預查 → argon2 → 交易。
    // argon2 之前能判的都先判（§5.5）。
    app.post("/api/auth/invite/accept", async (request, reply) => {
      const parsed = acceptInviteBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const invite = await findActiveInvite(deps.db, parsed.data.token, request.log);
      if (!invite) return sendInvalidInvite(reply, request.ip);
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      // 帳密關閉的 403 在上面先回，不扣這個桶（同重設密碼 N-1）。
      if (!deps.limiters.oneTimeLinkAttempt.consume(`link:${invite.id}`)) {
        return sendError(reply, 429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
      }
      if (parsed.data.password.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `密碼至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
      }
      const email = normalizeEmail(parsed.data.email);
      const displayName = parsed.data.displayName ?? defaultDisplayName(email);
      // 預期內的 409 不燒 argon2、不消耗邀請（交易外、不鎖；交易內 `insertPasswordUserInTx` 再判一次，並發形靠唯一鍵）。
      const [taken] = await deps.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
      if (taken !== undefined) return sendError(reply, 409, "email_taken", "此 email 已被使用");
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(parsed.data.password);
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        throw err;
      }

      // 重試契約同註冊：派生撞名 → 整 tx 重跑，第 4 次退 user-<uuid8>。
      let created: RegisteredUser | undefined;
      for (let attempt = 1; created === undefined && attempt <= MAX_DERIVE_ATTEMPTS + 1; attempt += 1) {
        const input = {
          linkId: invite.id,
          id: randomUUID(),
          email,
          displayName,
          passwordHash,
          useFallbackHandle: attempt > MAX_DERIVE_ATTEMPTS,
        };
        try {
          created = await deps.db.transaction(tx => acceptInviteInTx(tx, input));
        } catch (err) {
          // 交易內的 410 是並發造成（這發已以有效 token 通過上面的查詢），不經 sendInvalidInvite（spec N-4）。
          if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
          const constraint = uniqueViolationConstraint(err);
          if (constraint === "users_email_unique") return sendError(reply, 409, "email_taken", "此 email 已被使用");
          if ((constraint === "handles_pkey" || constraint === "users_handle_unique") && attempt <= MAX_DERIVE_ATTEMPTS) continue;
          // 儲存配額 §10（m9）：預設方案被刪的競態 → 23503。
          if (foreignKeyViolationConstraint(err) === "users_storage_plan_fk") return sendError(reply, 409, "server_busy", "伺服器忙碌，請稍後再試");
          // site_settings 沒有列 → DEFAULT 函式回 NULL → 23502。
          if (notNullViolationColumn(err) === "storage_plan_id") {
            request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
            return sendError(reply, 500, "internal", "伺服器內部錯誤");
          }
          // INSERT 帶 password hash，非預期 DB 錯誤不得讓 params 進 log（spec §5.6）。
          throw redactDbError(request.log, err, "接受邀請");
        }
      }
      if (created === undefined) throw new Error("接受邀請：handle 配置重試耗盡");

      request.log.info({ linkId: invite.id, userId: created.id }, "邀請已使用");
      await touchLastLogin(deps.db, created.id, request.log); // #247 §9.5 寫入點 7：接受邀請
      const token = await signSession(deps.config.appSecret, { userId: created.id, tv: created.tokenVersion });
      setSessionCookie(reply, deps.config, token);
      const dto: UserDto = {
        id: created.id,
        email: created.email,
        handle: created.handle,
        displayName: created.displayName,
        isAdmin: false,
        mustChangePassword: false,
        hasPassword: true,
        autoVersions: true,
      };
      return reply.code(201).send(dto);
    });

    // §8.3：session-only（`app.authenticate` 只認 cookie；Bearer → 401，r2-N6）。
    app.get("/api/auth/identities", { preHandler: app.authenticate }, async (request): Promise<IdentitiesDto> => {
      const userId = request.user!.id;
      const mine = await deps.db
        .select({ id: userIdentities.id, issuer: userIdentities.issuer, createdAt: userIdentities.createdAt, lastLoginAt: userIdentities.lastLoginAt })
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId))
        .orderBy(asc(userIdentities.createdAt), asc(userIdentities.id));
      const enabled = await enabledProvidersWithIssuer(deps.db);
      // hasPassword 直讀 DB（不用 gate 的 60 秒快取）：與 DELETE 交易內的讀法一致，表驅動案才能逐格一致。
      const [me] = await deps.db.select({ hasPassword: sql<boolean>`${users.passwordHash} is not null` }).from(users).where(eq(users.id, userId));
      const dbValue = await readPasswordLoginSetting(deps.db);
      if (dbValue === null) request.log.error({ table: "site_settings" }, PASSWORD_LOGIN_SETTINGS_MISSING_LOG);
      const usable = usableIdentityIds(mine, enabled);
      const hasPassword = me?.hasPassword ?? false;
      const identities: IdentityDto[] = mine.map(i => ({
        id: i.id,
        issuer: i.issuer,
        providers: enabled.filter(p => p.effectiveIssuer === i.issuer).map(p => ({ id: p.id, displayName: p.displayName, icon: p.icon })),
        createdAt: i.createdAt.toISOString(),
        lastLoginAt: i.lastLoginAt?.toISOString() ?? null,
        unlinkable: canUnlinkIdentity(i.id, { hasPassword, passwordLoginDbValue: dbValue ?? true, usableIdentityIds: usable }),
      }));
      const linkedIssuers = new Set(mine.map(i => i.issuer));
      return {
        identities,
        linkable: enabled
          .filter(p => !linkedIssuers.has(p.effectiveIssuer))
          .map(p => ({ providerId: p.id, displayName: p.displayName, template: p.template as AuthProviderTemplate, icon: p.icon })),
        hasPassword,
        // 有效值（DB OR env）：只決定設定頁顯示「加上密碼」與說明；INV-7 不看它（已折進 unlinkable）。
        passwordLoginEnabled: effectivePasswordLogin(dbValue, deps.config.passwordLoginForceEnable),
      };
    });

    app.delete("/api/auth/identities/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const raw = (request.params as { id: string }).id;
      if (!UUID_RE.test(raw)) return sendError(reply, 404, "not_found", IDENTITY_NOT_FOUND_MESSAGE);
      const input = { userId: request.user!.id, identityId: raw.toLowerCase() };
      let result: { settingsMissing: boolean };
      try {
        result = await deps.db.transaction(tx => unlinkIdentityInTx(tx, input));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
      if (result.settingsMissing) request.log.error({ table: "site_settings" }, PASSWORD_LOGIN_SETTINGS_MISSING_LOG);
      return reply.code(204).send();
    });

    // §8.4（S3，推翻 W3）：純 SSO 帳號加上密碼。不要求近期登入（B12，總管裁決；已知限制寫明）。session-only。
    app.post("/api/auth/password/set", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = z.object({ newPassword: z.string() }).strict().safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      // 第 0 步（B22）：有效值為關 → 403。一般讀、不鎖（與關閉的並發見 C30：讀到開之後才關閉 → 密碼設好了，關閉期間登入端點不收它）。
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      const { newPassword } = parsed.data;
      if (newPassword.length < MIN_PASSWORD_LENGTH) return sendError(reply, 400, "password_too_short", `密碼至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(newPassword);
      } catch (err) {
        if (err instanceof HashBusyError) return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        throw err;
      }
      const userId = request.user!.id;
      // 單句條件 UPDATE（C14：雙送出第二次 0 列）；token_version 在 SQL 端 +1（同改密碼的理由）。與解除連結以 users 列鎖序列化（C10）。
      const [updated] = await deps.db
        .update(users)
        .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(and(eq(users.id, userId), isNull(users.passwordHash)))
        .returning({ tokenVersion: users.tokenVersion });
      if (updated === undefined) return sendError(reply, 409, "password_already_set", "這個帳號已經有密碼，請改用修改密碼");
      // 同改密碼：讓其他裝置的舊 session 失效、重簽本人。
      deps.gate.invalidate(userId);
      deps.collabHooks.onUserRevoked(userId);
      const token = await signSession(deps.config.appSecret, { userId, tv: updated.tokenVersion });
      setSessionCookie(reply, deps.config, token);
      return reply.code(204).send();
    });
  };
}
