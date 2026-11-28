import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { MAX_REGISTER_DISPLAY_NAME_LENGTH, SESSION_COOKIE, normalizeEmail, normalizeHandle, validateHandle, type AuthConfigDto, type UserAvatarDto, type UserDto } from "@knotebook/shared";
import { sendError, sendLoginThrottled } from "../http/errors.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SiteLimits } from "../site-limits/store.js";
import { authProviders, handleRenames, handles, siteSettings, userAvatars, users } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { uniqueViolationConstraint } from "../db/pg-errors.js";
import { verifyPassword, hashPassword, HashBusyError, DUMMY_HASH } from "../auth/password.js";
import type { UserGate } from "../auth/session.js";
import { deleteSessionFromCookie, setSessionCookieFor, startSession } from "../auth/sessions.js";
import { changePasswordInTx } from "../auth/tx/change-password.js";
import { touchLastLogin } from "../auth/last-login.js";
import { readCurrentAvatar } from "../avatars/read.js";
import type { LoginThrottle } from "../auth/rate-limit.js";
import type { CollabHooks } from "../collab/hooks.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";
import { listEnabledProvidersForConfig } from "../auth/oidc-providers.js";
import { readRegistrationEnabled } from "../auth/site-settings.js";
import { isPasswordLoginAccepted, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../auth/password-login.js";
import { isStorableText } from "../auth/admin-provider-input.js";

const INVALID_CREDENTIALS_MESSAGE = "Wrong email or password.";
const ICON_NOT_FOUND_MESSAGE = "No sign-in service icon with that id.";

// Structure only: an `.email()` failure returning 400 would let attackers tell known from unknown addresses.
const loginBodySchema = z.object({
  email: z.string(),
  password: z.string(),
});

const passwordBodySchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
});

export interface AuthRouteDeps {
  db: Db;
  config: AppConfig;
  siteLimits: SiteLimits;
  gate: UserGate;
  throttle: LoginThrottle;
  collabHooks: CollabHooks;
  reloginReverifyDelayMs?: number;
}

// Unknown account, OIDC-only and wrong password all return the same 401 and call recordFailure; the first two run a dummy verify on DUMMY_HASH so timing isn't an oracle.
export function authRoutes(deps: AuthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // No auth: the login page needs the providers before credentials are entered; only id, display name and icon are exposed (AuthProviderPublicDto).
    app.get("/api/auth/config", async (request): Promise<AuthConfigDto> => {
      const { providers, autoCreateProviderIds } = await listEnabledProvidersForConfig(deps.db);
      const registrationEnabled = await readRegistrationEnabled(deps.db);
      if (registrationEnabled === null) request.log.error("site_settings 讀不到列：帳密自助註冊與 SSO 首登自動建帳都視同關閉（#187）");
      const passwordLoginEnabled = await isPasswordLoginAccepted(deps.db, deps.config, request.log);
      const [versionsRow] = await deps.db.select({ v: siteSettings.autoVersionsEnabled }).from(siteSettings).where(eq(siteSettings.singleton, true)).limit(1);
      return {
        providers,
        registration: { enabled: registrationEnabled ?? false, providerIds: registrationEnabled === null ? [] : autoCreateProviderIds },
        passwordLogin: { enabled: passwordLoginEnabled },
        autoVersionsEnabled: versionsRow?.v ?? true,
        noteMaxBytes: deps.siteLimits.get("noteMaxBytes"),
        maxUploadBytes: deps.siteLimits.get("uploadMaxBytes"),
        maxMediaUploadBytes: deps.siteLimits.get("uploadMediaMaxMib") * 1_048_576,
      };
    });

    // `v` is immutable only when it equals the current version exactly (`01` or `1.0` would long-cache a different URL).
    // No auth and ignores `enabled`: the login page needs icons before sign-in and the admin list shows disabled providers; icons aren't secret and ids are UUIDs.
    // Unthrottled; the MIME type is the one detected from the file header at upload.
    app.get("/api/auth/providers/:id/icon", async (request, reply) => {
      const raw = (request.params as { id: string }).id;
      if (!UUID_RE.test(raw)) return sendError(reply, 404, "not_found", ICON_NOT_FOUND_MESSAGE);
      const [row] = await deps.db
        .select({ iconKind: authProviders.iconKind, iconData: authProviders.iconData, iconMime: authProviders.iconMime, iconVersion: authProviders.iconVersion })
        .from(authProviders)
        .where(eq(authProviders.id, raw.toLowerCase()))
        .limit(1);
      if (!row || row.iconKind !== "upload" || row.iconData === null || row.iconMime === null) {
        return sendError(reply, 404, "not_found", ICON_NOT_FOUND_MESSAGE);
      }
      const v = (request.query as { v?: unknown }).v;
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "default-src 'none'; sandbox");
      reply.header("cache-control", typeof v === "string" && v === String(row.iconVersion) ? "public, max-age=31536000, immutable" : "no-cache");
      reply.type(row.iconMime);
      return reply.send(row.iconData);
    });

    app.post("/api/auth/login", async (request, reply) => {
      const parsed = loginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      }
      // Before reading the account and throttle: the response is account-independent, so there is no oracle and no dummy hash is needed; skipping argon2 also removes a CPU amplifier. Unthrottled while disabled (accepted). Admins are not exempt.
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      // Single normalization funnel: if the throttle key and the DB lookup normalized differently, case variants would each get their own throttle count.
      const email = normalizeEmail(parsed.data.email);
      const { password } = parsed.data;

      const throttleCheck = deps.throttle.checkAllowed(email, request.ip);
      if (!throttleCheck.allowed) {
        return sendLoginThrottled(reply, throttleCheck.retryAfterMs!);
      }

      // lower() mirrors the write paths, which store normalized lowercase. Multi-row guard (email is unique, so this is defense in depth).
      const [user] = await deps.db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .orderBy(users.createdAt, users.id)
        .limit(1);

      let verified: boolean;
      try {
        if (user?.passwordHash) {
          verified = await verifyPassword(user.passwordHash, password);
        } else {
          await verifyPassword(DUMMY_HASH, password);
          verified = false;
        }
      } catch (err) {
        if (err instanceof HashBusyError) {
          return sendError(reply, 429, "server_busy", "The server is busy. Try again in a moment.");
        }
        throw err;
      }

      if (!verified) {
        deps.throttle.recordFailure(email, request.ip);
        return sendError(reply, 401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
      }

      // Disabled is checked only after the password verifies, so a wrong password reveals nothing.
      if (user!.disabledAt !== null) {
        return sendError(reply, 403, "account_disabled", "This account is disabled.");
      }

      deps.throttle.recordSuccess(email, request.ip);
      await touchLastLogin(deps.db, user!.id, request.log);
      await startSession(deps, request, reply, { userId: user!.id, tv: user!.tokenVersion });

      const dto: UserDto = {
        id: user!.id,
        email: user!.email,
        handle: user!.handle,
        displayName: user!.displayName,
        isAdmin: user!.isAdmin,
        mustChangePassword: user!.mustChangePassword,
        hasPassword: user!.passwordHash !== null,
        autoVersions: user!.autoVersions,
        avatar: await readCurrentAvatar(deps.db, user!.id),
      };

      return reply.send(dto);
    });

    /** Logs out only this device; other devices' sessions are unaffected. Idempotent: no cookie, bad signature, an old JWT without `sid`, a missing row or a DB error while deleting all still return 204 and clear the cookie (on a DB error this device's collab connections aren't re-verified; a 500 would leave the web logout half done, and clearing the cookie needs no DB). The row then lives until expiry, usable only through a copied cookie. */
    app.post("/api/auth/logout", async (request, reply) => {
      const ended = await deleteSessionFromCookie(deps, request);
      if (ended) deps.collabHooks.onSessionRevoked(ended.userId, ended.sid);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.get("/api/auth/me", { preHandler: app.authenticate }, async (request): Promise<UserDto> => request.user!);

    const profileBodySchema = z
      .object({
        handle: z.string().optional(),
        autoVersions: z.boolean().optional(),
        displayName: z
          .string()
          .trim()
          .refine(isStorableText, "The display name contains characters that can't be stored.")
          .refine(s => s.length > 0, "The display name can't be empty.")
          .refine(s => [...s].length <= MAX_REGISTER_DISPLAY_NAME_LENGTH, `The display name can be at most ${MAX_REGISTER_DISPLAY_NAME_LENGTH} characters.`)
          .optional(),
      })
      .refine(b => b.handle !== undefined || b.autoVersions !== undefined || b.displayName !== undefined, { message: "Invalid request body: send at least one field." });
    /** Values after the write: request.user is the gate's 60 s cache. */
    const profileReturning = () => ({
      id: users.id, email: users.email, handle: users.handle, displayName: users.displayName, isAdmin: users.isAdmin,
      mustChangePassword: users.mustChangePassword, hasPassword: sql<boolean>`${users.passwordHash} is not null`, autoVersions: users.autoVersions,
      // Literal `users.id`: an interpolated column renders as a bare "id" in a single-table RETURNING and is captured by the inner FROM (always null).
      avatar: sql<UserAvatarDto | null>`(select json_build_object('id', ua.id, 'v', ua.version, 'pending', ua.display_data is null) from ${userAvatars} ua where ua.user_id = users.id and ua.is_current)`,
    });

    /**
     * Rename (#122, #291). Order inside the transaction matters: lock own row first (concurrent renames queue), count renames in the last 24 h after the lock
     * (so a queued rename sees the earlier one's commit and both can't pass the quota; >= 5 → 429), INSERT the new name (another user's current name → 409) before
     * DELETEing the old one (the other order deadlocks two people swapping names), then UPDATE users and record the rename.
     * The old name comes from the in-tx SELECT (request.user is a 60 s cache). With only autoVersions/displayName it is a plain UPDATE outside the rename transaction and quota;
     * sent with handle, they go in the same UPDATE users and roll back with a name collision. Every branch must reach the single gate.invalidate at the end.
     */
    app.patch("/api/auth/profile", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = profileBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      const userId = request.user!.id;
      const { autoVersions, displayName } = parsed.data;
      const extra = {
        ...(autoVersions !== undefined ? { autoVersions } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
      };
      let normalized: string | undefined;
      if (parsed.data.handle !== undefined) {
        normalized = normalizeHandle(parsed.data.handle);
        if (validateHandle(normalized) !== null) {
          return sendError(reply, 400, "invalid_body", "Invalid username: use 1 to 32 lowercase letters, digits and hyphens, with no hyphen at the start or end and no two in a row.");
        }
      }
      let dto: UserDto | undefined;
      if (normalized === undefined) {
        const [row] = await deps.db.update(users).set(extra).where(eq(users.id, userId)).returning(profileReturning());
        dto = row;
      } else {
        const newHandle = normalized;
        // A DB count (handle_renames), not a FixedWindowLimiter, so it survives restarts and multiple instances.
        const RENAME_QUOTA_PER_DAY = 5;
        const QUOTA_EXCEEDED = Symbol("rename-quota");
        const HANDLE_TAKEN = Symbol("rename-handle-taken");
        try {
          dto = await deps.db.transaction(async tx => {
            const [row] = await tx.select({ handle: users.handle }).from(users).where(eq(users.id, userId)).limit(1).for("update");
            const oldHandle = row!.handle;
            if (newHandle === oldHandle) throw HANDLE_TAKEN; // renaming to your current name must not return 200 or use quota, even in the window form (no registry row)

            const [spent] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(handleRenames)
              .where(and(eq(handleRenames.userId, userId), gt(handleRenames.renamedAt, sql`now() - interval '1 day'`)));
            if (spent!.n >= RENAME_QUOTA_PER_DAY) throw QUOTA_EXCEEDED;

            await tx.insert(handles).values({ handle: newHandle, userId, state: "live" });

            // 0 rows deleted is fine (window form: own name not in the registry); `user_id` keeps this from deleting another user's row.
            await tx.delete(handles).where(and(eq(handles.handle, oldHandle), eq(handles.userId, userId)));

            const [updated] = await tx
              .update(users)
              .set({ handle: newHandle, ...extra })
              .where(eq(users.id, userId))
              .returning(profileReturning());

            await tx.insert(handleRenames).values({ userId });
            return updated!;
          });
        } catch (err) {
          if (err === QUOTA_EXCEEDED) {
            return sendError(reply, 429, "too_many_requests", "Too many username changes: at most 5 in 24 hours. Try again later.");
          }
          if (err === HANDLE_TAKEN) return sendError(reply, 409, "handle_taken", "That username is taken.");
          const constraint = uniqueViolationConstraint(err);
          if (constraint === "handles_pkey" || constraint === "users_handle_unique") {
            return sendError(reply, 409, "handle_taken", "That username is taken.");
          }
          throw err;
        }
      }
      if (dto === undefined) return sendError(reply, 401, "unauthorized", "Not signed in.");
      deps.gate.invalidate(userId);
      return reply.send(dto);
    });

    app.post("/api/auth/password", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = passwordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      }
      const { currentPassword, newPassword } = parsed.data;
      const userId = request.user!.id;

      const [row] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!row) {
        return sendError(reply, 401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
      }

      let verified: boolean;
      try {
        if (row.passwordHash) {
          verified = await verifyPassword(row.passwordHash, currentPassword);
        } else {
          await verifyPassword(DUMMY_HASH, currentPassword);
          verified = false;
        }
      } catch (err) {
        if (err instanceof HashBusyError) {
          return sendError(reply, 429, "server_busy", "The server is busy. Try again in a moment.");
        }
        throw err;
      }

      if (!verified) {
        return sendError(reply, 401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
      }

      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }

      let newPasswordHash: string;
      try {
        newPasswordHash = await hashPassword(newPassword);
      } catch (err) {
        if (err instanceof HashBusyError) {
          return sendError(reply, 429, "server_busy", "The server is busy. Try again in a moment.");
        }
        throw err;
      }

      // token_version is bumped in SQL: a read-modify-write between two concurrent changes would lose an increment and roll a revocation back. The transaction (#388) keeps the bump and
      // the session-row swap under one users row lock. A successful change always clears mustChangePassword. The TTL is read once so the new row and the re-signed cookie agree (#397).
      const ttlSeconds = deps.siteLimits.get("sessionTtlSeconds");
      const input = { userId, passwordHash: newPasswordHash, ttlSeconds };
      const updated = await deps.db.transaction(tx => changePasswordInTx(tx, input));
      if (updated === null) return sendError(reply, 401, "unauthorized", "Not signed in.");

      deps.gate.invalidate(userId);
      deps.collabHooks.onUserRevoked(userId);

      // Re-sign with the DB-returned tokenVersion (not snapshot + 1, which can differ under concurrency) so the user isn't logged out by their own bump.
      await setSessionCookieFor(reply, deps.config, { userId, tv: updated.tokenVersion, sid: updated.sessionId, ttlSeconds });

      return reply.code(204).send();
    });
  };
}
