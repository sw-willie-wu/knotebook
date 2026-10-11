/**
 * #247 §9.2（rev 9／10）：群組用量「依成員」依佔用者 `uploads.charged_to_id` 分組——三條寫入（上傳、移入、複製）、一條刻意不動（刪群組轉移）。
 * (a)–(d)、(f)、(g) 對應 spec §9.2「測試要求」；RF2–RF5 對應 Part 4 計畫的 Review Focus。
 * (e)（migration 0023 回填）在 migrate.test.ts；「佔用者≠上傳者」的查詢分組案在 storage-admin.test.ts；RF1（UPDATE 的位置）在 unit/storage-quota-structure.test.ts ⑧。
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Db } from "../src/db/index.js";
import { uploads } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { upload } from "./storage-helpers.js";
import { imageDoc, seedDoc, seedUpload } from "./copy-helpers.js";

type MemberRow = { userId: string | null; handle: string | null; displayName: string | null; bytes: number };
type UploadRow = { uploader_id: string | null; charged_to_id: string | null; size: number };

async function byMember(app: FastifyInstance, groupId: string, viewerId: string): Promise<MemberRow[]> {
  const res = await app.inject({ method: "GET", url: `/api/groups/${groupId}/storage`, cookies: await cookieOf(viewerId) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().byMember as MemberRow[];
}
/** 該筆記的 uploads 列（raw SQL，與被測碼獨立），依 size 排。 */
async function uploadRows(db: Db, noteId: string): Promise<UploadRow[]> {
  return (await db.$client.query<UploadRow>(
    "select uploader_id, charged_to_id, size from uploads where note_id = $1 order by size, id", [noteId],
  )).rows;
}
async function uploaded(app: FastifyInstance, noteId: string, userId: string, size: number): Promise<void> {
  const res = await upload(app, noteId, userId, size);
  expect(res.statusCode, res.body).toBe(201);
}
const moveRest = async (app: FastifyInstance, noteId: string, userId: string, groupId: string): Promise<LightMyRequestResponse> =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });
const copyRest = async (app: FastifyInstance, noteId: string, userId: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload });
const transfer = async (app: FastifyInstance, groupId: string, adminId: string): Promise<LightMyRequestResponse> =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(adminId), payload: { mode: "transfer", transferTo: adminId } });

/** A 的個人筆記分享給 B（editor），B 經真路由上傳 100＋50 bytes。G＝{X admin、A member、B member}。 */
async function sharedNoteWithBsUploads(app: FastifyInstance, db: Db) {
  const [a, b, x] = await Promise.all([
    seedUser(db, { displayName: "A" }), seedUser(db, { displayName: "B" }), seedUser(db, { displayName: "X" }),
  ]);
  const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: a.id, role: "member" }, { userId: b.id, role: "member" }]);
  const n = await seedNote(db, { ownerId: a.id });
  await seedShare(db, n.id, b.id, "editor");
  await uploaded(app, n.id, b.id, 100);
  await uploaded(app, n.id, b.id, 50);
  return { a, b, x, g, n };
}

describe("#247 §9.2 byMember 依佔用者（uploads.charged_to_id）", () => {
  it("(a) REST 移入：B 在 A 分享給他的個人筆記上傳 → A 移入 G → 那些附件算 A、B（仍是成員）無列；uploader_id 仍是 B；G 另一篇 X 的附件不受影響（UPDATE 只動本篇）", async () => {
    const { app, db } = await buildTestApp();
    const { a, b, x, g, n } = await sharedNoteWithBsUploads(app, db);
    const other = await seedNote(db, { groupId: g.id });
    await uploaded(app, other.id, x.id, 20); // 旁觀列：G 的另一篇、X 上傳（佔用者 X）
    const res = await moveRest(app, n.id, a.id, g.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await byMember(app, g.id, x.id)).toEqual([
      { userId: a.id, handle: a.handle, displayName: "A", bytes: 150 },
      { userId: x.id, handle: x.handle, displayName: "X", bytes: 20 },
    ]);
    expect(await uploadRows(db, other.id)).toEqual([{ uploader_id: x.id, charged_to_id: x.id, size: 20 }]);
    expect(await uploadRows(db, n.id)).toEqual([
      { uploader_id: b.id, charged_to_id: a.id, size: 50 },
      { uploader_id: b.id, charged_to_id: a.id, size: 100 },
    ]);
  });

  it("(b) 直接上傳進群組筆記 → 佔用者＝上傳者；上傳進個人筆記也照寫佔用者", async () => {
    const { app, db } = await buildTestApp();
    const [m, x] = await Promise.all([seedUser(db, { displayName: "M" }), seedUser(db, { displayName: "X" })]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await uploaded(app, gn.id, m.id, 64);
    expect(await byMember(app, g.id, x.id)).toEqual([{ userId: m.id, handle: m.handle, displayName: "M", bytes: 64 }]);
    expect(await uploadRows(db, gn.id)).toEqual([{ uploader_id: m.id, charged_to_id: m.id, size: 64 }]);
    const p = await seedNote(db, { ownerId: m.id });
    await uploaded(app, p.id, m.id, 32);
    expect(await uploadRows(db, p.id)).toEqual([{ uploader_id: m.id, charged_to_id: m.id, size: 32 }]);
  });

  it("(c) 複製進群組：副本附件全算複製者 C（來源附件由 A、B 上傳）；內容沒連到的不複製、不計入；複製到個人空間也照寫佔用者", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [a, b, c, x] = await Promise.all([
      seedUser(db, { displayName: "A" }), seedUser(db, { displayName: "B" }), seedUser(db, { displayName: "C" }), seedUser(db, { displayName: "X" }),
    ]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: a.id });
    await seedShare(db, src.id, c.id, "viewer");
    const u1 = await seedUpload(db, uploadsDir, src.id, a.id, Buffer.alloc(30, 1));
    const u2 = await seedUpload(db, uploadsDir, src.id, b.id, Buffer.alloc(70, 2));
    await seedUpload(db, uploadsDir, src.id, a.id, Buffer.alloc(500, 3)); // 內容沒連到：不複製
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u2}`]));

    const res = await copyRest(app, src.id, c.id, { groupId: g.id });
    expect(res.statusCode, res.body).toBe(201);
    expect(await byMember(app, g.id, x.id)).toEqual([{ userId: c.id, handle: c.handle, displayName: "C", bytes: 100 }]);
    expect(await uploadRows(db, res.json().id as string)).toEqual([
      { uploader_id: c.id, charged_to_id: c.id, size: 30 },
      { uploader_id: c.id, charged_to_id: c.id, size: 70 },
    ]);
    const mine = await copyRest(app, src.id, c.id, {});
    expect(mine.statusCode, mine.body).toBe(201);
    expect(await uploadRows(db, mine.json().id as string)).toEqual([
      { uploader_id: c.id, charged_to_id: c.id, size: 30 },
      { uploader_id: c.id, charged_to_id: c.id, size: 70 },
    ]);
  });

  it("(d) 佔用者帳號被硬刪（上傳者仍在）→ 那些 bytes 落匿名列，不回落給上傳者 B", async () => {
    const { app, db } = await buildTestApp();
    const { a, x, g, n } = await sharedNoteWithBsUploads(app, db);
    expect((await moveRest(app, n.id, a.id, g.id)).statusCode).toBe(200);
    // 應用程式沒有刪帳號路徑：直接刪。A 移入後不擁有任何個人筆記（notes.owner_id 是 ON DELETE restrict，否則 23503）。
    await db.$client.query("delete from users where id = $1", [a.id]);
    expect(await byMember(app, g.id, x.id)).toEqual([{ userId: null, handle: null, displayName: null, bytes: 150 }]);
  });

  it("(f) MCP move_note_to_group 移入 → 歸屬與 REST (a) 相同", async () => {
    const { app, db } = await buildTestApp();
    const { a, b, x, g, n } = await sharedNoteWithBsUploads(app, db);
    const { token } = await seedTokenForUser(db, a.id, "notes:read notes:write notes:move");
    const res = await mcpPost(app, rpc("tools/call", { name: "move_note_to_group", arguments: { note_id: n.id, group_id: g.id } }), { token });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json().result as { isError?: true; structuredContent?: unknown };
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
    expect(await byMember(app, g.id, x.id)).toEqual([{ userId: a.id, handle: a.handle, displayName: "A", bytes: 150 }]);
    expect(await uploadRows(db, n.id)).toEqual([
      { uploader_id: b.id, charged_to_id: a.id, size: 50 },
      { uploader_id: b.id, charged_to_id: a.id, size: 100 },
    ]);
  });

  it("(g) 刪群組「轉移給管理員」不動 charged_to_id：佔用者 M（不是接收者 X）在轉移後仍是 M", async () => {
    const { app, db } = await buildTestApp();
    const [m, x] = await Promise.all([seedUser(db, { displayName: "M" }), seedUser(db, { displayName: "X" })]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await uploaded(app, gn.id, m.id, 80);
    expect(await uploadRows(db, gn.id)).toEqual([{ uploader_id: m.id, charged_to_id: m.id, size: 80 }]); // 前置
    const del = await transfer(app, g.id, x.id);
    expect(del.statusCode, del.body).toBe(204);
    expect(await uploadRows(db, gn.id)).toEqual([{ uploader_id: m.id, charged_to_id: m.id, size: 80 }]);
    expect((await db.$client.query("select owner_id, group_id from notes where id = $1", [gn.id])).rows).toEqual([{ owner_id: x.id, group_id: null }]);
  });

  it("RF2 移入的筆記帶著上傳者帳號早已刪除的附件（uploader_id NULL）→ 也算移入者：每一筆，不論原上傳者", async () => {
    const { app, db } = await buildTestApp();
    const [a, x] = await Promise.all([seedUser(db, { displayName: "A" }), seedUser(db, { displayName: "X" })]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: a.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: a.id });
    await db.insert(uploads).values([
      { noteId: n.id, uploaderId: null, mime: "image/png", size: 40 },
      { noteId: n.id, uploaderId: a.id, mime: "image/png", size: 60 },
    ]);
    expect((await moveRest(app, n.id, a.id, g.id)).statusCode).toBe(200);
    expect(await byMember(app, g.id, x.id)).toEqual([{ userId: a.id, handle: a.handle, displayName: "A", bytes: 100 }]);
    expect(await uploadRows(db, n.id)).toEqual([
      { uploader_id: null, charged_to_id: a.id, size: 40 },
      { uploader_id: a.id, charged_to_id: a.id, size: 60 },
    ]);
  });

  it("RF3 群組筆記再複製進同一群組：原篇仍算移入者 A，副本（只含內容連到的附件）算複製者 C", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [a, c, x] = await Promise.all([seedUser(db, { displayName: "A" }), seedUser(db, { displayName: "C" }), seedUser(db, { displayName: "X" })]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: a.id, role: "member" }, { userId: c.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: a.id });
    const u1 = await seedUpload(db, uploadsDir, n.id, a.id, Buffer.alloc(30, 1));
    await seedUpload(db, uploadsDir, n.id, a.id, Buffer.alloc(70, 2)); // 內容沒連到：移入時算 A，複製時不帶
    await seedDoc(db, n.id, imageDoc([`/api/uploads/${u1}`]));
    expect((await moveRest(app, n.id, a.id, g.id)).statusCode).toBe(200);
    const res = await copyRest(app, n.id, c.id, { groupId: g.id });
    expect(res.statusCode, res.body).toBe(201);
    expect(await byMember(app, g.id, x.id)).toEqual([
      { userId: a.id, handle: a.handle, displayName: "A", bytes: 100 },
      { userId: c.id, handle: c.handle, displayName: "C", bytes: 30 },
    ]);
  });

  it("RF4 佔用者離開群組後照列名字與位元組（不看是否仍是成員）", async () => {
    const { app, db } = await buildTestApp();
    const { a, x, g, n } = await sharedNoteWithBsUploads(app, db);
    expect((await moveRest(app, n.id, a.id, g.id)).statusCode).toBe(200);
    await db.$client.query("delete from group_members where group_id = $1 and user_id = $2", [g.id, a.id]);
    expect(await byMember(app, g.id, x.id)).toEqual([{ userId: a.id, handle: a.handle, displayName: "A", bytes: 150 }]);
  });

  it("RF5 轉移後接收者 X 再把那篇移入另一個群組 H → H 裡算 X（移入覆寫），不是原佔用者 M", async () => {
    const { app, db } = await buildTestApp();
    const [m, x] = await Promise.all([seedUser(db, { displayName: "M" }), seedUser(db, { displayName: "X" })]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const h = await seedGroup(db, "H", [{ userId: x.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await uploaded(app, gn.id, m.id, 80);
    expect((await transfer(app, g.id, x.id)).statusCode).toBe(204);
    expect((await moveRest(app, gn.id, x.id, h.id)).statusCode).toBe(200);
    expect(await byMember(app, h.id, x.id)).toEqual([{ userId: x.id, handle: x.handle, displayName: "X", bytes: 80 }]);
    expect(await uploadRows(db, gn.id)).toEqual([{ uploader_id: m.id, charged_to_id: x.id, size: 80 }]);
  });
});
