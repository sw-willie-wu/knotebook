import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { normalizeEmail, normalizeHandle, validateHandle } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { Db } from "../db/index.js";
import { handles, users } from "../db/schema.js";
import { deriveHandle } from "../auth/handle.js";
import { hashPassword, HashBusyError } from "../auth/password.js";
import type { UserGate } from "../auth/session.js";
import type { CollabHooks } from "../collab/hooks.js";
import { UUID_RE } from "../notes/service.js";
import { MIN_PASSWORD_LENGTH } from "../auth/constants.js";
import { uniqueViolationConstraint } from "../db/pg-errors.js";

const createBodySchema = z.object({
  email: z.string().email(),
  password: z.string(),
  displayName: z.string().min(1),
  isAdmin: z.boolean().optional(),
  /** #122：選填使用者名——空＝從 email local-part 派生（spec §2b）。 */
  handle: z.string().optional(),
});

export interface AdminUsersRouteDeps {
  db: Db;
  gate: UserGate;
  collabHooks: CollabHooks;
}

interface AdminUserDto {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
}

interface AdminUserRow {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  createdAt: Date;
}

// 只選這七欄（形狀鎖，#122 起含 handle）：不可帶 passwordHash/tokenVersion——即使只是內部查詢，也不要
// select 出這兩欄再靠序列化階段刻意漏掉，直接在 SQL 端就不撈，斷絕任何洩漏路徑。
function toAdminUserDto(row: AdminUserRow): AdminUserDto {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const adminUserColumns = {
  id: users.id,
  email: users.email,
  handle: users.handle,
  displayName: users.displayName,
  isAdmin: users.isAdmin,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
};

/**
 * Admin 使用者管理路由：全部端點皆需 `requireAdmin`。
 *
 * disable/enable/promote 三支操作性端點對 `:id` 皆先以 `UUID_RE` 擋掉格式不合法的
 * 路徑參數（見 notes/service.ts 的 `resolveRole` 同一套理由：pg uuid 欄位對非法格式
 * 字串會直接 throw，讓它冒到全域錯誤 handler 會被誤判成 500），非法格式與「查無此
 * 使用者」統一回同一個 404 `user_not_found`，不特別區分。
 */
export function adminUsersRoutes(deps: AdminUsersRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/admin/users", { preHandler: app.requireAdmin }, async () => {
      // 次要排序鍵 id asc（同 notes.ts GET /api/notes 清單慣例）：createdAt 精度不足以
      // 保證唯一序，兩筆使用者在同一毫秒建立時排序會不穩定。
      const rows = await deps.db.select(adminUserColumns).from(users).orderBy(asc(users.createdAt), asc(users.id));
      return rows.map(toAdminUserDto);
    });

    app.post("/api/admin/users", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      // 寫入端正規化（spec §14.3 單一漏斗）：重複判定仍照舊由 unique 約束的 409
      // email_taken 承擔，這裡不新增預查（§14.3 ④）。
      const email = normalizeEmail(parsed.data.email);
      const { password, displayName, isAdmin } = parsed.data;

      if (password.length < MIN_PASSWORD_LENGTH) {
        return sendError(reply, 400, "password_too_short", `密碼至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
      }

      // #122：選填 handle——填了先驗證（400，不落 DB CHECK 500；空字串也是顯式非法值，
      // 不當成「空＝派生」）。放在 hashPassword 之前：非法 handle 不值得燒一次 argon2。
      let explicitHandle: string | undefined;
      if (parsed.data.handle !== undefined) {
        const normalized = normalizeHandle(parsed.data.handle);
        if (validateHandle(normalized) !== null) {
          return sendError(reply, 400, "invalid_body", "使用者名格式不合法（1–32 字元、小寫英數與連字號，不可頭尾/連續連字號）");
        }
        explicitHandle = normalized;
      }

      let passwordHash: string;
      try {
        passwordHash = await hashPassword(password);
      } catch (err) {
        if (err instanceof HashBusyError) {
          return sendError(reply, 429, "server_busy", "伺服器忙碌，請稍後再試");
        }
        throw err;
      }

      /**
       * #122 registry-first（spec §2a/§2b）：每次嘗試＝一個全新 tx（先 INSERT handles
       * 由 PK 裁決、再 INSERT users）——**改掉原本的獨立語句形**（users 先寫會繞過墓碑：
       * released 名字不在 users.handle 裡，users_handle_unique 擋不住）。
       * 重試契約：派生撞名（探測後的真競態）→ 整 tx 重跑、重新探測，≤3 次後第 4 次
       * 直接用 `user-<uuid8>`；顯式指定者不重試、409 `handle_taken`。
       * 判別依 constraint 名（M4-2）：舊的「任何 unique violation → email_taken」會把
       * handle 撞名誤報成 email 已被使用。
       */
      const MAX_DERIVE_ATTEMPTS = 3;
      let created: AdminUserRow | undefined;
      // 迴圈以 attempt 上界收束（讀碼審查 m5）：`created === undefined` 當唯一條件時，
      // 若 tx 意外 resolve undefined 會無界自旋、每圈真的建出一個 uuid8 使用者。
      for (let attempt = 1; created === undefined && attempt <= MAX_DERIVE_ATTEMPTS + 1; attempt += 1) {
        const id = randomUUID();
        try {
          created = await deps.db.transaction(async tx => {
            const handle =
              explicitHandle ??
              (attempt <= MAX_DERIVE_ATTEMPTS ? await deriveHandle(tx, [email.split("@")[0]], id) : `user-${id.slice(0, 8)}`);
            await tx.insert(handles).values({ handle, userId: id, state: "live" });
            // spec rev 5.7 / §14.2：admin UI 代建的帳號一律掛 mustChangePassword=true（密碼是
            // admin 代選，非本人自訂）——與 OIDC 自動建帳刻意不同，那邊維持 DB 預設 false。
            const [row] = await tx
              .insert(users)
              .values({ id, email, passwordHash, displayName, isAdmin: isAdmin ?? false, mustChangePassword: true, handle })
              .returning(adminUserColumns);
            return row;
          });
        } catch (err) {
          const constraint = uniqueViolationConstraint(err);
          if (constraint === "users_email_unique") {
            return sendError(reply, 409, "email_taken", "此 email 已被使用");
          }
          if (constraint === "handles_pkey" || constraint === "users_handle_unique") {
            if (explicitHandle !== undefined) {
              return sendError(reply, 409, "handle_taken", "此使用者名已被使用");
            }
            if (attempt <= MAX_DERIVE_ATTEMPTS) continue; // 整 tx 重跑（重新探測；第 4 次退 uuid8）
          }
          throw err;
        }
      }

      if (created === undefined) {
        // 不應到達（第 4 次的 uuid8 也撞名＝~2^-32 級；或 tx 意外 resolve undefined）——
        // fail loud 進全域 500，不靜默重試下去。
        throw new Error("admin 建帳：handle 配置重試耗盡");
      }
      return reply.code(201).send(toAdminUserDto(created));
    });

    app.post("/api/admin/users/:id/disable", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      // 正規化成小寫：pg 的 uuid 型別比對本身不分大小寫，但 `id === request.user!.id`
      // 這個自我鎖死檢查是純 JS 字串比對——request.user!.id 來自 DB（一律小寫），若
      // 路徑參數帶大寫版本的自己 UUID（格式仍合法，UUID_RE 帶 /i），字串比對會誤判
      // 成「不是自己」而放行，讓 admin 能繞過 cannot_disable_self 把自己鎖死。統一在
      // 這裡正規化，後續比對／查詢都用同一個小寫 id。
      const id = rawId.toLowerCase();
      if (id === request.user!.id) {
        return sendError(reply, 400, "cannot_disable_self", "無法停用自己的帳號");
      }

      // tokenVersion 遞增交給 SQL 端做原子操作（同 auth.ts 改密碼路徑的理由），且以
      // `disabledAt IS NULL` 作為條件更新：已停用者重複呼叫時 affected 0 列，藉此
      // 分辨「冪等（已停用）」與「真的第一次停用」，不再重複 bump tv。只 returning id
      // ——呼叫方不需要 passwordHash/tokenVersion 這些欄位進記憶體。
      const [updated] = await deps.db
        .update(users)
        .set({ disabledAt: sql`now()`, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(and(eq(users.id, id), isNull(users.disabledAt)))
        .returning({ id: users.id });

      if (!updated) {
        const [existing] = await deps.db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
        if (!existing) {
          return sendError(reply, 404, "user_not_found", "找不到此使用者");
        }
        // 已存在但這次 UPDATE 沒命中列：代表已經是停用狀態——冪等 204，不再重複
        // invalidate/onUserRevoked（上一次真正停用時已經處理過，狀態沒有變化）。
        return reply.code(204).send();
      }

      deps.gate.invalidate(id);
      deps.collabHooks.onUserRevoked(id);

      return reply.code(204).send();
    });

    app.post("/api/admin/users/:id/enable", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      // 正規化成小寫（見 disable 端點同一段註解）：三個 :id 端點統一套用，即使 enable/
      // promote 本身沒有「跟自己比對」的檢查，仍保持一致行為與可預期性。
      const id = rawId.toLowerCase();

      // 刻意不動 tokenVersion：disable 當下已 bump 過的 tv 維持不變，讓 disable 前簽發
      // 的舊 session 即使在 enable 之後仍然失效（binding：只有重新登入才能拿到新 session）。
      const [updated] = await deps.db.update(users).set({ disabledAt: null }).where(eq(users.id, id)).returning({ id: users.id });
      if (!updated) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }

      deps.gate.invalidate(id);

      return reply.code(204).send();
    });

    app.post("/api/admin/users/:id/promote", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      const id = rawId.toLowerCase();

      const [updated] = await deps.db.update(users).set({ isAdmin: true }).where(eq(users.id, id)).returning({ id: users.id });
      if (!updated) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }

      // gate 快取內的 isAdmin 若不即時失效，該使用者要等到快取 TTL（60s）過期才會被
      // requireAdmin 認可——invalidate 讓下一次 authenticate 立刻反映新 isAdmin。
      deps.gate.invalidate(id);

      return reply.code(204).send();
    });
  };
}
