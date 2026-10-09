/**
 * 筆記版本歷史 REST（spec 2026-10-09-note-versions-design.md §6）。全部 cookie（`app.authenticate`）；PAT／MCP 不在本 spec（§14-2）。
 * 判準六支一致：`:id` 先 `UUID_RE` → `resolveRole`：none → 404 `not_found`、viewer → 403 `forbidden`「沒有編輯權限」（D5）。
 * 寫入四支（存、套用、改名、刪除）吃既有 `edit` 桶，排在角色檢查之後。apply 只在 `writes.available` 時註冊（與 `/edits` 同閘門）。
 * 參數（不變量 S）：`:seq` 走 `/^[1-9]\d{0,9}$/` 且 ≤ 2147483647，否則 404；`before` 同規則、`limit` 1..100，否則 400。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  VERSION_LIST_LIMIT_DEFAULT, VERSION_LIST_LIMIT_MAX, normalizeVersionName,
  type ApplyVersionBody, type ApplyVersionResultDto, type VersionDto, type VersionKind, type VersionListDto, type SavedVersionDto, type VersionSnapshotDto,
} from "@knotebook/shared";
import type { VersionService } from "../collab/versions.js";
import type { Db } from "../db/index.js";
import { noteVersions, users } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { NoteWriteService } from "../notes/editing/write-service.js";
import { resolveRole, UUID_RE } from "../notes/service.js";
import type { NoteVersionRow } from "../notes/tx/versions.js";

export interface NoteVersionsRouteDeps {
  db: Db;
  versions: VersionService;
  writes: NoteWriteService;
  limiters: { edit: FixedWindowLimiter };
}

const NOTE_NOT_FOUND = "找不到此筆記";
const VERSION_NOT_FOUND = "找不到此版本";
const INVALID_BODY = "請求格式錯誤";
const INVALID_NAME = "版本名稱須在 120 字以內，且不能含無法儲存的字元";
const INT4_MAX = 2147483647;
const SEQ_RE = /^[1-9]\d{0,9}$/;
const LIMIT_RE = /^[1-9]\d{0,2}$/;

/** `:seq`／`before` 的唯一解析點：只收正規十進位、≤ int4。 */
export function parseSeq(raw: string): number | null {
  if (!SEQ_RE.test(raw)) return null;
  const n = Number(raw);
  return n <= INT4_MAX ? n : null;
}

const listQuerySchema = z.object({ before: z.string().optional(), limit: z.string().optional() }).strict();
const saveBodySchema = z.object({ name: z.string().optional() }).strict();
const renameBodySchema = z.object({ name: z.string().nullable() }).strict();
// 形＝shared 的 `ApplyVersionBody`（`satisfies` 讓兩邊漂移在編譯期紅）。
const applyBodySchema = z.object({ versionId: z.string().regex(UUID_RE), discardUnsaved: z.boolean() }).strict() satisfies z.ZodType<ApplyVersionBody>;

function toVersionDto(r: NoteVersionRow, handles: Map<string, string>): VersionDto {
  return {
    id: r.id,
    seq: r.seq,
    kind: r.kind as VersionKind,
    name: r.name,
    editors: r.editors.map(e => ({ handle: handles.get(e.user_id) ?? "", agentLabel: e.agent_label })),
    baseSeq: r.baseSeq,
    createdAt: r.createdAt.toISOString(),
  };
}

/** editors 的 handle 一次查（`inArray`，筆數＝這一頁出現的不同使用者數）；刪除的使用者 → ""。 */
export async function toVersionDtos(db: Db, rows: NoteVersionRow[]): Promise<VersionDto[]> {
  const ids = [...new Set(rows.flatMap(r => r.editors.map(e => e.user_id)))].filter(id => UUID_RE.test(id));
  const handles = new Map<string, string>();
  if (ids.length > 0) {
    for (const u of await db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, ids))) handles.set(u.id, u.handle);
  }
  return rows.map(r => toVersionDto(r, handles));
}

export function noteVersionsRoutes(deps: NoteVersionsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    /** none → 404、viewer → 403；回 true＝可以往下走。 */
    async function canEdit(reply: FastifyReply, userId: string, noteId: string): Promise<boolean> {
      const role = await resolveRole(deps.db, userId, noteId);
      if (role === "none") {
        sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
        return false;
      }
      if (role === "viewer") {
        sendError(reply, 403, "forbidden", "沒有編輯權限");
        return false;
      }
      return true;
    }
    const noteIdOf = (raw: string): string | null => (UUID_RE.test(raw) ? raw.toLowerCase() : null);
    const tooMany = (reply: FastifyReply) => sendError(reply, 429, "too_many_requests", "寫入過於頻繁");

    app.get("/api/notes/:id/versions", { preHandler: app.authenticate }, async (request, reply) => {
      const id = noteIdOf((request.params as { id: string }).id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const q = listQuerySchema.safeParse(request.query ?? {});
      if (!q.success) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      const before = q.data.before === undefined ? null : parseSeq(q.data.before);
      if (q.data.before !== undefined && before === null) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      const limit = q.data.limit === undefined ? VERSION_LIST_LIMIT_DEFAULT : LIMIT_RE.test(q.data.limit) ? Number(q.data.limit) : 0;
      if (limit < 1 || limit > VERSION_LIST_LIMIT_MAX) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      if (!(await canEdit(reply, request.user!.id, id))) return reply;
      const rows = await deps.db
        .select()
        .from(noteVersions)
        .where(and(eq(noteVersions.noteId, id), before === null ? undefined : lt(noteVersions.seq, before)))
        .orderBy(desc(noteVersions.seq))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const current = await deps.versions.currentOf(id);
      if (current === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const body: VersionListDto = { versions: await toVersionDtos(deps.db, page), current, nextBefore: rows.length > limit ? page[page.length - 1]!.seq : null };
      return reply.send(body);
    });

    app.get("/api/notes/:id/versions/:seq", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { id: string; seq: string };
      const id = noteIdOf(params.id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const seq = parseSeq(params.seq);
      if (seq === null) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      if (!(await canEdit(reply, request.user!.id, id))) return reply;
      const [row] = await deps.db
        .select({ id: noteVersions.id, seq: noteVersions.seq, ydoc: noteVersions.ydoc })
        .from(noteVersions)
        .where(and(eq(noteVersions.noteId, id), eq(noteVersions.seq, seq)))
        .limit(1);
      if (!row) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      // §6.2：§9 會讓同一個 seq 指向不同內容——不得被任何快取留住（web 以 id 當快取鍵）。
      reply.header("cache-control", "private, no-store");
      return reply.send({ id: row.id, seq: row.seq, ydoc: Buffer.from(row.ydoc).toString("base64") } satisfies VersionSnapshotDto);
    });

    app.post("/api/notes/:id/versions", { preHandler: app.authenticate }, async (request, reply) => {
      const id = noteIdOf((request.params as { id: string }).id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const parsed = saveBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      const name = normalizeVersionName(parsed.data.name ?? null);
      if (!name.ok) return sendError(reply, 400, "invalid_body", INVALID_NAME);
      const userId = request.user!.id;
      if (!(await canEdit(reply, userId, id))) return reply;
      if (!deps.limiters.edit.consume(userId)) return tooMany(reply);
      const out = await deps.writes.saveVersion(request.log, { noteId: id, userId, name: name.name });
      if (!out.ok) {
        return out.kind === "note-deleted"
          ? sendError(reply, 404, "not_found", NOTE_NOT_FOUND)
          : sendError(reply, 503, "server_busy", "筆記正在被寫入，請稍後再試");
      }
      const [dto] = await toVersionDtos(deps.db, [out.row]);
      return reply.code(201).send({ ...dto!, upgraded: out.upgraded } satisfies SavedVersionDto);
    });

    if (deps.writes.available) {
      app.post("/api/notes/:id/versions/:seq/apply", { preHandler: app.authenticate }, async (request, reply) => {
        const params = request.params as { id: string; seq: string };
        const id = noteIdOf(params.id);
        if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
        const seq = parseSeq(params.seq);
        if (seq === null) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
        const parsed = applyBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) return sendError(reply, 400, "invalid_body", INVALID_BODY);
        const userId = request.user!.id;
        if (!(await canEdit(reply, userId, id))) return reply;
        if (!deps.limiters.edit.consume(userId)) return tooMany(reply);
        const out = await deps.writes.applyVersion(request.log, {
          noteId: id, seq, versionId: parsed.data.versionId.toLowerCase(), userId, discardUnsaved: parsed.data.discardUnsaved,
        });
        if (!out.ok) {
          if (out.kind === "busy") return sendError(reply, 503, "server_busy", "筆記正在被寫入，請稍後再試");
          if (out.code === "not_found") return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
          if (out.code === "version_mismatch") return sendError(reply, 409, "version_mismatch", "這一版已經不存在或已被取代，請重新整理");
          return sendError(reply, 409, "version_unsaved_changes", "目前有未儲存的修改");
        }
        // 起草裁定 12：回「套用全部完成後的實際 current」——沒有 WS 連線時 disconnect 內已卸載、可能已切出新的一版（需回寫 spec §6.4）。
        const current = await deps.versions.currentOf(id);
        if (current === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
        return reply.send({ current } satisfies ApplyVersionResultDto);
      });
    }

    app.patch("/api/notes/:id/versions/:seq", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { id: string; seq: string };
      const id = noteIdOf(params.id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const seq = parseSeq(params.seq);
      if (seq === null) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      const parsed = renameBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      const name = normalizeVersionName(parsed.data.name);
      if (!name.ok) return sendError(reply, 400, "invalid_body", INVALID_NAME);
      const userId = request.user!.id;
      if (!(await canEdit(reply, userId, id))) return reply;
      if (!deps.limiters.edit.consume(userId)) return tooMany(reply);
      // §6.5：任何 PATCH 都把 kind 變 manual（自動版本事後命名＝轉手動、永久保留，D7）。
      const [row] = await deps.db
        .update(noteVersions)
        .set({ name: name.name, kind: "manual" })
        .where(and(eq(noteVersions.noteId, id), eq(noteVersions.seq, seq)))
        .returning();
      if (!row) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      const [dto] = await toVersionDtos(deps.db, [row]);
      return reply.send(dto! satisfies VersionDto);
    });

    app.delete("/api/notes/:id/versions/:seq", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { id: string; seq: string };
      const id = noteIdOf(params.id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const seq = parseSeq(params.seq);
      if (seq === null) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      const userId = request.user!.id;
      if (!(await canEdit(reply, userId, id))) return reply;
      if (!deps.limiters.edit.consume(userId)) return tooMany(reply);
      // §6.6：單句；基底不可刪（A6）——述詞在 DELETE 當下重判。已知限制（見 spec §13）：READ COMMITTED 下 DELETE 與
      // `setVersionBase` 的 EXISTS 各看自己的快照，兩邊都提交後 `version_base_seq` 可能指向已刪列（無 FK）；窗口極窄，後果只是 `current.baseSeq` 懸空。
      const gone = await deps.db
        .delete(noteVersions)
        .where(and(
          eq(noteVersions.noteId, id),
          eq(noteVersions.seq, seq),
          sql`note_versions.seq is distinct from (select notes.version_base_seq from notes where notes.id = ${id})`,
        ))
        .returning({ id: noteVersions.id });
      if (gone.length === 1) return reply.code(204).send();
      const [still] = await deps.db
        .select({ id: noteVersions.id })
        .from(noteVersions)
        .where(and(eq(noteVersions.noteId, id), eq(noteVersions.seq, seq)))
        .limit(1);
      return still
        ? sendError(reply, 409, "version_is_base", "這是目前內容的基底版本，不能刪除")
        : sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
    });
  };
}
