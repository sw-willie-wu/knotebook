import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { NoteDto, Role } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { Db } from "../db/index.js";
import { noteLinks, noteShares, noteStateBackups, noteStates, notes, uploads } from "../db/schema.js";
import type { CollabHooks } from "../collab/hooks.js";
import { resolveRole } from "../notes/service.js";

// 建立時 title 允許省略（DB 端有 default "Untitled"），但若有帶就不可為空字串——
// 與 PATCH 的 title 驗證同一套規則，避免「傳空字串把標題清空」這種語意混淆的落地方式。
const createBodySchema = z.object({ title: z.string().min(1).optional() });
const updateBodySchema = z.object({ title: z.string().min(1) });

export interface NotesRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
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
      // 兩分支不會重疊（一篇 note 若同時符合兩者，代表 owner 也把自己加進了
      // note_shares——目前應用層不會這樣寫，即使發生，UNION ALL 會產生同一篇 note 的
      // 兩列，這點與舊版 leftJoin 寫法的語意一致：都是「以 join 命中與否個別判斷」，
      // 不特別去重）。
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
        .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)));

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
  };
}
