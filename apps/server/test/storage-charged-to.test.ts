// The migration 0023 backfill is in `migrate.test.ts`; the query grouping where the payer is not the uploader is in `storage-admin.test.ts`; where the UPDATE sits is in `unit/storage-quota-structure.test.ts`.
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
/** The note's uploads rows (raw SQL, independent of the code under test), ordered by size. */
async function uploadRows(db: Db, noteId: string): Promise<UploadRow[]> {
  return (await db.$client.query<UploadRow>(
    "select uploader_id, charged_to_id, size::text as size from uploads where note_id = $1 order by uploads.size, id", [noteId],
  )).rows.map(r => ({ ...r, size: Number(r.size) }));
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

/** A's personal note shared to B (editor), B uploads 100 + 50 bytes through the real route. G = {X admin, A member, B member}. */
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

describe("#247 byMember by the charged member (uploads.charged_to_id)", () => {
  it("REST move-in: B uploads on A's shared personal note -> A moves it into G -> those attachments count for A, B (still a member) has no row; uploader_id is still B; another note of X in G is unaffected (the UPDATE touches only this note)", async () => {
    const { app, db } = await buildTestApp();
    const { a, b, x, g, n } = await sharedNoteWithBsUploads(app, db);
    const other = await seedNote(db, { groupId: g.id });
    await uploaded(app, other.id, x.id, 20); // bystander row: another note in G, uploaded by X (charged X)
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

  it("direct upload into a group note -> charged = uploader; uploading into a personal note also writes the charged member", async () => {
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

  it("copy into a group: all copied attachments count for the copier C (sources uploaded by A, B); attachments the content does not link are not copied or counted; copying to a personal space also writes the charged member", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [a, b, c, x] = await Promise.all([
      seedUser(db, { displayName: "A" }), seedUser(db, { displayName: "B" }), seedUser(db, { displayName: "C" }), seedUser(db, { displayName: "X" }),
    ]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const src = await seedNote(db, { ownerId: a.id });
    await seedShare(db, src.id, c.id, "viewer");
    const u1 = await seedUpload(db, uploadsDir, src.id, a.id, Buffer.alloc(30, 1));
    const u2 = await seedUpload(db, uploadsDir, src.id, b.id, Buffer.alloc(70, 2));
    await seedUpload(db, uploadsDir, src.id, a.id, Buffer.alloc(500, 3)); // content does not link it: not copied
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

  it("charged account hard-deleted (uploader still exists) -> those bytes land on the anonymous row, not falling back to uploader B", async () => {
    const { app, db } = await buildTestApp();
    const { a, x, g, n } = await sharedNoteWithBsUploads(app, db);
    expect((await moveRest(app, n.id, a.id, g.id)).statusCode).toBe(200);
    // The app has no delete-account path: delete directly. After the move A owns no personal notes (notes.owner_id is ON DELETE restrict, otherwise 23503).
    await db.$client.query("delete from users where id = $1", [a.id]);
    expect(await byMember(app, g.id, x.id)).toEqual([{ userId: null, handle: null, displayName: null, bytes: 150 }]);
  });

  it("MCP move_note_to_group move-in -> same attribution as REST move-in", async () => {
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

  it("deleting a group with transfer to an admin leaves charged_to_id alone: charged M (not the recipient X) is still M after the transfer", async () => {
    const { app, db } = await buildTestApp();
    const [m, x] = await Promise.all([seedUser(db, { displayName: "M" }), seedUser(db, { displayName: "X" })]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await uploaded(app, gn.id, m.id, 80);
    expect(await uploadRows(db, gn.id)).toEqual([{ uploader_id: m.id, charged_to_id: m.id, size: 80 }]);
    const del = await transfer(app, g.id, x.id);
    expect(del.statusCode, del.body).toBe(204);
    expect(await uploadRows(db, gn.id)).toEqual([{ uploader_id: m.id, charged_to_id: m.id, size: 80 }]);
    expect((await db.$client.query("select owner_id, group_id from notes where id = $1", [gn.id])).rows).toEqual([{ owner_id: x.id, group_id: null }]);
  });

  it("a moved-in note carrying attachments whose uploader account was long deleted (uploader_id NULL) -> also counted for the mover: every one, whoever uploaded", async () => {
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

  it("copying a group note into the same group: the original still counts for mover A, the copy (only attachments linked by content) counts for copier C", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [a, c, x] = await Promise.all([seedUser(db, { displayName: "A" }), seedUser(db, { displayName: "C" }), seedUser(db, { displayName: "X" })]);
    const g = await seedGroup(db, "G", [{ userId: x.id, role: "admin" }, { userId: a.id, role: "member" }, { userId: c.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: a.id });
    const u1 = await seedUpload(db, uploadsDir, n.id, a.id, Buffer.alloc(30, 1));
    await seedUpload(db, uploadsDir, n.id, a.id, Buffer.alloc(70, 2)); // content does not link it: counted for A at move-in, not carried at copy
    await seedDoc(db, n.id, imageDoc([`/api/uploads/${u1}`]));
    expect((await moveRest(app, n.id, a.id, g.id)).statusCode).toBe(200);
    const res = await copyRest(app, n.id, c.id, { groupId: g.id });
    expect(res.statusCode, res.body).toBe(201);
    expect(await byMember(app, g.id, x.id)).toEqual([
      { userId: a.id, handle: a.handle, displayName: "A", bytes: 100 },
      { userId: c.id, handle: c.handle, displayName: "C", bytes: 30 },
    ]);
  });

  it("after the charged member leaves the group the name and bytes are still listed (membership is not checked)", async () => {
    const { app, db } = await buildTestApp();
    const { a, x, g, n } = await sharedNoteWithBsUploads(app, db);
    expect((await moveRest(app, n.id, a.id, g.id)).statusCode).toBe(200);
    await db.$client.query("delete from group_members where group_id = $1 and user_id = $2", [g.id, a.id]);
    expect(await byMember(app, g.id, x.id)).toEqual([{ userId: a.id, handle: a.handle, displayName: "A", bytes: 150 }]);
  });

  it("after a transfer, recipient X moves that note into another group H -> counts for X in H (move-in overrides), not the original charged member M", async () => {
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
