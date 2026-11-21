import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { desc } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { NoteDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { notes } from "../src/db/schema.js";
import { visibleNoteBranches } from "../src/notes/list-query.js";
import { noteSizeBytesSql } from "../src/notes/note-dto.js";
import { seedFolder, seedPlacement, setNoteFolder, setSnapshot } from "./folder-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedAttachment } from "./storage-helpers.js";
import { markTrashed } from "./trash-helpers.js";

/** The existing 14 keys (the set from `notes.test.ts`). */
const BASE_KEYS = [
  "createdAt", "group", "groupId", "id", "lastEdited", "ownerHandle", "ownerId", "permissions", "prevSlug", "role", "slug", "slugIsCustom", "title", "updatedAt",
];
const SINGLE_KEYS = [...BASE_KEYS, "folderId"].sort();
const LIST_KEYS = [...BASE_KEYS, "folderId", "sizeBytes", "tags"].sort();

const req = async (
  app: FastifyInstance, method: "GET" | "POST" | "PATCH", url: string, userId: string, payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, cookies: await cookieOf(userId), ...(payload !== undefined ? { payload } : {}) });

const ok = (res: LightMyRequestResponse, code = 200): NoteDto => {
  expect(res.statusCode, res.body).toBe(code);
  expect(res.body).not.toMatch(/trash_folder_path|trashFolderPath/);
  return res.json() as NoteDto;
};

async function listOf(app: FastifyInstance, userId: string): Promise<Map<string, NoteDto>> {
  const res = await req(app, "GET", "/api/notes", userId);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.body).not.toMatch(/trash_folder_path|trashFolderPath/);
  return new Map((res.json() as NoteDto[]).map(n => [n.id, n]));
}

/**
 * O's personal note N is in O's folder FO, shared with S (editor, put in S's own shared folder FS), E (editor, no placement) and V (viewer, no placement);
 * group G (O and M are members) has note GN in group folder FG; O's root-level note R (bystander). N carries non-empty trash snapshot columns (visible if leaked).
 */
async function scene(db: Db) {
  const [o, s, e, v, m] = await Promise.all(Array.from({ length: 5 }, () => seedUser(db)));
  const g = await seedGroup(db, "Team", [{ userId: o.id, role: "admin" }, { userId: m.id, role: "member" }]);
  const n = await seedNote(db, { ownerId: o.id }, { title: "N" });
  const r = await seedNote(db, { ownerId: o.id }, { title: "R" });
  const gn = await seedNote(db, { groupId: g.id }, { title: "GN" });
  const fo = await seedFolder(db, { personal: o.id });
  const fs = await seedFolder(db, { shared: s.id });
  const fg = await seedFolder(db, { group: g.id });
  const pool = db.$client;
  await setNoteFolder(pool, n.id, fo.id);
  await setNoteFolder(pool, gn.id, fg.id);
  await setSnapshot(pool, n.id, ["Leak"]);
  await seedShare(db, n.id, s.id, "editor");
  await seedShare(db, n.id, e.id, "editor");
  await seedShare(db, n.id, v.id, "viewer");
  await seedPlacement(pool, s.id, n.id, fs.id);
  return { o, s, e, v, m, g, n, r, gn, FO: fo.id, FS: fs.id, FG: fg.id };
}

describe("folders: NoteDto.folderId (caller's perspective)", () => {
  it("list: O sees N = FO, R = null; S sees N = own placement FS; V sees N = null; M sees GN = FG", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    const ofO = await listOf(app, c.o.id);
    expect(ofO.get(c.n.id)?.folderId).toBe(c.FO);
    expect(ofO.get(c.r.id)?.folderId).toBeNull();
    expect(ofO.get(c.gn.id)?.folderId).toBe(c.FG);
    expect((await listOf(app, c.s.id)).get(c.n.id)?.folderId).toBe(c.FS);
    expect((await listOf(app, c.e.id)).get(c.n.id)?.folderId).toBeNull();
    expect((await listOf(app, c.v.id)).get(c.n.id)?.folderId).toBeNull();
    expect((await listOf(app, c.m.id)).get(c.gn.id)?.folderId).toBe(c.FG);
  });

  it(":ref: O -> FO, S -> FS, V -> null, M sees GN -> FG; O sees R -> null", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    expect(ok(await req(app, "GET", `/api/notes/${c.n.id}`, c.o.id)).folderId).toBe(c.FO);
    expect(ok(await req(app, "GET", `/api/notes/${c.n.id}`, c.s.id)).folderId).toBe(c.FS);
    expect(ok(await req(app, "GET", `/api/notes/${c.n.id}`, c.v.id)).folderId).toBeNull();
    expect(ok(await req(app, "GET", `/api/notes/${c.gn.id}`, c.m.id)).folderId).toBe(c.FG);
    expect(ok(await req(app, "GET", `/api/notes/${c.r.id}`, c.o.id)).folderId).toBeNull();
  });

  it("by-path: S -> FS, V -> null, O -> FO; by-group-path: M -> FG", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    const path = `/api/notes/by-path/${c.o.handle}/${c.n.slug}`;
    expect(ok(await req(app, "GET", path, c.s.id)).folderId).toBe(c.FS);
    expect(ok(await req(app, "GET", path, c.v.id)).folderId).toBeNull();
    expect(ok(await req(app, "GET", path, c.o.id)).folderId).toBe(c.FO);
    expect(ok(await req(app, "GET", `/api/notes/by-group-path/${c.g.id}/${c.gn.slug}`, c.m.id)).folderId).toBe(c.FG);
  });

  it("PATCH: S changing N's title -> FS (not FO); E (no placement) -> null; O -> FO; M changing GN -> FG", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.s.id, { title: "by S" })).folderId).toBe(c.FS);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.e.id, { title: "by E" })).folderId).toBeNull();
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.o.id, { title: "by O" })).folderId).toBe(c.FO);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.o.id, { slug: "n-custom" })).folderId).toBe(c.FO);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.o.id, { slug: null })).folderId).toBe(c.FO);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.gn.id}`, c.m.id, { title: "by M" })).folderId).toBe(c.FG);
  });

  it("move response: O moves a personal note in FO into G -> folderId null (trigger self-heals)", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    const p = await seedNote(db, { ownerId: c.o.id }, { title: "P" });
    await setNoteFolder(db.$client, p.id, c.FO);
    const dto = ok(await req(app, "POST", `/api/notes/${p.id}/move`, c.o.id, { groupId: c.g.id }));
    expect(dto).toMatchObject({ id: p.id, groupId: c.g.id, folderId: null });
  });

  it("POST bare create/copy (personal, group) response: folderId null", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    expect(ok(await req(app, "POST", "/api/notes", c.o.id, {}), 201).folderId).toBeNull();
    expect(ok(await req(app, "POST", "/api/notes", c.o.id, { title: "G1", groupId: c.g.id }), 201).folderId).toBeNull();
    expect(ok(await req(app, "POST", `/api/notes/${c.n.id}/copy`, c.o.id, {}), 201).folderId).toBeNull();
    expect(ok(await req(app, "POST", `/api/notes/${c.n.id}/copy`, c.o.id, { groupId: c.g.id }), 201).folderId).toBeNull();
  });

  it("POST with content response: folderId null, key set = existing + folderId", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const dto = ok(await req(ctx.app, "POST", "/api/notes", u.id, { title: "C", content: "hi" }), 201);
    expect(dto.folderId).toBeNull();
    expect(Object.keys(dto).sort()).toEqual(SINGLE_KEYS);
  });

  it("restore response: O's N moved to the trash -> restore -> restored[0].folderId = FO", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    await markTrashed(db.$client, c.n.id, c.o.id);
    const res = await req(app, "POST", "/api/trash/restore", c.o.id, { ids: [c.n.id] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toMatch(/trash_folder_path|trashFolderPath/);
    const body = res.json() as { restored: NoteDto[] };
    expect(body.restored.map(x => x.id)).toEqual([c.n.id]);
    expect(body.restored[0]!.folderId).toBe(c.FO);
  });

  it("key sets: list = existing + folderId + sizeBytes + tags; :ref/PATCH/POST/by-path = existing + folderId; none contains the trash snapshot columns", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    for (const dto of (await listOf(app, c.s.id)).values()) expect(Object.keys(dto).sort()).toEqual(LIST_KEYS);
    for (const dto of (await listOf(app, c.o.id)).values()) expect(Object.keys(dto).sort()).toEqual(LIST_KEYS);
    for (const dto of (await listOf(app, c.m.id)).values()) expect(Object.keys(dto).sort()).toEqual(LIST_KEYS);
    expect(Object.keys(ok(await req(app, "GET", `/api/notes/${c.n.id}`, c.o.id))).sort()).toEqual(SINGLE_KEYS);
    expect(Object.keys(ok(await req(app, "GET", `/api/notes/by-path/${c.o.handle}/${c.n.slug}`, c.s.id))).sort()).toEqual(SINGLE_KEYS);
    expect(Object.keys(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.s.id, { title: "k" }))).sort()).toEqual(SINGLE_KEYS);
    expect(Object.keys(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.o.id, { title: "k2" }))).sort()).toEqual(SINGLE_KEYS);
    expect(Object.keys(ok(await req(app, "POST", "/api/notes", c.o.id, {}), 201)).sort()).toEqual(SINGLE_KEYS);
    expect(Object.keys(ok(await req(app, "POST", `/api/notes/${c.n.id}/copy`, c.o.id, {}), 201)).sort()).toEqual(SINGLE_KEYS);
  });
});

describe("folders: sizeBytes", () => {
  it("body 123 bytes + attachments 10 and 20 -> 153; R -> 0; S viewing N also gets 153; the outer SQL column carries the table name", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const c = await scene(db);
    await db.$client.query("insert into note_states (note_id, ydoc) values ($1, decode(repeat('00', 123), 'hex'))", [c.n.id]);
    await seedAttachment(db, uploadsDir, c.n.id, c.o.id, 10, { noFile: true });
    await seedAttachment(db, uploadsDir, c.n.id, c.o.id, 20, { noFile: true });
    // Bystanders: other notes' state and attachments don't count toward N.
    await db.$client.query("insert into note_states (note_id, ydoc) values ($1, decode(repeat('00', 7), 'hex'))", [c.gn.id]);
    await seedAttachment(db, uploadsDir, c.gn.id, c.m.id, 1000, { noFile: true });
    const ofO = await listOf(app, c.o.id);
    expect(ofO.get(c.n.id)?.sizeBytes).toBe(153);
    expect(ofO.get(c.r.id)?.sizeBytes).toBe(0);
    expect(ofO.get(c.gn.id)?.sizeBytes).toBe(1007);
    expect((await listOf(app, c.s.id)).get(c.n.id)?.sizeBytes).toBe(153);
    expect((await listOf(app, c.m.id)).get(c.gn.id)?.sizeBytes).toBe(1007);
    const b = visibleNoteBranches(db, c.o.id, { extra: { sizeBytes: noteSizeBytesSql() } });
    for (const q of [b.owned, b.shared, b.grouped]) {
      const text = q.toSQL().sql;
      expect(text).toContain(`s.note_id = "notes"."id"`);
      expect(text).toContain(`u.note_id = "notes"."id"`);
    }
    // Single-table select: the literal outer column must not degrade to `${notes.id}` (it would render as a bare "id" and resolve to u.id inside uploads u).
    const single = db.select({ x: noteSizeBytesSql() }).from(notes).toSQL().sql;
    expect(single).toContain(`s.note_id = "notes"."id"`);
    expect(single).toContain(`u.note_id = "notes"."id"`);
  });

  it("measurement (no threshold asserted): 2000 notes + note_states, median of three GET /api/notes; compared with and without sizeBytes at the query layer", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await db.$client.query(
      `with n as (
         insert into notes (owner_id, title, slug) select $1::uuid, 'B' || g, 'bulk-' || g from generate_series(1, 2000) g returning id
       ) insert into note_states (note_id, ydoc) select id, decode(repeat('00', 200), 'hex') from n`,
      [u.id],
    );
    await db.$client.query("analyze notes; analyze note_states; analyze uploads");
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const http: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const res = await req(app, "GET", "/api/notes", u.id);
      http.push(performance.now() - t0);
      expect(res.json()).toHaveLength(2000);
    }
    const timeQuery = async (withSize: boolean): Promise<number> => {
      const xs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const b = visibleNoteBranches(db, u.id, withSize ? { extra: { sizeBytes: noteSizeBytesSql() } } : {});
        const t0 = performance.now();
        await unionAll(b.owned, b.shared, b.grouped).orderBy(desc(notes.updatedAt), desc(notes.id));
        xs.push(performance.now() - t0);
      }
      return median(xs);
    };
    const plain = await timeQuery(false);
    const sized = await timeQuery(true);
    console.log(`[DTO-10] 2000 notes: GET /api/notes median ${median(http).toFixed(1)} ms (runs ${http.map(x => x.toFixed(1)).join(", ")}); query median without sizeBytes ${plain.toFixed(1)} ms, with sizeBytes ${sized.toFixed(1)} ms`);
  });
});
