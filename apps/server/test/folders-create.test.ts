/**
 * 資料夾 PR-3a T5：`GET`／`POST /api/folders`（spec §5.7.1、§5.5 入口順序、§5.6、§5.3 深度與數量、§5.11）。
 * 控制字元與組合字元一律以 `String.fromCharCode` 組字（原始碼不放跳脫序列）。
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { FOLDER_DEPTH_MAX, FOLDERS_PER_SPACE_MAX, type FolderDto, type FolderListDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { groupMembers } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { folderRow, seedFolder } from "./folder-helpers.js";
import { noteState, seedNote, seedRole, seedUser } from "./group-helpers.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { inject, sixRoleScene } from "./trash-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";

// 預設空間鎖上限在本檔換成 60 s（產品值 5000），「注入的短上限有生效」的牆鐘界線才能離兩邊都遠——見 ./lock-timeout-bound.ts。
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const COMBINING_ACUTE = String.fromCharCode(0x301);
const E_ACUTE = String.fromCharCode(0xe9);
const RANDOM_UUID = "7d0c6a4e-1f2b-4c3d-9e8f-0a1b2c3d4e5f";
const FOLDER_KEYS = ["createdAt", "id", "name", "parentId", "permissions", "space"];
const ALL = { manage: true, deleteNotes: true, createNote: true };

const post = (app: FastifyInstance, userId: string | null, payload: unknown) => inject(app, "POST", "/api/folders", userId, payload);

function created(res: LightMyRequestResponse): FolderDto {
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as FolderDto;
}

/** 斷言狀態與錯誤碼；回 body 原文（逐位元組比對用）。 */
function failed(res: LightMyRequestResponse, status: number, code: string): string {
  expect(res.statusCode, res.body).toBe(status);
  expect((res.json() as { error: { code: string } }).error.code).toBe(code);
  return res.body;
}
const messageOf = (res: LightMyRequestResponse): string => (res.json() as { error: { message: string } }).error.message;

async function listOf(app: FastifyInstance, userId: string): Promise<FolderDto[]> {
  const res = await inject(app, "GET", "/api/folders", userId);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as FolderListDto).folders;
}

async function folderCount(db: Db): Promise<number> {
  const { rows } = await db.$client.query<{ n: number }>("select count(*)::int as n from folders");
  return rows[0]!.n;
}

/** sixRoleScene ＋ create-only（讀＋建，無編輯）＋ noRead（成員、角色無閱讀）＋ 站台管理員（非成員）。 */
async function roleScene(db: Db) {
  const s = await sixRoleScene(db);
  const createOnly = await seedUser(db);
  const noRead = await seedUser(db);
  const siteAdmin = await seedUser(db, { isAdmin: true });
  const createOnlyRole = await seedRole(db, s.groupId, "create-only", { canRead: true, canCreate: true });
  const noReadRole = await seedRole(db, s.groupId, "no-read", {});
  await db.insert(groupMembers).values([
    { groupId: s.groupId, userId: createOnly.id, roleId: createOnlyRole },
    { groupId: s.groupId, userId: noRead.id, roleId: noReadRole },
  ]);
  return { ...s, createOnly, noRead, siteAdmin };
}

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

describe("POST /api/folders", () => {
  it("FC-1 個人根層：201、key 集合、permissions 全真、created_by＝呼叫者、GET 列得出", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const f = created(await post(app, u.id, { name: "Docs", space: { kind: "personal" } }));
    expect(Object.keys(f).sort()).toEqual(FOLDER_KEYS);
    expect(f).toMatchObject({ name: "Docs", parentId: null, space: { kind: "personal" }, permissions: ALL });
    expect(Object.keys(f.space)).toEqual(["kind"]);
    expect(await folderRow(db.$client, f.id)).toMatchObject({ kind: "personal", owner_id: u.id, group_id: null, parent_id: null, name: "Docs", created_by: u.id });
    expect(await listOf(app, u.id)).toEqual([f]);
  });

  it("FC-2 共享私人根層：createNote 為 false", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const f = created(await post(app, u.id, { name: "Shared", space: { kind: "shared" } }));
    expect(f).toMatchObject({ space: { kind: "shared" }, permissions: { manage: true, deleteNotes: true, createNote: false } });
    expect(await folderRow(db.$client, f.id)).toMatchObject({ kind: "shared", owner_id: u.id, group_id: null, created_by: u.id });
  });

  it("FC-3 群組根層：can_edit 的角色 201；無編輯 403；非成員／無閱讀／站台管理員／不存在／非 UUID 404 group_not_found 逐位元組相同", async () => {
    const { app, db } = await buildTestApp();
    const s = await roleScene(db);
    const space = { kind: "group", groupId: s.groupId };
    for (const u of [s.admin, s.member, s.editDelete, s.editOnly]) {
      const f = created(await post(app, u.id, { name: `by-${u.id}`, space }));
      expect(f.space).toEqual({ kind: "group", groupId: s.groupId });
      expect(await folderRow(db.$client, f.id)).toMatchObject({ kind: "group", owner_id: null, group_id: s.groupId, created_by: u.id });
    }
    for (const u of [s.deleteOnly, s.readOnly, s.createOnly]) {
      const res = await post(app, u.id, { name: `x-${u.id}`, space });
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe("你在這個群組的角色不能建立資料夾");
    }
    const bodies = [
      failed(await post(app, s.outsider.id, { name: "A", space }), 404, "group_not_found"),
      failed(await post(app, s.noRead.id, { name: "A", space }), 404, "group_not_found"),
      failed(await post(app, s.siteAdmin.id, { name: "A", space }), 404, "group_not_found"),
      failed(await post(app, s.member.id, { name: "A", space: { kind: "group", groupId: RANDOM_UUID } }), 404, "group_not_found"),
      failed(await post(app, s.member.id, { name: "A", space: { kind: "group", groupId: "x" } }), 404, "group_not_found"),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("找不到此群組");
    const { rows } = await db.$client.query<{ n: number }>("select count(*)::int as n from folders where group_id = $1", [s.groupId]);
    expect(rows[0]!.n).toBe(4);
  });

  it("FC-4 父資料夾：自己的 201；別人的、非成員群組的、站台管理員看別人的、隨機 uuid、\"x\" 404 逐位元組相同；群組資料夾 readOnly 403", async () => {
    const { app, db } = await buildTestApp();
    const s = await roleScene(db);
    const other = await seedUser(db);
    const mine = await seedFolder(db, { personal: s.outsider.id });
    const mineShared = await seedFolder(db, { shared: s.outsider.id });
    const othersPersonal = await seedFolder(db, { personal: other.id });
    const groupFolder = await seedFolder(db, { group: s.groupId });

    const child = created(await post(app, s.outsider.id, { name: "child", parentId: mine.id }));
    expect(child).toMatchObject({ parentId: mine.id, space: { kind: "personal" }, permissions: ALL });
    expect((await folderRow(db.$client, child.id))?.parent_id).toBe(mine.id);
    const sharedChild = created(await post(app, s.outsider.id, { name: "child", parentId: mineShared.id }));
    expect(sharedChild).toMatchObject({ parentId: mineShared.id, space: { kind: "shared" }, permissions: { createNote: false } });
    const groupChild = created(await post(app, s.member.id, { name: "child", parentId: groupFolder.id }));
    expect(groupChild).toMatchObject({ parentId: groupFolder.id, space: { kind: "group", groupId: s.groupId }, permissions: { manage: true, deleteNotes: false, createNote: true } });

    const bodies = [
      failed(await post(app, s.outsider.id, { name: "A", parentId: othersPersonal.id }), 404, "folder_not_found"),
      failed(await post(app, s.outsider.id, { name: "A", parentId: groupFolder.id }), 404, "folder_not_found"),
      failed(await post(app, s.siteAdmin.id, { name: "A", parentId: othersPersonal.id }), 404, "folder_not_found"),
      failed(await post(app, s.siteAdmin.id, { name: "A", parentId: groupFolder.id }), 404, "folder_not_found"),
      failed(await post(app, s.noRead.id, { name: "A", parentId: groupFolder.id }), 404, "folder_not_found"),
      failed(await post(app, s.outsider.id, { name: "A", parentId: RANDOM_UUID }), 404, "folder_not_found"),
      failed(await post(app, s.outsider.id, { name: "A", parentId: "x" }), 404, "folder_not_found"),
    ];
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("找不到此資料夾");
    for (const u of [s.readOnly, s.deleteOnly, s.createOnly]) {
      const res = await post(app, u.id, { name: "A", parentId: groupFolder.id });
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe("沒有管理這個資料夾的權限");
    }
    expect(await folderCount(db)).toBe(7);
  });

  it("FC-5 名稱：NUL／落單代理／換行／81 字 400；尾端換行修掉；80 個 😀；NFC；同層不分大小寫與 NFC 撞名 409；不同父層、不同空間同名 201", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const other = await seedUser(db);
    const personal = { kind: "personal" };
    const bad: Array<[string, string]> = [
      [`A${NUL}B`, "資料夾名稱含有無法儲存的字元"],
      [`A${LONE_SURROGATE}`, "資料夾名稱含有無法儲存的字元"],
      ["A\nB", "名稱不能包含換行或控制字元"],
      ["a".repeat(81), "資料夾名稱須為 1 到 80 個字"],
      ["   ", "資料夾名稱須為 1 到 80 個字"],
    ];
    for (const [name, message] of bad) {
      const res = await post(app, u.id, { name, space: personal });
      failed(res, 400, "invalid_body");
      expect(messageOf(res)).toBe(message);
    }
    expect(await folderCount(db)).toBe(0);

    expect(created(await post(app, u.id, { name: "A\n", space: personal })).name).toBe("A");
    const emoji = created(await post(app, u.id, { name: "😀".repeat(80), space: personal }));
    expect(Array.from(emoji.name)).toHaveLength(80);
    const nfc = created(await post(app, u.id, { name: `e${COMBINING_ACUTE}`, space: personal }));
    expect(nfc.name).toBe(E_ACUTE);
    expect((await folderRow(db.$client, nfc.id))?.name).toBe(E_ACUTE);

    const docs = created(await post(app, u.id, { name: "Docs", space: personal }));
    const taken = await post(app, u.id, { name: "docs", space: personal });
    failed(taken, 409, "folder_name_taken");
    expect(messageOf(taken)).toBe("這裡已經有同名資料夾");
    failed(await post(app, u.id, { name: E_ACUTE, space: personal }), 409, "folder_name_taken");
    failed(await post(app, u.id, { name: `E${COMBINING_ACUTE}`, space: personal }), 409, "folder_name_taken");

    created(await post(app, u.id, { name: "Docs", parentId: docs.id }));
    created(await post(app, u.id, { name: "Docs", space: { kind: "shared" } }));
    created(await post(app, other.id, { name: "Docs", space: personal }));
  });

  it(`FC-6 深度：連建 ${FOLDER_DEPTH_MAX} 層 201，第 ${FOLDER_DEPTH_MAX + 1} 層 409 folder_too_deep`, async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    let parent = created(await post(app, u.id, { name: "L1", space: { kind: "personal" } }));
    for (let level = 2; level <= FOLDER_DEPTH_MAX; level++) {
      parent = created(await post(app, u.id, { name: `L${level}`, parentId: parent.id }));
    }
    const res = await post(app, u.id, { name: "too deep", parentId: parent.id });
    failed(res, 409, "folder_too_deep");
    expect(messageOf(res)).toBe("資料夾最多 5 層");
    expect(await folderCount(db)).toBe(FOLDER_DEPTH_MAX);
  });

  it(`FC-7 數量：一個空間第 ${FOLDERS_PER_SPACE_MAX} 個 201、再多一個 409 folder_limit（含子層）；同人另一空間、另一位使用者照常`, async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const other = await seedUser(db);
    const p = await seedFolder(db, { personal: u.id }, { name: "P" });
    await db.$client.query(
      `insert into folders (kind, owner_id, parent_id, name, created_by)
       select 'personal', $1::uuid, $2::uuid, 'bulk-' || g, $1::uuid from generate_series(1, $3::int) g`,
      [u.id, p.id, FOLDERS_PER_SPACE_MAX - 2],
    );
    created(await post(app, u.id, { name: "last", space: { kind: "personal" } }));
    const full = await post(app, u.id, { name: "one more", parentId: p.id });
    failed(full, 409, "folder_limit");
    expect(messageOf(full)).toBe("資料夾數量已達上限");
    failed(await post(app, u.id, { name: "root more", space: { kind: "personal" } }), 409, "folder_limit");
    created(await post(app, u.id, { name: "fine", space: { kind: "shared" } }));
    created(await post(app, other.id, { name: "fine", space: { kind: "personal" } }));
  });

  it("FC-8 body：parentId 與 space 並帶、都不帶、未知鍵、space 形不對、name 缺或非字串 400；名稱先於位置判；大寫 parentId／groupId 201", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const s = await roleScene(db);
    const mine = await seedFolder(db, { personal: u.id });
    const before = await folderCount(db);
    const bad: unknown[] = [
      { name: "A", parentId: mine.id, space: { kind: "personal" } },
      { name: "A" },
      { name: "A", space: { kind: "personal" }, extra: 1 },
      { name: "A", space: { kind: "x" } },
      { name: "A", space: { kind: "personal", groupId: s.groupId } },
      { name: "A", space: { kind: "group" } },
      { name: "A", space: { kind: "group", groupId: s.groupId, x: 1 } },
      { name: "A", space: { kind: "shared", x: 1 } },
      { space: { kind: "personal" } },
      { name: 1, space: { kind: "personal" } },
      { name: "A", parentId: 1 },
    ];
    for (const payload of bad) failed(await post(app, u.id, payload), 400, "invalid_body");
    failed(await post(app, u.id, { name: `A${NUL}`, parentId: RANDOM_UUID }), 400, "invalid_body");
    expect(await folderCount(db)).toBe(before);

    const upper = created(await post(app, u.id, { name: "upper", parentId: mine.id.toUpperCase() }));
    expect(upper.parentId).toBe(mine.id);
    const upperGroup = created(await post(app, s.member.id, { name: "upper", space: { kind: "group", groupId: s.groupId.toUpperCase() } }));
    expect(upperGroup.space).toEqual({ kind: "group", groupId: s.groupId });
    expect((await folderRow(db.$client, upperGroup.id))?.group_id).toBe(s.groupId);
  });

  it("FC-9 認證：Bearer（notes:read notes:write）POST 401；Bearer notes:read GET 200；未登入 GET／POST 401", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "Mine" });
    const rw = await seedTokenForUser(db, u.id, "notes:read notes:write");
    const ro = await seedTokenForUser(db, u.id, "notes:read");
    const viaBearer = await app.inject({ method: "POST", url: "/api/folders", headers: bearer(rw.token), payload: { name: "B", space: { kind: "personal" } } });
    expect(viaBearer.statusCode, viaBearer.body).toBe(401);
    expect(await folderCount(db)).toBe(1);
    const got = await app.inject({ method: "GET", url: "/api/folders", headers: bearer(ro.token) });
    expect(got.statusCode, got.body).toBe(200);
    expect((got.json() as FolderListDto).folders.map(x => x.id)).toEqual([f.id]);
    expect((await inject(app, "GET", "/api/folders", null)).statusCode).toBe(401);
    expect((await post(app, null, { name: "C", space: { kind: "personal" } })).statusCode).toBe(401);
  });

  it("FC-10 節流：edit 桶上限 1——授權失敗的請求不扣；第二次成功前 429；另一位使用者不受影響", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const other = await seedUser(db);
    failed(await post(app, u.id, { name: "A", parentId: RANDOM_UUID }), 404, "folder_not_found");
    failed(await post(app, u.id, { name: "", space: { kind: "personal" } }), 400, "invalid_body");
    created(await post(app, u.id, { name: "first", space: { kind: "personal" } }));
    const res = await post(app, u.id, { name: "second", space: { kind: "personal" } });
    failed(res, 429, "too_many_requests");
    expect(messageOf(res)).toBe("寫入過於頻繁");
    created(await post(app, other.id, { name: "first", space: { kind: "personal" } }));
    expect(await folderCount(db)).toBe(2);
  });

  it("FC-13 授權後、交易前群組被刪（轉移）：群組根層 404 group_not_found、父資料夾形 404 folder_not_found，與不存在逐位元組相同", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const deleteGroupOf = (adminId: string, groupId: string) => async () => {
      const del = await inject(app, "DELETE", `/api/groups/${groupId}`, adminId, { mode: "transfer", transferTo: adminId });
      expect(del.statusCode, del.body).toBe(204);
    };
    const a = await sixRoleScene(db);
    seam.arm("folder-authorized", deleteGroupOf(a.admin.id, a.groupId));
    const rootBody = failed(await post(app, a.member.id, { name: "A", space: { kind: "group", groupId: a.groupId } }), 404, "group_not_found");
    expect(rootBody).toBe(failed(await post(app, a.member.id, { name: "A", space: { kind: "group", groupId: RANDOM_UUID } }), 404, "group_not_found"));

    const b = await sixRoleScene(db);
    const gf = await seedFolder(db, { group: b.groupId });
    seam.arm("folder-authorized", deleteGroupOf(b.admin.id, b.groupId));
    const parentBody = failed(await post(app, b.member.id, { name: "A", parentId: gf.id }), 404, "folder_not_found");
    expect(parentBody).toBe(failed(await post(app, b.member.id, { name: "A", parentId: RANDOM_UUID }), 404, "folder_not_found"));
    // 只看這幾次 POST 沒建出列（群組資料夾本身的去向由刪群組決定，不在這裡斷言）。
    const { rows } = await db.$client.query<{ n: number }>("select count(*)::int as n from folders where name = 'A'");
    expect(rows[0]!.n).toBe(0);
  });

  it("FC-14 交易內降權（結構鎖之後）：拿掉 can_edit → 403；拿掉閱讀或移出群組 → 404（根層 group_not_found、父資料夾 folder_not_found）", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const gf = await seedFolder(db, { group: s.groupId });
    const space = { kind: "group", groupId: s.groupId };
    const roleOf = async (userId: string) =>
      (await pool.query<{ role_id: string }>("select role_id from group_members where group_id = $1 and user_id = $2", [s.groupId, userId])).rows[0]!.role_id;
    const setFlags = (userId: string, sqlSet: string) => async () => {
      await pool.query(`update group_roles set ${sqlSet} where id = $1`, [await roleOf(userId)]);
    };
    const restore = (userId: string) => setFlags(userId, "can_read = true, can_edit = true")();

    const forbidden: Array<[unknown, string]> = [
      [{ name: "A", space }, "你在這個群組的角色不能建立資料夾"],
      [{ name: "A", parentId: gf.id }, "沒有管理這個資料夾的權限"],
    ];
    for (const [payload, message] of forbidden) {
      seam.arm("folder-structure-locked", setFlags(s.editOnly.id, "can_edit = false"));
      const res = await post(app, s.editOnly.id, payload);
      failed(res, 403, "forbidden");
      expect(messageOf(res)).toBe(message);
      await restore(s.editOnly.id);
    }
    seam.arm("folder-structure-locked", setFlags(s.editOnly.id, "can_edit = false, can_read = false"));
    failed(await post(app, s.editOnly.id, { name: "A", space }), 404, "group_not_found");
    await restore(s.editOnly.id);
    seam.arm("folder-structure-locked", setFlags(s.editOnly.id, "can_edit = false, can_read = false"));
    failed(await post(app, s.editOnly.id, { name: "A", parentId: gf.id }), 404, "folder_not_found");
    await restore(s.editOnly.id);

    const kick = async () => {
      await pool.query("delete from group_members where group_id = $1 and user_id = $2", [s.groupId, s.editDelete.id]);
    };
    seam.arm("folder-structure-locked", kick);
    failed(await post(app, s.editDelete.id, { name: "A", space }), 404, "group_not_found");
    await pool.query("insert into group_members (group_id, user_id, role_id) select $1, $2, id from group_roles where group_id = $1 and builtin = 'member'", [s.groupId, s.editDelete.id]);
    seam.arm("folder-structure-locked", kick);
    failed(await post(app, s.editDelete.id, { name: "A", parentId: gf.id }), 404, "folder_not_found");
    expect(await folderCount(db)).toBe(1);
  });

  it("FC-16 結構鎖等太久（另一條連線持住同空間的鎖、lock_timeout 300 ms）：409 server_busy（< 20 s：注入值有生效，不是本檔預設 60 s）、沒有建出列；鎖放掉後照常 201", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const u = await seedUser(db);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`knotebook.folders:personal:${u.id}`]);
      const t0 = Date.now();
      const res = await post(app, u.id, { name: "busy", space: { kind: "personal" } });
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
    expect(await folderCount(db)).toBe(0);
    created(await post(app, u.id, { name: "busy", space: { kind: "personal" } }));
  });

  it("FC-15 預讀之後父資料夾換了空間（模擬轉移成呼叫者的個人資料夾）或被刪：404 folder_not_found，不是 500", async () => {
    const seam = armedHook();
    const { app, db } = await buildTestApp({ groupTestHook: seam.hook });
    const s = await sixRoleScene(db);
    const gf = await seedFolder(db, { group: s.groupId });
    seam.arm("folder-authorized", async () => {
      await db.$client.query("update folders set kind = 'personal', owner_id = $2, group_id = null where id = $1", [gf.id, s.member.id]);
    });
    const body = failed(await post(app, s.member.id, { name: "A", parentId: gf.id }), 404, "folder_not_found");
    expect(body).toBe(failed(await post(app, s.member.id, { name: "A", parentId: RANDOM_UUID }), 404, "folder_not_found"));

    // 父資料夾在預讀之後被刪掉：交易內的 KEY SHARE 讀不到 → 404（不是 FK 23503 的 500）。
    const gone = await seedFolder(db, { personal: s.member.id });
    seam.arm("folder-authorized", async () => {
      await db.$client.query("delete from folders where id = $1", [gone.id]);
    });
    expect(failed(await post(app, s.member.id, { name: "A", parentId: gone.id }), 404, "folder_not_found")).toBe(body);
    expect(await folderCount(db)).toBe(1);
  });

  it("FC-12 S-F8：建立資料夾前後，呼叫者所有筆記的狀態（含 updated_at）與 note_states 列數不變", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const s = await sixRoleScene(db);
    const n1 = await seedNote(db, { ownerId: s.member.id });
    const n2 = await seedNote(db, { ownerId: s.member.id });
    const gn = await seedNote(db, { groupId: s.groupId });
    await pool.query("insert into note_states (note_id, ydoc) values ($1, decode('00', 'hex')), ($2, decode('00', 'hex'))", [n1.id, gn.id]);
    const ids = [n1.id, n2.id, gn.id];
    const snapshot = async () => ({
      states: await Promise.all(ids.map(id => noteState(pool, id))),
      noteStates: (await pool.query<{ n: number; v: string }>(
        "select count(*)::int as n, string_agg(note_id::text || ':' || version || ':' || updated_at::text, ',' order by note_id) as v from note_states",
      )).rows[0],
    });
    const before = await snapshot();
    const root = created(await post(app, s.member.id, { name: "P", space: { kind: "personal" } }));
    created(await post(app, s.member.id, { name: "C", parentId: root.id }));
    created(await post(app, s.member.id, { name: "G", space: { kind: "group", groupId: s.groupId } }));
    expect(await snapshot()).toEqual(before);
  });
});

describe("GET /api/folders", () => {
  it("FC-11 群組資料夾逐角色的 permissions；非成員、無閱讀、站台管理員看不到", async () => {
    const { app, db } = await buildTestApp();
    const s = await roleScene(db);
    const gf = await seedFolder(db, { group: s.groupId }, { name: "G" });
    await seedFolder(db, { personal: s.admin.id }, { name: "admin's own" });
    const expected: Array<[string, { manage: boolean; deleteNotes: boolean; createNote: boolean }]> = [
      [s.admin.id, ALL],
      [s.member.id, { manage: true, deleteNotes: false, createNote: true }],
      [s.editDelete.id, { manage: true, deleteNotes: true, createNote: false }],
      [s.deleteOnly.id, { manage: false, deleteNotes: true, createNote: false }],
      [s.editOnly.id, { manage: true, deleteNotes: false, createNote: false }],
      [s.readOnly.id, { manage: false, deleteNotes: false, createNote: false }],
      [s.createOnly.id, { manage: false, deleteNotes: false, createNote: false }],
    ];
    for (const [userId, permissions] of expected) {
      const groupRows = (await listOf(app, userId)).filter(f => f.space.kind === "group");
      expect(groupRows).toEqual([expect.objectContaining({ id: gf.id, permissions })]);
    }
    for (const u of [s.outsider, s.noRead, s.siteAdmin]) expect(await listOf(app, u.id)).toEqual([]);
  });
});
