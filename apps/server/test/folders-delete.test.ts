/**
 * 資料夾 PR-3a T8：`DELETE /api/folders/:id`（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.7.4〔M1、M2、M15、【推-1】〕、
 * §5.8「資料夾被刪」、§5.6、A3-4、A3-15）。
 */
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FolderDeleteResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import type { CollabHooks } from "../src/collab/hooks.js";
import { UserGate } from "../src/auth/session.js";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { Db } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { DELETE_FOLDER_TRASH_CHUNK, deleteFolderInTx } from "../src/folders/tx/delete-folder.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import {
  folderRow,
  noteFolderCols,
  placementOf,
  seedFolder,
  seedFolderChain,
  seedManyNotesInFolder,
  seedPlacement,
  setNoteFolder,
  setSnapshot,
} from "./folder-helpers.js";
import { seedNote, seedShare, seedUser, sharesOf, spyCollabHooks } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp, freshDb, freshLimiters } from "./helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

const RANDOM_UUID = "7d0c6a4e-1f2b-4c3d-9e8f-0a1b2c3d4e5f";
const TXN_CONTROL = /^(begin|commit|rollback)\b/i;
const BLOCKED = "資料夾裡有你不能刪除的筆記";
const CHANGED = "資料夾內容剛變動，請再試一次";
const NOT_MANAGER = "沒有管理這個資料夾的權限";

const del = (app: FastifyInstance, userId: string | null, id: string) => inject(app, "DELETE", `/api/folders/${id}`, userId);

function ok(res: LightMyRequestResponse): FolderDeleteResultDto {
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as FolderDeleteResultDto;
}
function failed(res: LightMyRequestResponse, status: number, code: string): string {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as { error: { code: string } }).error.code).toBe(code);
  return res.body;
}
const messageOf = (res: LightMyRequestResponse): string => (res.json() as { error: { message: string } }).error.message;
const sorted = (ids: readonly string[]): string[] => [...ids].sort();
let rootSeq = 0;
/** 同一群組根層要多棵子樹時用（同層名稱唯一）。 */
const rootName = (): string => `R${++rootSeq}`;

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
    get pending() {
      return armed !== null;
    },
  };
}

/** `beforeNoteDeleted` 換成記錄呼叫的 spy，閘門的 `release` 共用一個 spy。 */
function gateSpies() {
  const release = vi.fn();
  const beforeNoteDeleted = vi.fn<CollabHooks["beforeNoteDeleted"]>(async () => ({ release }));
  const hooks = { ...spyCollabHooks(), beforeNoteDeleted } satisfies CollabHooks;
  return { hooks, beforeNoteDeleted, release };
}

async function noteIn(db: Db, pool: Pool, owner: { ownerId: string } | { groupId: string }, folderId: string | null): Promise<string> {
  const n = await seedNote(db, owner);
  if (folderId !== null) await setNoteFolder(pool, n.id, folderId);
  return n.id;
}

async function roleIdOf(pool: Pool, groupId: string, userId: string): Promise<string> {
  const { rows } = await pool.query<{ role_id: string }>("select role_id from group_members where group_id = $1 and user_id = $2", [groupId, userId]);
  return rows[0]!.role_id;
}

/** 由葉往根讀名稱路徑。 */
async function pathOf(pool: Pool, folderId: string): Promise<string[]> {
  const out: string[] = [];
  let cur: string | null = folderId;
  while (cur !== null) {
    const f = await folderRow(pool, cur);
    if (!f) throw new Error(`pathOf: ${cur} 不存在`);
    out.unshift(f.name);
    cur = f.parent_id;
  }
  return out;
}

/** 這些筆記與資料夾都還在原處（失敗案「什麼都沒動」）。 */
async function expectUntouched(pool: Pool, notesAt: ReadonlyArray<[string, string]>, folderIds: readonly string[]): Promise<void> {
  for (const [noteId, folderId] of notesAt) {
    expect((await trashCols(pool, noteId))?.deleted_at, noteId).toBeNull();
    expect((await noteFolderCols(pool, noteId))?.folder_id, noteId).toBe(folderId);
  }
  for (const id of folderIds) expect(await folderRow(pool, id), id).toBeDefined();
}

describe("DELETE /api/folders/:id", () => {
  it("FD-1 個人正路：子樹活筆記進垃圾桶、快照是刪除當下的路徑；子樹垃圾桶筆記刷新快照；子樹外的筆記與資料夾不動", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const [R, X, Y] = await seedFolderChain(db, { personal: u.id }, ["R", "X", "Y"]);
    const O = (await seedFolder(db, { personal: u.id }, { name: "O" })).id;
    const a = await noteIn(db, pool, { ownerId: u.id }, R!);
    const b = await noteIn(db, pool, { ownerId: u.id }, X!);
    const t = await noteIn(db, pool, { ownerId: u.id }, X!);
    await markTrashed(pool, t, u.id);
    await setSnapshot(pool, t, ["Old"]);
    const c = await noteIn(db, pool, { ownerId: u.id }, Y!);
    const o = await noteIn(db, pool, { ownerId: u.id }, O);
    const uu = await noteIn(db, pool, { ownerId: u.id }, O);
    await markTrashed(pool, uu, u.id);
    const uuBefore = await trashCols(pool, uu);
    const tBefore = await trashCols(pool, t);

    const out = ok(await del(app, u.id, R!));
    expect(out).toEqual({ trashedNoteIds: sorted([a, b, c]), deletedFolderIds: sorted([R!, X!, Y!]) });
    for (const id of [a, b, c]) {
      const cols = await trashCols(pool, id);
      expect(cols?.deleted_at, id).not.toBeNull();
      expect(cols?.deleted_by, id).toBe(u.id);
    }
    expect(await noteFolderCols(pool, a)).toEqual({ folder_id: null, trash_folder_path: ["R"] });
    expect(await noteFolderCols(pool, b)).toEqual({ folder_id: null, trash_folder_path: ["R", "X"] });
    expect(await noteFolderCols(pool, c)).toEqual({ folder_id: null, trash_folder_path: ["R", "X", "Y"] });
    expect(await noteFolderCols(pool, t)).toEqual({ folder_id: null, trash_folder_path: ["R", "X"] });
    expect(await trashCols(pool, t)).toEqual(tBefore);
    // 旁觀者：子樹外的活筆記與垃圾桶筆記
    expect(await noteFolderCols(pool, o)).toEqual({ folder_id: O, trash_folder_path: null });
    expect((await trashCols(pool, o))?.deleted_at).toBeNull();
    expect(await noteFolderCols(pool, uu)).toEqual({ folder_id: O, trash_folder_path: null });
    expect(await trashCols(pool, uu)).toEqual(uuBefore);
    for (const id of [R!, X!, Y!]) expect(await folderRow(pool, id), id).toBeUndefined();
    expect(await folderRow(pool, O)).toBeDefined();
  });

  it("FD-2 還原照路徑重建（A3-4 的復原等價）：R›X›Y 重建、筆記回到各自位置；沒有筆記的空子資料夾不回來", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const [R, X, Y] = await seedFolderChain(db, { personal: u.id }, ["R", "X", "Y"]);
    await seedFolder(db, { personal: u.id }, { name: "E", parentId: R! });
    const a = await noteIn(db, pool, { ownerId: u.id }, R!);
    const b = await noteIn(db, pool, { ownerId: u.id }, X!);
    const c = await noteIn(db, pool, { ownerId: u.id }, Y!);

    const out = ok(await del(app, u.id, R!));
    expect(out.deletedFolderIds).toHaveLength(4);
    const res = await inject(app, "POST", "/api/trash/restore", u.id, { ids: out.trashedNoteIds });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as TrashRestoreResultDto).skipped).toEqual([]);

    const where = async (id: string) => {
      const cols = await noteFolderCols(pool, id);
      expect(cols?.trash_folder_path, id).toBeNull();
      expect((await trashCols(pool, id))?.deleted_at, id).toBeNull();
      return pathOf(pool, cols!.folder_id!);
    };
    expect(await where(a)).toEqual(["R"]);
    expect(await where(b)).toEqual(["R", "X"]);
    expect(await where(c)).toEqual(["R", "X", "Y"]);
    const { rows } = await pool.query<{ name: string }>("select name from folders where owner_id = $1 order by name", [u.id]);
    expect(rows.map(r => r.name)).toEqual(["R", "X", "Y"]);
  });

  it("FD-3 群組權限：有活筆記 admin／editDelete 200、member／editOnly 403 folder_delete_blocked（不開閘門）；只有垃圾桶筆記 member 200；deleteOnly／readOnly 403；outsider 404 與不存在同形", async () => {
    const spies = gateSpies();
    const { app, db } = await buildTestApp({ collabHooks: spies.hooks });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const g = { groupId: s.groupId };
    const scene = async () => {
      const name = rootName();
      const [R, X] = await seedFolderChain(db, { group: s.groupId }, [name, "X"]);
      const n = await noteIn(db, pool, g, X!);
      return { R: R!, X: X!, n, name };
    };

    for (const actor of [s.member, s.editOnly]) {
      const sc = await scene();
      const res = await del(app, actor.id, sc.R);
      failed(res, 403, "folder_delete_blocked");
      expect(messageOf(res)).toBe(BLOCKED);
      await expectUntouched(pool, [[sc.n, sc.X]], [sc.R, sc.X]);
    }
    // 快速路徑擋下：閘門一個都沒開
    expect(spies.beforeNoteDeleted).not.toHaveBeenCalled();

    for (const actor of [s.admin, s.editDelete]) {
      const sc = await scene();
      expect(ok(await del(app, actor.id, sc.R))).toEqual({ trashedNoteIds: [sc.n], deletedFolderIds: sorted([sc.R, sc.X]) });
      expect((await trashCols(pool, sc.n))?.deleted_by).toBe(actor.id);
      expect(await folderRow(pool, sc.R)).toBeUndefined();
    }

    const trashOnly = await scene();
    await markTrashed(pool, trashOnly.n, s.admin.id);
    expect(ok(await del(app, s.member.id, trashOnly.R))).toEqual({ trashedNoteIds: [], deletedFolderIds: sorted([trashOnly.R, trashOnly.X]) });
    expect(await noteFolderCols(pool, trashOnly.n)).toEqual({ folder_id: null, trash_folder_path: [trashOnly.name, "X"] });

    for (const actor of [s.deleteOnly, s.readOnly]) {
      const sc = await scene();
      const res = await del(app, actor.id, sc.R);
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe(NOT_MANAGER);
      await expectUntouched(pool, [[sc.n, sc.X]], [sc.R, sc.X]);
    }

    const sc = await scene();
    const outsider = failed(await del(app, s.outsider.id, sc.R), 404, "folder_not_found");
    expect(failed(await del(app, s.outsider.id, RANDOM_UUID), 404, "folder_not_found")).toBe(outsider);
    expect(failed(await del(app, s.outsider.id, "x"), 404, "folder_not_found")).toBe(outsider);
    await expectUntouched(pool, [[sc.n, sc.X]], [sc.R, sc.X]);
  });

  it("FD-4 共享私人：放置列消失、筆記不進垃圾桶、擁有者那邊的位置不變、不開閘門、不發任何 notes 查詢", async () => {
    const spies = gateSpies();
    const { db, pool } = await freshDb();
    const queries: string[] = [];
    const logged = drizzle(pool, { schema, logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    const { app } = await buildTestApp({ db: logged, gate: new UserGate(db), collabHooks: spies.hooks });
    const owner = await seedUser(db);
    const sharee = await seedUser(db);
    const P = (await seedFolder(db, { personal: owner.id }, { name: "P" })).id;
    const n1 = await noteIn(db, pool, { ownerId: owner.id }, P);
    const n2 = await noteIn(db, pool, { ownerId: owner.id }, P);
    await seedShare(db, n1, sharee.id, "editor");
    await seedShare(db, n2, sharee.id, "viewer");
    const [SR, SC] = await seedFolderChain(db, { shared: sharee.id }, ["SR", "SC"]);
    await seedPlacement(pool, sharee.id, n1, SR!);
    await seedPlacement(pool, sharee.id, n2, SC!);

    queries.length = 0;
    expect(ok(await del(app, sharee.id, SR!))).toEqual({ trashedNoteIds: [], deletedFolderIds: sorted([SR!, SC!]) });
    // 共享私人樹裡沒有任何筆記的 folder_id（trigger 守）：不預讀、不鎖、不移入、不刷新快照。
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter(q => q.includes("pg_advisory_xact_lock"))).toHaveLength(1);
    expect(queries.filter(q => /\bfrom "notes"/.test(q) || /\bupdate "notes"/.test(q))).toEqual([]);
    for (const id of [n1, n2]) {
      expect(await placementOf(pool, sharee.id, id), id).toBeNull();
      expect((await trashCols(pool, id))?.deleted_at, id).toBeNull();
      expect((await noteFolderCols(pool, id))?.folder_id, id).toBe(P);
      expect((await sharesOf(db, id)).map(x => x.userId), id).toEqual([sharee.id]);
    }
    expect(await folderRow(pool, SR!)).toBeUndefined();
    expect(await folderRow(pool, SC!)).toBeUndefined();
    expect(await folderRow(pool, P)).toBeDefined();
    expect(spies.beforeNoteDeleted).not.toHaveBeenCalled();
  });

  it("FD-5 閘門：成功與三種失敗（交易內 403、409、縫裡丟錯）都對子樹活筆記各開一次、全部 release", async () => {
    const spies = gateSpies();
    const seam = armedHook();
    const { app, db } = await buildTestApp({ collabHooks: spies.hooks, groupTestHook: seam.hook });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const g = { groupId: s.groupId };
    const roleId = await roleIdOf(pool, s.groupId, s.editDelete.id);
    const scene = async () => {
      const [R, X, Y] = await seedFolderChain(db, { group: s.groupId }, [rootName(), "X", "Y"]);
      const ids = [await noteIn(db, pool, g, R!), await noteIn(db, pool, g, X!), await noteIn(db, pool, g, Y!)];
      spies.beforeNoteDeleted.mockClear();
      spies.release.mockClear();
      return { R: R!, X: X!, Y: Y!, ids };
    };
    const opened = () => sorted(spies.beforeNoteDeleted.mock.calls.map(c => c[0]));

    const okScene = await scene();
    expect(ok(await del(app, s.editDelete.id, okScene.R)).trashedNoteIds).toEqual(sorted(okScene.ids));
    expect(opened()).toEqual(sorted(okScene.ids));
    expect(spies.release).toHaveBeenCalledTimes(3);

    const blocked = await scene();
    seam.arm("folder-delete-notes-locked", async () => {
      await pool.query("update group_roles set can_delete = false where id = $1", [roleId]);
    });
    failed(await del(app, s.editDelete.id, blocked.R), 403, "folder_delete_blocked");
    await pool.query("update group_roles set can_delete = true where id = $1", [roleId]);
    expect(seam.pending).toBe(false);
    expect(opened()).toEqual(sorted(blocked.ids));
    expect(spies.release).toHaveBeenCalledTimes(3);

    const conflict = await scene();
    seam.arm("folder-delete-gated", async () => {
      await noteIn(db, pool, g, conflict.Y);
    });
    failed(await del(app, s.editDelete.id, conflict.R), 409, "conflict");
    expect(opened()).toEqual(sorted(conflict.ids));
    expect(spies.release).toHaveBeenCalledTimes(3);

    const thrown = await scene();
    seam.arm("folder-delete-notes-locked", async () => {
      throw new Error("FD-5 boom");
    });
    expect((await del(app, s.editDelete.id, thrown.R)).statusCode).toBe(500);
    expect(opened()).toEqual(sorted(thrown.ids));
    expect(spies.release).toHaveBeenCalledTimes(3);
    await expectUntouched(pool, thrown.ids.map((id, i) => [id, [thrown.R, thrown.X, thrown.Y][i]!] as [string, string]), [thrown.R, thrown.X, thrown.Y]);
  });

  it("FD-M1 閘門開完後有一篇被搬出子樹：200、不含它；它的閘門被收回（可再開），已移入的閘門仍關著", async () => {
    const seam = armedHook();
    const ctx = await buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log), groupTestHook: seam.hook });
    const pool: Pool = ctx.db.$client;
    const u = await seedUser(ctx.db);
    const [R, X, Y] = await seedFolderChain(ctx.db, { personal: u.id }, ["R", "X", "Y"]);
    const Z = (await seedFolder(ctx.db, { personal: u.id }, { name: "Z" })).id;
    const a = await noteIn(ctx.db, pool, { ownerId: u.id }, R!);
    const b = await noteIn(ctx.db, pool, { ownerId: u.id }, X!);
    const c = await noteIn(ctx.db, pool, { ownerId: u.id }, Y!);
    const rel = vi.spyOn(ctx.collab, "releaseDeletingGate");
    seam.arm("folder-delete-gated", async () => {
      await setNoteFolder(pool, c, Z);
    });

    expect(ok(await del(ctx.app, u.id, R!))).toEqual({ trashedNoteIds: sorted([a, b]), deletedFolderIds: sorted([R!, X!, Y!]) });
    // release 是 fire-and-forget：等每一次 releaseDeletingGate 跑完再看閘門。
    expect(rel).toHaveBeenCalledTimes(3);
    await Promise.all(rel.mock.results.map(r => r.value));
    expect(ctx.collab.isDeleting(c)).toBe(false);
    expect(ctx.collab.isDeleting(a)).toBe(true);
    expect(ctx.collab.isDeleting(b)).toBe(true);
    expect(await noteFolderCols(pool, c)).toEqual({ folder_id: Z, trash_folder_path: null });
    expect((await trashCols(pool, c))?.deleted_at).toBeNull();
  });

  it("FD-C1 閘門開完後子樹裡多了一篇（沒開閘門）：409 conflict、什麼都沒動、閘門全收", async () => {
    const spies = gateSpies();
    const seam = armedHook();
    const { app, db } = await buildTestApp({ collabHooks: spies.hooks, groupTestHook: seam.hook });
    const pool = db.$client;
    const u = await seedUser(db);
    const [R, X, Y] = await seedFolderChain(db, { personal: u.id }, ["R", "X", "Y"]);
    const a = await noteIn(db, pool, { ownerId: u.id }, R!);
    const b = await noteIn(db, pool, { ownerId: u.id }, X!);
    const c = await noteIn(db, pool, { ownerId: u.id }, Y!);
    let late = "";
    seam.arm("folder-delete-gated", async () => {
      late = await noteIn(db, pool, { ownerId: u.id }, Y!);
    });

    const res = await del(app, u.id, R!);
    failed(res, 409, "conflict");
    expect(messageOf(res)).toBe(CHANGED);
    await expectUntouched(pool, [[a, R!], [b, X!], [c, Y!], [late, Y!]], [R!, X!, Y!]);
    expect(spies.release).toHaveBeenCalledTimes(3);
  });

  it("FD-M2 鎖完筆記後角色被改：拿掉 can_delete → 403 folder_delete_blocked；連 can_read 也拿掉 → 409 conflict；授權後交易前被改：拿掉 can_edit → 403 forbidden、拿掉 can_read → 404；全部不動", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const g = { groupId: s.groupId };
    const roleId = await roleIdOf(pool, s.groupId, s.editDelete.id);
    const scene = async () => {
      const [R, X] = await seedFolderChain(db, { group: s.groupId }, [rootName(), "X"]);
      const a = await noteIn(db, pool, g, R!);
      const b = await noteIn(db, pool, g, X!);
      const t = await noteIn(db, pool, g, X!);
      await markTrashed(pool, t, s.admin.id);
      await setSnapshot(pool, t, ["Old"]);
      return { R: R!, X: X!, a, b, t };
    };
    const expectAllKept = async (sc: Awaited<ReturnType<typeof scene>>) => {
      await expectUntouched(pool, [[sc.a, sc.R], [sc.b, sc.X]], [sc.R, sc.X]);
      expect(await noteFolderCols(pool, sc.t)).toEqual({ folder_id: sc.X, trash_folder_path: ["Old"] });
    };

    const noDelete = await scene();
    seam.arm("folder-delete-notes-locked", async () => {
      await pool.query("update group_roles set can_delete = false where id = $1", [roleId]);
    });
    const r1 = await del(app, s.editDelete.id, noDelete.R);
    failed(r1, 403, "folder_delete_blocked");
    expect(messageOf(r1)).toBe(BLOCKED);
    await expectAllKept(noDelete);

    await pool.query("update group_roles set can_delete = true where id = $1", [roleId]);
    const noRead = await scene();
    seam.arm("folder-delete-notes-locked", async () => {
      await pool.query(
        "update group_roles set can_read = false, can_create = false, can_edit = false, can_delete = false, can_manage_public_link = false where id = $1",
        [roleId],
      );
    });
    const r2 = await del(app, s.editDelete.id, noRead.R);
    failed(r2, 409, "conflict");
    expect(messageOf(r2)).toBe(CHANGED);
    await expectAllKept(noRead);

    // 交易外授權之後、交易之前被改：交易內重判資料夾的可見性與管理權。
    const restoreRole = () => pool.query("update group_roles set can_read = true, can_edit = true, can_delete = true where id = $1", [roleId]);
    await restoreRole();
    const noEdit = await scene();
    seam.arm("folder-authorized", async () => {
      await pool.query("update group_roles set can_edit = false where id = $1", [roleId]);
    });
    const r3 = await del(app, s.editDelete.id, noEdit.R);
    failed(r3, 403, "forbidden");
    expect(messageOf(r3)).toBe(NOT_MANAGER);
    await expectAllKept(noEdit);

    await restoreRole();
    const hidden = await scene();
    seam.arm("folder-authorized", async () => {
      await pool.query("update group_roles set can_read = false, can_edit = false, can_delete = false where id = $1", [roleId]);
    });
    failed(await del(app, s.editDelete.id, hidden.R), 404, "folder_not_found");
    await expectAllKept(hidden);
  });

  it("FD-L 鎖序字面：（群組）groups KS → 結構鎖 → 子樹資料夾 FOR UPDATE 一句 → 子樹筆記 FOR UPDATE 一句（WHERE 不分狀態）", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const [R, X] = await seedFolderChain(db, { personal: u.id }, ["R", "X"]);
    const a = await noteIn(db, pool, { ownerId: u.id }, R!);
    const t = await noteIn(db, pool, { ownerId: u.id }, X!);
    await markTrashed(pool, t, u.id);
    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;

    const out = await logged.transaction(tx => deleteFolderInTx(tx, {
      by: u.id, folderId: R!, space: { kind: "personal", ownerId: u.id }, gatedNoteIds: [a], lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS,
    }));
    expect(out).toEqual({ trashedNoteIds: [a], deletedFolderIds: sorted([R!, X!]) });

    const qs = queries.filter(q => !TXN_CONTROL.test(q.trim()));
    const isLock = (q: string) => /for update$/.test(q.trim());
    const folderLocks = qs.flatMap((q, i) => (/^select [^()]* from "folders" /.test(q) && isLock(q) ? [i] : []));
    const noteLocks = qs.flatMap((q, i) => (/^select [^()]* from "notes" /.test(q) && isLock(q) ? [i] : []));
    const subtreeNoteLocks = noteLocks.filter(i => qs[i]!.includes('"folder_id" in ('));
    const advisoryAt = qs.findIndex(q => q.includes("pg_advisory_xact_lock"));
    expect(folderLocks).toHaveLength(1);
    expect(advisoryAt).toBeGreaterThanOrEqual(0);
    expect(folderLocks[0]).toBeGreaterThan(advisoryAt);
    expect(noteLocks.length).toBeGreaterThan(0);
    expect(Math.min(...noteLocks)).toBeGreaterThan(folderLocks[0]!);
    expect(subtreeNoteLocks).toHaveLength(1);
    const q = qs[subtreeNoteLocks[0]!]!;
    expect(q).toMatch(/ order by ("notes"\.)?"id" asc for update$/);
    const where = q.slice(q.indexOf(" where "), q.lastIndexOf(" order by "));
    expect(where).toContain('"folder_id" in (');
    expect(where).not.toContain("deleted_at");

    // 群組空間：第一句是 groups FOR KEY SHARE，結構鎖在它之後。
    const s = await sixRoleScene(db);
    const GR = (await seedFolder(db, { group: s.groupId }, { name: "GR" })).id;
    const gn = await noteIn(db, pool, { groupId: s.groupId }, GR);
    queries.length = 0;
    const gOut = await logged.transaction(tx => deleteFolderInTx(tx, {
      by: s.admin.id, folderId: GR, space: { kind: "group", groupId: s.groupId }, gatedNoteIds: [gn], lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS,
    }));
    expect(gOut).toEqual({ trashedNoteIds: [gn], deletedFolderIds: [GR] });
    const gqs = queries.filter(x => !TXN_CONTROL.test(x.trim()));
    expect(gqs.findIndex(x => /from "groups"/.test(x) && x.includes("for key share"))).toBe(0);
    expect(gqs.findIndex(x => x.includes("pg_advisory_xact_lock"))).toBeGreaterThan(0);
  });

  it("FD-B 大子樹（M15）：1200 篇照樣全進垃圾桶；直呼時任一句的參數數 ≤ 每批上限 + 10；1000 篇量時間", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;

    const u1 = await seedUser(db);
    const F1 = (await seedFolder(db, { personal: u1.id })).id;
    const ids1 = await seedManyNotesInFolder(pool, { ownerId: u1.id }, F1, 1200);
    expect(ok(await del(app, u1.id, F1)).trashedNoteIds).toEqual(ids1);
    const { rows: [n1] } = await pool.query<{ n: number }>("select count(*)::int as n from notes where owner_id = $1 and deleted_at is not null", [u1.id]);
    expect(n1!.n).toBe(1200);

    const u2 = await seedUser(db);
    const F2 = (await seedFolder(db, { personal: u2.id })).id;
    const ids2 = await seedManyNotesInFolder(pool, { ownerId: u2.id }, F2, 1200);
    let maxParams = 0;
    const logged = drizzle(pool, { logger: { logQuery: (_q: string, params: unknown[]) => { maxParams = Math.max(maxParams, params.length); } } }) as unknown as Db;
    const out = await logged.transaction(tx => deleteFolderInTx(tx, {
      by: u2.id, folderId: F2, space: { kind: "personal", ownerId: u2.id }, gatedNoteIds: ids2, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS,
    }));
    expect(out.trashedNoteIds).toEqual(ids2);
    expect(maxParams).toBeGreaterThan(DELETE_FOLDER_TRASH_CHUNK);
    expect(maxParams).toBeLessThanOrEqual(DELETE_FOLDER_TRASH_CHUNK + 10);

    const u3 = await seedUser(db);
    const F3 = (await seedFolder(db, { personal: u3.id })).id;
    const ids3 = await seedManyNotesInFolder(pool, { ownerId: u3.id }, F3, 1000);
    const t0 = performance.now();
    const res = await del(app, u3.id, F3);
    const ms = performance.now() - t0;
    expect(ok(res).trashedNoteIds).toEqual(ids3);
    console.log(`[FD-B] 刪含 1000 篇活筆記的資料夾：${ms.toFixed(0)} ms`);
  });

  it("FD-6 雜項：Bearer 401；節流 429（404／403 不扣桶）；非 UUID 404；同一資料夾刪兩次第二次 404", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const u = s.readOnly;
    const f1 = (await seedFolder(db, { personal: u.id })).id;
    const f2 = (await seedFolder(db, { personal: u.id })).id;
    const gf = (await seedFolder(db, { group: s.groupId })).id;

    const rw = await seedTokenForUser(db, u.id, "notes:read notes:write");
    const viaBearer = await app.inject({ method: "DELETE", url: `/api/folders/${f1}`, headers: bearer(rw.token) });
    expect(viaBearer.statusCode, viaBearer.body).toBe(401);
    expect((await del(app, null, f1)).statusCode).toBe(401);

    failed(await del(app, u.id, "not-a-uuid"), 404, "folder_not_found");
    failed(await del(app, u.id, RANDOM_UUID), 404, "folder_not_found");
    failed(await del(app, u.id, gf), 403, "forbidden");
    ok(await del(app, u.id, f1));
    const limited = await del(app, u.id, f2);
    failed(limited, 429, "too_many_requests");
    expect(messageOf(limited)).toBe("寫入過於頻繁");
    expect(await folderRow(pool, f2)).toBeDefined();
    failed(await del(app, u.id, f1), 404, "folder_not_found");
  });

  it("FD-7 結構鎖等太久（另一條連線持住同空間的鎖、lock_timeout 300 ms）：409 server_busy（< 3000 ms）、什麼都沒動、閘門已收；鎖放掉後照常 200", async () => {
    const spies = gateSpies();
    const { app, db } = await buildTestApp({ collabHooks: spies.hooks, storageLockTimeoutMs: 300 });
    const pool = db.$client;
    const u = await seedUser(db);
    const R = (await seedFolder(db, { personal: u.id }, { name: "R" })).id;
    const a = await noteIn(db, pool, { ownerId: u.id }, R);
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`knotebook.folders:personal:${u.id}`]);
      const t0 = Date.now();
      const res = await del(app, u.id, R);
      const ms = Date.now() - t0;
      failed(res, 409, "server_busy");
      expect(messageOf(res)).toBe("伺服器忙碌，請稍後再試");
      expect(ms).toBeLessThan(3000);
    } finally {
      try {
        await holder.query("rollback");
      } finally {
        holder.release();
      }
    }
    await expectUntouched(pool, [[a, R]], [R]);
    expect(spies.release).toHaveBeenCalledTimes(1);
    expect(ok(await del(app, u.id, R)).trashedNoteIds).toEqual([a]);
  });
});

/** 資料夾 PR-3c T1：只刪空資料夾（spec §5.7.4「只刪空資料夾」、§5.11、§6.18）。 */
describe("DELETE /api/folders/:id { onlyIfEmpty }", () => {
  const NOT_EMPTY = "資料夾裡還有其他內容，沒有刪除";
  const ONLY = { onlyIfEmpty: true } as const;
  const delE = (app: FastifyInstance, userId: string | null, id: string, body?: unknown) =>
    inject(app, "DELETE", `/api/folders/${id}`, userId, body);
  const expectNotEmpty = (res: LightMyRequestResponse): void => {
    failed(res, 409, "folder_not_empty");
    expect(messageOf(res)).toBe(NOT_EMPTY);
  };

  it("FE-1 空資料夾（個人、群組 admin、共享）→ 200、只刪那一個、沒有筆記進垃圾桶", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const s = await sixRoleScene(db);
    const P = (await seedFolder(db, { personal: u.id })).id;
    const G = (await seedFolder(db, { group: s.groupId })).id;
    const S = (await seedFolder(db, { shared: u.id })).id;
    for (const [actor, id] of [[u.id, P], [s.admin.id, G], [u.id, S]] as const) {
      expect(ok(await delE(app, actor, id, ONLY))).toEqual({ trashedNoteIds: [], deletedFolderIds: [id] });
      expect(await folderRow(pool, id), id).toBeUndefined();
    }
  });

  it("FE-2 有子資料夾（個人、共享；子資料夾裡沒有筆記）→ 409 folder_not_empty、父與子都在", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    for (const space of [{ personal: u.id }, { shared: u.id }]) {
      const [R, C] = await seedFolderChain(db, space, [rootName(), "C"]);
      expectNotEmpty(await delE(app, u.id, R!, ONLY));
      expect(await folderRow(pool, R!)).toBeDefined();
      expect(await folderRow(pool, C!)).toBeDefined();
    }
  });

  it("FE-3 有活筆記（個人、群組）→ 409、筆記不動、不開閘門、不扣桶（limit 1：之後刪空資料夾仍 200）", async () => {
    const spies = gateSpies();
    const { app, db } = await buildTestApp({
      collabHooks: spies.hooks,
      limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const pool = db.$client;
    const u = await seedUser(db);
    const s = await sixRoleScene(db);
    const P = (await seedFolder(db, { personal: u.id })).id;
    const pn = await noteIn(db, pool, { ownerId: u.id }, P);
    const G = (await seedFolder(db, { group: s.groupId })).id;
    const gn = await noteIn(db, pool, { groupId: s.groupId }, G);

    for (const [actor, id, n] of [[u.id, P, pn], [s.admin.id, G, gn]] as const) {
      expectNotEmpty(await delE(app, actor, id, ONLY));
      await expectUntouched(pool, [[n, id]], [id]);
    }
    expect(spies.beforeNoteDeleted).not.toHaveBeenCalled();

    const PE = (await seedFolder(db, { personal: u.id })).id;
    const GE = (await seedFolder(db, { group: s.groupId })).id;
    expect(ok(await delE(app, u.id, PE, ONLY))).toEqual({ trashedNoteIds: [], deletedFolderIds: [PE] });
    expect(ok(await delE(app, s.admin.id, GE, ONLY))).toEqual({ trashedNoteIds: [], deletedFolderIds: [GE] });
  });

  it("FE-4 只有垃圾桶筆記 → 200；那篇的快照是刪除當下的路徑、folder_id 變 null", async () => {
    const spies = gateSpies();
    const { app, db } = await buildTestApp({ collabHooks: spies.hooks });
    const pool = db.$client;
    const u = await seedUser(db);
    const R = (await seedFolder(db, { personal: u.id }, { name: "R" })).id;
    const t = await noteIn(db, pool, { ownerId: u.id }, R);
    await markTrashed(pool, t, u.id);
    await setSnapshot(pool, t, ["Old"]);

    expect(ok(await delE(app, u.id, R, ONLY))).toEqual({ trashedNoteIds: [], deletedFolderIds: [R] });
    expect(await noteFolderCols(pool, t)).toEqual({ folder_id: null, trash_folder_path: ["R"] });
    expect(await folderRow(pool, R)).toBeUndefined();
    expect(spies.beforeNoteDeleted).not.toHaveBeenCalled();
  });

  it("FE-5 共享私人有一筆放置 → 409、放置還在；拿掉放置後同一請求 → 200", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const owner = await seedUser(db);
    const sharee = await seedUser(db);
    const n = (await seedNote(db, { ownerId: owner.id })).id;
    await seedShare(db, n, sharee.id, "viewer");
    const S = (await seedFolder(db, { shared: sharee.id })).id;
    await seedPlacement(pool, sharee.id, n, S);

    expectNotEmpty(await delE(app, sharee.id, S, ONLY));
    expect(await placementOf(pool, sharee.id, n)).toBe(S);
    expect(await folderRow(pool, S)).toBeDefined();

    await pool.query("delete from note_placements where user_id = $1 and note_id = $2", [sharee.id, n]);
    expect(ok(await delE(app, sharee.id, S, ONLY))).toEqual({ trashedNoteIds: [], deletedFolderIds: [S] });
  });

  it("FE-6 無 body、{}、{ onlyIfEmpty: false } ＝現行行為：各自那一篇進垃圾桶、各自那個資料夾被刪", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    for (const body of [undefined, {}, { onlyIfEmpty: false }]) {
      const R = (await seedFolder(db, { personal: u.id })).id;
      const n = await noteIn(db, pool, { ownerId: u.id }, R);
      const res = await delE(app, u.id, R, body);
      expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(200);
      expect(res.json()).toEqual({ trashedNoteIds: [n], deletedFolderIds: [R] });
      expect((await trashCols(pool, n))?.deleted_at, n).not.toBeNull();
      expect(await folderRow(pool, R)).toBeUndefined();
    }
  });

  it("FE-7 多餘欄位、型別不對 → 400 invalid_body；資料夾還在", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const u = await seedUser(db);
    const R = (await seedFolder(db, { personal: u.id })).id;
    for (const body of [{ onlyIfEmpty: true, x: 1 }, { onlyIfEmpty: "yes" }]) {
      failed(await delE(app, u.id, R, body), 400, "invalid_body");
    }
    expect(await folderRow(pool, R)).toBeDefined();
  });

  it("FE-8 判斷順序：outsider 404（與不存在同形）→ readOnly 403 forbidden → editOnly 409 folder_not_empty（不是 folder_delete_blocked）；editOnly 刪空的群組資料夾 200", async () => {
    const spies = gateSpies();
    const { app, db } = await buildTestApp({ collabHooks: spies.hooks });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const G = (await seedFolder(db, { group: s.groupId })).id;
    const n = await noteIn(db, pool, { groupId: s.groupId }, G);

    const outsider = failed(await delE(app, s.outsider.id, G, ONLY), 404, "folder_not_found");
    expect(failed(await delE(app, s.outsider.id, RANDOM_UUID, ONLY), 404, "folder_not_found")).toBe(outsider);
    const ro = await delE(app, s.readOnly.id, G, ONLY);
    failed(ro, 403, "forbidden");
    expect(messageOf(ro)).toBe(NOT_MANAGER);
    expectNotEmpty(await delE(app, s.editOnly.id, G, ONLY));
    await expectUntouched(pool, [[n, G]], [G]);
    expect(spies.beforeNoteDeleted).not.toHaveBeenCalled();

    const E = (await seedFolder(db, { group: s.groupId })).id;
    expect(ok(await delE(app, s.editOnly.id, E, ONLY))).toEqual({ trashedNoteIds: [], deletedFolderIds: [E] });
  });

  it("FE-9 併發（預讀時空；folder-delete-gated 縫裡動手）：① 放進一篇活筆記 → 409 folder_not_empty（不是 conflict）、那篇不動；② 建子資料夾 → 409、兩個都在", async () => {
    const spies = gateSpies();
    const seam = armedHook();
    const { app, db } = await buildTestApp({ collabHooks: spies.hooks, groupTestHook: seam.hook });
    const pool = db.$client;
    const u = await seedUser(db);

    const R1 = (await seedFolder(db, { personal: u.id })).id;
    const n = await noteIn(db, pool, { ownerId: u.id }, null);
    seam.arm("folder-delete-gated", async () => {
      await setNoteFolder(pool, n, R1);
    });
    expectNotEmpty(await delE(app, u.id, R1, ONLY));
    expect(seam.pending).toBe(false);
    await expectUntouched(pool, [[n, R1]], [R1]);

    const R2 = (await seedFolder(db, { personal: u.id })).id;
    let child = "";
    seam.arm("folder-delete-gated", async () => {
      child = (await seedFolder(db, { personal: u.id }, { parentId: R2 })).id;
    });
    expectNotEmpty(await delE(app, u.id, R2, ONLY));
    expect(seam.pending).toBe(false);
    expect(await folderRow(pool, R2)).toBeDefined();
    expect(await folderRow(pool, child)).toBeDefined();
    expect(spies.beforeNoteDeleted).not.toHaveBeenCalled();
  });

  it("FE-10 共享：folder-delete-gated 縫裡放進一筆放置 → 409、放置還在", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const owner = await seedUser(db);
    const sharee = await seedUser(db);
    const n = (await seedNote(db, { ownerId: owner.id })).id;
    await seedShare(db, n, sharee.id, "editor");
    const S = (await seedFolder(db, { shared: sharee.id })).id;
    seam.arm("folder-delete-gated", async () => {
      await seedPlacement(pool, sharee.id, n, S);
    });

    expectNotEmpty(await delE(app, sharee.id, S, ONLY));
    expect(seam.pending).toBe(false);
    expect(await placementOf(pool, sharee.id, n)).toBe(S);
    expect(await folderRow(pool, S)).toBeDefined();
  });

  it("FE-11 鎖序字面：個人與共享的空資料夾，不帶 body 與帶 onlyIfEmpty 各刪一次，鎖語句序列逐句相同", async () => {
    const { db, pool } = await freshDb();
    const queries: string[] = [];
    const logged = drizzle(pool, { schema, logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    const { app } = await buildTestApp({ db: logged, gate: new UserGate(db) });
    const u = await seedUser(db);
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const lockSeq = async (space: { personal: string } | { shared: string }, body: unknown): Promise<string[]> => {
      const F = (await seedFolder(db, space)).id;
      queries.length = 0;
      expect(ok(await delE(app, u.id, F, body))).toEqual({ trashedNoteIds: [], deletedFolderIds: [F] });
      // 只看交易內（第一個請求另有驗證層節流的 `last_active_at` 更新，不屬刪資料夾的鎖序）。
      const begin = queries.findIndex(q => /^begin\b/i.test(q.trim()));
      expect(begin).toBeGreaterThanOrEqual(0);
      return queries
        .slice(begin)
        .filter(q => /for update|for no key update|for share|for key share|pg_advisory_xact_lock/i.test(q))
        .map(q => q.replace(UUID, "<id>"));
    };

    for (const space of [{ personal: u.id }, { shared: u.id }]) {
      const label = Object.keys(space)[0];
      const plain = await lockSeq(space, undefined);
      const only = await lockSeq(space, ONLY);
      expect(plain.some(q => q.includes("pg_advisory_xact_lock")), label).toBe(true);
      expect(plain.some(q => /from "folders" [\s\S]*for update$/.test(q.trim())), label).toBe(true);
      expect(only, label).toEqual(plain);
    }
  });
});
