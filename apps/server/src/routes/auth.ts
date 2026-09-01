import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { SESSION_COOKIE, normalizeEmail, normalizeHandle, validateHandle, type AuthConfigDto, type UserDto } from "@knotebook/shared";
import { sendError, sendLoginThrottled } from "../http/errors.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { handles, users } from "../db/schema.js";
import { uniqueViolationConstraint } from "../db/pg-errors.js";
import { verifyPassword, hashPassword, HashBusyError, DUMMY_HASH } from "../auth/password.js";
import { signSession, type UserGate } from "../auth/session.js";
import { setSessionCookie } from "../auth/cookies.js";
import type { LoginThrottle } from "../auth/rate-limit.js";
import type { CollabHooks } from "../collab/hooks.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";

const INVALID_CREDENTIALS_MESSAGE = "帳號或密碼錯誤";

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
    // 免認證（Plan 5 §5）：登入頁在使用者輸入帳密之前就要知道「有沒有 SSO 可用」，
    // 這條路由必須在未登入狀態下也能打。GET 不受 app.ts 的 JSON CSRF hook 影響
    // （該 hook 只管 POST/PUT/PATCH/DELETE，見 CHANGE_METHODS），不需要額外豁免。
    // 只曝光布林旗標，不回傳 issuerUrl/clientId 等設定細節。
    app.get("/api/auth/config", async (): Promise<AuthConfigDto> => ({ oidc: { enabled: deps.config.oidc !== undefined } }));

    app.post("/api/auth/login", async (request, reply) => {
      const parsed = loginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
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
      };

      return reply.send(dto);
    });

    app.post("/api/auth/logout", async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.get("/api/auth/me", { preHandler: app.authenticate }, async (request): Promise<UserDto> => request.user!);

    /**
     * #122 改名（spec §2a Task 4）。單一 tx 四步：①額度（**DB registry 計數**，5/日
     * ——`state='released' AND released_at > now()-1day`；不用 in-memory limiter：24h
     * 窗口重啟歸零的相對傷害太大，registry 天然跨重啟/實例）→ ②`INSERT handles`
     * 取新名（PK 裁決，含墓碑；**改成自己現行名也走這裡撞自己的 live 列回 409**——
     * 刻意，不得加 DELETE 短路破壞永不回收）→ ③釋放舊名（fail-closed upsert：正常態
     * live→released；窗期態（無列）補一筆 released；`WHERE user_id=$me` 防翻他人列，
     * **rowcount≠1 整 tx 回滾 500**）→ ④`UPDATE users`。
     *
     * 舊名以 tx 內 SELECT 為準（request.user 是 gate 的 60s 快取，可能落後）。
     * 成功後 `gate.invalidate`（比照改密碼），/api/auth/me 立即反映。
     * 同使用者併發改名可雙過額度計數——非安全邊界，明示接受（spec m4-5）。
     */
    app.patch("/api/auth/profile", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = z.object({ handle: z.string() }).safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      }
      const normalized = normalizeHandle(parsed.data.handle);
      if (validateHandle(normalized) !== null) {
        return sendError(reply, 400, "invalid_body", "使用者名格式不合法（1–32 字元、小寫英數與連字號，不可頭尾/連續連字號）");
      }
      const userId = request.user!.id;

      // 5/日（spec §2a；plan m10 的「無 limiter 常數」指不建 FixedWindowLimiter，
      // 具名常數反而消除 JSDoc/判斷/錯誤訊息三處數字漂移面）
      const RENAME_QUOTA_PER_DAY = 5;
      const QUOTA_EXCEEDED = Symbol("rename-quota");
      try {
        await deps.db.transaction(async tx => {
          const [spent] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(handles)
            .where(and(eq(handles.userId, userId), eq(handles.state, "released"), gt(handles.releasedAt, sql`now() - interval '1 day'`)));
          if (spent!.n >= RENAME_QUOTA_PER_DAY) throw QUOTA_EXCEEDED;

          // FOR UPDATE（讀碼審查 m1）：同人兩個併發 PATCH 若都讀到同一個舊名，晚者的
          // 釋放 upsert 會在先者 commit 後對新版本重評 WHERE（仍是本人）而過關——終態
          // 留下先者新名的 live 孤兒列（永不釋放、破壞「每人恰一列 live」不變量）。
          // 鎖住本人 users 列讓第二個 tx 在這裡排隊、解鎖後讀到最新名，孤兒形不可達。
          const [row] = await tx.select({ handle: users.handle }).from(users).where(eq(users.id, userId)).limit(1).for("update");
          const oldHandle = row!.handle;

          await tx.insert(handles).values({ handle: normalized, userId, state: "live" });

          const released = await tx.execute(
            sql`INSERT INTO handles (handle, user_id, state, released_at)
                VALUES (${oldHandle}, ${userId}, 'released', now())
                ON CONFLICT (handle) DO UPDATE SET state = 'released', released_at = now()
                WHERE handles.user_id = ${userId}`,
          );
          if (released.rowCount !== 1) {
            // 舊名的 registry 列屬他人（資料不一致形）——絕不靜默吞：整 tx 回滾。
            throw new Error(`改名釋放失敗：舊名 ${oldHandle} 的 registry 列不屬於本人（rowcount=${released.rowCount}）`);
          }

          await tx.update(users).set({ handle: normalized }).where(eq(users.id, userId));
        });
      } catch (err) {
        if (err === QUOTA_EXCEEDED) {
          return sendError(reply, 429, "too_many_requests", "改名太頻繁（每日限額已用完——舊名永不回收，改名是消耗性動作）");
        }
        const constraint = uniqueViolationConstraint(err);
        if (constraint === "handles_pkey" || constraint === "users_handle_unique") {
          return sendError(reply, 409, "handle_taken", "此使用者名已被使用");
        }
        throw err;
      }

      // 比照改密碼的既有慣例：invalidate 讓下一次 authenticate 立刻反映（60s 快取不等 TTL）
      deps.gate.invalidate(userId);
      const dto: UserDto = { ...request.user!, handle: normalized };
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
