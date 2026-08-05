import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../app.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { instanceSetup, users } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { signSession } from "../auth/session.js";
import { setSessionCookie } from "../auth/cookies.js";
import type { SetupState } from "../auth/setup.js";

const MIN_PASSWORD_LENGTH = 12;

// 只驗結構（型別/存在），不驗內容（email 格式、密碼長度、displayName 非空）——內容層級
// 的驗證要照 spec 規定的順序手動做（token 優先於 email/password/displayName 內容），
// 不能讓 zod 一次到位的 schema 把驗證順序洗掉。
const setupBodySchema = z.object({
  token: z.string(),
  email: z.string(),
  password: z.string(),
  displayName: z.string(),
});

export interface SetupRouteDeps {
  db: Db;
  config: AppConfig;
  setupState: SetupState;
}

/** POST /api/setup 交易內：instance_setup 的 atomic guard 沒拿到列時，用這個訊號中止交易並 rollback。 */
class AlreadySetupError extends Error {}

const PG_UNIQUE_VIOLATION = "23505";

/**
 * pg 的 unique_violation（code 23505）在拋出時，可能是原始的 node-postgres
 * `DatabaseError`（`.code` 直接在最外層），也可能被 drizzle-orm 包成
 * `DrizzleQueryError`（原始 pg 錯誤落在 `.cause`）——兩種形狀都要認得，否則
 * users.email 唯一鍵違反會被 `throw err` 一路冒到最外層變成未預期的 500。
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err: unknown): unknown => (typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined);
  if (code(err) === PG_UNIQUE_VIOLATION) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return code(cause) === PG_UNIQUE_VIOLATION;
}

/**
 * 一次性 setup 流程路由：`GET /api/setup/status`（免認證，查目前是否需要 setup）與
 * `POST /api/setup`（免認證，token 驗證通過後原子性建立第一個 admin user）。
 *
 * `POST /api/setup` 的唯一原子性機制是 `instance_setup` 表的 `INSERT ... ON CONFLICT
 * DO NOTHING RETURNING *`：拿不到列代表另一個並發請求已經（或正在）完成 setup，
 * 立刻中止交易回 409——不能只靠應用層的 `setupState` 狀態判斷並發安全（那沒有
 * DB 交易保證的原子性）。
 */
export function setupRoutes(deps: SetupRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/setup/status", async () => {
      const needed = await deps.setupState.isNeeded();
      return { needed };
    });

    app.post("/api/setup", async (request, reply) => {
      const parsed = setupBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      const { token, email, password, displayName } = parsed.data;

      // 順序 binding：token 驗證優先於 email/password/displayName 內容檢查——token
      // 錯誤時，不透露密碼/email 是否也有問題（403 不可被 400 蓋過）。
      if (!deps.setupState.verifyToken(token)) {
        return sendError(reply, 403, "invalid_setup_token", "setup token 錯誤或已失效");
      }

      // ---- 內容驗證段：以下皆為 400（結構已通過，token 也已通過，剩下是內容是否合法）----
      if (password.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `密碼至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
      }

      const emailCheck = z.string().email().safeParse(email);
      if (!emailCheck.success) {
        return sendError(reply, 400, "invalid_email", "email 格式錯誤");
      }

      const displayNameCheck = z.string().min(1).safeParse(displayName);
      if (!displayNameCheck.success) {
        return sendError(reply, 400, "invalid_display_name", "displayName 不可為空");
      }
      // ---- 內容驗證段結束 ----

      if (deps.config.bootstrapAdminEmail && email !== deps.config.bootstrapAdminEmail) {
        return sendError(reply, 403, "bootstrap_email_mismatch", "email 與 BOOTSTRAP_ADMIN_EMAIL 不符");
      }

      let admin: typeof users.$inferSelect;
      try {
        const passwordHash = await hashPassword(password);
        admin = await deps.db.transaction(async tx => {
          const [setupRow] = await tx.insert(instanceSetup).values({ singleton: true }).onConflictDoNothing().returning();
          if (!setupRow) throw new AlreadySetupError();

          const [user] = await tx.insert(users).values({ email, passwordHash, displayName, isAdmin: true }).returning();
          return user;
        });
      } catch (err) {
        if (err instanceof AlreadySetupError) {
          // 正面證明：instance_setup 的 singleton 列已經存在——不是這次交易失敗，是
          // 「setup 早就完成了」（可能是並發的另一個請求，或另一個管道直接寫入 DB）。
          // 要讓 setupState 反映這個事實，之後同一個 process 的 verifyToken/isNeeded
          // 才會與 DB 一致——不然這個 process 會誤以為自己手上的 token 還能再用一次。
          deps.setupState.markCompleted();
          return sendError(reply, 409, "already_setup", "此實例已完成 setup");
        }
        if (isUniqueViolation(err)) {
          // 這裡不是「setup 已完成」的正面證明：整筆交易（含 instance_setup 那個
          // insert）已經 rollback，所以不 markCompleted()——與上面的分支分開處理。
          // 訊息刻意中性，不透露到底是 email 已存在還是其他唯一鍵衝突。
          return sendError(reply, 409, "already_setup", "無法建立此帳號，可能已存在或實例已完成 setup");
        }
        throw err;
      }

      // 交易成功提交後才 markCompleted：確保「setup 已完成」這個 in-memory 事實只在
      // DB 真的落地之後才生效，避免交易失敗（例如 email 唯一鍵違反、整個 rollback）
      // 卻把 verifyToken 永久鎖死。
      deps.setupState.markCompleted();

      const sessionToken = await signSession(deps.config.appSecret, { userId: admin.id, tv: admin.tokenVersion });
      setSessionCookie(reply, deps.config, sessionToken);

      return reply
        .code(201)
        .send({ id: admin.id, email: admin.email, displayName: admin.displayName, isAdmin: admin.isAdmin });
    });
  };
}
