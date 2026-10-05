/**
 * #175 PR2 T4（spec §6.5）：`POST /api/notes/:id/copy`——個人→群組、群組→個人（與個人→個人）的複製。
 * 真共編連線的「有人在線、未落盤編輯」案在 `groups-v2-revocation.test.ts` 檔尾。
 * C19a／C19b／C19c（review r1 I-1）：交易第一步對目標 groups 取 KEY SHARE＋重驗成員——複製∥移除成員兩種先後、同群組複製
 * ∥「groups FOR UPDATE → 該群組筆記 FOR UPDATE」（PR4 全刪的形）不死結。C19d（review r2 M-2）：201 的 role／permissions
 * 取 (g) 交易內讀到的旗標，降級落在路由檢查與 (g) 之間時回降級後的值。
 */
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { autoSlugFromTitle } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, noteLinks, noteShares, notes, uploads } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { nextSlugCandidate } from "../src/notes/slug.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";
import { imageDoc, loadDoc, seedDoc, seedUpload, wikilinkDoc, xmlOf } from "./copy-helpers.js";

const MEMBER_PERMS = { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false };
const OWNER_PERMS = { read: true, edit: true, delete: true, manageShares: true, managePublicLink: true, changeSlug: true, moveToGroup: true };
const EXTERNAL = "https://example.com/x.png";

const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });

const noteCount = async (db: Db): Promise<number> => (await db.$client.query<{ n: number }>("select count(*)::int as n from notes")).rows[0]!.n;
const uploadCount = async (db: Db): Promise<number> => (await db.$client.query<{ n: number }>("select count(*)::int as n from uploads")).rows[0]!.n;
const filesIn = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();
const uploadsOf = (db: Db, noteId: string) =>
  db.select({ id: uploads.id, uploaderId: uploads.uploaderId, mime: uploads.mime, size: uploads.size }).from(uploads).where(eq(uploads.noteId, noteId));

describe("#175 PR2 POST /api/notes/:id/copy（T4）", () => {
  it("個人→群組：201 群組形 DTO；note_states version 1、XML 只差改寫的網址；本站附件換新 id 與新檔、外部圖與他篇附件原樣；不帶 AI 紀錄／shares／token／別名／prev／legacy／last_edited；副本 updated_at 晚於來源", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [owner, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: owner.id }, {
      title: "Plan", slug: "plan", slugIsCustom: true, prevSlug: "old", legacySlug: "legacy-x", publicToken: "t".repeat(43), publicSlug: "alias",
    });
    const other = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, src.id, c.id, "editor");
    await db.insert(noteAiEdits).values({ noteId: src.id, userId: owner.id, op: "append" });
    await db.update(notes).set({ lastEditedAt: new Date(), lastEditedBy: owner.id }).where(eq(notes.id, src.id));
    const b1 = Buffer.from("bytes-of-u1"), b2 = Buffer.from("bytes-of-u2-longer");
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id, b1);
    const u2 = await seedUpload(db, uploadsDir, src.id, c.id, b2);
    const u3 = await seedUpload(db, uploadsDir, other.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u1}`, `/api/uploads/${u2}`, EXTERNAL, `/api/uploads/${u3}`]));
    const srcXml = xmlOf((await loadDoc(db, src.id))!);
    const filesBefore = await filesIn(uploadsDir);
    const srcRowBefore = (await db.$client.query("select * from notes where id = $1", [src.id])).rows[0];

    const res = await copy(app, src.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      groupId: g.id, ownerId: null, ownerHandle: null, role: "editor", group: { id: g.id, name: "G" }, permissions: MEMBER_PERMS,
      lastEdited: null, prevSlug: null, title: "Plan", slugIsCustom: false,
    });
    expect(body.id).not.toBe(src.id);
    const copyId = body.id as string;

    // 副本的附件：恰兩列（u1、u2 各一，RF2：u1 被引用兩次也只一份），uploader＝呼叫者、mime／size 同來源，新檔 bytes 同來源。
    const rows = await uploadsOf(db, copyId);
    expect(rows).toHaveLength(2);
    const bySize = new Map(rows.map(r => [r.size, r]));
    const n1 = bySize.get(b1.length)!, n2 = bySize.get(b2.length)!;
    for (const r of [n1, n2]) expect(r).toMatchObject({ uploaderId: owner.id, mime: "image/png" });
    expect(await readFile(uploadFilePath(uploadsDir, n1.id))).toEqual(b1);
    expect(await readFile(uploadFilePath(uploadsDir, n2.id))).toEqual(b2);
    expect(await filesIn(uploadsDir)).toEqual([...filesBefore, n1.id, n2.id].sort());

    // 副本 XML：把新 id 換回舊 id 後與來源逐字相同（u3 他篇附件、外部網址原樣）；version 1。
    const copyXml = xmlOf((await loadDoc(db, copyId))!);
    expect(copyXml.split(`/api/uploads/${n1.id}`).length - 1).toBe(2);
    expect(copyXml).toContain(`/api/uploads/${u3}`);
    expect(copyXml).toContain(EXTERNAL);
    expect(copyXml.replaceAll(n1.id, u1).replaceAll(n2.id, u2)).toBe(srcXml);
    expect((await db.$client.query("select version from note_states where note_id = $1", [copyId])).rows).toEqual([{ version: 1 }]);

    // 來源原封不動。
    expect((await db.$client.query("select * from notes where id = $1", [src.id])).rows[0]).toEqual(srcRowBefore);
    expect(xmlOf((await loadDoc(db, src.id))!)).toBe(srcXml);
    expect((await uploadsOf(db, src.id)).map(r => r.id).sort()).toEqual([u1, u2].sort());
    expect(await readFile(uploadFilePath(uploadsDir, u1))).toEqual(b1);

    // 不帶的東西。
    expect(await db.select().from(noteShares).where(eq(noteShares.noteId, copyId))).toEqual([]);
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, copyId))).toEqual([]);
    const { rows: [cp] } = await db.$client.query(
      "select owner_id, group_id, public_token, public_slug, prev_slug, legacy_slug, slug_is_custom, last_edited_at, last_edited_by from notes where id = $1",
      [copyId],
    );
    expect(cp).toEqual({
      owner_id: null, group_id: g.id, public_token: null, public_slug: null, prev_slug: null, legacy_slug: null, slug_is_custom: false,
      last_edited_at: null, last_edited_by: null,
    });
    // PR2 Task 6 review（D5／D6）：副本是新筆記，`updated_at` 取 DB default——晚於來源（MCP `list_notes` 說明依賴）。
    const { rows: [cmp] } = await db.$client.query<{ later: boolean }>(
      "select (select updated_at from notes where id = $1) > (select updated_at from notes where id = $2) as later",
      [copyId, src.id],
    );
    expect(cmp!.later).toBe(true);
    expect(new Date(body.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(srcRowBefore.updated_at).getTime());
  });

  it("群組→個人（只讀自訂角色也行）：201 owner 形；slug 在呼叫者個人範圍以標題去重", async () => {
    const { app, db } = await buildTestApp();
    const [admin, reader] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: reader.id, role: "member" }]);
    const readerRole = await seedRole(db, g.id, "Reader", { canRead: true });
    await setMemberRole(db, g.id, reader.id, readerRole);
    const auto = autoSlugFromTitle("Weekly Plan");
    const src = await seedNote(db, { groupId: g.id }, { title: "Weekly Plan", slug: auto });
    await seedNote(db, { ownerId: reader.id }, { title: "Weekly Plan", slug: auto });

    const res = await copy(app, src.id, reader.id);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      ownerId: reader.id, ownerHandle: reader.handle, groupId: null, group: null, role: "owner", permissions: OWNER_PERMS,
      title: "Weekly Plan", slug: nextSlugCandidate(auto, 2),
    });
    expect(res.json().slug).toBe(`${auto}-2`);
  });

  it("來源授權：陌生人（個人筆記無分享）、非成員（群組筆記）→ 404 not_found，與不存在的 id 逐位元組相同；不建任何列", async () => {
    const { app, db } = await buildTestApp();
    const [owner, stranger, admin] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const personal = await seedNote(db, { ownerId: owner.id });
    const grouped = await seedNote(db, { groupId: g.id });
    const before = await noteCount(db);

    const missing = await copy(app, "00000000-0000-4000-8000-000000000000", stranger.id);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "not_found", message: "找不到此筆記" } });
    for (const noteId of [personal.id, grouped.id, "not-a-uuid"]) {
      const res = await copy(app, noteId, stranger.id);
      expect(res.statusCode, noteId).toBe(404);
      expect(res.body).toBe(missing.body);
    }
    expect(await noteCount(db)).toBe(before);
  });

  it("目標：非 UUID、不存在、非成員、成員無 can_create → 404 group_not_found（四者逐位元組相同），不建任何列、不落任何檔", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const notMine = await seedGroup(db, "NotMine", [{ userId: admin.id, role: "admin" }]);
    const readOnly = await seedGroup(db, "ReadOnly", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const reader = await seedRole(db, readOnly.id, "Reader", { canRead: true });
    await setMemberRole(db, readOnly.id, owner.id, reader);
    const src = await seedNote(db, { ownerId: owner.id });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    const [notesBefore, uploadsBefore, filesBefore] = [await noteCount(db), await uploadCount(db), await filesIn(uploadsDir)];

    const bodies: string[] = [];
    for (const groupId of ["not-a-uuid", "00000000-0000-4000-8000-00000000abcd", notMine.id, readOnly.id]) {
      const res = await copy(app, src.id, owner.id, { groupId });
      expect(res.statusCode, groupId).toBe(404);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: { code: "group_not_found", message: "找不到此群組" } });
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await uploadCount(db)).toBe(uploadsBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
  });

  it("body strict：多餘鍵、groupId 非字串／null → 400 invalid_body，不建列", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: owner.id });
    const before = await noteCount(db);
    for (const payload of [{ groupId: g.id, extra: 1 }, { extra: 1 }, { groupId: 42 }, { groupId: null }]) {
      const res = await copy(app, src.id, owner.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect(await noteCount(db)).toBe(before);
  });

  it("複製到群組撞名：beforeInsert 搶插 → savepoint 重試成功（gate r1 I2），201", async () => {
    const holder: { db?: Db; groupId?: string; candidates: string[] } = { candidates: [] };
    const { app, db } = await buildTestApp({
      noteCreateHooks: {
        beforeInsert: async candidate => {
          holder.candidates.push(candidate);
          // 另一條連線先 commit 一篇同 slug 的群組筆記——副本的 INSERT 撞 notes_group_slug_idx。
          if (holder.candidates.length === 1) await seedNote(holder.db!, { groupId: holder.groupId! }, { slug: candidate });
        },
      },
    });
    holder.db = db;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    holder.groupId = g.id;
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan", slug: "plan" });

    const res = await copy(app, src.id, owner.id, { groupId: g.id });

    expect(holder.candidates).toEqual(["plan", "plan-2"]);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "plan-2", groupId: g.id });
    expect((await db.$client.query("select count(*)::int as n from note_states where note_id = $1", [res.json().id])).rows[0].n).toBe(1);
  });

  it("DB 失敗不留孤兒檔：note-copy-files-copied 縫丟錯 → 500；uploadsDir 只剩來源的檔、沒有副本列與副本 uploads 列", async () => {
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        if (point === "note-copy-files-copied") throw new Error("boom");
      },
    });
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const u2 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u2}`]));
    const [notesBefore, uploadsBefore] = [await noteCount(db), await uploadCount(db)];

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(500);
    expect(await filesIn(uploadsDir)).toEqual([u1, u2].sort());
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await uploadCount(db)).toBe(uploadsBefore);
  });

  it("C7：複製持 FOR KEY SHARE 時刪除來源 → DELETE 卡在列刪除（blocked）→ 複製 201 → 刪除 204 → 副本的圖對呼叫者仍 200", async () => {
    const holder: { app?: FastifyInstance; db?: Db; srcId?: string; cookie?: Record<string, string>; del?: Promise<{ statusCode: number }>; interleave?: string } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-locked" || holder.del) return;
        holder.del = holder.app!.inject({ method: "DELETE", url: `/api/notes/${holder.srcId}`, cookies: holder.cookie });
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.del);
      },
    });
    Object.assign(holder, { app, db });
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    Object.assign(holder, { srcId: src.id, cookie: await cookieOf(owner.id) });

    const res = await copy(app, src.id, owner.id);

    expect(holder.interleave).toBe("blocked");
    expect(res.statusCode).toBe(201);
    expect((await holder.del!).statusCode).toBe(204);
    expect(await db.select().from(notes).where(eq(notes.id, src.id))).toEqual([]);
    const [n1] = await uploadsOf(db, res.json().id);
    const img = await app.inject({ method: "GET", url: `/api/uploads/${n1!.id}`, cookies: await cookieOf(owner.id) });
    expect(img.statusCode).toBe(200);
    expect(await filesIn(uploadsDir)).toEqual([n1!.id]); // 來源的檔隨刪除 commit 後清掉；副本的留著
  });

  it("M1：複製持鎖期間，來源的一般 UPDATE（last_edited_at）不被擋", async () => {
    const holder: { db?: Db; srcId?: string; upd?: Promise<"done">; outcome?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-locked") return;
        const upd = holder.db!.update(notes).set({ lastEditedAt: new Date() }).where(eq(notes.id, holder.srcId!)).then(() => "done" as const);
        holder.upd = upd;
        // 不等 `upd` 本身：被擋的話 1 秒後放行、複製照常 commit，被擋的 UPDATE 隨即完成（不留懸掛連線）。
        holder.outcome = await Promise.race([upd, new Promise<string>(r => setTimeout(() => r("timeout"), 1000))]);
      },
    });
    holder.db = db;
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    holder.srcId = src.id;

    const res = await copy(app, src.id, owner.id);

    await holder.upd;
    expect(res.statusCode).toBe(201);
    expect(holder.outcome).toBe("done");
  });

  it("副本公開後匿名讀得到圖；來源刪除後副本圖對 owner 仍 200", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));

    const res = await copy(app, src.id, owner.id);
    expect(res.statusCode).toBe(201);
    const copyId = res.json().id as string;
    const [n1] = await uploadsOf(db, copyId);
    // 圖的 id 取自副本文件（使用者實際看到的那個網址），並與副本的 uploads 列一致。
    const docUrl = /\/api\/uploads\/([0-9a-f-]{36})/.exec(xmlOf((await loadDoc(db, copyId))!))![1];
    expect(docUrl).toBe(n1!.id);
    const pub = await app.inject({ method: "PUT", url: `/api/notes/${copyId}/public-link`, cookies: await cookieOf(owner.id) });
    expect(pub.statusCode).toBe(200);
    const anon = await app.inject({ method: "GET", url: `/api/public/notes/${pub.json().token}/uploads/${n1!.id}` });
    expect(anon.statusCode).toBe(200);
    // 對照：來源的附件 id 掛在副本的公開連結下讀不到（證明上一條真的靠改寫後的新 id）。
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${pub.json().token}/uploads/${u1}` })).statusCode).toBe(404);

    expect((await app.inject({ method: "DELETE", url: `/api/notes/${src.id}`, cookies: await cookieOf(owner.id) })).statusCode).toBe(204);
    const img = await app.inject({ method: "GET", url: `/api/uploads/${n1!.id}`, cookies: await cookieOf(owner.id) });
    expect(img.statusCode).toBe(200);
  });

  it("出向 note_links：以複製者身分寫——他看得到的目標有列、看不到的沒有；看得到的目標的 backlinks 列出副本", async () => {
    const { app, db } = await buildTestApp();
    const [owner, copier] = await Promise.all([seedUser(db), seedUser(db)]);
    const visible = await seedNote(db, { ownerId: copier.id });
    const hidden = await seedNote(db, { ownerId: owner.id });
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Links" });
    await seedShare(db, src.id, copier.id, "viewer");
    await seedDoc(db, src.id, wikilinkDoc([visible.id, hidden.id]));

    const res = await copy(app, src.id, copier.id);

    expect(res.statusCode).toBe(201);
    const copyId = res.json().id as string;
    const links = await db.select({ target: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, copyId));
    expect(links).toEqual([{ target: visible.id }]);
    const bl = await app.inject({ method: "GET", url: `/api/notes/${visible.id}/backlinks`, cookies: await cookieOf(copier.id) });
    expect(bl.statusCode).toBe(200);
    expect((bl.json().backlinks as Array<{ id: string }>).map(b => b.id)).toEqual([copyId]);
    // 副本文件裡兩個 wikilink 都原樣保留（看不到的那個在副本裡顯示為未解析）。
    const xml = xmlOf((await loadDoc(db, copyId))!);
    expect(xml).toContain(visible.id);
    expect(xml).toContain(hidden.id);
  });

  it("RF3：從沒開過的筆記（無 note_states）→ 201、副本有一列 note_states（version 1、空文件）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Never opened" });
    expect(await loadDoc(db, src.id)).toBeNull();

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(201);
    const copyId = res.json().id as string;
    expect((await db.$client.query("select version from note_states where note_id = $1", [copyId])).rows).toEqual([{ version: 1 }]);
    expect(xmlOf((await loadDoc(db, copyId))!)).toBe("");
  });

  it("RF4：來源附件列在、磁碟檔不在 → 201；該節點保留原網址、不建它的 uploads 列；其他附件照常複製", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const lost = await seedUpload(db, uploadsDir, src.id, owner.id, undefined, { noFile: true });
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${lost}`]));

    const res = await copy(app, src.id, owner.id);

    expect(res.statusCode).toBe(201);
    const copyId = res.json().id as string;
    const rows = await uploadsOf(db, copyId);
    expect(rows).toHaveLength(1);
    const xml = xmlOf((await loadDoc(db, copyId))!);
    expect(xml).toContain(`/api/uploads/${rows[0]!.id}`);
    expect(xml).toContain(`/api/uploads/${lost}`);
    expect(xml).not.toContain(`/api/uploads/${u1}`);
    expect(await filesIn(uploadsDir)).toEqual([u1, rows[0]!.id].sort());
  });

  it("節流：edit 桶用盡 → 429，不建列", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const before = await noteCount(db);
    expect((await copy(app, src.id, owner.id)).statusCode).toBe(201);
    const second = await copy(app, src.id, owner.id);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("too_many_requests");
    expect(await noteCount(db)).toBe(before + 1);
  });

  it("目標被拒（非成員）→ 404 group_not_found，不扣 edit 桶、不扣 upload 桶（快速檢查的成員述詞要有 userId）", async () => {
    const edit = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const upload = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ edit, upload }) });
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    // 目標群組裡有別人（admin）具備 can_create；owner 不是成員。
    const notMine = await seedGroup(db, "NotMine", [{ userId: admin.id, role: "admin" }]);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    const notesBefore = await noteCount(db);

    const res = await copy(app, src.id, owner.id, { groupId: notMine.id });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("group_not_found");
    expect(await noteCount(db)).toBe(notesBefore);
    // 帳：被拒的那發什麼桶都沒扣 → edit 桶剩整窗 2、upload 桶剩整窗 1。
    expect(edit.consume(owner.id)).toBe(true);
    expect(edit.consume(owner.id)).toBe(true);
    expect(edit.consume(owner.id)).toBe(false);
    expect(upload.consume(owner.id)).toBe(true);
    expect(upload.consume(owner.id)).toBe(false);
  });

  it("upload 桶（M-1）：依會被複製的附件數扣（他篇附件、外部圖不算）；額度不夠 → 429 too_many_requests、不建列不落檔、被拒的那發不記帳", async () => {
    const upload = new FixedWindowLimiter({ limit: 3, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
    const owner = await seedUser(db);
    const other = await seedNote(db, { ownerId: owner.id });
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u1 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const u2 = await seedUpload(db, uploadsDir, src.id, owner.id);
    const u3 = await seedUpload(db, uploadsDir, other.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u1}`, `/api/uploads/${u2}`, `/api/uploads/${u3}`, EXTERNAL]));

    expect((await copy(app, src.id, owner.id)).statusCode).toBe(201); // 扣 2（u1 兩次引用只算一張；u3、外部圖不算）
    const [notesBefore, uploadsBefore, filesBefore] = [await noteCount(db), await uploadCount(db), await filesIn(uploadsDir)];

    const second = await copy(app, src.id, owner.id); // 要 2、剩 1
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: { code: "too_many_requests", message: "請求過於頻繁，請稍後再試" } });
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await uploadCount(db)).toBe(uploadsBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
    // 帳：第一發記 2、被拒的第二發不記 → 剩恰 1 張。
    expect(upload.consume(owner.id)).toBe(true);
    expect(upload.consume(owner.id)).toBe(false);
  });

  it("upload 桶（review r2 I-1）：附件張數 > 整窗額度 → 新視窗第一發 201（夾到整窗、扣滿），同窗緊接再複製 429、不建列", async () => {
    const upload = new FixedWindowLimiter({ limit: 2, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
    const owner = await seedUser(db);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedUpload(db, uploadsDir, src.id, owner.id));
    await seedDoc(db, src.id, imageDoc(ids.map(u => `/api/uploads/${u}`)));

    const first = await copy(app, src.id, owner.id); // 要 3 > 限額 2：夾成 2，新窗放行（不夾就永遠 429）
    expect(first.statusCode).toBe(201);
    expect(await uploadsOf(db, first.json().id)).toHaveLength(3); // 三張照常全複製
    const notesBefore = await noteCount(db);

    const second = await copy(app, src.id, owner.id);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: { code: "too_many_requests", message: "請求過於頻繁，請稍後再試" } });
    expect(await noteCount(db)).toBe(notesBefore);
    expect(upload.consume(owner.id)).toBe(false); // 第一發已扣滿整窗
  });

  it("upload 桶（M-1）：沒有要複製的附件（只有他篇附件與外部圖）→ 不碰 upload 桶", async () => {
    const upload = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload }) });
    const owner = await seedUser(db);
    const other = await seedNote(db, { ownerId: owner.id });
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    const u3 = await seedUpload(db, uploadsDir, other.id, owner.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u3}`, EXTERNAL]));

    expect((await copy(app, src.id, owner.id)).statusCode).toBe(201);
    expect((await copy(app, src.id, owner.id)).statusCode).toBe(201);
    expect(upload.consume(owner.id)).toBe(true); // 額度 1 還在
  });

  it("複製不踢任何人（§7）：onGroupAccessChanged、onShareChanged 都沒被呼叫", async () => {
    const spy = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: spy });
    const [owner, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });
    await seedShare(db, src.id, c.id, "editor");
    const gn = await seedNote(db, { groupId: g.id }, { title: "Group" });

    expect((await copy(app, src.id, owner.id, { groupId: g.id })).statusCode).toBe(201);
    expect((await copy(app, gn.id, owner.id)).statusCode).toBe(201);
    expect(spy.onGroupAccessChanged).not.toHaveBeenCalled();
    expect(spy.onShareChanged).not.toHaveBeenCalled();
    expect(spy.onUserRevoked).not.toHaveBeenCalled();
  });

  it("create-only 角色複製進群組 → 201，副本回應 role viewer、permissions.edit false", async () => {
    const { app, db } = await buildTestApp();
    const [owner, admin] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: owner.id, role: "member" }]);
    const contributor = await seedRole(db, g.id, "Contributor", { canRead: true, canCreate: true });
    await setMemberRole(db, g.id, owner.id, contributor);
    const src = await seedNote(db, { ownerId: owner.id }, { title: "Plan" });

    const res = await copy(app, src.id, owner.id, { groupId: g.id });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      groupId: g.id, ownerId: null, role: "viewer",
      permissions: { read: true, edit: false, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
  });
});

describe("#175 PR2 複製 × 群組鎖（C19a／C19b／C19c，review r1 I-1）", () => {
  const membersOf = async (db: Db, groupId: string, userId: string): Promise<number> =>
    (await db.$client.query<{ n: number }>("select count(*)::int as n from group_members where group_id = $1 and user_id = $2", [groupId, userId])).rows[0]!.n;
  const notesInGroup = async (db: Db, groupId: string): Promise<string[]> =>
    (await db.$client.query<{ title: string }>("select title from notes where group_id = $1 order by title", [groupId])).rows.map(r => r.title);

  it("C19a 複製先持鎖（note-copy-locked：目標 groups KEY SHARE＋來源）→ 移除成員的 lockGroup 等它 commit（blocked）→ 複製 201、移除 204；終態＝先複製、後移除", async () => {
    const holder: { app?: FastifyInstance; db?: Db; groupId?: string; userId?: string; cookie?: Record<string, string>; rm?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "note-copy-locked" || holder.rm) return;
        holder.rm = holder.app!.inject({ method: "DELETE", url: `/api/groups/${holder.groupId}/members/${holder.userId}`, cookies: holder.cookie });
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.rm);
      },
    });
    const [admin, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: m.id, role: "member" }]);
    Object.assign(holder, { app, db, groupId: g.id, userId: m.id, cookie: await cookieOf(admin.id) });
    const src = await seedNote(db, { ownerId: m.id }, { title: "Copied" });

    const res = await copy(app, src.id, m.id, { groupId: g.id });
    const removed = await holder.rm!;

    // 拿掉 (g) 的 KEY SHARE（突變實測）：來源的 KEY SHARE 不擋 lockGroup → 本行紅（settled）。整個拿掉 (g) 時 review r1
    // 實驗 A 看到的終態是移除 204 先落地、複製照樣 201——非成員在群組裡建出了筆記。
    expect(holder.interleave).toBe("blocked");
    expect(res.statusCode).toBe(201);
    expect(removed.statusCode).toBe(204);
    expect(await membersOf(db, g.id, m.id)).toBe(0);
    expect(await notesInGroup(db, g.id)).toEqual(["Copied"]);
  });

  it("C19c 移除成員先鎖（group-members-checked）→ 複製的路由檢查讀到 commit 前的成員資格而通過，交易 (g) 的 KEY SHARE 等移除 commit → 重驗 404 group_not_found；群組無新筆記、不落檔", async () => {
    const holder: { pool?: Db["$client"]; fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const built = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "group-members-checked" || !holder.fire || holder.second) return;
        holder.second = holder.fire();
        holder.interleave = await waitForBlockedOrSettled(holder.pool!, holder.second);
      },
    });
    const { app, db, uploadsDir } = built;
    holder.pool = db.$client;
    const [admin, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: m.id }, { title: "Copied" });
    const u1 = await seedUpload(db, uploadsDir, src.id, m.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));
    const [notesBefore, filesBefore] = [await noteCount(db), await filesIn(uploadsDir)];
    holder.fire = () => copy(app, src.id, m.id, { groupId: g.id });

    const removed = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${m.id}`, cookies: await cookieOf(admin.id) });
    const copied = await holder.second!;

    // 拿掉 (g) 的成員重驗、只留 KEY SHARE（突變實測）：複製仍 blocked，但移除 commit 後照樣 201。
    expect(holder.interleave).toBe("blocked");
    expect(removed.statusCode).toBe(204);
    expect(copied.statusCode).toBe(404);
    expect(copied.json()).toEqual({ error: { code: "group_not_found", message: "找不到此群組" } });
    expect(await noteCount(db)).toBe(notesBefore);
    expect(await notesInGroup(db, g.id)).toEqual([]);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
  });

  it("C19d（review r2 M-2）降級先鎖（group-members-checked）→ 複製的路由檢查讀到降級前的 admin 而通過，(g) 等降級 commit 後重讀 → 201 的 role／permissions 是降級後的 member 值，與 GET 副本一致", async () => {
    const holder: { pool?: Db["$client"]; fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "group-members-checked" || !holder.fire || holder.second) return;
        holder.second = holder.fire();
        holder.interleave = await waitForBlockedOrSettled(holder.pool!, holder.second);
      },
    });
    holder.pool = db.$client;
    const [a1, a2] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a1.id, role: "admin" }, { userId: a2.id, role: "admin" }]);
    const src = await seedNote(db, { ownerId: a2.id }, { title: "Copied" });
    holder.fire = () => copy(app, src.id, a2.id, { groupId: g.id });

    const demoted = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${a2.id}`, cookies: await cookieOf(a1.id), payload: { roleId: g.memberRoleId } });
    const copied = await holder.second!;

    expect(holder.interleave).toBe("blocked");
    expect(demoted.statusCode).toBe(200);
    expect(copied.statusCode).toBe(201);
    // 路由改回用交易外 `loadCreateTarget` 的值組 DTO（突變實測）→ 本行紅：回應是 admin 的 delete／managePublicLink／changeSlug true。
    expect(copied.json()).toMatchObject({
      groupId: g.id, group: { id: g.id, name: "G" }, role: "editor",
      permissions: { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
    const got = await app.inject({ method: "GET", url: `/api/notes/${copied.json().id}`, cookies: await cookieOf(a2.id) });
    expect(got.json().permissions).toEqual(copied.json().permissions);
  });

  it("C19b 同群組複製（來源與目標都在 G）持 (g) 時，另一交易「groups FOR UPDATE → G 的筆記 FOR UPDATE」（PR4 全刪的形）→ 對方等複製 commit（blocked）、兩邊都完成、沒有 40P01", async () => {
    const holder: { db?: Db; groupId?: string; other?: Promise<string>; interleave?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        // 複製交易**第一把鎖之後**的那個縫：現序是 (g) 之後（note-copy-target-locked，只持 groups KEY SHARE）。鎖序若改回
        // 「來源 → groups」（或整個拿掉 (g)、靠 INSERT 的 FK 取 groups），第一個到的縫是 note-copy-locked（只持來源）：
        // 對方拿得到 groups、再等來源，複製接著等 groups → 成環（突變實測 40P01）。
        if ((point !== "note-copy-target-locked" && point !== "note-copy-locked") || holder.other) return;
        holder.other = (async () => {
          const c = await holder.db!.$client.connect();
          try {
            await c.query("begin");
            await c.query("select id from groups where id = $1 for update", [holder.groupId]);
            await c.query("select id from notes where group_id = $1 for update", [holder.groupId]);
            await c.query("commit");
            return "committed";
          } catch (err) {
            await c.query("rollback").catch(() => {});
            return `error ${(err as { code?: string }).code}`;
          } finally {
            c.release();
          }
        })();
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.other);
      },
    });
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    Object.assign(holder, { db, groupId: g.id });
    const src = await seedNote(db, { groupId: g.id }, { title: "Same group" });

    const res = await copy(app, src.id, admin.id, { groupId: g.id });

    expect(holder.interleave).toBe("blocked");
    expect(res.statusCode).toBe(201);
    expect(await holder.other!).toBe("committed");
    expect(await notesInGroup(db, g.id)).toEqual(["Same group", "Same group"]);
  });
});
