import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { MAX_REGISTER_DISPLAY_NAME_LENGTH, SESSION_COOKIE, normalizeEmail, normalizeHandle, validateHandle, type AuthConfigDto, type UserDto } from "@knotebook/shared";
import { sendError, sendLoginThrottled } from "../http/errors.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { authProviders, handleRenames, handles, siteSettings, users } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { uniqueViolationConstraint } from "../db/pg-errors.js";
import { verifyPassword, hashPassword, HashBusyError, DUMMY_HASH } from "../auth/password.js";
import { signSession, type UserGate } from "../auth/session.js";
import { setSessionCookie } from "../auth/cookies.js";
import { touchLastLogin } from "../auth/last-login.js";
import type { LoginThrottle } from "../auth/rate-limit.js";
import type { CollabHooks } from "../collab/hooks.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";
import { listEnabledProvidersPublic } from "../auth/oidc-providers.js";
import { readRegistrationEnabled } from "../auth/site-settings.js";
import { isPasswordLoginAccepted, PASSWORD_LOGIN_DISABLED_MESSAGE } from "../auth/password-login.js";
import { isStorableText } from "../auth/admin-provider-input.js";

const INVALID_CREDENTIALS_MESSAGE = "帳號或密碼錯誤";
const ICON_NOT_FOUND_MESSAGE = "找不到此圖示";

// 只驗結構，內容一律讓 DB 查詢/密碼驗證自然決定結果——login 對外只有一種失敗訊息
// （invalid_credentials），不該讓 email 格式檢查變成一個額外的、可被用來區分
// 「帳號存在與否」的旁路（例如 `.email()` 格式驗證失敗直接回 400，會讓攻擊者用
// 格式錯誤/格式正確但帳號不存在來探測）。
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
  gate: UserGate;
  throttle: LoginThrottle;
  collabHooks: CollabHooks;
}

/**
 * 登入/登出/me/改密碼路由。
 *
 * `POST /api/auth/login` 的等時化 oracle 防護：帳號不存在、OIDC-only（無
 * passwordHash）、密碼錯誤這三種情況一律回同一組 401 `invalid_credentials`
 * （同 code、同 message），且都會呼叫 `throttle.recordFailure`；帳號不存在或
 * OIDC-only 時改用 `DUMMY_HASH` 跑一次 dummy verify（而非直接短路回 401），
 * 讓耗時與「真的算了一次 argon2 verify」的路徑相近，不讓回應時間差成為新的 oracle。
 */
export function authRoutes(deps: AuthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // 免認證（#187）：登入頁在使用者輸入帳密之前就要知道有哪些登入服務。只曝光 id、顯示名與圖示（AuthProviderPublicDto）。
    // GET 不受 app.ts 的 JSON CSRF hook 影響。
    app.get("/api/auth/config", async (request): Promise<AuthConfigDto> => {
      const providers = await listEnabledProvidersPublic(deps.db);
      const registrationEnabled = await readRegistrationEnabled(deps.db);
      if (registrationEnabled === null) request.log.error("site_settings 讀不到列：註冊視同關閉（#187 §4.3）");
      // §9.5：有效值（DB OR env）；不揭露是否 env 強制。讀不到列 → 開＋log.error（B17）。
      const passwordLoginEnabled = await isPasswordLoginAccepted(deps.db, deps.config, request.log);
      // 版本歷史 §6.8：總開關讓非 admin 也讀得到（個人／群組開關的 disabled 顯示）。讀不到列 → true（DB 預設；起草裁定 16）。
      const [versionsRow] = await deps.db.select({ v: siteSettings.autoVersionsEnabled }).from(siteSettings).where(eq(siteSettings.singleton, true)).limit(1);
      return {
        providers, registration: { enabled: registrationEnabled ?? false }, passwordLogin: { enabled: passwordLoginEnabled },
        autoVersionsEnabled: versionsRow?.v ?? true,
      };
    });

    /**
     * 登入服務圖示（spec 2026-10-07-provider-icon §4.4）：免登入、不看 enabled（停用中也可讀——admin 列表要用；圖示非機密、id 為 UUID）。
     * 只回檔頭驗過的 PNG／JPEG／WebP（PUT 時存的偵測值），`nosniff`＋`default-src 'none'; sandbox`。
     * `v` 字串**完全等於**現版本才 immutable（`01`、`1.0` 不算——版本不同的網址不得被長快取，§7.3）。不加節流（Q9）。
     */
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
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      // #187 B20：帳密登入的有效值為關 → 403。排在讀帳號與 throttle **之前**：回應與帳號完全無關（同碼、同訊息、不讀 users），
      // 本身不是存在性 oracle，所以不需要 dummy-hash 等時化；不跑 argon2 也拿掉一個 CPU 放大面。關閉期間這條路徑不吃任何節流
      // （§17 第 33 條，接受）。管理員不豁免（W24）。
      if (!(await isPasswordLoginAccepted(deps.db, deps.config, request.log))) {
        return sendError(reply, 403, "password_login_disabled", PASSWORD_LOGIN_DISABLED_MESSAGE);
      }
      // 進門一次性正規化（spec §14.3 單一漏斗）：下面 throttle 鍵值、DB 查詢、
      // recordFailure/recordSuccess 全部共用這個值——throttle 帳號鍵與 DB 查詢比對
      // 若用不同的正規化值，Mixed-Case 變體就能各自累積獨立的 throttle 計數，形同
      // 繞過帳號軸限流。
      const email = normalizeEmail(parsed.data.email);
      const { password } = parsed.data;

      const throttleCheck = deps.throttle.checkAllowed(email, request.ip);
      if (!throttleCheck.allowed) {
        return sendLoginThrottled(reply, throttleCheck.retryAfterMs!);
      }

      // lower() 讀取端比對，與寫入端（admin-users.ts／bootstrap.ts 皆存正規化小寫）
      // 對稱；多列命中防護：createdAt/id 排序取第一列（正常情況下 email 有 unique
      // 約束不會有多列，這裡是防禦縱深）。
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
          // 帳號不存在或 OIDC-only（無 passwordHash）：仍跑一次 dummy verify（結果丟棄，
          // 一律視為失敗）——只為了等時化，不讓「省略這次 argon2 運算」的耗時差異變成
          // 判斷帳號是否存在的 oracle。
          await verifyPassword(DUMMY_HASH, password);
          verified = false;
        }
      } catch (err) {
        if (err instanceof HashBusyError) {
          return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        }
        throw err;
      }

      if (!verified) {
        deps.throttle.recordFailure(email, request.ip);
        return sendError(reply, 401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
      }

      // 密碼已驗證正確——只有此時才檢查 disabled，避免密碼錯誤時洩漏帳號存在與否
      // 之外的額外資訊（是否被停用），也避免被用來當帳號存在 oracle。
      if (user!.disabledAt !== null) {
        return sendError(reply, 403, "account_disabled", "此帳號已被停用");
      }

      deps.throttle.recordSuccess(email, request.ip);
      await touchLastLogin(deps.db, user!.id, request.log); // #247 §9.5 寫入點 1：帳密登入
      const token = await signSession(deps.config.appSecret, { userId: user!.id, tv: user!.tokenVersion });
      setSessionCookie(reply, deps.config, token);

      // 標上 shared 的 DTO 型別：形狀漂移（少欄位、型別改了）在 server 端就編譯失敗，
      // 不必等 web 端 build 才發現——那時錯的其實已經是這裡（#21）。
      const dto: UserDto = {
        id: user!.id,
        email: user!.email,
        handle: user!.handle,
        displayName: user!.displayName,
        isAdmin: user!.isAdmin,
        mustChangePassword: user!.mustChangePassword,
        hasPassword: user!.passwordHash !== null,
        autoVersions: user!.autoVersions,
      };

      return reply.send(dto);
    });

    app.post("/api/auth/logout", async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.get("/api/auth/me", { preHandler: app.authenticate }, async (request): Promise<UserDto> => request.user!);

    const profileBodySchema = z
      .object({
        handle: z.string().optional(),
        autoVersions: z.boolean().optional(),
        // #247 §9.3：驗證與註冊同一套（routes/account.ts 的 registerBodySchema.displayName）。
        displayName: z
          .string()
          .trim()
          .refine(isStorableText, "顯示名稱含有無法儲存的字元")
          .refine(s => s.length > 0, "顯示名稱不得為空")
          .refine(s => [...s].length <= MAX_REGISTER_DISPLAY_NAME_LENGTH, `顯示名稱不得超過 ${MAX_REGISTER_DISPLAY_NAME_LENGTH} 個字`)
          .optional(),
      })
      .refine(b => b.handle !== undefined || b.autoVersions !== undefined || b.displayName !== undefined, { message: "請求格式錯誤：至少需要一個欄位" });
    /** 回應形：寫入後的值（交易內 RETURNING）——現行 `{ ...request.user, handle }` 是 gate 的 60 s 快取，不能沿用（r7 M-4）。 */
    const profileReturning = () => ({
      id: users.id, email: users.email, handle: users.handle, displayName: users.displayName, isAdmin: users.isAdmin,
      mustChangePassword: users.mustChangePassword, hasPassword: sql<boolean>`${users.passwordHash} is not null`, autoVersions: users.autoVersions,
    });

    /**
     * #122／#291 改名。單一 tx 六步：
     * ①`SELECT users.handle … FOR UPDATE`（本人列；同人併發改名排隊）
     * ②額度：數 `handle_renames` 24 h 內列數，≥5 → 429（DB 計數跨重啟／實例；在鎖之後數，同人併發也過不了額度）
     * ③`INSERT handles` 取新名（PK 裁決；改成他人現用名回 409；改成自己現行名在 ① 後即 409，不論 registry 有無自己的列）——必須先於 ④，倒過來兩人互換名字會死鎖
     * ④`DELETE` 舊名列（帶 `user_id`；刪 0 列照常繼續），commit 後舊名任何人可取用
     * ⑤`UPDATE users`
     * ⑥`INSERT handle_renames`
     *
     * 舊名以 tx 內 SELECT 為準（request.user 是 gate 的 60s 快取，可能落後）。
     * 成功後 `gate.invalidate`（比照改密碼），/api/auth/me 立即反映。
     * 版本歷史 §6.8、#247 §9.3：只帶 `autoVersions`／`displayName`（任一或兩者）→ 純 UPDATE、不進改名交易、不扣額度；與 `handle` 一起帶 →
     * 在改名交易的 `UPDATE users` 同一句寫（撞名回滾時一起不寫）。回應取寫入後的值（RETURNING），不沿用 `request.user` 快取；
     * 所有分支都經過下方同一個 `gate.invalidate` 出口——不得為 displayName 加提前 return。
     */
    app.patch("/api/auth/profile", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = profileBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      const userId = request.user!.id;
      const { autoVersions, displayName } = parsed.data;
      // 不在 handle 之列的欄位：純 UPDATE 分支整組寫、改名交易的 UPDATE 同一句帶上。
      const extra = {
        ...(autoVersions !== undefined ? { autoVersions } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
      };
      let normalized: string | undefined;
      if (parsed.data.handle !== undefined) {
        normalized = normalizeHandle(parsed.data.handle);
        if (validateHandle(normalized) !== null) {
          return sendError(reply, 400, "invalid_body", "使用者名格式不合法（1–32 字元、小寫英數與連字號，不可頭尾/連續連字號）");
        }
      }
      let dto: UserDto | undefined;
      if (normalized === undefined) {
        const [row] = await deps.db.update(users).set(extra).where(eq(users.id, userId)).returning(profileReturning());
        dto = row;
      } else {
        const newHandle = normalized;
        // 5/日（spec §2a；plan m10 的「無 limiter 常數」指不建 FixedWindowLimiter，
        // 具名常數反而消除 JSDoc/判斷/錯誤訊息三處數字漂移面）
        const RENAME_QUOTA_PER_DAY = 5;
        const QUOTA_EXCEEDED = Symbol("rename-quota");
        const HANDLE_TAKEN = Symbol("rename-handle-taken");
        try {
          dto = await deps.db.transaction(async tx => {
            // ① 鎖本人列：同人併發改名在此排隊、解鎖後讀到最新名（否則晚者刪 0 列、先者新名留成 live 孤兒）。
            const [row] = await tx.select({ handle: users.handle }).from(users).where(eq(users.id, userId)).limit(1).for("update");
            const oldHandle = row!.handle;
            if (newHandle === oldHandle) throw HANDLE_TAKEN; // 改成自己現行名：窗期形（無 registry 列）也不得 200／耗額度

            // ② 額度：鎖之後才數，排隊者看得到前者已 commit 的紀錄（I3）。
            const [spent] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(handleRenames)
              .where(and(eq(handleRenames.userId, userId), gt(handleRenames.renamedAt, sql`now() - interval '1 day'`)));
            if (spent!.n >= RENAME_QUOTA_PER_DAY) throw QUOTA_EXCEEDED;

            // ③ 取新名（PK 裁決）。必須先於 ④：倒過來兩人互換名字會死鎖（40P01 → 500），改成自己現行名也會回 200。
            await tx.insert(handles).values({ handle: newHandle, userId, state: "live" });

            // ④ 釋放舊名。刪 0 列＝本人現行名不在 registry（窗期形），照常繼續；帶 user_id 不會刪到他人的列。
            await tx.delete(handles).where(and(eq(handles.handle, oldHandle), eq(handles.userId, userId)));

            // ⑤ 改名；同一句帶上 autoVersions／displayName（兩者都帶 → 同一交易，§6.8、#247 §9.3）。
            const [updated] = await tx
              .update(users)
              .set({ handle: newHandle, ...extra })
              .where(eq(users.id, userId))
              .returning(profileReturning());

            // ⑥ 改名紀錄（額度來源）。
            await tx.insert(handleRenames).values({ userId });
            return updated!;
          });
        } catch (err) {
          if (err === QUOTA_EXCEEDED) {
            return sendError(reply, 429, "too_many_requests", "改名太頻繁（24 小時內最多改名 5 次）");
          }
          if (err === HANDLE_TAKEN) return sendError(reply, 409, "handle_taken", "此使用者名已被使用");
          const constraint = uniqueViolationConstraint(err);
          if (constraint === "handles_pkey" || constraint === "users_handle_unique") {
            return sendError(reply, 409, "handle_taken", "此使用者名已被使用");
          }
          throw err;
        }
      }
      if (dto === undefined) return sendError(reply, 401, "unauthorized", "未登入"); // 帳號在請求途中被刪
      // 比照改密碼的既有慣例：invalidate 讓下一次 authenticate 立刻反映（60s 快取不等 TTL）
      deps.gate.invalidate(userId);
      return reply.send(dto);
    });

    app.post("/api/auth/password", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = passwordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      const { currentPassword, newPassword } = parsed.data;
      const userId = request.user!.id;

      const [row] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
      // request.user 是 authenticate 剛查出來的，理論上這裡一定找得到；找不到就當
      // 成「憑證已失效」處理（一致的 401），不 throw 成 500。
      if (!row) {
        return sendError(reply, 401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
      }

      let verified: boolean;
      try {
        if (row.passwordHash) {
          verified = await verifyPassword(row.passwordHash, currentPassword);
        } else {
          // OIDC-only（無 passwordHash）：沒有密碼可比對，仍跑 dummy verify 等時化，
          // 結果一律視為失敗——與 login 路徑同一套 oracle 防護理由。
          await verifyPassword(DUMMY_HASH, currentPassword);
          verified = false;
        }
      } catch (err) {
        if (err instanceof HashBusyError) {
          return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        }
        throw err;
      }

      if (!verified) {
        return sendError(reply, 401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
      }

      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `密碼至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
      }

      let newPasswordHash: string;
      try {
        newPasswordHash = await hashPassword(newPassword);
      } catch (err) {
        if (err instanceof HashBusyError) {
          return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        }
        throw err;
      }

      // tokenVersion 遞增交給 SQL 端做原子操作（`tokenVersion = tokenVersion + 1`），
      // 不是先在應用層算出 `row.tokenVersion + 1` 再寫回——後者在兩個並發改密碼請求
      // 之間有 read-modify-write 競態（例如帳號被撤銷/改密碼的同時，另一個並發請求
      // 用同一份舊快照 +1 寫回，會把先前那次的遞增結果覆蓋掉，等於撤銷被回捲）。
      // 單一 UPDATE 陳述式本身已是原子操作，不需要額外包 `db.transaction`。
      // 成功改密碼一併清 mustChangePassword（spec rev 5.7）：不論這次改密碼前是 true 或
      // false，改完後一律 false——這是「自己主動改過密碼」這件事本身帶來的效果，不需要
      // 額外判斷原本的值。
      const [updated] = await deps.db
        .update(users)
        .set({ passwordHash: newPasswordHash, tokenVersion: sql`${users.tokenVersion} + 1`, mustChangePassword: false })
        .where(eq(users.id, userId))
        .returning();

      // 踢掉所有舊 session（含改密碼前簽發、當下可能正被其他裝置使用的那些）——
      // gate.invalidate 讓下一次 `authenticate` 立刻反映新 tokenVersion，
      // collabHooks.onUserRevoked 是 Plan 2 即時協作連線的接縫（Plan 1 為 noop）。
      deps.gate.invalidate(userId);
      deps.collabHooks.onUserRevoked(userId);

      // 重簽自己這個 request 的 cookie（帶 DB 端算出的新 tokenVersion，而非應用層快照
      // +1 的值——兩者在並發情境下可能不同，必須用 UPDATE ... RETURNING 拿到的真值），
      // 確保改密碼的本人不會被自己剛剛觸發的 tokenVersion bump 給登出。
      const newToken = await signSession(deps.config.appSecret, { userId, tv: updated.tokenVersion });
      setSessionCookie(reply, deps.config, newToken);

      return reply.code(204).send();
    });
  };
}
