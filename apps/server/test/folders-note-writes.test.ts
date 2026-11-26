import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NoteDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { groupMembers } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import type { NoteCreateHooks } from "../src/notes/create.js";
import { cloneForCopy } from "../src/notes/copy-doc.js";
import { extractForIndex } from "../src/notes/search-index.js";
import { extractKnowledgeForIndex } from "../src/knowledge/extract.js";
import { copyNoteInTx } from "../src/notes/tx/copy.js";
import { moveNoteToGroupInTx } from "../src/notes/tx/move.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { noteFolderCols, seedFolder, setNoteFolder } from "./folder-helpers.js";
import { noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, sharesOf, type SeededUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp, freshDb } from "./helpers.js";
import { inject, sixRoleScene } from "./trash-helpers.js";

const RANDOM_UUID = "7d0c6a4e-1f2b-4c3d-9e8f-0a1b2c3d4e5f";
const TXN_CONTROL = /^(begin|commit|rollback)\b/i;
const ROW_LOCK = /for (update|key share)$/;
const CROSS_SPACE = "A note can't go into a folder in another space.";
const ROLE_FORBIDDEN = "Your role in this group can't put notes in folders.";
const FOLDER_NOT_FOUND = "No folder with that id.";

const post = (app: FastifyInstance, userId: string, body: unknown) => inject(app, "POST", "/api/notes", userId, body);
const copy = (app: FastifyInstance, userId: string, noteId: string, body: unknown) => inject(app, "POST", `/api/notes/${noteId}/copy`, userId, body);
const move = (app: FastifyInstance, userId: string, noteId: string, body: unknown) => inject(app, "POST", `/api/notes/${noteId}/move`, userId, body);

function okDto(res: LightMyRequestResponse, status: 200 | 201): NoteDto {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as NoteDto;
}
function failed(res: LightMyRequestResponse, status: number, code: string): string {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as { error: { code: string } }).error.code).toBe(code);
  return res.body;
}
const messageOf = (res: LightMyRequestResponse): string => (res.json() as { error: { message: string } }).error.message;

/** Test hook: after `arm(point, fn)`, the first time point is passed fn runs (once only). */
function armedHook() {
  let armed: { point: GroupRacePoint; fn: () => Promise<void> } | null = null;
  return {
    hook: async (point: GroupRacePoint) => {
      if (armed && armed.point === point) {
        const { fn } = armed;
        armed = null;
        await fn();
      }
    },
    arm(point: GroupRacePoint, fn: () => Promise<void>) {
      armed = { point, fn };
    },
    get pending() {
      return armed !== null;
    },
  };
}

/** Adds a custom create-only role (read + create, can't be placed in a group folder) to the group. */
async function createOnlyMember(db: Db, groupId: string): Promise<SeededUser> {
  const u = await seedUser(db);
  const roleId = await seedRole(db, groupId, `co-${u.id.slice(0, 8)}`, { canRead: true, canCreate: true });
  await db.insert(groupMembers).values({ groupId, userId: u.id, roleId });
  return u;
}

async function setRole(pool: Pool, groupId: string, userId: string, roleId: string): Promise<void> {
  await pool.query("update group_members set role_id = $3 where group_id = $1 and user_id = $2", [groupId, userId, roleId]);
}

async function noteIn(db: Db, pool: Pool, owner: { ownerId: string } | { groupId: string }, folderId: string | null, opts: Parameters<typeof seedNote>[2] = {}): Promise<string> {
  const n = await seedNote(db, owner, opts);
  if (folderId !== null) await setNoteFolder(pool, n.id, folderId);
  return n.id;
}

async function countTitled(pool: Pool, title: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from notes where title = $1", [title]);
  return rows[0]!.n;
}

/** Number of personal notes owned by someone (to tell "no copy / new note was created"). */
async function notesOwnedBy(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from notes where owner_id = $1", [userId]);
  return rows[0]!.n;
}

async function transferGroup(app: FastifyInstance, groupId: string, adminId: string): Promise<void> {
  const del = await inject(app, "DELETE", `/api/groups/${groupId}`, adminId, { mode: "transfer", transferTo: adminId });
  expect(del.statusCode, del.body).toBe(204);
}

describe("POST /api/notes with folderId", () => {
  it("personal: created in own folder -> 201, folderId correct, DB consistent; uppercase folderId the same; Bearer (notes:write) the same", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const F = (await seedFolder(db, { personal: u.id })).id;

    const a = okDto(await post(app, u.id, { title: "FN1 a", folderId: F }), 201);
    expect(a.folderId).toBe(F);
    expect((await noteFolderCols(pool, a.id))?.folder_id).toBe(F);

    const upper = okDto(await post(app, u.id, { folderId: F.toUpperCase() }), 201);
    expect(upper.folderId).toBe(F);
    expect((await noteFolderCols(pool, upper.id))?.folder_id).toBe(F);

    const rw = await seedTokenForUser(db, u.id, "notes:read notes:write");
    const viaBearer = await app.inject({ method: "POST", url: "/api/notes", headers: bearer(rw.token), payload: { title: "FN1 b", folderId: F } });
    const b = okDto(viaBearer, 201);
    expect(b.folderId).toBe(F);
    expect((await noteFolderCols(pool, b.id))?.folder_id).toBe(F);

    const root = okDto(await post(app, u.id, { title: "FN1 root" }), 201);
    expect(root.folderId).toBeNull();
    expect((await noteFolderCols(pool, root.id))?.folder_id).toBeNull();
  });

  it("with content: created in folder -> 201, folderId correct, DB consistent; invisible 404; row insert hitting KF001 -> 404 folder_not_found", async () => {
    const seam = armedHook();
    const ctx = await buildCollabTestApp({ groupTestHook: seam.hook });
    const pool = ctx.db.$client;
    const u = await seedUser(ctx.db);
    const F = (await seedFolder(ctx.db, { personal: u.id })).id;
    const rw = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const res = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(rw.token), payload: { title: "FN1 content", content: "# H\n\n本文", folderId: F } });
    const dto = okDto(res, 201);
    expect(dto.folderId).toBe(F);
    expect((await noteFolderCols(pool, dto.id))?.folder_id).toBe(F);

    const bad = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(rw.token), payload: { title: "FN1 content bad", content: "x", folderId: RANDOM_UUID } });
    failed(bad, 404, "folder_not_found");
    expect(await countTitled(pool, "FN1 content bad")).toBe(0);

    // The row insert is outside the service's try: KF001 is thrown unchanged to the route's catch (the folder moved to another space after the membership check)
    const s = await sixRoleScene(ctx.db);
    const GF = (await seedFolder(ctx.db, { group: s.groupId })).id;
    const memberToken = await seedTokenForUser(ctx.db, s.member.id, "notes:read notes:write");
    seam.arm("membership-checked", async () => {
      await pool.query("update folders set kind = 'personal', owner_id = $2, group_id = null where id = $1", [GF, s.admin.id]);
    });
    const kf = await ctx.app.inject({
      method: "POST", url: "/api/notes", headers: bearer(memberToken.token),
      payload: { title: "FN1 content kf001", content: "本文", groupId: s.groupId, folderId: GF },
    });
    failed(kf, 404, "folder_not_found");
    expect(messageOf(kf)).toBe(FOLDER_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await countTitled(pool, "FN1 content kf001")).toBe(0);
  });

  it("group: {groupId, that group's folder} 201; consistency errors 400; invisible 404 byte-for-byte identical to nonexistent; visibility is judged before the group criterion; create-only root 201, folder 403", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const G = s.groupId;
    const GF = (await seedFolder(db, { group: G })).id;
    const H = (await seedGroup(db, "H", [{ userId: s.member.id, role: "member" }])).id;
    const HF = (await seedFolder(db, { group: H })).id;
    const xAdmin = await seedUser(db);
    const X = (await seedGroup(db, "X", [{ userId: xAdmin.id, role: "admin" }])).id;
    const XF = (await seedFolder(db, { group: X })).id;
    const SF = (await seedFolder(db, { shared: s.member.id })).id;
    const PF = (await seedFolder(db, { personal: s.member.id })).id;

    const created = okDto(await post(app, s.member.id, { title: "FN2 ok", groupId: G, folderId: GF }), 201);
    expect(created.folderId).toBe(GF);
    expect(created.groupId).toBe(G);
    expect((await noteFolderCols(pool, created.id))?.folder_id).toBe(GF);
    // groupId in uppercase is accepted too
    expect(okDto(await post(app, s.member.id, { groupId: G.toUpperCase(), folderId: GF }), 201).folderId).toBe(GF);

    const crossCases: Array<[string, Record<string, string>]> = [
      ["群組資料夾、沒給 groupId", { folderId: GF }],
      ["groupId 是另一個我在的群組", { groupId: H, folderId: GF }],
      ["另一個我在的群組的資料夾", { groupId: G, folderId: HF }],
      ["共享私人資料夾", { folderId: SF }],
      ["共享私人資料夾＋groupId", { groupId: G, folderId: SF }],
      ["個人資料夾＋groupId", { groupId: G, folderId: PF }],
    ];
    for (const [label, body] of crossCases) {
      const res = await post(app, s.member.id, { title: `FN2 cross ${label}`, ...body });
      failed(res, 400, "folder_cross_space");
      expect(messageOf(res), label).toBe(CROSS_SPACE);
      expect(await countTitled(pool, `FN2 cross ${label}`), label).toBe(0);
    }

    const hidden = failed(await post(app, s.member.id, { groupId: G, folderId: XF }), 404, "folder_not_found");
    expect(failed(await post(app, s.member.id, { groupId: G, folderId: RANDOM_UUID }), 404, "folder_not_found")).toBe(hidden);
    expect(failed(await post(app, s.member.id, { folderId: XF }), 404, "folder_not_found")).toBe(hidden);
    expect(messageOf(await post(app, s.member.id, { groupId: G, folderId: XF }))).toBe(FOLDER_NOT_FOUND);
    // Visibility is judged before the group criterion: a non-member -> folder_not_found (not group_not_found); readOnly can't see H's folder -> 404 (not 403)
    expect(failed(await post(app, s.outsider.id, { groupId: G, folderId: GF }), 404, "folder_not_found")).toBe(hidden);
    expect(failed(await post(app, s.readOnly.id, { groupId: G, folderId: HF }), 404, "folder_not_found")).toBe(hidden);

    const co = await createOnlyMember(db, G);
    const coRoot = okDto(await post(app, co.id, { title: "FN2 co root", groupId: G }), 201);
    expect(coRoot.folderId).toBeNull();
    const denied = await post(app, co.id, { title: "FN2 co folder", groupId: G, folderId: GF });
    failed(denied, 403, "forbidden");
    expect(messageOf(denied)).toBe(ROLE_FORBIDDEN);
    expect(await countTitled(pool, "FN2 co folder")).toBe(0);
    // Can edit but can't create (editOnly): the existing criterion blocks first -> the existing 403 sentence
    const eo = await post(app, s.editOnly.id, { groupId: G, folderId: GF });
    failed(eo, 403, "forbidden");
    expect(messageOf(eo)).toBe("Your role in this group can't create notes.");
  });

  it("vanishing and non-UUID: group transferred inside the test hook -> 404 folder_not_found; folder moved to another space -> 404; personal folder deleted before the INSERT -> 404; 'x' and a random uuid byte-for-byte identical", async () => {
    const seam = armedHook();
    const createHooks: NoteCreateHooks = {};
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook, noteCreateHooks: createHooks });
    const pool = db.$client;

    // The group is transferred after the membership check
    const s = await sixRoleScene(db);
    const GF = (await seedFolder(db, { group: s.groupId })).id;
    seam.arm("membership-checked", () => transferGroup(app, s.groupId, s.admin.id));
    const gone = await post(app, s.member.id, { title: "FN3 transferred", groupId: s.groupId, folderId: GF });
    failed(gone, 404, "folder_not_found");
    expect(messageOf(gone)).toBe(FOLDER_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await countTitled(pool, "FN3 transferred")).toBe(0);

    // The folder moves to another space after the membership check (equivalent to a transfer moving the group folder into the recipient's personal space; the group row remains) -> trigger KF001
    const s2 = await sixRoleScene(db);
    const GF2 = (await seedFolder(db, { group: s2.groupId })).id;
    seam.arm("membership-checked", async () => {
      await pool.query("update folders set kind = 'personal', owner_id = $2, group_id = null where id = $1", [GF2, s2.admin.id]);
    });
    const kf = await post(app, s2.member.id, { title: "FN3 kf001", groupId: s2.groupId, folderId: GF2 });
    failed(kf, 404, "folder_not_found");
    expect(messageOf(kf)).toBe(FOLDER_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await countTitled(pool, "FN3 kf001")).toBe(0);

    // Personal: the folder is deleted before the INSERT (beforeInsert test hook, which is only called when a title is given) -> notes_folder_fk 23503
    const u = await seedUser(db);
    const doomed = (await seedFolder(db, { personal: u.id })).id;
    let fired = 0;
    createHooks.beforeInsert = async () => {
      if (fired++ === 0) await pool.query("delete from folders where id = $1", [doomed]);
    };
    const fk = await post(app, u.id, { title: "FN3 personal", folderId: doomed });
    delete createHooks.beforeInsert;
    failed(fk, 404, "folder_not_found");
    expect(messageOf(fk)).toBe(FOLDER_NOT_FOUND);
    expect(fired).toBe(1);
    expect(await countTitled(pool, "FN3 personal")).toBe(0);

    const viaX = failed(await post(app, u.id, { folderId: "x" }), 404, "folder_not_found");
    expect(failed(await post(app, u.id, { folderId: RANDOM_UUID }), 404, "folder_not_found")).toBe(viaX);
    expect(await notesOwnedBy(pool, u.id)).toBe(0);
  });
});

describe("POST /api/notes/:id/copy with folderId", () => {
  it("to own folder, 'make a copy' (personal and group in the same folder) -> 201, copy's folderId correct; consistency errors 400; invisible 404; create-only to a group folder 403", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const F1 = (await seedFolder(db, { personal: u.id })).id;
    const F2 = (await seedFolder(db, { personal: u.id })).id;
    const n = await noteIn(db, pool, { ownerId: u.id }, F1, { title: "FN4 src" });

    const toF2 = okDto(await copy(app, u.id, n, { folderId: F2 }), 201);
    expect(toF2.folderId).toBe(F2);
    expect(toF2.id).not.toBe(n);
    expect((await noteFolderCols(pool, toF2.id))?.folder_id).toBe(F2);
    expect((await noteFolderCols(pool, n))?.folder_id).toBe(F1);

    const dup = okDto(await copy(app, u.id, n, { folderId: F1.toUpperCase() }), 201);
    expect(dup.folderId).toBe(F1);
    expect((await noteFolderCols(pool, dup.id))?.folder_id).toBe(F1);

    const plain = okDto(await copy(app, u.id, n, {}), 201);
    expect(plain.folderId).toBeNull();
    expect((await noteFolderCols(pool, plain.id))?.folder_id).toBeNull();

    const s = await sixRoleScene(db);
    const G = s.groupId;
    const GF = (await seedFolder(db, { group: G })).id;
    const gn = await noteIn(db, pool, { groupId: G }, GF, { title: "FN4 gsrc" });
    const gdup = okDto(await copy(app, s.member.id, gn, { groupId: G, folderId: GF }), 201);
    expect(gdup.folderId).toBe(GF);
    expect(gdup.groupId).toBe(G);
    expect((await noteFolderCols(pool, gdup.id))?.folder_id).toBe(GF);

    const H = (await seedGroup(db, "H", [{ userId: s.member.id, role: "member" }])).id;
    const HF = (await seedFolder(db, { group: H })).id;
    const SF = (await seedFolder(db, { shared: s.member.id })).id;
    const PF = (await seedFolder(db, { personal: s.member.id })).id;
    const xAdmin = await seedUser(db);
    const XF = (await seedFolder(db, { group: (await seedGroup(db, "X", [{ userId: xAdmin.id, role: "admin" }])).id })).id;
    const before = await countTitled(pool, "FN4 gsrc");
    const crossCases: Array<[string, Record<string, string>]> = [
      ["群組資料夾、沒給 groupId", { folderId: GF }],
      ["groupId 是另一個我在的群組", { groupId: H, folderId: GF }],
      ["另一個我在的群組的資料夾", { groupId: G, folderId: HF }],
      ["共享私人資料夾", { folderId: SF }],
      ["個人資料夾＋groupId", { groupId: G, folderId: PF }],
    ];
    for (const [label, body] of crossCases) {
      const res = await copy(app, s.member.id, gn, body);
      failed(res, 400, "folder_cross_space");
      expect(messageOf(res), label).toBe(CROSS_SPACE);
    }
    const hidden = failed(await copy(app, s.member.id, gn, { groupId: G, folderId: XF }), 404, "folder_not_found");
    expect(failed(await copy(app, s.member.id, gn, { groupId: G, folderId: RANDOM_UUID }), 404, "folder_not_found")).toBe(hidden);
    expect(failed(await copy(app, s.member.id, gn, { groupId: G, folderId: "x" }), 404, "folder_not_found")).toBe(hidden);
    expect(messageOf(await copy(app, s.member.id, gn, { groupId: G, folderId: XF }))).toBe(FOLDER_NOT_FOUND);
    // Visibility is judged before the group criterion: readOnly (no can_create) can't see H's folder -> 404 folder_not_found (not group_not_found)
    expect(failed(await copy(app, s.readOnly.id, gn, { groupId: G, folderId: HF }), 404, "folder_not_found")).toBe(hidden);

    const co = await createOnlyMember(db, G);
    const denied = await copy(app, co.id, gn, { groupId: G, folderId: GF });
    failed(denied, 403, "forbidden");
    expect(messageOf(denied)).toBe(ROLE_FORBIDDEN);
    expect(await countTitled(pool, "FN4 gsrc")).toBe(before);
    expect(okDto(await copy(app, co.id, gn, { groupId: G }), 201).folderId).toBeNull();
  });

  it("copy lock order: group target groups KS -> folder KS -> source KS; personal target folder KS -> source KS", async () => {
    const { db, pool } = await freshDb();
    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    const run = async (input: { sourceId: string; userId: string; scope: { groupId: string } | { ownerId: string }; folderId: string }) => {
      queries.length = 0;
      const doc = cloneForCopy(new Y.Doc());
      const out = await logged.transaction(tx => copyNoteInTx(tx, {
        ...input, copy: doc, uploadsDir: tmpdir(), prepared: [], searchExtract: extractForIndex(doc.doc), knowledgeExtract: extractKnowledgeForIndex(doc.doc), lockTimeoutMs: 5000,
      }));
      const all = queries.filter(q => !TXN_CONTROL.test(q.trim())).filter(q => ROW_LOCK.test(q.trim()));
      // Up to reading the source (the first notes row lock); what follows are the locks the full-text index and the knowledge index take on the new copy (`replaceNoteSearchIndexInTx`, `replaceNoteKnowledgeIndexInTx`), outside this lock order.
      const locks = all.slice(0, all.findIndex(q => / from "notes" /.test(q)) + 1);
      return { out, locks };
    };

    const a = await seedUser(db);
    const G = (await seedGroup(db, "G", [{ userId: a.id, role: "admin" }])).id;
    const GF = (await seedFolder(db, { group: G })).id;
    const gn = await noteIn(db, pool, { groupId: G }, GF);
    const g = await run({ sourceId: gn, userId: a.id, scope: { groupId: G }, folderId: GF });
    expect(g.locks).toHaveLength(3);
    expect(g.locks[0]).toMatch(/ from "groups" .*for key share$/);
    expect(g.locks[1]).toMatch(/ from "folders" .*for key share$/);
    expect(g.locks[2]).toMatch(/ from "notes" .*for key share$/);
    expect(g.out.note.folderId).toBe(GF);

    const F = (await seedFolder(db, { personal: a.id })).id;
    const pn = await noteIn(db, pool, { ownerId: a.id }, F);
    const p = await run({ sourceId: pn, userId: a.id, scope: { ownerId: a.id }, folderId: F });
    expect(p.locks).toHaveLength(2);
    expect(p.locks[0]).toMatch(/ from "folders" .*for key share$/);
    expect(p.locks[1]).toMatch(/ from "notes" .*for key share$/);
    expect(p.out.note.folderId).toBe(F);
  });

  it("copy vanishing: target folder deleted in the test hook -> 404 folder_not_found; target group transferred in the test hook -> 404 folder_not_found (not group_not_found); downgraded to create-only in the test hook -> 403 (inside the transaction)", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;

    const u = await seedUser(db);
    const F = (await seedFolder(db, { personal: u.id })).id;
    const n = await noteIn(db, pool, { ownerId: u.id }, null);
    seam.arm("note-copy-authorized", async () => {
      await pool.query("delete from folders where id = $1", [F]);
    });
    const deleted = await copy(app, u.id, n, { folderId: F });
    failed(deleted, 404, "folder_not_found");
    expect(messageOf(deleted)).toBe(FOLDER_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await notesOwnedBy(pool, u.id)).toBe(1);

    const s = await sixRoleScene(db);
    const GF = (await seedFolder(db, { group: s.groupId })).id;
    const gn = await noteIn(db, pool, { groupId: s.groupId }, null, { title: "FN6 gsrc" });
    seam.arm("note-copy-authorized", () => transferGroup(app, s.groupId, s.admin.id));
    const transferred = await copy(app, s.member.id, gn, { groupId: s.groupId, folderId: GF });
    failed(transferred, 404, "folder_not_found");
    expect(messageOf(transferred)).toBe(FOLDER_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await countTitled(pool, "FN6 gsrc")).toBe(1);

    const s2 = await sixRoleScene(db);
    const GF2 = (await seedFolder(db, { group: s2.groupId })).id;
    const gn2 = await noteIn(db, pool, { groupId: s2.groupId }, null, { title: "FN6 gsrc2" });
    const coRole = await seedRole(db, s2.groupId, "co-late", { canRead: true, canCreate: true });
    seam.arm("note-copy-authorized", () => setRole(pool, s2.groupId, s2.member.id, coRole));
    const demoted = await copy(app, s2.member.id, gn2, { groupId: s2.groupId, folderId: GF2 });
    failed(demoted, 403, "forbidden");
    expect(messageOf(demoted)).toBe(ROLE_FORBIDDEN);
    expect(seam.pending).toBe(false);
    expect(await countTitled(pool, "FN6 gsrc2")).toBe(1);
  });
});

describe("POST /api/notes/:id/move with folderId", () => {
  it("move into a group folder: 200, folderId, shares/public/versions cleared, updated_at unchanged; without folderId -> root; consistency 400; invisible 404; create-only 403", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const o = await seedUser(db);
    const c = await seedUser(db);
    const G = (await seedGroup(db, "G", [{ userId: o.id, role: "member" }])).id;
    const FG = (await seedFolder(db, { group: G })).id;
    const FO = (await seedFolder(db, { personal: o.id })).id;

    const n = await noteIn(db, pool, { ownerId: o.id }, FO, { publicToken: "t".repeat(43), publicSlug: `alias-${o.id.slice(0, 8)}` });
    await seedShare(db, n, c.id, "editor");
    await pool.query("insert into note_versions (note_id, seq, ydoc, kind) values ($1, 1, decode('00', 'hex'), 'auto')", [n]);
    await pool.query("update notes set updated_at = now() - interval '2 hours' where id = $1", [n]);
    const before = await noteState(pool, n);

    const moved = okDto(await move(app, o.id, n, { groupId: G, folderId: FG.toUpperCase() }), 200);
    expect(moved.folderId).toBe(FG);
    expect(moved.groupId).toBe(G);
    const after = await noteState(pool, n);
    expect(after).toMatchObject({ owner_id: null, group_id: G, public_token: null, public_slug: null, updated_at: before.updated_at });
    expect((await noteFolderCols(pool, n))?.folder_id).toBe(FG);
    expect(await sharesOf(db, n)).toEqual([]);
    expect((await pool.query("select count(*)::int as n from note_versions where note_id = $1", [n])).rows[0].n).toBe(0);

    // Without folderId: group root (the note was in a personal folder)
    const n2 = await noteIn(db, pool, { ownerId: o.id }, FO);
    expect(okDto(await move(app, o.id, n2, { groupId: G }), 200).folderId).toBeNull();
    expect((await noteFolderCols(pool, n2))?.folder_id).toBeNull();

    const H = (await seedGroup(db, "H", [{ userId: o.id, role: "member" }])).id;
    const HF = (await seedFolder(db, { group: H })).id;
    const SF = (await seedFolder(db, { shared: o.id })).id;
    const xAdmin = await seedUser(db);
    const XF = (await seedFolder(db, { group: (await seedGroup(db, "X", [{ userId: xAdmin.id, role: "admin" }])).id })).id;
    const n3 = await noteIn(db, pool, { ownerId: o.id }, FO);
    for (const [label, folderId] of [["別的群組", HF], ["自己的個人資料夾", FO], ["共享私人資料夾", SF]] as const) {
      const res = await move(app, o.id, n3, { groupId: G, folderId });
      failed(res, 400, "folder_cross_space");
      expect(messageOf(res), label).toBe(CROSS_SPACE);
    }
    const hidden = failed(await move(app, o.id, n3, { groupId: G, folderId: XF }), 404, "folder_not_found");
    expect(failed(await move(app, o.id, n3, { groupId: G, folderId: RANDOM_UUID }), 404, "folder_not_found")).toBe(hidden);
    expect(failed(await move(app, o.id, n3, { groupId: G, folderId: "x" }), 404, "folder_not_found")).toBe(hidden);
    expect(messageOf(await move(app, o.id, n3, { groupId: G, folderId: XF }))).toBe(FOLDER_NOT_FOUND);
    // Visibility is judged before the group criterion: a group the user isn't a member of + its folder -> folder_not_found (not the in-transaction group_not_found)
    const X = (await seedGroup(db, "X2", [{ userId: xAdmin.id, role: "admin" }])).id;
    const X2F = (await seedFolder(db, { group: X })).id;
    expect(failed(await move(app, o.id, n3, { groupId: X, folderId: X2F }), 404, "folder_not_found")).toBe(hidden);
    expect(await noteState(pool, n3)).toMatchObject({ owner_id: o.id, group_id: null });
    expect((await noteFolderCols(pool, n3))?.folder_id).toBe(FO);

    // create-only (judged inside the transaction): group folder 403, nothing changed; group root still 200
    const C = (await seedGroup(db, "C", [{ userId: xAdmin.id, role: "admin" }])).id;
    const CF = (await seedFolder(db, { group: C })).id;
    const coRole = await seedRole(db, C, "co", { canRead: true, canCreate: true });
    await db.insert(groupMembers).values({ groupId: C, userId: o.id, roleId: coRole });
    const n4 = await noteIn(db, pool, { ownerId: o.id }, FO);
    await seedShare(db, n4, c.id, "viewer");
    const denied = await move(app, o.id, n4, { groupId: C, folderId: CF });
    failed(denied, 403, "forbidden");
    expect(messageOf(denied)).toBe(ROLE_FORBIDDEN);
    expect(await noteState(pool, n4)).toMatchObject({ owner_id: o.id, group_id: null });
    expect((await noteFolderCols(pool, n4))?.folder_id).toBe(FO);
    expect(await sharesOf(db, n4)).toHaveLength(1);
    expect(okDto(await move(app, o.id, n4, { groupId: C }), 200).folderId).toBeNull();
  });

  it("move vanishing: FG deleted in the test hook -> 404 folder_not_found; target group transferred in the test hook -> 404 folder_not_found with folderId, 404 group_not_found without", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;

    const o = await seedUser(db);
    const admin = await seedUser(db);
    const G = (await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: o.id, role: "member" }])).id;
    const FG = (await seedFolder(db, { group: G })).id;
    const n = await noteIn(db, pool, { ownerId: o.id }, null);
    seam.arm("note-move-authorized", async () => {
      await pool.query("delete from folders where id = $1", [FG]);
    });
    const deleted = await move(app, o.id, n, { groupId: G, folderId: FG });
    failed(deleted, 404, "folder_not_found");
    expect(messageOf(deleted)).toBe(FOLDER_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await noteState(pool, n)).toMatchObject({ owner_id: o.id, group_id: null });

    const FG2 = (await seedFolder(db, { group: G })).id;
    seam.arm("note-move-authorized", () => transferGroup(app, G, admin.id));
    const transferred = await move(app, o.id, n, { groupId: G, folderId: FG2 });
    failed(transferred, 404, "folder_not_found");
    expect(messageOf(transferred)).toBe(FOLDER_NOT_FOUND);
    expect(seam.pending).toBe(false);
    expect(await noteState(pool, n)).toMatchObject({ owner_id: o.id, group_id: null });

    // Control: the same test hook transfer without folderId -> group_not_found as before
    const K = (await seedGroup(db, "K", [{ userId: admin.id, role: "admin" }, { userId: o.id, role: "member" }])).id;
    seam.arm("note-move-authorized", () => transferGroup(app, K, admin.id));
    const plain = await move(app, o.id, n, { groupId: K });
    failed(plain, 404, "group_not_found");
    expect(seam.pending).toBe(false);
    expect(await noteState(pool, n)).toMatchObject({ owner_id: o.id, group_id: null });
  });

  it("move-in lock order literally: note FOR UPDATE -> groups KS -> folder KS, with the folder KS before the note-move-locked test hook", async () => {
    const { db, pool } = await freshDb();
    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    const o = await seedUser(db);
    const G = (await seedGroup(db, "G", [{ userId: o.id, role: "member" }])).id;
    const FG = (await seedFolder(db, { group: G })).id;
    const n = await noteIn(db, pool, { ownerId: o.id }, null);

    let atHook = -1;
    const hook = async (point: GroupRacePoint) => {
      if (point === "note-move-locked") atHook = queries.length;
    };
    await logged.transaction(tx => moveNoteToGroupInTx(tx, { noteId: n, userId: o.id, userHandle: o.handle, groupId: G, folderId: FG, lockTimeoutMs: 5000 }, hook));
    const stmts = queries.filter(q => !TXN_CONTROL.test(q.trim()));
    const locks = stmts.filter(q => ROW_LOCK.test(q.trim()));
    expect(locks).toHaveLength(3);
    expect(locks[0]).toMatch(/ from "notes" .*for update$/);
    expect(locks[1]).toMatch(/ from "groups" .*for key share$/);
    expect(locks[2]).toMatch(/ from "folders" .*for key share$/);
    const folderLockAt = queries.findIndex(q => / from "folders" .*for key share$/.test(q.trim()));
    expect(atHook).toBeGreaterThan(0);
    expect(folderLockAt).toBeGreaterThanOrEqual(0);
    expect(folderLockAt).toBeLessThan(atHook);
    expect((await noteFolderCols(pool, n))?.folder_id).toBe(FG);
  });
});
