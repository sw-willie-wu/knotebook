import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
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
import { userIdentities, users } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { uniqueViolationConstraint } from "../db/pg-errors.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { CollabHooks } from "../collab/hooks.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";
import { HashBusyError, hashPassword } from "../auth/password.js";
import { signSession, type UserGate } from "../auth/session.js";
import { setSessionCookie } from "../auth/cookies.js";
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

export interface AccountRouteDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  collabHooks: CollabHooks;
  limiters: { register: FixedWindowLimiter };
}

const MAX_DERIVE_ATTEMPTS = 3;

// 上限（總管裁定疑點 4）：email 對齊 SSO 那條的 254（`routes/oidc.ts` 的 `MAX_EMAIL_CLAIM_LENGTH`），以 JS `.length` 計；
// 顯示名 100 個 code point。以 refine 給中文訊息（`sendInvalidBody` 只取自訂 issue 的訊息）。
const registerBodySchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .refine(s => s.length <= MAX_REGISTER_EMAIL_LENGTH, `email 不得超過 ${MAX_REGISTER_EMAIL_LENGTH} 個字元`),
    password: z.string(),
    displayName: z
      .string()
      .trim()
      .refine(isStorableText, "顯示名稱含有無法儲存的字元")
      .refine(s => s.length > 0, "顯示名稱不得為空")
      .refine(s => [...s].length <= MAX_REGISTER_DISPLAY_NAME_LENGTH, `顯示名稱不得超過 ${MAX_REGISTER_DISPLAY_NAME_LENGTH} 個字`)
      .optional(),
  })
  .strict();

/**
 * #187 PR3：自己帳號的路由——帳密註冊（§9.1）、登入方式（§8.2／§8.3，Task 5）、加上密碼（§8.4，Task 6）。
 * HTTP 層訊息中文。
 */
export function accountRoutes(deps: AccountRouteDeps) {
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
      // 不填顯示名 → email local-part，截到上限個 code point（local-part 可長到 242 字元，不截就繞過上限；以 code point 切，不切斷代理對）。
      const displayName = parsed.data.displayName ?? Array.from(email.split("@")[0]!).slice(0, MAX_REGISTER_DISPLAY_NAME_LENGTH).join("");
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

      // 第 5 步：registry-first，重試契約同 admin 代建（routes/admin-users.ts）：派生撞名 → 整 tx 重跑，第 4 次退 user-<uuid8>。
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
          throw err;
        }
      }
      if (created === undefined) throw new Error("註冊：handle 配置重試耗盡");

      // 第 7 步：成功即登入（B9）。
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
