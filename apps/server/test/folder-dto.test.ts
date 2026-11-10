/**
 * 資料夾：`NoteDto.folderId`（呼叫者視角）與 `sizeBytes`（只有 `GET /api/notes`）。
 * 資料夾還沒有寫入 API——位置一律以 helper 直寫 `notes.folder_id`／`note_placements`。
 */
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

/** 既有的 14 鍵（`notes.test.ts` 的那組）。 */
const BASE_KEYS = [
  "createdAt", "group", "groupId", "id", "lastEdited", "ownerHandle", "ownerId", "permissions", "prevSlug", "role", "slug", "slugIsCustom", "title", "updatedAt",
];
const SINGLE_KEYS = [...BASE_KEYS, "folderId"].sort();
const LIST_KEYS = [...BASE_KEYS, "folderId", "sizeBytes"].sort();

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
 * O 的個人筆記 N 在 O 的資料夾 FO，分享給 S（editor，放進自己的 shared 資料夾 FS）、E（editor，無放置）、V（viewer，無放置）；
 * 群組 G（O、M 為成員）的筆記 GN 在群組資料夾 FG；O 的根層筆記 R（旁觀者）。N 帶非空的垃圾桶快照欄（洩漏時看得到）。
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

describe("資料夾：NoteDto.folderId（呼叫者視角）", () => {
  it("DTO-1 清單：O 看 N＝FO、R＝null；S 看 N＝自己的放置 FS；V 看 N＝null；M 看 GN＝FG", async () => {
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

  it("DTO-2 :ref：O→FO、S→FS、V→null、M 看 GN→FG；O 看 R→null", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    expect(ok(await req(app, "GET", `/api/notes/${c.n.id}`, c.o.id)).folderId).toBe(c.FO);
    expect(ok(await req(app, "GET", `/api/notes/${c.n.id}`, c.s.id)).folderId).toBe(c.FS);
    expect(ok(await req(app, "GET", `/api/notes/${c.n.id}`, c.v.id)).folderId).toBeNull();
    expect(ok(await req(app, "GET", `/api/notes/${c.gn.id}`, c.m.id)).folderId).toBe(c.FG);
    expect(ok(await req(app, "GET", `/api/notes/${c.r.id}`, c.o.id)).folderId).toBeNull();
  });

  it("DTO-3 by-path：S→FS、V→null、O→FO；by-group-path：M→FG", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    const path = `/api/notes/by-path/${c.o.handle}/${c.n.slug}`;
    expect(ok(await req(app, "GET", path, c.s.id)).folderId).toBe(c.FS);
    expect(ok(await req(app, "GET", path, c.v.id)).folderId).toBeNull();
    expect(ok(await req(app, "GET", path, c.o.id)).folderId).toBe(c.FO);
    expect(ok(await req(app, "GET", `/api/notes/by-group-path/${c.g.id}/${c.gn.slug}`, c.m.id)).folderId).toBe(c.FG);
  });

  it("DTO-4 PATCH：S 改 N 的標題 → FS（不是 FO）；E（無放置）→ null；O → FO；M 改 GN → FG", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.s.id, { title: "by S" })).folderId).toBe(c.FS);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.e.id, { title: "by E" })).folderId).toBeNull();
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.o.id, { title: "by O" })).folderId).toBe(c.FO);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.o.id, { slug: "n-custom" })).folderId).toBe(c.FO);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.n.id}`, c.o.id, { slug: null })).folderId).toBe(c.FO);
    expect(ok(await req(app, "PATCH", `/api/notes/${c.gn.id}`, c.m.id, { title: "by M" })).folderId).toBe(c.FG);
  });

  it("DTO-5 move 回應：O 把在 FO 的個人筆記移入 G → folderId null（trigger 自癒）", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    const p = await seedNote(db, { ownerId: c.o.id }, { title: "P" });
    await setNoteFolder(db.$client, p.id, c.FO);
    const dto = ok(await req(app, "POST", `/api/notes/${p.id}/move`, c.o.id, { groupId: c.g.id }));
    expect(dto).toMatchObject({ id: p.id, groupId: c.g.id, folderId: null });
  });

  it("DTO-6 POST 裸建／copy（個人、群組）回應：folderId null", async () => {
    const { app, db } = await buildTestApp();
    const c = await scene(db);
    expect(ok(await req(app, "POST", "/api/notes", c.o.id, {}), 201).folderId).toBeNull();
    expect(ok(await req(app, "POST", "/api/notes", c.o.id, { title: "G1", groupId: c.g.id }), 201).folderId).toBeNull();
    expect(ok(await req(app, "POST", `/api/notes/${c.n.id}/copy`, c.o.id, {}), 201).folderId).toBeNull();
    expect(ok(await req(app, "POST", `/api/notes/${c.n.id}/copy`, c.o.id, { groupId: c.g.id }), 201).folderId).toBeNull();
  });

  it("DTO-6 POST 帶 content 回應：folderId null、鍵集合＝既有＋folderId", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const dto = ok(await req(ctx.app, "POST", "/api/notes", u.id, { title: "C", content: "hi" }), 201);
    expect(dto.folderId).toBeNull();
    expect(Object.keys(dto).sort()).toEqual(SINGLE_KEYS);
  });

  it("DTO-7 還原回應：O 的 N 移入垃圾桶 → restore → restored[0].folderId＝FO", async () => {
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

  it("DTO-8 欄位集合：清單＝既有＋folderId＋sizeBytes；:ref／PATCH／POST／by-path＝既有＋folderId；都不含垃圾桶快照欄", async () => {
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

describe("資料夾：sizeBytes", () => {
  it("DTO-9 內文 123 bytes＋附件 10、20 → 153；R → 0；S 看 N 也是 153；SQL 外層欄帶表名", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const c = await scene(db);
    await db.$client.query("insert into note_states (note_id, ydoc) values ($1, decode(repeat('00', 123), 'hex'))", [c.n.id]);
    await seedAttachment(db, uploadsDir, c.n.id, c.o.id, 10, { noFile: true });
    await seedAttachment(db, uploadsDir, c.n.id, c.o.id, 20, { noFile: true });
    // 旁觀者：別篇的狀態與附件不算進 N。
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
    // 單表 select：字面外層欄不能退化成 `${notes.id}`（會渲染成裸 "id"，在 uploads u 裡解析成 u.id）。
    const single = db.select({ x: noteSizeBytesSql() }).from(notes).toSQL().sql;
    expect(single).toContain(`s.note_id = "notes"."id"`);
    expect(single).toContain(`u.note_id = "notes"."id"`);
  });

  it("DTO-10 量測（不斷言門檻）：2000 篇＋note_states，GET /api/notes 三次中位數；查詢層有無 sizeBytes 對照", async () => {
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
