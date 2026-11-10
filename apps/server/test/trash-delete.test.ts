/**
 * #181：`DELETE /api/notes/:id` 改成移入垃圾桶、單篇讀取三形的 `in_trash`、
 * 直連寫入的 `gone` 映射。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { YDOC_FRAGMENT, type NoteDto } from "@knotebook/shared";
import type { NoteDeleteGate } from "../src/collab/hooks.js";
import type { Db } from "../src/db/index.js";
import { groupMembers, groupRoles, noteAiEdits, noteLinkConversion, notes, uploads } from "../src/db/schema.js";
import { runLinkConversion } from "../src/notes/link-conversion.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import { trashNote } from "../src/trash/service.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { loadDoc, seedDoc } from "./copy-helpers.js";
import { bearer, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser, spyCollabHooks } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp, testConfig, type CollabTestCtx } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedAttachment } from "./storage-helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";
import { paraDoc, seedOldNote } from "./version-helpers.js";

const NOT_FOUND = { error: { code: "not_found", message: "No note with that id." } };
const FORBIDDEN = { error: { code: "forbidden", message: "You don't have permission to delete this note." } };
const inTrash = (noteId: string) => ({ error: { code: "in_trash", message: "This note is in the trash." }, noteId });
const del = (app: FastifyInstance, noteId: string, userId: string | null) => inject(app, "DELETE", `/api/notes/${noteId}`, userId);

/** `spyCollabHooks` 把 `beforeNoteDeleted` 換成回 `release` spy 的版本（原本回的 release 不是 spy）。 */
function gateHooks() {
  const release = vi.fn();
  const beforeNoteDeleted = vi.fn<(noteId: string) => Promise<NoteDeleteGate>>(async () => ({ release }));
  return { hooks: { ...spyCollabHooks(), beforeNoteDeleted }, beforeNoteDeleted, release };
}

describe("D1 移入", () => {
  it("owner DELETE → 204；deleted_at 非 NULL、deleted_by＝owner；附件列與磁碟檔都在；清單不列；GET :id 404 in_trash＋noteId", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const bystander = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 12);

    expect((await del(app, n.id, owner.id)).statusCode).toBe(204);

    const cols = await trashCols(db.$client, n.id);
    expect(cols?.deleted_at).not.toBeNull();
    expect(cols?.deleted_by).toBe(owner.id);
    expect(await trashCols(db.$client, bystander.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, n.id))).toEqual([{ id: up }]);
    expect(existsSync(uploadFilePath(uploadsDir, up)), "磁碟檔").toBe(true);
    expect(((await inject(app, "GET", "/api/notes", owner.id)).json() as NoteDto[]).map(x => x.id)).toEqual([bystander.id]);
    const get = await inject(app, "GET", `/api/notes/${n.id}`, owner.id);
    expect(get.statusCode).toBe(404);
    expect(get.json()).toEqual(inTrash(n.id));
  });
});

describe("D2 回應碼與錯誤形不變", () => {
  it("分享 editor 403、陌生人 404、已在垃圾桶的再 DELETE 404 not_found（不是 in_trash）、未登入 401、Bearer 401", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const editor = await seedUser(db);
    const stranger = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, n.id, editor.id, "editor");
    const missing = await del(app, randomUUID(), owner.id);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(NOT_FOUND);

    const byEditor = await del(app, n.id, editor.id);
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toEqual(FORBIDDEN);
    const byStranger = await del(app, n.id, stranger.id);
    expect(byStranger.statusCode).toBe(404);
    expect(byStranger.body).toBe(missing.body);
    expect((await del(app, n.id, null)).statusCode).toBe(401);
    const { token } = await seedTokenForUser(db, owner.id);
    expect((await app.inject({ method: "DELETE", url: `/api/notes/${n.id}`, headers: bearer(token) })).statusCode).toBe(401);
    expect(await trashCols(db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });

    await markTrashed(db.$client, n.id, owner.id);
    const again = await del(app, n.id, owner.id);
    expect(again.statusCode).toBe(404);
    expect(again.body).toBe(missing.body);
  });
});

describe("D3 閘門：結果不是 trashed 一律 release", () => {
  it("① 204 → beforeNoteDeleted 被 await 一次、release 未被呼叫", async () => {
    const g = gateHooks();
    const { app, db } = await buildTestApp({ collabHooks: g.hooks });
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    expect((await del(app, n.id, owner.id)).statusCode).toBe(204);
    expect(g.beforeNoteDeleted).toHaveBeenCalledTimes(1);
    expect(g.beforeNoteDeleted).toHaveBeenCalledWith(n.id);
    expect(g.release).not.toHaveBeenCalled();
  });

  it("② 交易爆（BEFORE UPDATE trigger RAISE，只對該篇）→ 500、release 一次、deleted_at 仍 NULL", async () => {
    const g = gateHooks();
    const { app, db } = await buildTestApp({ collabHooks: g.hooks });
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const pool: Pool = db.$client;
    await pool.query(`create function t8_boom() returns trigger language plpgsql as $$ begin raise exception 't8 boom'; end $$`);
    await pool.query(`create trigger t8_boom before update on notes for each row when (old.id = '${n.id}'::uuid) execute function t8_boom()`);
    try {
      expect((await del(app, n.id, owner.id)).statusCode).toBe(500);
    } finally {
      await pool.query(`drop trigger t8_boom on notes`);
      await pool.query(`drop function t8_boom()`);
    }
    expect(g.release).toHaveBeenCalledTimes(1);
    expect(await trashCols(pool, n.id)).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("③ 鎖後在交易內被降權（note-trash-locked 縫拿掉角色的 can_delete）→ 403、release 一次、deleted_at 仍 NULL", async () => {
    const g = gateHooks();
    const holder: { db?: Db; roleId?: string } = {};
    const { app, db } = await buildTestApp({
      collabHooks: g.hooks,
      groupTestHook: async point => {
        // 只改 group_roles——notes 那一列正被交易 FOR UPDATE 持著，在這裡寫它會自我死等。
        if (point === "note-trash-locked") await holder.db!.update(groupRoles).set({ canDelete: false }).where(eq(groupRoles.id, holder.roleId!));
      },
    });
    holder.db = db;
    const admin = await seedUser(db);
    const u = await seedUser(db);
    const grp = await seedGroup(db, "D3", [{ userId: admin.id, role: "admin" }]);
    holder.roleId = await seedRole(db, grp.id, "edit-delete", { canRead: true, canEdit: true, canDelete: true });
    await db.insert(groupMembers).values({ groupId: grp.id, userId: u.id, roleId: holder.roleId });
    const gn = await seedNote(db, { groupId: grp.id });

    const res = await del(app, gn.id, u.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN);
    expect(g.release).toHaveBeenCalledTimes(1);
    expect(await trashCols(db.$client, gn.id)).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("④ 授權之後、交易之前被別人先移入 → 交易內重判 none → 404、release 一次、deleted_by 仍是先移入的人", async () => {
    const g = gateHooks();
    const { app, db } = await buildTestApp({ collabHooks: g.hooks });
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    g.beforeNoteDeleted.mockImplementation(async (id: string) => {
      await markTrashed(db.$client, id, other.id);
      return { release: g.release };
    });

    const res = await del(app, n.id, owner.id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
    expect(g.release).toHaveBeenCalledTimes(1);
    expect((await trashCols(db.$client, n.id))?.deleted_by).toBe(other.id);
  });
});

describe("D7 服務函式收大寫 id（MCP 等呼叫端不一定先轉小寫）", () => {
  it("trashNote 傳大寫 id → trashed、閘門開在小寫 id 上且不 release、deleted_at 非 NULL", async () => {
    const g = gateHooks();
    const { db, uploadsDir } = await buildTestApp({ collabHooks: g.hooks });
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });

    const out = await trashNote({ db, collabHooks: g.hooks, uploadsDir, storageLockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }, { noteId: n.id.toUpperCase(), by: owner.id });
    expect(out).toBe("trashed");
    expect(g.beforeNoteDeleted).toHaveBeenCalledWith(n.id);
    expect(g.release).not.toHaveBeenCalled();
    expect((await trashCols(db.$client, n.id))?.deleted_at).not.toBeNull();
  });
});

describe("D4 in_trash 三形", () => {
  it("群組垃圾桶筆記：admin、editDelete 得 in_trash；member、deleteOnly、editOnly、readOnly、outsider 得 not_found（與不存在逐位元組相同）；大寫 uuid 的 noteId 回小寫", async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const gn = await seedNote(db, { groupId: s.groupId }, { slug: "d4-group" });
    await markTrashed(db.$client, gn.id, s.admin.id);
    const urls = [`/api/notes/${gn.id}`, `/api/notes/by-group-path/${s.groupId}/d4-group`];

    for (const u of [s.admin, s.editDelete]) {
      for (const url of urls) {
        const res = await inject(app, "GET", url, u.id);
        expect(res.statusCode, url).toBe(404);
        expect(res.json(), url).toEqual(inTrash(gn.id));
      }
    }
    const upper = await inject(app, "GET", `/api/notes/${gn.id.toUpperCase()}`, s.admin.id);
    expect(upper.statusCode).toBe(404);
    expect(upper.json()).toEqual(inTrash(gn.id));

    for (const [name, u] of Object.entries({ member: s.member, deleteOnly: s.deleteOnly, editOnly: s.editOnly, readOnly: s.readOnly, outsider: s.outsider })) {
      const missing = await inject(app, "GET", `/api/notes/${randomUUID()}`, u.id);
      expect(missing.json()).toEqual(NOT_FOUND);
      for (const url of urls) {
        const res = await inject(app, "GET", url, u.id);
        expect(res.statusCode, `${name} ${url}`).toBe(404);
        expect(res.body, `${name} ${url}`).toBe(missing.body);
      }
    }
  });

  it("個人垃圾桶筆記：owner 的 :ref、/by-path、prev_slug 補查形得 in_trash；分享 editor 三形得 not_found", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const editor = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "d4-now", slugIsCustom: true, prevSlug: "d4-old" });
    await seedShare(db, n.id, editor.id, "editor");
    const urls = [`/api/notes/${n.id}`, `/api/notes/by-path/${owner.handle}/d4-now`, `/api/notes/by-path/${owner.handle}/d4-old`];
    for (const url of urls) expect((await inject(app, "GET", url, owner.id)).statusCode, `移入前 ${url}`).toBe(200);
    await markTrashed(db.$client, n.id, owner.id);

    for (const url of urls) {
      const res = await inject(app, "GET", url, owner.id);
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual(inTrash(n.id));
    }
    const missing = await inject(app, "GET", `/api/notes/${randomUUID()}`, editor.id);
    for (const url of urls) {
      const res = await inject(app, "GET", url, editor.id);
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).toBe(missing.body);
    }
  });
});

/** `note_states` 該篇的現值（沒有列 → undefined）。 */
async function stateOf(pool: Pool, noteId: string): Promise<{ ydoc: string; version: number } | undefined> {
  const { rows } = await pool.query<{ ydoc: string; version: number }>(
    `select encode(ydoc, 'hex') as ydoc, version from note_states where note_id = $1`,
    [noteId],
  );
  return rows[0];
}
const aiEditCount = async (db: Db, noteId: string) => (await db.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId))).length;

/** 前置：活筆記＋一則 AI 修改紀錄＋一版版本＋一把 PAT；文件卸載後才回（`note_states` 從此不再動）。 */
async function goneScene() {
  const ctx = await buildCollabTestApp();
  const owner = await seedUser(ctx.db);
  const n = await seedNote(ctx.db, { ownerId: owner.id });
  await seedDoc(ctx.db, n.id, paraDoc(["內容"]));
  const edit = await inject(ctx.app, "POST", `/api/notes/${n.id}/edits`, owner.id, { op: "append", markdown: "AI 寫的" });
  expect(edit.statusCode, edit.body).toBe(201);
  const version = await inject(ctx.app, "POST", `/api/notes/${n.id}/versions`, owner.id, {});
  expect(version.statusCode, version.body).toBe(201);
  const { token } = await seedTokenForUser(ctx.db, owner.id);
  await waitFor("文件卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  return { ctx, owner, noteId: n.id, editId: edit.json().editId as string, seq: version.json().seq as number, versionId: version.json().id as string, token };
}
type GoneScene = Awaited<ReturnType<typeof goneScene>>;

const editNote = (app: FastifyInstance, token: string, noteId: string) =>
  mcpPost(app, rpc("tools/call", { name: "edit_note", arguments: { note_id: noteId, op: "append", markdown: "MCP 寫的" } }), { token });

const GONE_ROWS: Array<[string, (s: GoneScene) => Promise<void>]> = [
  ["POST …/edits", async s => {
    const res = await inject(s.ctx.app, "POST", `/api/notes/${s.noteId}/edits`, s.owner.id, { op: "append", markdown: "more" });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  }],
  ["POST …/edits/:editId/revert", async s => {
    const res = await inject(s.ctx.app, "POST", `/api/notes/${s.noteId}/edits/${s.editId}/revert`, s.owner.id);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  }],
  ["POST …/versions/:seq/apply", async s => {
    const res = await inject(s.ctx.app, "POST", `/api/notes/${s.noteId}/versions/${s.seq}/apply`, s.owner.id, { versionId: s.versionId, discardUnsaved: true });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  }],
  ["MCP edit_note", async s => {
    const res = await editNote(s.ctx.app, s.token, s.noteId);
    const missing = await editNote(s.ctx.app, s.token, randomUUID());
    const result = res.json().result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: { code?: string } };
    expect(result.isError, res.body).toBe(true);
    expect(result.structuredContent?.code).toBe("not_found");
    expect(result.content[0]!.text).toBe((missing.json().result as { content: Array<{ text: string }> }).content[0]!.text);
  }],
];

describe("D5 gone 映射：授權通過、直連寫入前閘門已開（markDeleting）→ 各路徑既有的 not_found", () => {
  it.each(GONE_ROWS)("%s", async (_name, check) => {
    const s = await goneScene();
    const pool: Pool = s.ctx.db.$client;
    const before = { state: await stateOf(pool, s.noteId), edits: await aiEditCount(s.ctx.db, s.noteId) };
    await s.ctx.collab.markDeleting(s.noteId);
    try {
      await check(s);
    } finally {
      s.ctx.collab.unmarkDeleting(s.noteId);
    }
    expect(await aiEditCount(s.ctx.db, s.noteId), "note_ai_edits 沒有新列").toBe(before.edits);
    expect(await stateOf(pool, s.noteId), "note_states 不變").toEqual(before.state);
  });
});

describe("D6 連結轉換：合併前一刻被移入 → NoteGoneError 收成 deleted", () => {
  it("beforeMerge 縫裡 markTrashed → 該列仍 pending、attempts 不變、內容未改", async () => {
    const holder: { ctx?: CollabTestCtx; noteId?: string; ownerId?: string; merges: number } = { merges: 0 };
    const ctx = await buildCollabTestApp({
      editingTestHooks: {
        beforeMerge: async () => {
          holder.merges += 1;
          await markTrashed(holder.ctx!.db.$client, holder.noteId!, holder.ownerId!);
        },
      },
    });
    holder.ctx = ctx;
    const alice = await ctx.createUser({ email: "d6@example.com", password: "correct-horse-battery" });
    holder.ownerId = alice.id;
    const a = await seedNote(ctx.db, { ownerId: alice.id }, { title: "A" });
    const host = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Host" });
    holder.noteId = host.id;
    await seedOldNote(ctx.db, host.id, `[x](${testConfig.publicUrl.origin}/notes/${a.id})`);
    await ctx.db.insert(noteLinkConversion).values({ noteId: host.id, status: "pending" });
    const before = (await loadDoc(ctx.db, host.id))!.getXmlFragment(YDOC_FRAGMENT).toString();

    await runLinkConversion(ctx.app.linkConversion.deps!, { signal: new AbortController().signal, batchSize: 50 });

    expect(holder.merges, "走到合併那一步").toBe(1);
    const [row] = await ctx.db.select().from(noteLinkConversion).where(eq(noteLinkConversion.noteId, host.id));
    expect({ status: row!.status, attempts: row!.attempts }).toEqual({ status: "pending", attempts: 0 });
    const after = (await loadDoc(ctx.db, host.id))!.getXmlFragment(YDOC_FRAGMENT).toString();
    expect(after).toBe(before);
    expect(after).not.toContain("wikilink");
    expect((await trashCols(ctx.db.$client, host.id))?.deleted_at).not.toBeNull();
  });
});

// docs/known-limitations.md「A note in the trash still holds its URL and its custom public URL」與 api.md Trash 段靠這兩案釘。
describe("D8 垃圾桶期間 slug 與公開別名仍佔用", () => {
  it("移入後同一 owner 建同標題筆記 → slug 得 -2；垃圾桶那篇的 slug 不變", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const first = await inject(app, "POST", "/api/notes", owner.id, { title: "Occupied Title" });
    expect(first.statusCode).toBe(201);
    const a = first.json() as NoteDto;
    expect(a.slug).toBe("occupied-title");
    expect((await del(app, a.id, owner.id)).statusCode).toBe(204);

    const second = await inject(app, "POST", "/api/notes", owner.id, { title: "Occupied Title" });
    expect(second.statusCode).toBe(201);
    expect((second.json() as NoteDto).slug).toBe("occupied-title-2");
    expect(await db.select({ slug: notes.slug }).from(notes).where(eq(notes.id, a.id))).toEqual([{ slug: "occupied-title" }]);
  });

  it("移入後另一篇把網址改成垃圾桶那篇的 slug → 409 slug_taken；兩篇的 slug 都不變", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const a = await seedNote(db, { ownerId: owner.id }, { slug: "occupied-custom" });
    const b = await seedNote(db, { ownerId: owner.id }, { slug: "other-note" });
    expect((await del(app, a.id, owner.id)).statusCode).toBe(204);

    const res = await inject(app, "PATCH", `/api/notes/${b.id}`, owner.id, { slug: "occupied-custom" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("slug_taken");
    const slugs = await db.select({ id: notes.id, slug: notes.slug }).from(notes).where(eq(notes.ownerId, owner.id));
    expect(Object.fromEntries(slugs.map(r => [r.id, r.slug]))).toEqual({ [a.id]: "occupied-custom", [b.id]: "other-note" });
  });

  it("移入後另一篇設同一個公開別名 → 409 public_slug_taken", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const a = await seedNote(db, { ownerId: owner.id }, { publicToken: "a".repeat(43), publicSlug: "occupied-alias" });
    const b = await seedNote(db, { ownerId: owner.id }, { publicToken: "b".repeat(43) });
    expect((await del(app, a.id, owner.id)).statusCode).toBe(204);

    const res = await inject(app, "PUT", `/api/notes/${b.id}/public-link/slug`, owner.id, { slug: "occupied-alias" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("public_slug_taken");
  });
});
