/**
 * 資料夾 PR-3a T11：刪群組（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.9、§5.4 表「刪群組」兩列、§5.3 系統代建名、
 * A3-12、§7【推-4】）——轉移把群組資料夾整棵收進接收者個人根層的新頂層、全刪取結構鎖、舊碼在新 schema 上照跑。
 * 控制字元與組合字元一律以 `String.fromCharCode` 組字。
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import type { FolderDto, FolderListDto, TrashRestoreResultDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import { folderRow, noteFolderCols, seedFolder, seedFolderChain, setNoteFolder, setSnapshot } from "./folder-helpers.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { inject, markTrashed, trashCols } from "./trash-helpers.js";
import {
  legacyDeleteGroupWithNotesInTx,
  legacyMoveNoteToGroupInTx,
  legacyRestoreNotesInTx,
  legacyTransferGroupInTx,
} from "./legacy-tx-fixtures.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS } from "./lock-timeout-bound.js";

// 預設空間鎖上限在本檔換成 60 s（產品值 5000），「注入的短上限有生效」的牆鐘界線才能離兩邊都遠——見 ./lock-timeout-bound.ts。
vi.mock("../src/storage/tx/quota.js", async () => ({
  ...(await vi.importActual<typeof import("../src/storage/tx/quota.js")>("../src/storage/tx/quota.js")),
  DEFAULT_STORAGE_LOCK_TIMEOUT_MS: (await import("./lock-timeout-bound.js")).SLOW_DEFAULT_LOCK_TIMEOUT_MS,
}));

const COMBINING_ACUTE = String.fromCharCode(0x301);
const E_ACUTE = String.fromCharCode(0xe9);
const CTRL_NAME = String.fromCharCode(1) + String.fromCharCode(2);

async function transfer(
  app: FastifyInstance,
  groupId: string,
  by: string,
  transferTo: string,
  acceptLanguage?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "DELETE",
    url: `/api/groups/${groupId}`,
    cookies: await cookieOf(by),
    ...(acceptLanguage !== undefined ? { headers: { "accept-language": acceptLanguage } } : {}),
    payload: { mode: "transfer", transferTo },
  });
}
async function transferOk(app: FastifyInstance, groupId: string, by: string, transferTo: string, acceptLanguage?: string): Promise<void> {
  const r = await transfer(app, groupId, by, transferTo, acceptLanguage);
  expect(r.statusCode, r.body).toBe(204);
}
const deleteAll = (app: FastifyInstance, groupId: string, by: string) => inject(app, "DELETE", `/api/groups/${groupId}`, by, { mode: "delete" });

type FolderLite = { id: string; kind: string; owner_id: string | null; group_id: string | null; parent_id: string | null; name: string; created_by: string | null };
async function personalFolders(pool: Pool, ownerId: string): Promise<FolderLite[]> {
  const { rows } = await pool.query<FolderLite>(
    "select id, kind, owner_id, group_id, parent_id, name, created_by from folders where kind = 'personal' and owner_id = $1 order by id",
    [ownerId],
  );
  return rows;
}
async function rootsOf(pool: Pool, ownerId: string): Promise<FolderLite[]> {
  return (await personalFolders(pool, ownerId)).filter(f => f.parent_id === null);
}
async function groupFolderCount(pool: Pool, groupId: string): Promise<number> {
  return (await pool.query<{ n: number }>("select count(*)::int n from folders where group_id = $1", [groupId])).rows[0]!.n;
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
/** T1 m-1：trigger 只守被寫的那一列，這裡以 SQL 全掃補「父子同空間」「筆記與所在資料夾同空間」兩條不變量。 */
async function spaceViolations(pool: Pool): Promise<{ parentChild: number; noteFolder: number }> {
  const parentChild = (await pool.query<{ n: number }>(
    `select count(*)::int n from folders c join folders p on p.id = c.parent_id
     where (c.kind, c.owner_id, c.group_id) is distinct from (p.kind, p.owner_id, p.group_id)`,
  )).rows[0]!.n;
  const noteFolder = (await pool.query<{ n: number }>(
    `select count(*)::int n from notes n join folders f on f.id = n.folder_id
     where not ((f.kind = 'personal' and f.owner_id is not distinct from n.owner_id) or (f.kind = 'group' and f.group_id is not distinct from n.group_id))`,
  )).rows[0]!.n;
  return { parentChild, noteFolder };
}
async function listFolders(app: FastifyInstance, userId: string): Promise<FolderDto[]> {
  const r = await inject(app, "GET", "/api/folders", userId);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as FolderListDto).folders;
}
async function trashedNote(db: Db, owner: { groupId: string } | { ownerId: string }, by: string, folderId: string | null, snapshot: string[] | null): Promise<string> {
  const n = await seedNote(db, owner);
  if (folderId !== null) await setNoteFolder(db.$client, n.id, folderId);
  if (snapshot !== null) await setSnapshot(db.$client, n.id, snapshot);
  await markTrashed(db.$client, n.id, by);
  return n.id;
}
async function liveNote(db: Db, owner: { groupId: string } | { ownerId: string }, folderId: string | null): Promise<string> {
  const n = await seedNote(db, owner);
  if (folderId !== null) await setNoteFolder(db.$client, n.id, folderId);
  return n.id;
}

describe("刪群組・轉移：資料夾整棵收進接收者的新頂層", () => {
  it("FG-1 正路（A3-12）：新頂層「研發組」在接收者根層、整棵掛在它下面；筆記三種列各自落位；之後還原帶快照的那篇在新頂層下照路徑重建；樹只有接收者看得到", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const [r, q, m] = [await seedUser(db), await seedUser(db), await seedUser(db)];
    const g = await seedGroup(db, "研發組", [{ userId: q.id, role: "admin" }, { userId: r.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const [A, B] = await seedFolderChain(db, { group: g.id }, ["A", "B"]);
    const C = (await seedFolder(db, { group: g.id }, { name: "C" })).id;
    const a = await liveNote(db, { groupId: g.id }, A!);
    const b = await liveNote(db, { groupId: g.id }, B!);
    const root = await liveNote(db, { groupId: g.id }, null);
    const ta = await trashedNote(db, { groupId: g.id }, q.id, A!, ["A"]);
    const tr = await trashedNote(db, { groupId: g.id }, q.id, null, null);
    const ts = await trashedNote(db, { groupId: g.id }, q.id, null, ["X", "Y"]);
    expect(await personalFolders(pool, r.id)).toEqual([]);

    await transferOk(app, g.id, q.id, r.id);

    const roots = await rootsOf(pool, r.id);
    expect(roots).toHaveLength(1);
    const top = roots[0]!;
    expect(top).toMatchObject({ kind: "personal", owner_id: r.id, group_id: null, parent_id: null, name: "研發組", created_by: q.id });
    expect(await folderRow(pool, A!)).toMatchObject({ kind: "personal", owner_id: r.id, group_id: null, parent_id: top.id, name: "A" });
    expect(await folderRow(pool, B!)).toMatchObject({ kind: "personal", owner_id: r.id, group_id: null, parent_id: A, name: "B" });
    expect(await folderRow(pool, C)).toMatchObject({ kind: "personal", owner_id: r.id, group_id: null, parent_id: top.id, name: "C" });
    expect((await personalFolders(pool, r.id)).map(f => f.id).sort()).toEqual([top.id, A!, B!, C].sort());

    expect(await noteFolderCols(pool, a)).toEqual({ folder_id: A, trash_folder_path: null });
    expect(await noteFolderCols(pool, b)).toEqual({ folder_id: B, trash_folder_path: null });
    expect(await noteFolderCols(pool, root)).toEqual({ folder_id: top.id, trash_folder_path: null });
    expect(await noteFolderCols(pool, tr)).toEqual({ folder_id: top.id, trash_folder_path: null });
    expect(await noteFolderCols(pool, ta)).toEqual({ folder_id: A, trash_folder_path: ["A"] });
    expect(await noteFolderCols(pool, ts)).toEqual({ folder_id: null, trash_folder_path: ["研發組", "X", "Y"] });
    const owners = (await pool.query<{ owner_id: string | null; group_id: string | null }>(
      "select distinct owner_id, group_id from notes where id = any($1::uuid[])", [[a, b, root, ta, tr, ts]],
    )).rows;
    expect(owners).toEqual([{ owner_id: r.id, group_id: null }]);
    expect(await spaceViolations(pool)).toEqual({ parentChild: 0, noteFolder: 0 });

    const mine = await listFolders(app, r.id);
    expect(mine.map(f => ({ id: f.id, parentId: f.parentId, name: f.name, space: f.space })).sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [
        { id: top.id, parentId: null, name: "研發組", space: { kind: "personal" } },
        { id: A!, parentId: top.id, name: "A", space: { kind: "personal" } },
        { id: B!, parentId: A!, name: "B", space: { kind: "personal" } },
        { id: C, parentId: top.id, name: "C", space: { kind: "personal" } },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect(await listFolders(app, m.id)).toEqual([]);
    expect(await listFolders(app, q.id)).toEqual([]);

    const res = await inject(app, "POST", "/api/trash/restore", r.id, { ids: [ts] });
    expect(res.statusCode, res.body).toBe(200);
    const restored = res.json() as TrashRestoreResultDto;
    expect(restored.skipped).toEqual([]);
    const leaf = (await noteFolderCols(pool, ts))!.folder_id;
    expect(leaf).not.toBeNull();
    expect(await pathOf(pool, leaf!)).toEqual(["研發組", "X", "Y"]);
    const x = (await folderRow(pool, leaf!))!.parent_id!;
    expect((await folderRow(pool, x))!.parent_id).toBe(top.id);
    expect(await rootsOf(pool, r.id)).toHaveLength(1);
  });

  it("FG-2 旁觀者：另一個群組的資料夾、接收者原有的個人與共享私人資料夾、別人的資料夾——kind／owner_id／group_id／parent_id 都不變", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const [r, u] = [await seedUser(db), await seedUser(db)];
    const g = await seedGroup(db, "G", [{ userId: r.id, role: "admin" }]);
    const h = await seedGroup(db, "H", [{ userId: r.id, role: "admin" }]);
    await seedFolderChain(db, { group: g.id }, ["GA", "GB"]);
    const [HA, HB] = await seedFolderChain(db, { group: h.id }, ["HA", "HB"]);
    const hn = await liveNote(db, { groupId: h.id }, HB!);
    const RA = (await seedFolder(db, { personal: r.id }, { name: "Mine" })).id;
    const RS = (await seedFolder(db, { shared: r.id }, { name: "Shared" })).id;
    const [UA, UB] = await seedFolderChain(db, { personal: u.id }, ["UA", "UB"]);
    const watched = [HA!, HB!, RA, RS, UA!, UB!];
    const before = await Promise.all(watched.map(id => folderRow(pool, id)));

    await transferOk(app, g.id, r.id, r.id);

    expect(await Promise.all(watched.map(id => folderRow(pool, id)))).toEqual(before);
    expect(await groupFolderCount(pool, h.id)).toBe(2);
    expect(await noteFolderCols(pool, hn)).toEqual({ folder_id: HB, trash_folder_path: null });
    expect((await rootsOf(pool, r.id)).map(f => f.name).sort()).toEqual(["G", "Mine"]);
  });

  it("FG-3 沒有結構：沒有資料夾也沒有帶快照的垃圾桶筆記 → 不建新頂層、筆記在根層；只有帶快照的垃圾桶筆記（n-r4-2）→ 建新頂層、根層活筆記也進去、快照前接", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);
    const RA = (await seedFolder(db, { personal: r.id }, { name: "Mine" })).id;

    const g1 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    const live1 = await liveNote(db, { groupId: g1.id }, null);
    const trashed1 = await trashedNote(db, { groupId: g1.id }, r.id, null, null);
    await transferOk(app, g1.id, r.id, r.id);
    expect((await personalFolders(pool, r.id)).map(f => f.id)).toEqual([RA]);
    expect(await noteFolderCols(pool, live1)).toEqual({ folder_id: null, trash_folder_path: null });
    expect(await noteFolderCols(pool, trashed1)).toEqual({ folder_id: null, trash_folder_path: null });

    const g2 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    const live2 = await liveNote(db, { groupId: g2.id }, null);
    const snap = await trashedNote(db, { groupId: g2.id }, r.id, null, ["X"]);
    await transferOk(app, g2.id, r.id, r.id);
    const tops = (await rootsOf(pool, r.id)).filter(f => f.id !== RA);
    expect(tops.map(f => f.name)).toEqual(["研發組"]);
    expect(await noteFolderCols(pool, live2)).toEqual({ folder_id: tops[0]!.id, trash_folder_path: null });
    expect(await noteFolderCols(pool, snap)).toEqual({ folder_id: null, trash_folder_path: ["研發組", "X"] });
  });

  it("FG-11 活筆記殘留快照（回滾期間被舊碼還原）不算「垃圾桶裡帶快照」：群組沒有資料夾時不為它建新頂層、留在根層、快照不動；群組有資料夾時照根層規則進新頂層、快照不動", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);

    const g1 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    const stale1 = await liveNote(db, { groupId: g1.id }, null);
    await setSnapshot(pool, stale1, ["X"]);
    await transferOk(app, g1.id, r.id, r.id);
    expect(await personalFolders(pool, r.id)).toEqual([]);
    expect(await noteFolderCols(pool, stale1)).toEqual({ folder_id: null, trash_folder_path: ["X"] });

    const g2 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    await seedFolder(db, { group: g2.id }, { name: "A" });
    const stale2 = await liveNote(db, { groupId: g2.id }, null);
    await setSnapshot(pool, stale2, ["X"]);
    await transferOk(app, g2.id, r.id, r.id);
    const roots = await rootsOf(pool, r.id);
    expect(roots.map(f => f.name)).toEqual(["研發組"]);
    expect(await noteFolderCols(pool, stale2)).toEqual({ folder_id: roots[0]!.id, trash_folder_path: ["X"] });
  });

  it("FG-4 撞名與尾碼（M7、n-r4-1）：根層已有「研發組」→「研發組 (2)」、快照前接「研發組 (2)」；再有「研發組 (2)」→「研發組 (3)」；已有 team、群組名 Team → Team (2)（lower 比對）", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);
    const existing = (await seedFolder(db, { personal: r.id }, { name: "研發組" })).id;
    const before = await folderRow(pool, existing);

    const g = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    const A = (await seedFolder(db, { group: g.id }, { name: "A" })).id;
    const ts = await trashedNote(db, { groupId: g.id }, r.id, null, ["X"]);
    await transferOk(app, g.id, r.id, r.id);
    const top2 = (await rootsOf(pool, r.id)).find(f => f.name === "研發組 (2)");
    expect(top2).toBeDefined();
    expect((await folderRow(pool, A))!.parent_id).toBe(top2!.id);
    expect(await noteFolderCols(pool, ts)).toEqual({ folder_id: null, trash_folder_path: ["研發組 (2)", "X"] });
    expect(await folderRow(pool, existing)).toEqual(before);

    const g3 = await seedGroup(db, "研發組", [{ userId: r.id, role: "admin" }]);
    await seedFolder(db, { group: g3.id }, { name: "A" });
    await transferOk(app, g3.id, r.id, r.id);
    expect((await rootsOf(pool, r.id)).map(f => f.name).sort()).toEqual(["研發組", "研發組 (2)", "研發組 (3)"]);

    const u = await seedUser(db);
    const team = (await seedFolder(db, { personal: u.id }, { name: "team" })).id;
    // 旁觀者：同名但不在接收者的個人根層（共享私人根層、個人子層、別人的個人根層）——探測不得把它們算進去。
    await seedFolder(db, { shared: u.id }, { name: "Team" });
    await seedFolder(db, { personal: u.id }, { name: "Team (2)", parentId: team });
    await seedFolder(db, { personal: (await seedUser(db)).id }, { name: "Team (2)" });
    const t = await seedGroup(db, "Team", [{ userId: u.id, role: "admin" }]);
    await seedFolder(db, { group: t.id }, { name: "A" });
    await transferOk(app, t.id, u.id, u.id);
    expect((await rootsOf(pool, u.id)).map(f => f.name).sort()).toEqual(["Team (2)", "team"]);
  });

  it("FG-5 長名：群組名 80 個字、接收者已有同名 → 新頂層 ≤ 80 code point、以「 (2)」結尾", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);
    const long = "名".repeat(80);
    await seedFolder(db, { personal: r.id }, { name: long });
    const g = await seedGroup(db, long, [{ userId: r.id, role: "admin" }]);
    await seedFolder(db, { group: g.id }, { name: "A" });
    await transferOk(app, g.id, r.id, r.id);
    const top = (await rootsOf(pool, r.id)).find(f => f.name !== long)!;
    expect(Array.from(top.name).length).toBeLessThanOrEqual(80);
    expect(top.name).toBe(`${"名".repeat(76)} (2)`);
  });

  it("FG-6 固定名（r3 n-5）：群組名全是控制字元 → zh-TW「群組」、en-US「Group」、不帶「Group」；NFD 群組名 → NFC 新頂層名", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const cases: Array<[string | undefined, string]> = [["zh-TW,zh;q=0.9,en;q=0.8", "群組"], ["en-US,en;q=0.9", "Group"], [undefined, "Group"]];
    for (const [lang, expected] of cases) {
      const r = await seedUser(db);
      const g = await seedGroup(db, "tmp", [{ userId: r.id, role: "admin" }]);
      await pool.query("update groups set name = $2 where id = $1", [g.id, CTRL_NAME]);
      await seedFolder(db, { group: g.id }, { name: "A" });
      await transferOk(app, g.id, r.id, r.id, lang);
      expect((await rootsOf(pool, r.id)).map(f => f.name), String(lang)).toEqual([expected]);
    }

    const r = await seedUser(db);
    const g = await seedGroup(db, `Cafe${COMBINING_ACUTE}`, [{ userId: r.id, role: "admin" }]);
    await seedFolder(db, { group: g.id }, { name: "A" });
    await transferOk(app, g.id, r.id, r.id, "zh-TW");
    expect((await rootsOf(pool, r.id)).map(f => f.name)).toEqual([`Caf${E_ACUTE}`]);
  });

  it("FG-7 深度不擋：群組樹 5 層 → 轉移後接收者的樹 6 層、204；整庫沒有父子或筆記與資料夾不同空間；最深那篇位置不變", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const [r, q] = [await seedUser(db), await seedUser(db)];
    const g = await seedGroup(db, "Deep", [{ userId: q.id, role: "admin" }, { userId: r.id, role: "admin" }]);
    const chain = await seedFolderChain(db, { group: g.id }, ["L1", "L2", "L3", "L4", "L5"]);
    const n = await liveNote(db, { groupId: g.id }, chain[4]!);
    await transferOk(app, g.id, q.id, r.id);
    expect(await spaceViolations(pool)).toEqual({ parentChild: 0, noteFolder: 0 });
    expect(await pathOf(pool, chain[4]!)).toEqual(["Deep", "L1", "L2", "L3", "L4", "L5"]);
    expect(await noteFolderCols(pool, n)).toEqual({ folder_id: chain[4], trash_folder_path: null });
  });
});

describe("刪群組・全刪", () => {
  it("FG-8 群組資料夾與子資料夾都不在；別的群組資料夾、筆記不動", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client;
    const r = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: r.id, role: "admin" }]);
    const h = await seedGroup(db, "H", [{ userId: r.id, role: "admin" }]);
    const [A, B] = await seedFolderChain(db, { group: g.id }, ["A", "B"]);
    await liveNote(db, { groupId: g.id }, B!);
    const [HA] = await seedFolderChain(db, { group: h.id }, ["HA"]);
    const hn = await liveNote(db, { groupId: h.id }, HA!);
    const hBefore = await folderRow(pool, HA!);

    const res = await deleteAll(app, g.id, r.id);
    expect(res.statusCode, res.body).toBe(204);
    expect(await folderRow(pool, A!)).toBeUndefined();
    expect(await folderRow(pool, B!)).toBeUndefined();
    expect(await groupFolderCount(pool, g.id)).toBe(0);
    expect(await folderRow(pool, HA!)).toEqual(hBefore);
    expect(await noteFolderCols(pool, hn)).toEqual({ folder_id: HA, trash_folder_path: null });
  });
});

describe("刪群組：結構鎖等太久 → 409 server_busy", () => {
  /** 另一條連線持住 key 的結構鎖，期間跑 act；`try { rollback } finally { release }`。 */
  async function whileHolding<T>(pool: Pool, key: string, act: () => Promise<T>): Promise<T> {
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
      return await act();
    } finally {
      try {
        await holder.query("rollback");
      } finally {
        holder.release();
      }
    }
  }
  async function busy(res: Promise<LightMyRequestResponse>): Promise<void> {
    const t0 = Date.now();
    const r = await res;
    const ms = Date.now() - t0;
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toEqual({ error: { code: "server_busy", message: "伺服器忙碌，請稍後再試" } });
    expect(ms).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS); // 注入值（300 ms）有生效，不是本檔預設 60 s
  }
  const groupExists = async (pool: Pool, id: string) => (await pool.query("select 1 from groups where id = $1", [id])).rowCount === 1;

  it("FG-9 轉移（另一位管理員 q 發動、轉給 r）：群組空間的鎖、接收者 r 個人空間的鎖各被持住（lock_timeout 300 ms）→ 409 server_busy（< 20 s）、群組與資料夾原封；放掉後 204", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const pool = db.$client;
    const [r, q] = [await seedUser(db), await seedUser(db)];
    const g = await seedGroup(db, "G", [{ userId: q.id, role: "admin" }, { userId: r.id, role: "admin" }]);
    const A = (await seedFolder(db, { group: g.id }, { name: "A" })).id;
    const n = await liveNote(db, { groupId: g.id }, A);
    const before = await folderRow(pool, A);

    for (const key of [`knotebook.folders:group:${g.id}`, `knotebook.folders:personal:${r.id}`]) {
      await whileHolding(pool, key, () => busy(transfer(app, g.id, q.id, r.id)));
      expect(await groupExists(pool, g.id), key).toBe(true);
      expect(await folderRow(pool, A), key).toEqual(before);
      expect(await personalFolders(pool, r.id), key).toEqual([]);
      expect((await pool.query("select group_id from notes where id = $1", [n])).rows[0].group_id, key).toBe(g.id);
    }
    await transferOk(app, g.id, r.id, r.id);
  });

  it("FG-10 全刪：群組空間的鎖被持住（lock_timeout 300 ms）→ 409 server_busy（< 20 s）、群組、資料夾、筆記原封；放掉後 204", async () => {
    const { app, db } = await buildTestApp({ storageLockTimeoutMs: 300 });
    const pool = db.$client;
    const r = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: r.id, role: "admin" }]);
    const A = (await seedFolder(db, { group: g.id }, { name: "A" })).id;
    const n = await liveNote(db, { groupId: g.id }, A);

    await whileHolding(pool, `knotebook.folders:group:${g.id}`, () => busy(deleteAll(app, g.id, r.id)));
    expect(await groupExists(pool, g.id)).toBe(true);
    expect(await folderRow(pool, A)).toBeDefined();
    expect(await noteFolderCols(pool, n)).toEqual({ folder_id: A, trash_folder_path: null });
    const res = await deleteAll(app, g.id, r.id);
    expect(res.statusCode, res.body).toBe(204);
  });
});

describe("舊碼相容（§7【推-4】）：4a7e0c1 的交易本體在新 schema 上照跑", () => {
  it("FG-OLD 舊版移入群組、轉移、全刪、還原：都成功；歸屬變了的筆記 folder_id 自癒成 NULL，群組資料夾隨 DELETE groups CASCADE，還原回原資料夾或根層", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const lockTimeoutMs = DEFAULT_STORAGE_LOCK_TIMEOUT_MS;

    // ① 移入群組：個人筆記在個人資料夾 → 群組筆記、folder_id NULL（trigger 自癒）
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const PF = (await seedFolder(db, { personal: u.id })).id;
    const moved = await liveNote(db, { ownerId: u.id }, PF);
    await db.transaction(tx => legacyMoveNoteToGroupInTx(tx, { noteId: moved, userId: u.id, userHandle: u.handle, groupId: g.id, lockTimeoutMs }));
    expect((await pool.query("select owner_id, group_id, folder_id from notes where id = $1", [moved])).rows[0])
      .toEqual({ owner_id: null, group_id: g.id, folder_id: null });
    expect(await folderRow(pool, PF)).toBeDefined();

    // ② 轉移：群組資料夾裡的活筆記與垃圾桶筆記 → 接收者的個人筆記、folder_id NULL；群組資料夾 CASCADE
    const r = await seedUser(db);
    const g2 = await seedGroup(db, "G2", [{ userId: r.id, role: "admin" }]);
    const [GA, GB] = await seedFolderChain(db, { group: g2.id }, ["A", "B"]);
    const inB = await liveNote(db, { groupId: g2.id }, GB!);
    const trashedInA = await trashedNote(db, { groupId: g2.id }, r.id, GA!, ["A"]);
    await db.transaction(tx => legacyTransferGroupInTx(tx, { groupId: g2.id, transferTo: r.id, lockTimeoutMs }));
    for (const id of [inB, trashedInA]) {
      expect((await pool.query("select owner_id, group_id, folder_id from notes where id = $1", [id])).rows[0])
        .toEqual({ owner_id: r.id, group_id: null, folder_id: null });
    }
    expect(await folderRow(pool, GA!)).toBeUndefined();
    expect(await folderRow(pool, GB!)).toBeUndefined();
    expect(await personalFolders(pool, r.id)).toEqual([]);

    // ③ 全刪：資料夾 CASCADE、筆記刪除
    const g3 = await seedGroup(db, "G3", [{ userId: r.id, role: "admin" }]);
    const [HA, HB] = await seedFolderChain(db, { group: g3.id }, ["A", "B"]);
    const doomed = await liveNote(db, { groupId: g3.id }, HB!);
    await db.transaction(tx => legacyDeleteGroupWithNotesInTx(tx, { groupId: g3.id }));
    expect(await folderRow(pool, HA!)).toBeUndefined();
    expect(await folderRow(pool, HB!)).toBeUndefined();
    expect(await noteFolderCols(pool, doomed)).toBeUndefined();

    // ④ 還原：資料夾還在 → 回原資料夾、快照殘留；資料夾已刪 → 根層
    const keep = (await seedFolder(db, { personal: u.id }, { name: "Keep" })).id;
    const gone = (await seedFolder(db, { personal: u.id }, { name: "Gone" })).id;
    const back = await trashedNote(db, { ownerId: u.id }, u.id, keep, ["Keep"]);
    const orphan = await trashedNote(db, { ownerId: u.id }, u.id, gone, ["Gone"]);
    await pool.query("delete from folders where id = $1", [gone]);
    const out = await db.transaction(tx => legacyRestoreNotesInTx(tx, { ids: [back, orphan], by: u.id }));
    expect(out).toEqual({ done: [back, orphan], skipped: [] });
    expect(await noteFolderCols(pool, back)).toEqual({ folder_id: keep, trash_folder_path: ["Keep"] });
    expect(await noteFolderCols(pool, orphan)).toEqual({ folder_id: null, trash_folder_path: ["Gone"] });
    for (const id of [back, orphan]) expect((await trashCols(pool, id))?.deleted_at).toBeNull();
  });
});
