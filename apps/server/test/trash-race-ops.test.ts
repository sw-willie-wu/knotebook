/**
 * #181：移入垃圾桶 ×｛搬移、上傳、複製、分享、改網址、改標題、開公開連結、MCP `edit_note`｝的併發。
 * 每種操作三形：
 *   (a) 操作先——操作卡在它的交易內縫（持鎖）、DELETE 送出並確認在等鎖 → 放行 → 操作成功、之後移入；
 *   (b) 移入先——操作卡在它的授權後縫，縫裡跑完整個 DELETE → 放行 → 操作回該處原本的 not_found，狀態沒被改到；
 *   (c) 移入在途——DELETE 卡在 `note-trash-locked`（持 FOR UPDATE）、操作送出並確認在等鎖 → 放行 → 操作 not_found
 *       （PG 等鎖後對新版本重評 `deleted_at IS NULL` 的那條路）。
 * 改標題、開公開連結沒有交易（單句 UPDATE／三句無交易），MCP `edit_note` 的直連寫入也不持 DB 鎖：(a) 以「操作完成後才 DELETE」
 * 的循序案代替；MCP 的併發證據另見 `trash-direct-write.test.ts` DW3，且 MCP 不等鎖、沒有 (c)。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { NoteDeleteGate } from "../src/collab/hooks.js";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, noteVersions, notes, uploads } from "../src/db/schema.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { loadDoc, seedDoc, xmlOf } from "./copy-helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { noteState, seedGroup, seedNote, seedShare, seedUser, sharesOf, spyCollabHooks, waitForLockWaiters, type SeededUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { filesIn, upload } from "./storage-helpers.js";
import { inject, trashCols } from "./trash-helpers.js";
import { paraDoc } from "./version-helpers.js";

type Res = LightMyRequestResponse;
const NOT_FOUND = { error: { code: "not_found", message: "No note with that id." } };
const FORBIDDEN = { error: { code: "forbidden", message: "You don't have permission to delete this note." } };
const del = (app: FastifyInstance, id: string, by: string) => inject(app, "DELETE", `/api/notes/${id}`, by);

/** 一次性測試縫：`on` 登記的處理第一次觸發時拿掉並執行，其餘觸發直接放行。 */
class Seams {
  private readonly handlers = new Map<string, () => Promise<void>>();
  on(name: string, fn: () => Promise<void>): void {
    this.handlers.set(name, fn);
  }
  async fire(name: string): Promise<void> {
    const fn = this.handlers.get(name);
    if (!fn) return;
    this.handlers.delete(name);
    await fn();
  }
  /** 在 name 卡住：`entered` 在進縫時 resolve，`open()` 放行。 */
  hold(name: string): { entered: Promise<void>; open: () => void } {
    let open!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const entered = new Promise<void>(r => { enter = r; });
    this.on(name, async () => {
      enter();
      await gate;
    });
    return { entered, open };
  }
  readonly group: GroupTestHook = point => this.fire(point);
}

/** 等請求走進縫；它若先回應了（沒走到縫）就直接失敗，不空等。 */
async function entered(seam: Promise<void>, req: Promise<Res>): Promise<void> {
  await Promise.race([seam, req.then(r => { throw new Error(`請求沒走到縫就回了 ${r.statusCode} ${r.body}`); })]);
}

/** 等 n 條連線卡在鎖上；逾時就先放行、讓在途請求收尾，再把逾時丟出去（不留懸著的請求）。 */
async function blockedOrBail(pool: Pool, n: number, bail: () => void, inflight: Array<Promise<unknown>>): Promise<void> {
  try {
    await waitForLockWaiters(pool, n);
  } catch (err) {
    bail();
    await Promise.allSettled(inflight);
    throw err;
  }
}

interface Scene {
  app: FastifyInstance;
  db: Db;
  pool: Pool;
  uploadsDir: string;
  seams: Seams;
  release: ReturnType<typeof vi.fn>;
  owner: SeededUser;
  friend: SeededUser;
  groupId: string;
  noteId: string;
}

/**
 * owner 的個人筆記（自訂 slug、一筆 viewer 分享）；owner 在搬移目標群組裡是 `ownerRole`。
 * 閘門照既有的造法注入 release spy（`beforeNoteDeleted` 回 `{ release }`）。
 */
async function scene(ownerRole: "admin" | "member" = "admin"): Promise<Scene> {
  const seams = new Seams();
  const release = vi.fn();
  const beforeNoteDeleted = vi.fn<(noteId: string) => Promise<NoteDeleteGate>>(async () => ({ release }));
  const built = await buildTestApp({
    collabHooks: { ...spyCollabHooks(), beforeNoteDeleted },
    groupTestHook: seams.group,
    slugPatchTestHook: point => seams.fire(`slug-${point}`),
    slugUpdateTestHook: () => seams.fire("rename"),
  });
  const { db } = built;
  const [owner, friend, viewer] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
  const g = await seedGroup(db, "Target", [{ userId: owner.id, role: ownerRole }]);
  const n = await seedNote(db, { ownerId: owner.id }, { title: "原標題", slug: "old-custom", slugIsCustom: true });
  await seedShare(db, n.id, viewer.id, "viewer");
  return { ...built, pool: db.$client, seams, release, owner, friend, groupId: g.id, noteId: n.id };
}

const titleOf = async (db: Db, id: string) => (await db.select({ title: notes.title }).from(notes).where(eq(notes.id, id)))[0]!.title;
const uploadRows = async (db: Db, id: string) => (await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, id))).map(r => r.id);

/** 狀態：歸屬、網址、公開、標題、分享、版本，加上附件列、筆記總數與磁碟檔（上傳、複製兩種）。 */
async function snap(e: Scene) {
  const [width] = await e.db.select({ w: notes.publicWidth }).from(notes).where(eq(notes.id, e.noteId));
  return {
    state: await noteState(e.pool, e.noteId),
    title: await titleOf(e.db, e.noteId),
    width: width!.w,
    shares: await sharesOf(e.db, e.noteId),
    versions: (await e.db.select({ n: sql<number>`count(*)::int` }).from(noteVersions).where(eq(noteVersions.noteId, e.noteId)))[0]!.n,
    uploads: await uploadRows(e.db, e.noteId),
    notes: (await e.db.select({ n: sql<number>`count(*)::int` }).from(notes))[0]!.n,
    files: await filesIn(e.uploadsDir),
  };
}

interface Op {
  name: string;
  /** (a) 的交易內縫（持鎖）；null＝沒有交易，(a) 改循序。 */
  locked: string | null;
  /** (b) 的授權後縫。 */
  auth: string;
  ok: number;
  send(e: Scene): Promise<Res>;
  /** (a) 操作成功之後、移入之後，操作的效果還在。 */
  applied(e: Scene, res: Res): Promise<void>;
}

const OPS: Op[] = [
  {
    name: "搬移", locked: "note-move-locked", auth: "note-move-authorized", ok: 200,
    send: e => inject(e.app, "POST", `/api/notes/${e.noteId}/move`, e.owner.id, { groupId: e.groupId }),
    applied: async e => expect(await noteState(e.pool, e.noteId)).toMatchObject({ owner_id: null, group_id: e.groupId }),
  },
  {
    name: "上傳", locked: "storage-space-locked", auth: "upload-authorized", ok: 201,
    send: e => upload(e.app, e.noteId, e.owner.id, 8),
    applied: async e => {
      const ids = await uploadRows(e.db, e.noteId);
      expect(ids).toHaveLength(1);
      expect(await filesIn(e.uploadsDir)).toEqual(ids);
    },
  },
  {
    name: "複製", locked: "note-copy-locked", auth: "note-copy-authorized", ok: 201,
    send: e => inject(e.app, "POST", `/api/notes/${e.noteId}/copy`, e.owner.id, {}),
    applied: async (e, res) => expect(await trashCols(e.pool, (res.json() as { id: string }).id)).toEqual({ deleted_at: null, deleted_by: null }),
  },
  {
    name: "分享", locked: "share-group-checked", auth: "share-authorized", ok: 200,
    send: e => inject(e.app, "PUT", `/api/notes/${e.noteId}/shares`, e.owner.id, { email: e.friend.email, role: "editor" }),
    applied: async e => expect(await sharesOf(e.db, e.noteId)).toContainEqual({ userId: e.friend.id, role: "editor" }),
  },
  {
    name: "改網址", locked: "slug-slug-written", auth: "slug-authorized", ok: 200,
    send: e => inject(e.app, "PATCH", `/api/notes/${e.noteId}`, e.owner.id, { slug: "x-new" }),
    applied: async e => expect(await noteState(e.pool, e.noteId)).toMatchObject({ slug: "x-new", prev_slug: "old-custom" }),
  },
  {
    name: "改標題", locked: null, auth: "rename", ok: 200,
    send: e => inject(e.app, "PATCH", `/api/notes/${e.noteId}`, e.owner.id, { title: "新標題" }),
    applied: async e => expect(await titleOf(e.db, e.noteId)).toBe("新標題"),
  },
  {
    name: "開公開連結", locked: null, auth: "public-link-authorized", ok: 200,
    send: e => inject(e.app, "PUT", `/api/notes/${e.noteId}/public-link`, e.owner.id),
    applied: async (e, res) => expect((await noteState(e.pool, e.noteId)).public_token).toBe((res.json() as { token: string }).token),
  },
];

/**
 * (a) 的交錯：操作卡在 `seam`（持鎖）→ DELETE 送出、確認在等鎖 → 放行操作。移入拿到鎖之後在 `note-trash-locked`
 * 等操作回完應答再繼續——不和操作 commit 之後的重讀／授權競速（那會讓「操作成功」偶爾回成 404）。
 */
async function opFirst(e: Scene, seam: string, send: () => Promise<Res>): Promise<{ op: Res; del: Res }> {
  const op = e.seams.hold(seam);
  let replied!: () => void;
  const opReplied = new Promise<void>(r => { replied = r; });
  e.seams.on("note-trash-locked", () => opReplied);
  const opRes = send();
  await entered(op.entered, opRes);
  const delRes = del(e.app, e.noteId, e.owner.id);
  await blockedOrBail(e.pool, 1, () => { op.open(); replied(); }, [opRes, delRes]);
  op.open();
  const opOut = await opRes;
  replied();
  return { op: opOut, del: await delRes };
}

describe("移入 × 一般操作", () => {
  for (const op of OPS) {
    if (op.locked !== null) {
      const seam = op.locked;
      it(`${op.name} (a) 操作先：操作卡在 ${seam}（持鎖）、移入等鎖 → 操作 ${op.ok}、移入 204，操作的效果留著`, async () => {
        const e = await scene();
        const r = await opFirst(e, seam, () => op.send(e));
        expect(r.op.statusCode, r.op.body).toBe(op.ok);
        expect(r.del.statusCode, r.del.body).toBe(204);
        await op.applied(e, r.op);
        expect((await trashCols(e.pool, e.noteId))?.deleted_by).toBe(e.owner.id);
        expect(e.release).not.toHaveBeenCalled();
      });
    } else {
      // 沒有交易內縫（見檔頭）：「操作先完成、之後移入」以循序代替。
      it(`${op.name} (a) 操作先（循序）：操作 ${op.ok} 之後移入 204，操作的效果留著`, async () => {
        const e = await scene();
        const res = await op.send(e);
        expect(res.statusCode, res.body).toBe(op.ok);
        expect((await del(e.app, e.noteId, e.owner.id)).statusCode).toBe(204);
        await op.applied(e, res);
        expect((await trashCols(e.pool, e.noteId))?.deleted_by).toBe(e.owner.id);
      });
    }

    it(`${op.name} (b) 移入先：操作卡在 ${op.auth}（授權後）時整個 DELETE 完成 → 操作 404 not_found，狀態沒被改到`, async () => {
      const e = await scene();
      const before = await snap(e);
      let d: Res | undefined;
      e.seams.on(op.auth, async () => { d = await del(e.app, e.noteId, e.owner.id); });

      const res = await op.send(e);

      expect(d?.statusCode, "縫裡的 DELETE").toBe(204);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
      expect(await snap(e)).toEqual(before);
      expect((await trashCols(e.pool, e.noteId))?.deleted_by).toBe(e.owner.id);
    });

    it(`${op.name} (c) 移入在途：移入卡在 note-trash-locked、操作等鎖 → 移入 204、操作 404 not_found，狀態沒被改到`, async () => {
      const e = await scene();
      const before = await snap(e);
      const tr = e.seams.hold("note-trash-locked");
      const d = del(e.app, e.noteId, e.owner.id);
      await entered(tr.entered, d);
      const r = op.send(e);
      await blockedOrBail(e.pool, 1, tr.open, [d, r]);
      tr.open();

      expect((await d).statusCode).toBe(204);
      const res = await r;
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
      expect(await snap(e)).toEqual(before);
    });
  }

  it("搬移 (a') 操作先、owner 在目標群組只是一般成員 → 搬移 200、移入在交易內重判得 403，閘門 release 被呼叫、筆記沒進垃圾桶", async () => {
    const e = await scene("member");
    const r = await opFirst(e, "note-move-locked", () => OPS[0]!.send(e));
    expect(r.op.statusCode, r.op.body).toBe(200);
    expect(r.del.statusCode, r.del.body).toBe(403);
    expect(r.del.json()).toEqual(FORBIDDEN);
    expect(e.release).toHaveBeenCalledTimes(1);
    expect(await noteState(e.pool, e.noteId)).toMatchObject({ owner_id: null, group_id: e.groupId });
    expect(await trashCols(e.pool, e.noteId)).toEqual({ deleted_at: null, deleted_by: null });
  });
});

/** MCP：真 hooks（閘門、unload 等待）＋ `beforeMerge` 縫；筆記有一段內容、文件未載入。 */
async function mcpScene() {
  const seams = new Seams();
  const ctx = await buildCollabTestApp({
    collabHooks: (server, log) => createCollabHooks(server, log),
    groupTestHook: seams.group,
    editingTestHooks: { beforeMerge: () => seams.fire("beforeMerge") },
  });
  const owner = await seedUser(ctx.db);
  const n = await seedNote(ctx.db, { ownerId: owner.id });
  await seedDoc(ctx.db, n.id, paraDoc(["內容"]));
  const { token } = await seedTokenForUser(ctx.db, owner.id);
  return { ctx, seams, owner, noteId: n.id, token, pool: ctx.db.$client as Pool };
}
const editNote = (app: FastifyInstance, token: string, noteId: string) =>
  mcpPost(app, rpc("tools/call", { name: "edit_note", arguments: { note_id: noteId, op: "append", markdown: "MCP 寫的" } }), { token });
type ToolResult = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { code?: string } };
const stateHex = async (pool: Pool, id: string) =>
  (await pool.query<{ y: string }>(`select encode(ydoc, 'hex') as y from note_states where note_id = $1`, [id])).rows[0]?.y;
const aiEdits = async (db: Db, id: string) => (await db.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, id))).length;

describe("移入 × MCP edit_note", () => {
  it("(a) 操作先（循序）：edit_note 寫入之後移入 204，寫入的內容留在垃圾桶裡的筆記", async () => {
    const s = await mcpScene();
    const res = await editNote(s.ctx.app, s.token, s.noteId);
    expect((res.json().result as ToolResult).isError, res.body).toBeFalsy();

    expect((await del(s.ctx.app, s.noteId, s.owner.id)).statusCode).toBe(204);

    expect(xmlOf((await loadDoc(s.ctx.db, s.noteId))!)).toContain("MCP 寫的");
    expect(await aiEdits(s.ctx.db, s.noteId)).toBe(1);
    expect((await trashCols(s.pool, s.noteId))?.deleted_by).toBe(s.owner.id);
  });

  it("(b) 移入先：beforeMerge 縫裡 DELETE 204、再模擬閘門 TTL 到期（只剩 DB 檢查）→ edit_note not_found，內容與 AI 紀錄沒變", async () => {
    const s = await mcpScene();
    const before = { state: await stateHex(s.pool, s.noteId), edits: await aiEdits(s.ctx.db, s.noteId) };
    let d: Res | undefined;
    s.seams.on("beforeMerge", async () => {
      d = await del(s.ctx.app, s.noteId, s.owner.id);
      s.ctx.collab.unmarkDeleting(s.noteId);
    });

    const res = await editNote(s.ctx.app, s.token, s.noteId);

    expect(d?.statusCode, "縫裡的 DELETE").toBe(204);
    expect(s.ctx.collab.isDeleting(s.noteId)).toBe(false);
    const result = res.json().result as ToolResult;
    expect(result.isError, res.body).toBe(true);
    expect(result.structuredContent?.code).toBe("not_found");
    const missing = (await editNote(s.ctx.app, s.token, randomUUID())).json().result as ToolResult;
    expect(result.content[0]!.text).toBe(missing.content[0]!.text);
    expect({ state: await stateHex(s.pool, s.noteId), edits: await aiEdits(s.ctx.db, s.noteId) }).toEqual(before);
  });
});
