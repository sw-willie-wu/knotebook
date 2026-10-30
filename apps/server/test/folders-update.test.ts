/**
 * 資料夾 PR-3a T6：`PATCH /api/folders/:id`（spec §5.7.2 改名、§5.7.3 搬移〔只限同空間〕、§5.5 入口順序、A3-10 ①、A3-11）。
 * 控制字元與組合字元一律以 `String.fromCharCode` 組字（原始碼不放跳脫序列）。
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { FOLDER_DEPTH_MAX, type FolderDto } from "@knotebook/shared";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { folderRow, noteFolderCols, placementOf, seedFolder, seedFolderChain, seedPlacement, setNoteFolder, xminOf } from "./folder-helpers.js";
import { noteState, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";

// 預設空間鎖上限在本檔換成 60 s（產品值 5000），「注入的短上限有生效」的牆鐘界線才能離兩邊都遠——見 ./lock-timeout-bound.ts。
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const NUL = String.fromCharCode(0);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const E_ACUTE = String.fromCharCode(0xe9);
const CAP_E_ACUTE = String.fromCharCode(0xc9);
const RANDOM_UUID = "7d0c6a4e-1f2b-4c3d-9e8f-0a1b2c3d4e5f";
const FOLDER_KEYS = ["createdAt", "id", "name", "parentId", "permissions", "space"];
const NOT_MANAGER = "沒有管理這個資料夾的權限";

const patch = (app: FastifyInstance, userId: string | null, id: string, payload?: unknown) =>
  inject(app, "PATCH", `/api/folders/${id}`, userId, payload);

function ok(res: LightMyRequestResponse): FolderDto {
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as FolderDto;
}

/** 斷言狀態與錯誤碼；回 body 原文（逐位元組比對用）。 */
function failed(res: LightMyRequestResponse, status: number, code: string): string {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as { error: { code: string } }).error.code).toBe(code);
  return res.body;
}
const messageOf = (res: LightMyRequestResponse): string => (res.json() as { error: { message: string } }).error.message;

const parentOf = async (pool: Pool, id: string) => (await folderRow(pool, id))?.parent_id;
const nameOf = async (pool: Pool, id: string) => (await folderRow(pool, id))?.name;

/** 測試縫：`arm(point, fn)` 之後第一次經過 point 時跑 fn（只跑一次）。 */
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
  };
}

describe("PATCH /api/folders/:id", () => {
  it("FU-1 改名：200；只差大小寫照寫；NFC 等價不寫；同層撞名 409；名稱規則同 FC-5", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "Docs" });
    await seedFolder(db, { personal: u.id }, { name: "Other" });

    const renamed = ok(await patch(app, u.id, f.id, { name: "Renamed" }));
    expect(Object.keys(renamed).sort()).toEqual(FOLDER_KEYS);
    expect(renamed).toMatchObject({ id: f.id, name: "Renamed", parentId: null, space: { kind: "personal" }, permissions: { manage: true, deleteNotes: true, createNote: true } });
    expect(await nameOf(pool, f.id)).toBe("Renamed");
    expect(ok(await patch(app, u.id, f.id, { name: "renamed" })).name).toBe("renamed");
    expect(await nameOf(pool, f.id)).toBe("renamed");

    const e = await seedFolder(db, { personal: u.id }, { name: E_ACUTE });
    const x0 = await xminOf(pool, "folders", e.id);
    expect(ok(await patch(app, u.id, e.id, { name: `e${COMBINING_ACUTE}` })).name).toBe(E_ACUTE);
    expect(await xminOf(pool, "folders", e.id)).toBe(x0);
    expect(ok(await patch(app, u.id, e.id, { name: `E${COMBINING_ACUTE}` })).name).toBe(CAP_E_ACUTE);
    expect(await nameOf(pool, e.id)).toBe(CAP_E_ACUTE);

    const taken = await patch(app, u.id, f.id, { name: "other" });
    failed(taken, 409, "folder_name_taken");
    expect(messageOf(taken)).toBe("這裡已經有同名資料夾");
    const bad: Array<[string, string]> = [
      [`A${NUL}B`, "資料夾名稱含有無法儲存的字元"],
      ["A\nB", "名稱不能包含換行或控制字元"],
      ["a".repeat(81), "資料夾名稱須為 1 到 80 個字"],
      ["   ", "資料夾名稱須為 1 到 80 個字"],
    ];
    for (const [name, message] of bad) {
      const res = await patch(app, u.id, f.id, { name });
      failed(res, 400, "invalid_body");
      expect(messageOf(res)).toBe(message);
    }
    // 名稱先於位置判：NUL 名稱配隨機 id 也是 400。
    failed(await patch(app, u.id, RANDOM_UUID, { name: `A${NUL}` }), 400, "invalid_body");
    expect(ok(await patch(app, u.id, f.id, { name: "  Trimmed\n" })).name).toBe("Trimmed");
  });

  it("FU-2 搬移：到兄弟底下 200；parentId null 回根層；搬到原父層不寫（xmin 不變）；目標層已有同名 409；名稱與位置一起改", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const a = await seedFolder(db, { personal: u.id }, { name: "A" });
    const b = await seedFolder(db, { personal: u.id }, { name: "B" });
    const a1 = await seedFolder(db, { personal: u.id }, { name: "A1", parentId: a.id });

    expect(ok(await patch(app, u.id, a1.id, { parentId: b.id })).parentId).toBe(b.id);
    expect(await parentOf(pool, a1.id)).toBe(b.id);
    expect(ok(await patch(app, u.id, a1.id, { parentId: null })).parentId).toBeNull();
    expect(await parentOf(pool, a1.id)).toBeNull();

    let x = await xminOf(pool, "folders", a1.id);
    expect(ok(await patch(app, u.id, a1.id, { parentId: null })).parentId).toBeNull();
    expect(await xminOf(pool, "folders", a1.id)).toBe(x);
    ok(await patch(app, u.id, a1.id, { parentId: a.id }));
    x = await xminOf(pool, "folders", a1.id);
    expect(ok(await patch(app, u.id, a1.id, { parentId: a.id, name: "A1" })).parentId).toBe(a.id);
    expect(await xminOf(pool, "folders", a1.id)).toBe(x);

    await seedFolder(db, { personal: u.id }, { name: "dup", parentId: b.id });
    const dup = await seedFolder(db, { personal: u.id }, { name: "Dup" });
    const taken = await patch(app, u.id, dup.id, { parentId: b.id });
    failed(taken, 409, "folder_name_taken");
    expect(messageOf(taken)).toBe("這裡已經有同名資料夾");
    expect(await parentOf(pool, dup.id)).toBeNull();

    const both = ok(await patch(app, u.id, dup.id, { parentId: b.id, name: "Dup2" }));
    expect(both).toMatchObject({ parentId: b.id, name: "Dup2" });
    expect(await folderRow(pool, dup.id)).toMatchObject({ parent_id: b.id, name: "Dup2" });
  });

  it("FU-3 成環：搬到自己、自己的子、自己的孫 409 folder_cycle，什麼都沒寫", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const [x, y, z] = await seedFolderChain(db, { personal: u.id }, ["X", "Y", "Z"]);
    const before = await xminOf(pool, "folders", x!);
    for (const target of [x!, y!, z!]) {
      const res = await patch(app, u.id, x!, { parentId: target });
      failed(res, 409, "folder_cycle");
      expect(messageOf(res)).toBe("不能把資料夾移到它自己裡面");
    }
    failed(await patch(app, u.id, y!, { parentId: z! }), 409, "folder_cycle");
    expect(await parentOf(pool, x!)).toBeNull();
    expect(await parentOf(pool, y!)).toBe(x);
    expect(await xminOf(pool, "folders", x!)).toBe(before);
  });

  it(`FU-4 深度：高 2 的子樹搬到深 4 的父層 409、深 3 200；搬回根層看高度；超深樹改名與搬到原父層照常`, async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const space = { personal: u.id };
    const d = await seedFolderChain(db, space, ["D1", "D2", "D3", "D4"]);
    const [s1, s2] = await seedFolderChain(db, space, ["S1", "S2"]);
    const res = await patch(app, u.id, s1!, { parentId: d[3]! });
    failed(res, 409, "folder_too_deep");
    expect(messageOf(res)).toBe(`資料夾最多 ${FOLDER_DEPTH_MAX} 層`);
    expect(await parentOf(pool, s1!)).toBeNull();
    expect(ok(await patch(app, u.id, s1!, { parentId: d[2]! })).parentId).toBe(d[2]);
    expect(await parentOf(pool, s2!)).toBe(s1);

    // 轉移造出的超深樹（直接種 7 層）：H1 底下高 6，搬到根層 409；改名與「搬到原父層」不檢查深度。
    const [r, h1, ...rest] = await seedFolderChain(db, space, ["R", "H1", "H2", "H3", "H4", "H5", "H6"]);
    failed(await patch(app, u.id, h1!, { parentId: null }), 409, "folder_too_deep");
    expect(await parentOf(pool, h1!)).toBe(r);
    expect(ok(await patch(app, u.id, h1!, { parentId: r!, name: "H1x" })).name).toBe("H1x");
    expect(ok(await patch(app, u.id, rest[4]!, { name: "deepest" })).name).toBe("deepest");
    expect(ok(await patch(app, u.id, rest[0]!, { parentId: null })).parentId).toBeNull();
  });

  it("FU-5 跨空間：個人→自己的 shared、個人→看得到的群組、群組→個人 400；看不到的群組資料夾 404 與隨機 uuid、\"x\"、\"\" 逐位元組相同", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const other = await sixRoleScene(db);
    const u = s.member;
    const p1 = await seedFolder(db, { personal: u.id });
    const sh = await seedFolder(db, { shared: u.id });
    const g = await seedFolder(db, { group: s.groupId });
    const hidden = await seedFolder(db, { group: other.groupId });

    for (const [self, target] of [[p1.id, sh.id], [p1.id, g.id], [g.id, p1.id], [sh.id, p1.id]] as const) {
      const res = await patch(app, u.id, self, { parentId: target });
      failed(res, 400, "folder_cross_space");
      expect(messageOf(res)).toBe("資料夾不能移到其他空間");
    }
    const bodies = [
      failed(await patch(app, u.id, p1.id, { parentId: hidden.id }), 404, "folder_not_found"),
      failed(await patch(app, u.id, g.id, { parentId: hidden.id }), 404, "folder_not_found"),
      failed(await patch(app, u.id, p1.id, { parentId: RANDOM_UUID }), 404, "folder_not_found"),
      failed(await patch(app, u.id, p1.id, { parentId: "x" }), 404, "folder_not_found"),
      failed(await patch(app, u.id, p1.id, { parentId: "" }), 404, "folder_not_found"),
      failed(await patch(app, u.id, hidden.id, { name: "A" }), 404, "folder_not_found"),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("找不到此資料夾");
    for (const id of [p1.id, sh.id, g.id, hidden.id]) expect(await parentOf(pool, id)).toBeNull();
  });

  it("FU-6 權限（群組資料夾）：admin／member／editDelete／editOnly 改名與搬移 200；deleteOnly、readOnly 403；非成員、站台管理員 404 與不存在同形", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const g = await seedFolder(db, { group: s.groupId }, { name: "G" });
    const c = await seedFolder(db, { group: s.groupId }, { name: "C", parentId: g.id });

    for (const [i, u] of [s.admin, s.member, s.editDelete, s.editOnly].entries()) {
      const renamed = ok(await patch(app, u.id, g.id, { name: `G${i}` }));
      expect(renamed.space).toEqual({ kind: "group", groupId: s.groupId });
      expect(ok(await patch(app, u.id, c.id, { parentId: null })).parentId).toBeNull();
      expect(ok(await patch(app, u.id, c.id, { parentId: g.id })).parentId).toBe(g.id);
    }
    expect(ok(await patch(app, s.member.id, g.id, { name: "G" })).permissions).toEqual({ manage: true, deleteNotes: false, createNote: true });
    const before = await xminOf(pool, "folders", g.id);
    for (const u of [s.deleteOnly, s.readOnly]) {
      for (const [id, payload] of [[g.id, { name: "nope" }], [c.id, { parentId: null }], [c.id, { name: "nope", parentId: null }]] as const) {
        const res = await patch(app, u.id, id, payload);
        failed(res, 403, "forbidden");
        expect(messageOf(res)).toBe(NOT_MANAGER);
      }
      // §5.7.3 順序：可見性 → 空間 → 管理權——沒有管理權的人往跨空間目標搬得 400、往看不到的目標得 404。
      const own = await seedFolder(db, { personal: u.id });
      const cross = await patch(app, u.id, c.id, { parentId: own.id });
      failed(cross, 400, "folder_cross_space");
      expect(messageOf(cross)).toBe("資料夾不能移到其他空間");
      failed(await patch(app, u.id, c.id, { parentId: RANDOM_UUID }), 404, "folder_not_found");
    }
    const bodies = [
      failed(await patch(app, s.outsider.id, g.id, { name: "nope" }), 404, "folder_not_found"),
      failed(await patch(app, s.outsider.id, c.id, { parentId: null }), 404, "folder_not_found"),
      failed(await patch(app, siteAdmin.id, g.id, { name: "nope" }), 404, "folder_not_found"),
      failed(await patch(app, s.member.id, RANDOM_UUID, { name: "nope" }), 404, "folder_not_found"),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(await xminOf(pool, "folders", g.id)).toBe(before);
    expect(await folderRow(pool, c.id)).toMatchObject({ parent_id: g.id, name: "C" });
  });

  it("FU-7 S-F8／A3-11：搬移與改名前後，子樹裡活、垃圾桶、被分享、有版本與 note_states 的筆記一個位元都沒寫", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const viewer = await seedUser(db);
    const [p, q] = await seedFolderChain(db, { personal: u.id }, ["P", "Q"]);
    const r = await seedFolder(db, { personal: u.id }, { name: "R" });
    const live = await seedNote(db, { ownerId: u.id }, { prevSlug: "old-slug", publicToken: "tok-fu7", publicSlug: "pub-fu7" });
    const trashed = await seedNote(db, { ownerId: u.id });
    const shared = await seedNote(db, { ownerId: u.id });
    const versioned = await seedNote(db, { ownerId: u.id });
    const ids = [live.id, trashed.id, shared.id, versioned.id];
    await setNoteFolder(pool, live.id, q!);
    await setNoteFolder(pool, trashed.id, q!);
    await setNoteFolder(pool, shared.id, p!);
    await setNoteFolder(pool, versioned.id, q!);
    await markTrashed(pool, trashed.id, u.id);
    await seedShare(db, shared.id, viewer.id, "editor");
    const viewerShelf = await seedFolder(db, { shared: viewer.id });
    await seedPlacement(pool, viewer.id, shared.id, viewerShelf.id);
    await pool.query("insert into note_states (note_id, ydoc) values ($1, decode('00', 'hex'))", [versioned.id]);
    await pool.query("insert into note_versions (note_id, seq, ydoc, kind) values ($1, 1, decode('00', 'hex'), 'auto'), ($1, 2, decode('00', 'hex'), 'manual')", [versioned.id]);
    await pool.query("insert into note_redirects (old_path, note_id, expires_at) values ($1, $2, now() + interval '1 day')", [`/n/fu7-${live.id}`, live.id]);

    const snapshot = async () => ({
      notes: await Promise.all(ids.map(async id => ({
        state: await noteState(pool, id),
        folder: await noteFolderCols(pool, id),
        trash: await trashCols(pool, id),
        xmin: await xminOf(pool, "notes", id),
      }))),
      placement: await placementOf(pool, viewer.id, shared.id),
      counts: (await pool.query(
        `select (select count(*)::int from note_versions where note_id = any($1)) as versions,
                (select count(*)::int from note_redirects where note_id = any($1)) as redirects,
                (select string_agg(note_id::text || ':' || version || ':' || updated_at::text, ',' order by note_id) from note_states where note_id = any($1)) as states`,
        [ids],
      )).rows[0],
    });
    const before = await snapshot();
    expect(before.counts).toMatchObject({ versions: 2, redirects: 1 });
    ok(await patch(app, u.id, q!, { parentId: r.id }));
    ok(await patch(app, u.id, p!, { name: "P renamed" }));
    ok(await patch(app, u.id, q!, { parentId: null, name: "Q renamed" }));
    ok(await patch(app, u.id, p!, { parentId: q! }));
    expect(await snapshot()).toEqual(before);
  });

  it("FU-8 旁觀者：改名與搬移只動那一列（兄弟、自己 shared 的同名、別人的同名資料夾 xmin 與名稱不變）", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const other = await seedUser(db);
    const target = await seedFolder(db, { personal: u.id }, { name: "Same" });
    const bystanders = [
      await seedFolder(db, { personal: u.id }, { name: "Sibling" }),
      await seedFolder(db, { shared: u.id }, { name: "Same" }),
      await seedFolder(db, { personal: other.id }, { name: "Same" }),
      await seedFolder(db, { personal: other.id }, { name: "Sibling" }),
    ];
    const dest = await seedFolder(db, { personal: u.id }, { name: "Dest" });
    const snap = async () => Promise.all(bystanders.map(async f => ({ x: await xminOf(pool, "folders", f.id), row: await folderRow(pool, f.id) })));
    const before = await snap();
    ok(await patch(app, u.id, target.id, { name: "Renamed" }));
    expect(await snap()).toEqual(before);
    ok(await patch(app, u.id, target.id, { parentId: dest.id }));
    expect(await snap()).toEqual(before);
    expect(await folderRow(pool, target.id)).toMatchObject({ name: "Renamed", parent_id: dest.id });
  });

  it("FU-9 body 與認證：{}、未知鍵、型別錯 400；parentId \"x\" 404；大寫 :id 與大寫 parentId 200；Bearer、未登入 401", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "F" });
    const dest = await seedFolder(db, { personal: u.id }, { name: "Dest" });
    const empty = await patch(app, u.id, f.id, {});
    failed(empty, 400, "invalid_body");
    expect(messageOf(empty)).toBe("請求格式錯誤：至少需要一個欄位");
    failed(await patch(app, u.id, f.id), 400, "invalid_body");
    for (const payload of [{ name: "A", x: 1 }, { name: 1 }, { parentId: 1 }, { name: null }, { parentId: dest.id, extra: true }]) {
      failed(await patch(app, u.id, f.id, payload), 400, "invalid_body");
    }
    failed(await patch(app, u.id, f.id, { parentId: "x" }), 404, "folder_not_found");
    expect(await folderRow(pool, f.id)).toMatchObject({ name: "F", parent_id: null });

    expect(ok(await patch(app, u.id, f.id.toUpperCase(), { name: "Upper" })).id).toBe(f.id);
    const moved = ok(await patch(app, u.id, f.id.toUpperCase(), { parentId: dest.id.toUpperCase() }));
    expect(moved.parentId).toBe(dest.id);
    expect(await folderRow(pool, f.id)).toMatchObject({ name: "Upper", parent_id: dest.id });
    // 大寫的「原父層」也是不搬：不寫。
    const x = await xminOf(pool, "folders", f.id);
    expect(ok(await patch(app, u.id, f.id, { parentId: dest.id.toUpperCase() })).parentId).toBe(dest.id);
    expect(await xminOf(pool, "folders", f.id)).toBe(x);
    failed(await patch(app, u.id, "x", { name: "A" }), 404, "folder_not_found");

    const rw = await seedTokenForUser(db, u.id, "notes:read notes:write");
    const viaBearer = await app.inject({ method: "PATCH", url: `/api/folders/${f.id}`, headers: bearer(rw.token), payload: { name: "B" } });
    expect(viaBearer.statusCode, viaBearer.body).toBe(401);
    expect((await patch(app, null, f.id, { name: "C" })).statusCode).toBe(401);
    expect(await nameOf(pool, f.id)).toBe("Upper");
  });

  it("FU-10 節流：edit 桶上限 1——名稱不合、看不到、無管理權、跨空間的請求不扣；第二次成功前 429；另一位使用者不受影響", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const s = await sixRoleScene(db);
    const u = s.readOnly;
    const other = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id });
    const sh = await seedFolder(db, { shared: u.id });
    const g = await seedFolder(db, { personal: other.id });
    const gf = await seedFolder(db, { group: s.groupId });
    failed(await patch(app, u.id, gf.id, { name: "nope" }), 403, "forbidden");
    failed(await patch(app, u.id, f.id, { name: "" }), 400, "invalid_body");
    failed(await patch(app, u.id, RANDOM_UUID, { name: "A" }), 404, "folder_not_found");
    failed(await patch(app, u.id, f.id, { parentId: RANDOM_UUID }), 404, "folder_not_found");
    failed(await patch(app, u.id, f.id, { parentId: sh.id }), 400, "folder_cross_space");
    ok(await patch(app, u.id, f.id, { name: "first" }));
    const res = await patch(app, u.id, f.id, { name: "second" });
    failed(res, 429, "too_many_requests");
    expect(messageOf(res)).toBe("寫入過於頻繁");
    ok(await patch(app, other.id, g.id, { name: "first" }));
    expect(await nameOf(db.$client, f.id)).toBe("first");
  });

  it("FU-11 預讀之後狀態變了（縫）：父層變別人的 → 404（不是 400）；父層變自己的 shared → 400；自己被刪或換空間 → 404；群組被刪 → 404；降權 → 403／404", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const u = await seedUser(db);
    const stranger = await seedUser(db);
    const notFoundBody = failed(await patch(app, u.id, RANDOM_UUID, { name: "A" }), 404, "folder_not_found");

    // 父層在授權之後變成別人的個人資料夾：看不到（同時也跨空間）→ 先判可見性 → 404。
    const self = await seedFolder(db, { personal: u.id }, { name: "Self" });
    const p2 = await seedFolder(db, { personal: u.id }, { name: "P2" });
    seam.arm("folder-authorized", async () => {
      await pool.query("update folders set owner_id = $2 where id = $1", [p2.id, stranger.id]);
    });
    expect(failed(await patch(app, u.id, self.id, { parentId: p2.id }), 404, "folder_not_found")).toBe(notFoundBody);
    // 父層在授權之後變成自己的 shared 資料夾：看得到、跨空間 → 400。
    const p3 = await seedFolder(db, { personal: u.id }, { name: "P3" });
    seam.arm("folder-authorized", async () => {
      await pool.query("update folders set kind = 'shared' where id = $1", [p3.id]);
    });
    failed(await patch(app, u.id, self.id, { parentId: p3.id }), 400, "folder_cross_space");
    expect(await parentOf(pool, self.id)).toBeNull();

    // 自己在授權之後被刪（改名走 FOR UPDATE、只搬走一般讀，兩條都 404）或換了空間。
    for (const payload of [{ name: "gone" }, { parentId: null }]) {
      const doomed = await seedFolder(db, { personal: u.id }, { parentId: self.id });
      seam.arm("folder-authorized", async () => {
        await pool.query("delete from folders where id = $1", [doomed.id]);
      });
      expect(failed(await patch(app, u.id, doomed.id, payload), 404, "folder_not_found")).toBe(notFoundBody);
    }
    const moved = await seedFolder(db, { personal: u.id }, { name: "Moved" });
    seam.arm("folder-authorized", async () => {
      await pool.query("update folders set kind = 'shared' where id = $1", [moved.id]);
    });
    expect(failed(await patch(app, u.id, moved.id, { name: "x" }), 404, "folder_not_found")).toBe(notFoundBody);
    expect(await nameOf(pool, moved.id)).toBe("Moved");

    // 群組在授權之後被刪（轉移）→ 404。
    const a = await sixRoleScene(db);
    const ga = await seedFolder(db, { group: a.groupId }, { name: "GA" });
    seam.arm("folder-authorized", async () => {
      const del = await inject(app, "DELETE", `/api/groups/${a.groupId}`, a.admin.id, { mode: "transfer", transferTo: a.admin.id });
      expect(del.statusCode, del.body).toBe(204);
    });
    expect(failed(await patch(app, a.member.id, ga.id, { name: "x" }), 404, "folder_not_found")).toBe(notFoundBody);

    // 結構鎖之後降權：拿掉 can_edit → 403；拿掉閱讀或移出群組 → 404。
    const s = await sixRoleScene(db);
    const gs = await seedFolder(db, { group: s.groupId }, { name: "GS" });
    const roleOf = async (userId: string) =>
      (await pool.query<{ role_id: string }>("select role_id from group_members where group_id = $1 and user_id = $2", [s.groupId, userId])).rows[0]!.role_id;
    const setFlags = (sqlSet: string) => async () => {
      await pool.query(`update group_roles set ${sqlSet} where id = $1`, [await roleOf(s.editOnly.id)]);
    };
    for (const payload of [{ name: "x" }, { parentId: null }]) {
      seam.arm("folder-structure-locked", setFlags("can_edit = false"));
      const res = await patch(app, s.editOnly.id, gs.id, payload);
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe(NOT_MANAGER);
      await setFlags("can_edit = true")();
    }
    // 交易內同序：授權之後同時被拿掉 can_edit、新父層又變成自己的個人資料夾（看得到、跨空間）→ 400，不是 403。
    const gp = await seedFolder(db, { group: s.groupId }, { name: "GP" });
    seam.arm("folder-authorized", async () => {
      await setFlags("can_edit = false")();
      await pool.query("update folders set kind = 'personal', owner_id = $2, group_id = null where id = $1", [gp.id, s.editOnly.id]);
    });
    failed(await patch(app, s.editOnly.id, gs.id, { parentId: gp.id }), 400, "folder_cross_space");
    await setFlags("can_edit = true")();
    expect(await parentOf(pool, gs.id)).toBeNull();
    seam.arm("folder-structure-locked", setFlags("can_edit = false, can_read = false"));
    expect(failed(await patch(app, s.editOnly.id, gs.id, { name: "x" }), 404, "folder_not_found")).toBe(notFoundBody);
    await setFlags("can_read = true, can_edit = true")();
    seam.arm("folder-structure-locked", async () => {
      await pool.query("delete from group_members where group_id = $1 and user_id = $2", [s.groupId, s.editDelete.id]);
    });
    expect(failed(await patch(app, s.editDelete.id, gs.id, { name: "x" }), 404, "folder_not_found")).toBe(notFoundBody);
    expect(await nameOf(pool, gs.id)).toBe("GS");
  });

  it("FU-12 結構鎖等太久（另一條連線持住同空間的鎖、lock_timeout 300 ms）：409 server_busy（< 20 s：注入值有生效，不是本檔預設 60 s）、沒有寫；鎖放掉後照常 200", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const pool = db.$client;
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "Busy" });
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`knotebook.folders:personal:${u.id}`]);
      const t0 = Date.now();
      const res = await patch(app, u.id, f.id, { name: "busy2" });
      const ms = Date.now() - t0;
      failed(res, 409, "server_busy");
      expect(messageOf(res)).toBe("伺服器忙碌，請稍後再試");
      expect(ms).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS);
    } finally {
      try {
        await holder.query("rollback");
      } finally {
        holder.release();
      }
    }
    expect(await nameOf(pool, f.id)).toBe("Busy");
    expect(ok(await patch(app, u.id, f.id, { name: "busy2" })).name).toBe("busy2");
  });
});
