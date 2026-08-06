import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { NoteDto, Role, ShareDto } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { noteLinks, noteShares, noteStateBackups, noteStates, notes, uploads, users } from "../db/schema.js";
import type { CollabHooks } from "../collab/hooks.js";
import { resolveRole, UUID_RE } from "../notes/service.js";
import { signCollabToken } from "../collab/token.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";

// 建立時 title 允許省略（DB 端有 default "Untitled"），但若有帶就不可為空字串——
// 與 PATCH 的 title 驗證同一套規則，避免「傳空字串把標題清空」這種語意混淆的落地方式。
const createBodySchema = z.object({ title: z.string().min(1).optional() });
const updateBodySchema = z.object({ title: z.string().min(1) });
const putShareBodySchema = z.object({ email: z.string().email(), role: z.enum(["viewer", "editor"]) });

const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * pg 的 foreign_key_violation（code 23503）在拋出時，與 setup.ts 的
 * `isUniqueViolation` 同理：可能是原始 node-postgres `DatabaseError`（`.code` 在最外
 * 層），也可能被 drizzle-orm 包成 `DrizzleQueryError`（原始 pg 錯誤落在 `.cause`）——
 * 兩種形狀都要認得，否則會被 `throw err` 一路冒到全域錯誤 handler 變成未預期的 500。
 */
function isForeignKeyViolation(err: unknown): boolean {
  const code = (e: unknown): unknown => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  if (code(err) === PG_FOREIGN_KEY_VIOLATION) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return code(cause) === PG_FOREIGN_KEY_VIOLATION;
}

export interface NotesRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  config: AppConfig;
  /** Task 8 的 slugPatch 也取用同一包物件（見 `app.ts` 的接線註解），本檔目前只消費 collabToken。 */
  limiters: { collabToken: FixedWindowLimiter; slugPatch: FixedWindowLimiter };
}

// 只列出 toNoteDto 實際會用到的欄位（而非完整 `typeof notes.$inferSelect`）：GET
// list 那支改走 UNION ALL 後，兩個分支各自的 select shape 只挑這五欄 + role，不含
// linksClock/deletedAt——用這個窄介面讓「完整 note row」與「union 出來的窄 row」都能
// 結構相容地傳進來，不必為了餵同一個函式而多 select 用不到的欄位。
interface NoteFields {
  id: string;
  title: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

function toNoteDto(note: NoteFields, role: Role): NoteDto {
  return {
    id: note.id,
    title: note.title,
    ownerId: note.ownerId,
    role,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

/**
 * Notes CRUD 路由——皆需認證（`authenticate` preHandler）。
 *
 * `GET /api/notes/:id`／`PATCH`／`DELETE` 一律先經 `resolveRole` 判斷權限：查無權限
 * （'none'，涵蓋「note 不存在」與「存在但未分享給此使用者」兩種情況）一律回 404
 * `not_found`，不區分這兩者——避免把「note 是否存在」洩漏給無權限的使用者
 * （spec：防列舉）。403 `forbidden` 只用在「查得到、但角色不夠」的情況
 * （PATCH 需要 editor+，viewer 會落在這裡；DELETE 需要 owner，editor/viewer 會落在這裡）。
 */
export function notesRoutes(deps: NotesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/api/notes", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      const userId = request.user!.id;

      // title 未帶時完全不放進 values——讓 DB 的 default "Untitled" 生效，而不是應用層
      // 自己重複寫死同一個預設值字面量（唯一真相來源在 schema.ts）。
      const values = parsed.data.title === undefined ? { ownerId: userId } : { ownerId: userId, title: parsed.data.title };
      const [note] = await deps.db.insert(notes).values(values).returning();

      return reply.code(201).send(toNoteDto(note, "owner"));
    });

    app.get("/api/notes", { preHandler: app.authenticate }, async request => {
      const userId = request.user!.id;

      // I1（審查）：原本的 leftJoin + WHERE(owner_id=$u OR note_shares.user_id=$u) 形狀
      // 中，那個 OR 橫跨了 outer join 兩側的欄位——單靠幫 owner_id／note_shares.user_id
      // 個別加索引救不了，planner 對這種「join 結果上的 OR」通常還是得整個 notes 表
      // 全掃一輪（無法把 OR 的任一邊下推成單獨的 index scan）。改寫成 UNION ALL 兩支
      // 各自單純的查詢：自有分支 `WHERE owner_id=$u`（吃 notes_owner_idx）、被分享分支
      // `INNER JOIN note_shares ON note_id=notes.id AND user_id=$u`（吃
      // note_shares_user_idx），兩支各自可以走 index scan，讓索引真的生效。
      //
      // Task 11 re-review（I1 補述）：兩分支結構上不保證互斥——note_shares 目前雖然靠
      // PUT /api/notes/:id/shares 的 `cannot_share_with_self` 擋掉 owner 把自己加進
      // 自己的分享名單，但那只是應用層的單一入口擋，不是資料庫層的不可能。若未來有
      // 其他路徑（手動 SQL、資料修復腳本、之後新增的匯入功能等）繞過那層檢查，塞進一筆
      // owner 對自己 note 的 note_shares 列，被分享分支就會多撈出同一篇 note 的第二列
      // （role 還會是錯的：note_shares 上存的 'editor'/'viewer'，而非其實際身分
      // 'owner'）。因此被分享分支額外加上 `ne(notes.ownerId, userId)`，在資料庫層面
      // 直接排除這種自我分享列，讓「同一位使用者、同一篇 note 只會出現一列」在結構上
      // 就不可能被打破，不依賴上層某個入口有沒有檢查到——防禦縱深（見
      // test/shares.test.ts「GET /api/notes 清單去重」）。
      const ownedSelect = deps.db
        .select({
          id: notes.id,
          title: notes.title,
          ownerId: notes.ownerId,
          createdAt: notes.createdAt,
          updatedAt: notes.updatedAt,
          role: sql<string>`'owner'`.as("role"),
        })
        .from(notes)
        .where(eq(notes.ownerId, userId));

      const sharedSelect = deps.db
        .select({
          id: notes.id,
          title: notes.title,
          ownerId: notes.ownerId,
          createdAt: notes.createdAt,
          updatedAt: notes.updatedAt,
          role: noteShares.role,
        })
        .from(notes)
        .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
        .where(ne(notes.ownerId, userId));

      // 次要排序鍵 id desc（M3）：updatedAt 精度不足以保證唯一序，未來若加分頁
      // （keyset pagination），排序不穩定會讓同一批結果在跨頁時重複或漏掉列。
      const rows = await unionAll(ownedSelect, sharedSelect).orderBy(desc(notes.updatedAt), desc(notes.id));

      return rows.map((row): NoteDto => toNoteDto(row, row.role as Role));
    });

    app.get("/api/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }

      // I2（審查）：resolveRole 判定完到這裡的 re-select 之間存在競態視窗——若同時有
      // 另一個請求把這篇 note 刪了，這裡會查不到列。用 guard 明確回 404，不是拿
      // non-null assertion 賭「resolveRole 說有就一定還在」（那個賭注在併發下不成立，
      // `note!` 一旦落空會直接在 toNoteDto 內對 undefined 取欄位炸成 500）。
      const [note] = await deps.db.select().from(notes).where(eq(notes.id, id)).limit(1);
      if (!note) {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      return toNoteDto(note, role);
    });

    app.patch("/api/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const parsed = updateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role === "viewer") {
        return sendError(reply, 403, "forbidden", "沒有編輯權限");
      }

      // I2（審查）：同一個競態視窗（resolveRole 判定完到這裡的 UPDATE 之間可能被另一個
      // 請求刪除），`.returning()` 落空時代表 UPDATE 命中 0 列——明確回 404，不是拿
      // non-null assertion 賭一定有結果。
      const [updated] = await deps.db
        .update(notes)
        .set({ title: parsed.data.title, updatedAt: new Date() })
        .where(eq(notes.id, id))
        .returning();
      if (!updated) {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }

      return toNoteDto(updated, role);
    });

    app.delete("/api/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以刪除");
      }

      // Plan 2 接縫：關閉/flush 該文件所有進行中的即時協作連線，必須在刪除交易「之前」
      // 完成並 await——若交易先跑，Hocuspocus 端可能在文件已經被刪除之後才嘗試 flush，
      // 落地到一筆孤兒 note_states/note_state_backups（或對已刪除 noteId 的外鍵失敗）。
      // Plan 1 這裡注入的是 noopCollabHooks，本身不做任何事；此呼叫只是先把接縫留好。
      await deps.collabHooks.beforeNoteDeleted(id);

      await deps.db.transaction(async tx => {
        await tx.delete(noteStates).where(eq(noteStates.noteId, id));
        await tx.delete(noteStateBackups).where(eq(noteStateBackups.noteId, id));
        await tx.delete(noteShares).where(eq(noteShares.noteId, id));
        await tx.delete(noteLinks).where(or(eq(noteLinks.sourceNoteId, id), eq(noteLinks.targetNoteId, id)));
        await tx.delete(uploads).where(eq(uploads.noteId, id));
        await tx.delete(notes).where(eq(notes.id, id));
      });

      return reply.code(204).send();
    });

    /**
     * 簽發共編（Hocuspocus）連線用的短效 token（spec §5 關鍵契約，逐字）。
     *
     * 與其他 notes 路由的「none → 404」慣例**刻意不同**：有 session 但對此 note 無權限
     * （`resolveRole` 回 'none'）一律回 **200 + `role:'none'` 的 token**，絕不 403/404。
     * 理由：此 endpoint 只是「幫你把目前的權限狀態簽成一份可攜的憑證」，本身不代表
     * 「你正在存取這篇筆記的內容」；真正的存取控制在 Hocuspocus `onAuthenticate`
     * （Task 5）憑 token 內的 role 執行——'none' token 會在那裡被拒連，而不是在這裡
     * 提前用 HTTP 錯誤碼洩漏「有沒有權限」這件事的存在與否（此 endpoint 本身不因權限
     * 高低而有不同的可觀察行為，防止被拿來當作權限探測 oracle）。
     *
     * body 的 `role` 與 JWT 內的 role 重複：client 不解 JWT（也不該解——那是 server 與
     * Hocuspocus 之間的憑證），N4 降級通知要顯示的角色資訊改讀這個頂層欄位。
     *
     * per-user 節流（`limiters.collabToken`，預設 60 次/分鐘）：超限回標準 429
     * `too_many_requests`——不像 `sendLoginThrottled` 額外帶 `retryAfterMs`（spec 沒有
     * 要求 client 據此排程重試，維持標準錯誤 body 形狀即可）。
     */
    app.post("/api/notes/:id/collab-token", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      if (!deps.limiters.collabToken.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      }

      const role = await resolveRole(deps.db, userId, id);
      const token = await signCollabToken(deps.config.appSecret, {
        noteId: id,
        userId,
        role,
        tv: request.sessionTv!,
      });

      return { token, role };
    });

    // 以下三支分享管理路由全部 authenticate + owner-only：none → 404 not_found（不
    // 洩漏「note 是否存在」給無權限者，與其他 notes 路由的防列舉原則一致）；查得到但
    // 角色不是 owner（editor/viewer）→ 403 forbidden。
    app.get("/api/notes/:id/shares", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以查看分享名單");
      }

      // orderBy(users.email)：回應順序確定性，比照 GET /api/notes 清單的次要排序鍵慣例
      // （沒有穩定排序，測試斷言與前端渲染順序都會受 DB 實際回傳順序影響而不可靠）。
      const rows = await deps.db
        .select({ userId: noteShares.userId, email: users.email, displayName: users.displayName, role: noteShares.role })
        .from(noteShares)
        .innerJoin(users, eq(users.id, noteShares.userId))
        .where(eq(noteShares.noteId, id))
        .orderBy(users.email);

      return rows.map((row): ShareDto => ({ userId: row.userId, email: row.email, displayName: row.displayName, role: row.role as ShareDto["role"] }));
    });

    app.put("/api/notes/:id/shares", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const parsed = putShareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以管理分享");
      }

      const [target] = await deps.db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
      if (!target) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      if (target.id === userId) {
        return sendError(reply, 400, "cannot_share_with_self", "不能分享給自己");
      }

      try {
        await deps.db
          .insert(noteShares)
          .values({ noteId: id, userId: target.id, role: parsed.data.role })
          .onConflictDoUpdate({ target: [noteShares.noteId, noteShares.userId], set: { role: parsed.data.role } });
      } catch (err) {
        // I2（審查）：resolveRole／email 查找完成到這個 insert 之間存在競態視窗——note
        // 可能被 owner 自己在另一個分頁同時 DELETE 掉（note_shares.note_id 的 FK），或
        // target user 剛好被管理員刪除／停用流程清掉（note_shares.user_id 的 FK，若
        // 未來 users 刪除不再只是 soft delete）——兩種都會讓這個 insert 撞上
        // foreign_key_violation，而不是「權限判斷落後於實際狀態」以外的真正伺服器錯誤。
        // 用 `note!`/`target!` 賭「resolveRole／email 查找說有就一定還在」在併發下不
        // 成立（同 GET/PATCH/DELETE /api/notes/:id 已有的 I2 慣例），這裡改成明確
        // catch 住 FK violation 並映射成 404 not_found——不特別區分是 note 還是 user
        // 消失，避免對 owner 洩漏「到底是哪一邊被刪除」的細節。
        if (isForeignKeyViolation(err)) {
          return sendError(reply, 404, "not_found", "找不到此筆記");
        }
        throw err;
      }

      // binding 規格：role 從 editor 降為 viewer（撤權）或任何變更都要呼叫
      // onShareChanged 逼迫 Plan 2 重驗該使用者在此文件上的連線權限。這裡不特地去查
      // upsert 前的舊 role 來判斷「這次到底算不算降級」——統一呼叫：對「其實是升級」或
      // 「角色沒變」的情況，重驗只是多一次無害的握手（Plan 1 這裡注入的
      // noopCollabHooks 甚至完全不做事）；反之若漏判某個實際上是降級的情況（例如未來
      // 改壞這段判斷邏輯），代價是「已撤權的使用者還能繼續編輯進行中的連線」，遠比多餘
      // 呼叫一次更危險。統一呼叫用簡單性換取這裡不會漏判。
      deps.collabHooks.onShareChanged(id, target.id);

      const dto: ShareDto = { userId: target.id, email: target.email, displayName: target.displayName, role: parsed.data.role };
      return dto;
    });

    app.delete("/api/notes/:id/shares/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetUserId } = request.params as { id: string; userId: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以管理分享");
      }

      // 與 resolveRole 內部對 noteId 的處理同理：`:userId` 路徑參數格式不可信任，先用
      // UUID_RE 擋掉非法格式（否則 DELETE 的 WHERE 條件會讓 pg 直接 throw "invalid
      // input syntax for type uuid"，被全域錯誤 handler 歸類成 500）。效果上等同「這個
      // userId 沒有對應的分享列」，回同一個 404 share_not_found，不特別區分。
      if (!UUID_RE.test(targetUserId)) {
        return sendError(reply, 404, "share_not_found", "找不到此分享");
      }

      const [deleted] = await deps.db
        .delete(noteShares)
        .where(and(eq(noteShares.noteId, id), eq(noteShares.userId, targetUserId)))
        .returning();
      if (!deleted) {
        return sendError(reply, 404, "share_not_found", "找不到此分享");
      }

      deps.collabHooks.onShareChanged(id, targetUserId);

      return reply.code(204).send();
    });
  };
}
