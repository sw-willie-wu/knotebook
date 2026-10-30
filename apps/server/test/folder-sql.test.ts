/**
 * 資料夾 PR-3a T3：SQL 片段（`folders/sql.ts`）、可見性查詢（`folders/queries.ts`）、結構鎖與交易內讀取（`folders/tx/lock.ts`）。
 * 直接對 DB 跑，不經路由。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { FOLDER_DEPTH_MAX, type FolderPermissionsDto } from "@knotebook/shared";
import { createDb, type Db } from "../src/db/index.js";
import type { Tx } from "../src/db/tx.js";
import { folders, groupMembers, notes } from "../src/db/schema.js";
import type { GroupHookCtx, GroupRacePoint } from "../src/groups/test-hook.js";
import type { FolderSpace } from "../src/folders/space.js";
import {
  FOLDER_CTE_DEPTH_LIMIT, NOTES_FOLDER_ID, folderAncestorIdsSql, folderDepthSql, folderPathJsonSql, folderSpaceWhere, subtreeFolderIdsSql, subtreeHeightSql,
} from "../src/folders/sql.js";
import { listVisibleFolders, resolveFolderAccess } from "../src/folders/queries.js";
import { folderAccessInTx, lockFolderInTx, lockFolderSpacesInTx, lockGroupsKeyShareInTx, memberFlagsInTx } from "../src/folders/tx/lock.js";
import { freshDb } from "./helpers.js";
import { seedGroup, seedNote, seedRole, seedUser, waitForBlockedOrSettled, waitForLockWaiters } from "./group-helpers.js";
import { sixRoleScene } from "./trash-helpers.js";
import { noteFolderCols, seedFolder, seedFolderChain, setNoteFolder } from "./folder-helpers.js";
import { INJECTED_LOCK_TIMEOUT_BOUND_MS, SLOW_DEFAULT_LOCK_TIMEOUT_MS } from "./lock-timeout-bound.js";

/** drizzle logger 會記交易控制語句（H7）——數 SQL 前先濾掉。 */
const TXN_CONTROL = /^(begin|commit|rollback)\b/i;
const loggedDb = (pool: Pool, queries: string[]) => drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
const ids = async (db: Db, inner: ReturnType<typeof subtreeFolderIdsSql>) =>
  (await db.execute<{ id: string }>(sql`select id from folders where id in (${inner})`)).rows.map(r => r.id).sort();
const scalar = async <T>(db: Db, expr: ReturnType<typeof sql>) => (await db.execute<{ v: T }>(sql`select ${expr} as v`)).rows[0]!.v;
const sorted = (...xs: string[]) => [...xs].sort();

/** 交易 A 以 `lock` 取鎖後停住，跑完 `fn` 才放（`fn` 斷言失敗也放，免得持鎖交易卡住 teardown）。 */
async function whileHeld(db: Db, lock: (tx: Tx) => Promise<unknown>, fn: () => Promise<void>): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let locked!: () => void;
  const ready = new Promise<void>(r => { locked = r; });
  const done = db.transaction(async tx => {
    await lock(tx);
    locked();
    await gate;
  });
  await ready;
  try {
    await fn();
  } finally {
    release();
    await done;
  }
}
const holdSpaces = (spaces: readonly FolderSpace[]) => (tx: Tx) => lockFolderSpacesInTx(tx, spaces, { lockTimeoutMs: 5_000 });

describe("資料夾 SQL 片段（folders/sql.ts）", () => {
  it("S-1 路徑：三層 A › B \"q\" › C 的筆記得根→葉陣列；在 A 得 [A]；根層 NULL；同一式放進 UPDATE 一樣", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const [a, , c] = await seedFolderChain(db, { personal: u.id }, ["A", 'B "q"', "C"]);
    const inC = await seedNote(db, { ownerId: u.id });
    const inA = await seedNote(db, { ownerId: u.id });
    const atRoot = await seedNote(db, { ownerId: u.id });
    await setNoteFolder(pool, inC.id, c!);
    await setNoteFolder(pool, inA.id, a!);
    const pathOf = async (noteId: string) =>
      (await db.select({ p: folderPathJsonSql(NOTES_FOLDER_ID()) }).from(notes).where(eq(notes.id, noteId)))[0]!.p;
    expect(await pathOf(inC.id)).toEqual(["A", 'B "q"', "C"]);
    expect(await pathOf(inA.id)).toEqual(["A"]);
    expect(await pathOf(atRoot.id)).toBeNull();

    await db.update(notes).set({ trashFolderPath: folderPathJsonSql(NOTES_FOLDER_ID()) }).where(inArray(notes.id, [inC.id, inA.id, atRoot.id]));
    expect(await noteFolderCols(pool, inC.id)).toEqual({ folder_id: c, trash_folder_path: ["A", 'B "q"', "C"] });
    expect(await noteFolderCols(pool, inA.id)).toEqual({ folder_id: a, trash_folder_path: ["A"] });
    expect(await noteFolderCols(pool, atRoot.id)).toEqual({ folder_id: null, trash_folder_path: null });
  });

  it("S-2 子樹：R›{X›{Y}, Z} 與另一棵 S›{S1} → R 恰 {R,X,Y,Z}；X 恰 {X,Y}", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const sp = { personal: u.id };
    const [r, x, y] = await seedFolderChain(db, sp, ["R", "X", "Y"]);
    const z = await seedFolder(db, sp, { parentId: r!, name: "Z" });
    await seedFolderChain(db, sp, ["S", "S1"]);
    expect(await ids(db, subtreeFolderIdsSql(r!))).toEqual(sorted(r!, x!, y!, z.id));
    expect(await ids(db, subtreeFolderIdsSql(x!))).toEqual(sorted(x!, y!));
  });

  it("S-3 深度／高度／祖先：R 深 1、Y 深 3；R 高 3、Y 高 1；Y 的祖先 {Y,X,R}", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const [r, x, y] = await seedFolderChain(db, { personal: u.id }, ["R", "X", "Y"]);
    await seedFolderChain(db, { personal: u.id }, ["S", "S1"]);
    expect(await scalar<number>(db, folderDepthSql(r!))).toBe(1);
    expect(await scalar<number>(db, folderDepthSql(y!))).toBe(3);
    expect(await scalar<number>(db, subtreeHeightSql(r!))).toBe(3);
    expect(await scalar<number>(db, subtreeHeightSql(y!))).toBe(1);
    expect(await ids(db, folderAncestorIdsSql(y!))).toEqual(sorted(y!, x!, r!));
  });

  it("S-11 遞迴上限：恰 FOLDER_CTE_DEPTH_LIMIT 層的鏈完整走到；人為成環 → 每支查詢在上限內結束（statement_timeout 2 s 下不掛住）", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const N = FOLDER_CTE_DEPTH_LIMIT;
    // 上限要高於正常可達的最深（FOLDER_DEPTH_MAX + 1：轉移多一層新頂層），合法的樹才不會被截
    expect(N).toBeGreaterThan(FOLDER_DEPTH_MAX + 1);
    const bounded = async <T>(q: ReturnType<typeof sql>) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '2s'`);
      return (await tx.execute<{ v: T }>(q)).rows.map(r => r.v);
    });
    const count = (inner: ReturnType<typeof subtreeFolderIdsSql>) => sql`select count(*)::int as v from (${inner}) kf_t`;
    const pathSql = (noteId: string) => sql`select ${folderPathJsonSql(NOTES_FOLDER_ID())} as v from notes where notes.id = ${noteId}`;

    // 邊界：恰 N 層的鏈不被截
    const names = Array.from({ length: N }, (_, i) => `L${i + 1}`);
    const chain = await seedFolderChain(db, { personal: u.id }, names);
    const leaf = await seedNote(db, { ownerId: u.id });
    await setNoteFolder(pool, leaf.id, chain[N - 1]!);
    expect(await bounded<string[]>(pathSql(leaf.id))).toEqual([names]);
    expect(await bounded<number>(sql`select ${folderDepthSql(chain[N - 1]!)} as v`)).toEqual([N]);
    expect(await bounded<number>(sql`select ${subtreeHeightSql(chain[0]!)} as v`)).toEqual([N]);
    expect(await bounded<number>(count(subtreeFolderIdsSql(chain[0]!)))).toEqual([N]);
    expect(await bounded<number>(count(folderAncestorIdsSql(chain[N - 1]!)))).toEqual([N]);

    // 成環 CA ↔ CB（DB 不守成環；直寫造出來）：每支都在 N 層停
    const [ca, cb] = await seedFolderChain(db, { personal: u.id }, ["CA", "CB"]);
    await pool.query("update folders set parent_id = $2 where id = $1", [ca, cb]);
    const inCa = await seedNote(db, { ownerId: u.id });
    await setNoteFolder(pool, inCa.id, ca!);
    const cyclePath = Array.from({ length: N }, (_, i) => ((N - 1 - i) % 2 === 0 ? "CA" : "CB"));
    await expect(bounded<string[]>(pathSql(inCa.id))).resolves.toEqual([cyclePath]);
    await expect(bounded<number>(sql`select ${folderDepthSql(ca!)} as v`)).resolves.toEqual([N]);
    await expect(bounded<number>(sql`select ${subtreeHeightSql(ca!)} as v`)).resolves.toEqual([N]);
    await expect(bounded<number>(count(subtreeFolderIdsSql(ca!)))).resolves.toEqual([N]);
    await expect(bounded<number>(count(folderAncestorIdsSql(ca!)))).resolves.toEqual([N]);
  });

  it("S-8 渲染：單表 UPDATE 與單表 SELECT 的路徑子查詢裡外層欄都帶表名 \"notes\".\"folder_id\"", async () => {
    const { db } = await freshDb();
    const upd = db.update(notes).set({ trashFolderPath: folderPathJsonSql(NOTES_FOLDER_ID()) }).where(eq(notes.id, randomUUID())).toSQL().sql;
    expect(upd).toContain('where f.id = "notes"."folder_id"');
    // 單表 SELECT 才是 drizzle 會把直接傳入的欄位渲染成裸 "folder_id" 的形（UPDATE 照樣帶表名，0.44 實測）
    const sel = db.select({ p: folderPathJsonSql(NOTES_FOLDER_ID()) }).from(notes).toSQL().sql;
    expect(sel).toContain('where f.id = "notes"."folder_id"');
  });

  it("S-10 folderSpaceWhere：personal／shared／group 各只選到自己空間的資料夾", async () => {
    const { db } = await freshDb();
    const [u, v] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const g2 = await seedGroup(db, "G2", [{ userId: u.id, role: "admin" }]);
    const up = await seedFolder(db, { personal: u.id });
    const us = await seedFolder(db, { shared: u.id });
    const vp = await seedFolder(db, { personal: v.id });
    const gf = await seedFolder(db, { group: g.id });
    await seedFolder(db, { group: g2.id });
    const pick = async (space: FolderSpace) => (await db.select({ id: folders.id }).from(folders).where(folderSpaceWhere(space))).map(r => r.id);
    expect(await pick({ kind: "personal", ownerId: u.id })).toEqual([up.id]);
    expect(await pick({ kind: "shared", ownerId: u.id })).toEqual([us.id]);
    expect(await pick({ kind: "personal", ownerId: v.id })).toEqual([vp.id]);
    expect(await pick({ kind: "group", groupId: g.id })).toEqual([gf.id]);
  });
});

describe("資料夾可見性（folders/queries.ts、folders/tx/lock.ts）", () => {
  it("S-4 可見性：群組資料夾照角色推導權限；全 false 角色、outsider → null；personal／shared 只對 owner；隨機 uuid、非 UUID → null；交易內同推導", async () => {
    const { db } = await freshDb();
    const s = await sixRoleScene(db);
    const noRead = await seedUser(db);
    const noReadRole = await seedRole(db, s.groupId, "nothing", {});
    await db.insert(groupMembers).values({ groupId: s.groupId, userId: noRead.id, roleId: noReadRole });
    const gf = await seedFolder(db, { group: s.groupId });
    const pf = await seedFolder(db, { personal: s.admin.id });
    const sf = await seedFolder(db, { shared: s.admin.id });

    const P = (manage: boolean, deleteNotes: boolean, createNote: boolean): FolderPermissionsDto => ({ manage, deleteNotes, createNote });
    const expected: Array<[string, string, FolderPermissionsDto | null]> = [
      ["admin", s.admin.id, P(true, true, true)],
      ["member", s.member.id, P(true, false, true)],
      ["editDelete", s.editDelete.id, P(true, true, false)],
      ["deleteOnly", s.deleteOnly.id, P(false, true, false)],
      ["editOnly", s.editOnly.id, P(true, false, false)],
      ["readOnly", s.readOnly.id, P(false, false, false)],
      ["noRead", noRead.id, null],
      ["outsider", s.outsider.id, null],
    ];
    const [gfRow] = await db.select().from(folders).where(eq(folders.id, gf.id));
    for (const [name, userId, perms] of expected) {
      const access = await resolveFolderAccess(db, userId, gf.id);
      expect(access?.permissions ?? null, name).toEqual(perms);
      if (access) {
        expect(access.folder.id, name).toBe(gf.id);
        expect(access.space, name).toEqual({ kind: "group", groupId: s.groupId });
      }
      const inTx = await db.transaction(tx => folderAccessInTx(tx, userId, gfRow!));
      expect(inTx, `${name}（交易內）`).toEqual(access);
    }
    expect((await resolveFolderAccess(db, s.admin.id, pf.id))?.permissions).toEqual(P(true, true, true));
    expect(await resolveFolderAccess(db, s.member.id, pf.id)).toBeNull();
    expect((await resolveFolderAccess(db, s.admin.id, sf.id))?.permissions).toEqual(P(true, true, false));
    expect(await resolveFolderAccess(db, s.member.id, sf.id)).toBeNull();
    const [pfRow] = await db.select().from(folders).where(eq(folders.id, pf.id));
    expect((await db.transaction(tx => folderAccessInTx(tx, s.admin.id, pfRow!)))?.permissions).toEqual(P(true, true, true));
    expect(await db.transaction(tx => folderAccessInTx(tx, s.member.id, pfRow!))).toBeNull();
    expect(await resolveFolderAccess(db, s.admin.id, randomUUID())).toBeNull();
    await expect(resolveFolderAccess(db, s.admin.id, "x")).resolves.toBeNull();

    // 站台管理員沒有特權（spec §5.5）：非成員看不到群組資料夾、看不到別人的 personal／shared，清單也是空的
    const siteAdmin = await seedUser(db, { isAdmin: true });
    for (const f of [gf, pf, sf]) expect(await resolveFolderAccess(db, siteAdmin.id, f.id), f.name).toBeNull();
    expect(await db.transaction(tx => folderAccessInTx(tx, siteAdmin.id, gfRow!))).toBeNull();
    expect(await listVisibleFolders(db, siteAdmin.id)).toEqual([]);

    // memberFlagsInTx：成員回四旗標、非成員 null
    expect(await db.transaction(tx => memberFlagsInTx(tx, s.member.id, s.groupId))).toEqual({ canRead: true, canCreate: true, canEdit: true, canDelete: false });
    expect(await db.transaction(tx => memberFlagsInTx(tx, s.outsider.id, s.groupId))).toBeNull();
  });

  it("S-5 清單：只得我的 personal、shared 與我能讀的群組資料夾；順序 kind → 空間 → 根層先 → lower(name) → id；permissions 逐列；createdAt ISO", async () => {
    const { db } = await freshDb();
    const [me, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const gMine = await seedGroup(db, "Mine", [{ userId: me.id, role: "admin" }, { userId: other.id, role: "member" }]);
    const gReadOnly = await seedGroup(db, "RO", [{ userId: other.id, role: "admin" }]);
    const roRole = await seedRole(db, gReadOnly.id, "ro", { canRead: true });
    await db.insert(groupMembers).values({ groupId: gReadOnly.id, userId: me.id, roleId: roRole });
    const gOthers = await seedGroup(db, "Others", [{ userId: other.id, role: "admin" }]);
    const gNoRead = await seedGroup(db, "NoRead", [{ userId: other.id, role: "admin" }]);
    const nrRole = await seedRole(db, gNoRead.id, "nr", {});
    await db.insert(groupMembers).values({ groupId: gNoRead.id, userId: me.id, roleId: nrRole });

    const mk = (space: Parameters<typeof seedFolder>[1], name: string, parentId?: string) =>
      seedFolder(db, space, { name, ...(parentId ? { parentId } : {}) });
    const pB = await mk({ personal: me.id }, "B1");
    const pA = await mk({ personal: me.id }, "a2");
    const pChild = await mk({ personal: me.id }, "0child", pB.id);
    const sh = await mk({ shared: me.id }, "shared");
    const gm1 = await mk({ group: gMine.id }, "zz");
    const gm0 = await mk({ group: gMine.id }, "Yy");
    const ro = await mk({ group: gReadOnly.id }, "ro");
    await mk({ group: gOthers.id }, "others");
    await mk({ group: gNoRead.id }, "noread");
    await mk({ personal: other.id }, "theirs");
    await mk({ shared: other.id }, "theirs-shared");

    const T = { manage: true, deleteNotes: true, createNote: true };
    const RO = { manage: false, deleteNotes: false, createNote: false };
    const SH = { manage: true, deleteNotes: true, createNote: false };
    const groupBlocks = [
      { gid: gMine.id, rows: [[gm0, null, T], [gm1, null, T]] as const },
      { gid: gReadOnly.id, rows: [[ro, null, RO]] as const },
    ].sort((x, y) => (x.gid < y.gid ? -1 : 1));
    const expected = [
      ...groupBlocks.flatMap(b => b.rows.map(([f, parentId, permissions]) => ({ id: f.id, name: f.name, parentId, space: { kind: "group", groupId: b.gid }, permissions }))),
      ...([[pA, null], [pB, null], [pChild, pB.id]] as const).map(([f, parentId]) => ({ id: f.id, name: f.name, parentId, space: { kind: "personal" }, permissions: T })),
      { id: sh.id, name: sh.name, parentId: null, space: { kind: "shared" }, permissions: SH },
    ];
    // resolves：SQL 篩選與 folderAccessOf 不一致時 listVisibleFolders 會 throw，這裡要以斷言失敗呈現
    await expect(listVisibleFolders(db, me.id).then(l => l.map(({ createdAt: _c, ...rest }) => rest))).resolves.toEqual(expected);
    const list = await listVisibleFolders(db, me.id);
    const created = new Map((await db.select({ id: folders.id, createdAt: folders.createdAt }).from(folders)).map(r => [r.id, r.createdAt.toISOString()]));
    for (const f of list) expect(f.createdAt, f.name).toBe(created.get(f.id));
  });

  it("S-9 lockFolderInTx：回整列；不存在 → undefined；update 擋 key share、key share 不擋 key share", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const f = await seedFolder(db, { personal: u.id }, { name: "F" });
    const row = await db.transaction(tx => lockFolderInTx(tx, f.id, "key share"));
    expect(row).toMatchObject({ id: f.id, kind: "personal", ownerId: u.id, groupId: null, parentId: null, name: "F" });
    expect(await db.transaction(tx => lockFolderInTx(tx, randomUUID(), "update"))).toBeUndefined();

    const ks = () => db.transaction(tx => lockFolderInTx(tx, f.id, "key share"));
    let b: Promise<unknown> = Promise.resolve();
    await whileHeld(db, tx => lockFolderInTx(tx, f.id, "update"), async () => {
      b = ks();
      expect(await waitForBlockedOrSettled(pool, b)).toBe("blocked");
    });
    await b;
    await whileHeld(db, tx => lockFolderInTx(tx, f.id, "key share"), async () => {
      expect(await waitForBlockedOrSettled(pool, ks())).toBe("settled");
    });
  });
});

describe("結構鎖與 groups KS（folders/tx/lock.ts）", () => {
  it("S-6a 結構鎖互斥：異鍵不等、同鍵等、大寫 id 的同空間也等（鍵小寫）", async () => {
    const { db, pool } = await freshDb();
    const [u, v] = await Promise.all([seedUser(db), seedUser(db)]);
    const mine: FolderSpace = { kind: "personal", ownerId: u.id };
    const lockB = (spaces: readonly FolderSpace[]) => db.transaction(tx => lockFolderSpacesInTx(tx, spaces, { lockTimeoutMs: 5_000 }));
    let pending: Promise<unknown> = Promise.resolve();
    await whileHeld(db, holdSpaces([mine]), async () => {
      // 異鍵（別人的 personal、自己的 shared）→ 不等（先測：此時沒有其他等鎖者）
      const otherKey = lockB([{ kind: "personal", ownerId: v.id }, { kind: "shared", ownerId: u.id }]);
      pending = otherKey;
      expect(await waitForBlockedOrSettled(pool, otherKey)).toBe("settled");
      await otherKey;
      // 同鍵 → 等
      pending = lockB([mine]);
      await waitForLockWaiters(pool, 1);
    });
    await pending;
    await whileHeld(db, holdSpaces([mine]), async () => {
      pending = lockB([{ kind: "personal", ownerId: u.id.toUpperCase() }]);
      expect(await waitForBlockedOrSettled(pool, pending)).toBe("blocked");
    });
    await pending;
  });

  it("S-6b 逾時：A 不放、B 的上限 200 ms → 55P03，而且是 200 ms 級（不是交易原本的上限）", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const mine: FolderSpace = { kind: "personal", ownerId: u.id };
    await whileHeld(db, holdSpaces([mine]), async () => {
      const t0 = Date.now();
      // 交易原本的上限先設成 60 s（session 預設是 0＝無限等）：200 ms 沒套上的話要等滿 60 s 才 55P03，牆鐘界線 20 s 離兩邊都遠
      // （見 ./lock-timeout-bound.ts；以前 200 ms 對 3 s 界線，對照組是無限等）。
      const err = await db
        .transaction(async tx => {
          await tx.execute(sql.raw(`set local lock_timeout = '${SLOW_DEFAULT_LOCK_TIMEOUT_MS}ms'`));
          await lockFolderSpacesInTx(tx, [mine], { lockTimeoutMs: 200 });
        })
        .catch((e: unknown) => e);
      expect((err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code).toBe("55P03");
      expect(Date.now() - t0).toBeLessThan(INJECTED_LOCK_TIMEOUT_BOUND_MS);
    });
  });

  it("S-6c lock_timeout 只罩取鎖那幾句：交易內與 commit 後同一條連線都回到 database 層設的 7s（不是寫死 0、不是 session 層）", async () => {
    const { db, url } = await freshDb();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    // database 層設 7s（`TO DEFAULT` 要回到這個值）；只有之後新開的連線吃得到，故另開 pool；max 1 ⇒ commit 後量的是同一條連線
    const dbName = (await db.$client.query<{ d: string }>("select current_database() as d")).rows[0]!.d;
    await db.$client.query(`alter database "${dbName}" set lock_timeout = '7s'`);
    const pool2 = new Pool({ connectionString: url, max: 1 });
    try {
      const db2 = createDb(pool2);
      const show = async () => String((await pool2.query<{ lock_timeout: string }>("show lock_timeout")).rows[0]!.lock_timeout);
      expect(await show()).toBe("7s");
      let inside = "";
      await db2.transaction(async tx => {
        await lockFolderSpacesInTx(tx, [{ kind: "personal", ownerId: u.id }, { kind: "group", groupId: g.id }], { lockTimeoutMs: 200 });
        inside = String((await tx.execute<{ lock_timeout: string }>(sql`show lock_timeout`)).rows[0]!.lock_timeout);
      });
      expect(inside).toBe("7s");
      expect(await show()).toBe("7s");
    } finally {
      await pool2.end();
      await db.$client.query(`alter database "${dbName}" reset lock_timeout`);
    }
  });

  it("S-6d lockTimeoutMs 必須是正整數（0／負數／小數／NaN → throw，不送進 PG）；鍵空時不驗、直接回", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const mine: FolderSpace = { kind: "personal", ownerId: u.id };
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(db.transaction(tx => lockFolderSpacesInTx(tx, [mine], { lockTimeoutMs: bad })), String(bad)).rejects.toThrow(/lockTimeoutMs/);
    }
    await expect(db.transaction(tx => lockFolderSpacesInTx(tx, [], { lockTimeoutMs: 0 }))).resolves.toBeUndefined();
  });

  it("S-6e 縫：三把鍵（含一個重複空間）全部取完之後恰呼叫一次、ctx 原樣", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const mine: FolderSpace = { kind: "personal", ownerId: u.id };
    const queries: string[] = [];
    const logged = loggedDb(pool, queries);
    const calls: Array<{ point: GroupRacePoint; ctx: GroupHookCtx; stmts: number }> = [];
    const ctx: GroupHookCtx = { folderId: randomUUID(), groupId: g.id };
    await logged.transaction(tx => lockFolderSpacesInTx(tx, [{ kind: "group", groupId: g.id }, mine, { kind: "shared", ownerId: u.id }, mine], {
      lockTimeoutMs: 5_000,
      hook: async (point, c) => { calls.push({ point, ctx: c, stmts: queries.filter(q => !TXN_CONTROL.test(q.trim())).length }); },
      hookCtx: ctx,
    }));
    expect(calls).toEqual([{ point: "folder-structure-locked", ctx, stmts: 9 }]);
  });

  it("S-6f 鍵空：0 句 SQL、不呼叫縫", async () => {
    const { pool } = await freshDb();
    const queries: string[] = [];
    const logged = loggedDb(pool, queries);
    const calls: GroupRacePoint[] = [];
    await logged.transaction(tx => lockFolderSpacesInTx(tx, [], {
      lockTimeoutMs: 5_000,
      hook: async point => { calls.push(point); },
      hookCtx: { folderId: randomUUID() },
    }));
    expect(queries.filter(q => !TXN_CONTROL.test(q.trim()))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("S-7 groups KS：回實際存在的 id；一句、依 id 排序、for key share；空陣列 0 句", async () => {
    const { db, pool } = await freshDb();
    const u = await seedUser(db);
    const g1 = await seedGroup(db, "G1", [{ userId: u.id, role: "admin" }]);
    const g2 = await seedGroup(db, "G2", [{ userId: u.id, role: "admin" }]);
    const queries: string[] = [];
    const logged = loggedDb(pool, queries);
    const got = await logged.transaction(tx => lockGroupsKeyShareInTx(tx, [g2.id, g1.id, randomUUID()]));
    expect(got).toEqual(new Set([g1.id, g2.id]));
    const stmts = queries.filter(q => !TXN_CONTROL.test(q.trim()));
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('order by "groups"."id"');
    expect(stmts[0]).toContain("for key share");

    queries.length = 0;
    expect(await logged.transaction(tx => lockGroupsKeyShareInTx(tx, []))).toEqual(new Set());
    expect(queries.filter(q => !TXN_CONTROL.test(q.trim()))).toEqual([]);
  });
});
