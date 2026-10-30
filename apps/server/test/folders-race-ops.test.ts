/**
 * 資料夾 PR-3a T13：併發（下）——刪群組（轉移、全刪）、共享放置、結構交易彼此（spec docs/superpowers/specs/2026-10-22-folders-design.md
 * §6.18 其餘各組、§5.4、§5.9；plan 附錄 A 鎖序表）。作法同 `folders-race.test.ts`：一方卡在自己交易內的縫，另一方送出後以
 * `waitForLockWaiters` 確認它真的在等鎖（**斷言**，不只是等待），放行後斷言勝方、錯誤碼與 DB 終值。每組兩種先後；每案都斷言沒有
 * 409 `server_busy`（40P01 經 `isRetryableTxError` 會變成它）與資料一致——RG-CN 例外：那組真的會死結，斷言的是 40P01 映成 409。
 * RG-PG／RG-DA 照 trash-race 的 RC-DL：測試連線持一篇的列鎖，讓兩方依序排在它後面（heap 序、created_at 序與 id 序相反的兩篇）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { FolderDeleteResultDto, FolderDto, NoteDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { Db } from "../src/db/index.js";
import { notes } from "../src/db/schema.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import { folderRow, noteFolderCols, placementOf, seedFolder, seedFolderChain, setNoteFolder, setSnapshot } from "./folder-helpers.js";
import { seedGroup, seedNote, seedShare, seedUser, sharesOf, waitForBlockedOrSettled, waitForLockWaiters } from "./group-helpers.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

type Res = LightMyRequestResponse;
const GROUP_NAME = "研發組";

const transfer = (app: FastifyInstance, by: string, groupId: string, to: string) =>
  inject(app, "DELETE", `/api/groups/${groupId}`, by, { mode: "transfer", transferTo: to });
const deleteAll = (app: FastifyInstance, by: string, groupId: string) => inject(app, "DELETE", `/api/groups/${groupId}`, by, { mode: "delete" });
const createFolder = (app: FastifyInstance, by: string, body: { name: string; parentId: string } | { name: string; space: { kind: "group"; groupId: string } }) =>
  inject(app, "POST", "/api/folders", by, body);
const patchFolder = (app: FastifyInstance, by: string, id: string, body: { name?: string; parentId?: string | null }) => inject(app, "PATCH", `/api/folders/${id}`, by, body);
const delFolder = (app: FastifyInstance, by: string, id: string) => inject(app, "DELETE", `/api/folders/${id}`, by);
const place = (app: FastifyInstance, by: string, noteId: string, folderId: string | null) => inject(app, "PUT", `/api/notes/${noteId}/folder`, by, { folderId });
const revoke = (app: FastifyInstance, by: string, noteId: string, userId: string) => inject(app, "DELETE", `/api/notes/${noteId}/shares/${userId}`, by);
const trashNote = (app: FastifyInstance, by: string, noteId: string) => inject(app, "DELETE", `/api/notes/${noteId}`, by);
const restore = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/restore", by, { ids });
const purge = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/purge", by, { ids });
const copy = (app: FastifyInstance, by: string, noteId: string, body: { folderId: string }) => inject(app, "POST", `/api/notes/${noteId}/copy`, by, body);
const move = (app: FastifyInstance, by: string, noteId: string, body: { groupId: string; folderId: string }) => inject(app, "POST", `/api/notes/${noteId}/move`, by, body);

const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const errCode = (r: Res): string | undefined => (r.statusCode >= 400 ? (r.json() as { error?: { code?: string } }).error?.code : undefined);

function okJson<T>(r: Res, status: number): T {
  expect(r.statusCode, r.body).toBe(status);
  return r.json() as T;
}
function failed(r: Res, status: number, code: string): void {
  expect(r.statusCode, r.body).toBe(status);
  expect(errCode(r)).toBe(code);
}

/** 一次性測試縫（`trash-race.test.ts` 的慣例）：`hold` 登記的點第一次觸發時卡住，其餘觸發直接放行。 */
class Seams {
  private readonly handlers = new Map<string, () => Promise<void>>();
  on(name: GroupRacePoint, fn: () => Promise<void>): void {
    this.handlers.set(name, fn);
  }
  async fire(name: GroupRacePoint): Promise<void> {
    const fn = this.handlers.get(name);
    if (!fn) return;
    this.handlers.delete(name);
    await fn();
  }
  /** 在 name 卡住：`entered` 在進縫時 resolve，`open()` 放行。 */
  hold(name: GroupRacePoint): { entered: Promise<void>; open: () => void } {
    let open!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const entered = new Promise<void>(r => { enter = r; });
    this.on(name, async () => {
      enter();
      await gate;
    });
    return { entered, open };
  }
  readonly group: GroupTestHook = point => this.fire(point);
}

/** 等請求走進縫；它若先回應了（沒走到縫）就直接失敗，不空等。 */
async function entered(seam: Promise<void>, req: Promise<Res>): Promise<void> {
  await Promise.race([seam, req.then(r => { throw new Error(`請求沒走到縫就回了 ${r.statusCode} ${r.body}`); })]);
}

/** 至少 n 條連線在等鎖（5 s 內）→ true；逾時 → false（呼叫端先放行、收尾，再以斷言判）。 */
async function sawLockWaiters(pool: Pool, n: number): Promise<boolean> {
  try {
    await waitForLockWaiters(pool, n);
    return true;
  } catch {
    return false;
  }
}

/** 沒有 409 server_busy（40P01／55P03 的映射）、沒有 5xx。鎖序倒置（例：建群組資料夾的結構鎖排到 groups KS 之前）會以 server_busy 在這裡紅。 */
function noBusy(...rs: Res[]): void {
  for (const r of rs) {
    expect(errCode(r), r.body).not.toBe("server_busy");
    expect(r.statusCode, r.body).toBeLessThan(500);
  }
}

interface Scene {
  ctx: CollabTestCtx;
  app: FastifyInstance;
  db: Db;
  pool: Pool;
  seams: Seams;
  /** 等每一次 `releaseDeletingGate` 跑完（release 是 fire-and-forget）。 */
  gatesSettled(): Promise<void>;
}

async function scene(): Promise<Scene> {
  const seams = new Seams();
  const ctx = await buildCollabTestApp({
    collabHooks: (server, log) => createCollabHooks(server, log),
    groupTestHook: seams.group,
    storageLockTimeoutMs: 20_000,
  });
  const rel = vi.spyOn(ctx.collab, "releaseDeletingGate");
  return {
    ctx, app: ctx.app, db: ctx.db, pool: ctx.db.$client, seams,
    gatesSettled: async () => {
      await Promise.all(rel.mock.results.map(r => r.value));
    },
  };
}

/**
 * first 卡在 point；second 送出；斷言 second 真的在等鎖、兩者都不是 server_busy／5xx。回 [first, second] 的回應。
 * `holdSecondUntilFirstReplies`：second 拿到鎖、走到這個縫之後，等 first 回完應答才繼續——first commit 之後在鎖外重讀組回應，
 * 不讓 second 搶在重讀前 commit（那會讓 first 偶爾回成 404）。同 `trash-race-ops.test.ts` 的 `opFirst`。
 */
async function race(
  s: Scene,
  point: GroupRacePoint,
  first: () => Promise<Res>,
  second: () => Promise<Res>,
  holdSecondUntilFirstReplies?: GroupRacePoint,
): Promise<[Res, Res]> {
  // Seams 以點名為鍵：同一點後登記的會蓋掉 first 的 hold。
  if (holdSecondUntilFirstReplies === point) throw new Error(`holdSecondUntilFirstReplies 不能與 point 同為 ${point}`);
  const h = s.seams.hold(point);
  let replied!: () => void;
  const firstReplied = new Promise<void>(r => { replied = r; });
  if (holdSecondUntilFirstReplies !== undefined) s.seams.on(holdSecondUntilFirstReplies, () => firstReplied);
  const p1 = first().finally(() => replied());
  await entered(h.entered, p1);
  const p2 = second();
  const waited = await sawLockWaiters(s.pool, 1);
  h.open();
  const out: [Res, Res] = [await p1, await p2];
  expect(waited, "第二方在第一方持有的鎖上等（交錯有發生）").toBe(true);
  noBusy(...out);
  return out;
}

/** 全庫不變量：沒有筆記或放置指向不存在的資料夾；活筆記沒有快照；父子、筆記與所在資料夾都同空間；資料夾樹無環。 */
async function expectConsistent(pool: Pool): Promise<void> {
  const { rows } = await pool.query<Record<string, number>>(`select
    (select count(*)::int from notes n where n.folder_id is not null and not exists (select 1 from folders f where f.id = n.folder_id)) as dangling,
    (select count(*)::int from note_placements p where not exists (select 1 from folders f where f.id = p.folder_id)) as dangling_pl,
    (select count(*)::int from notes where deleted_at is null and trash_folder_path is not null) as live_snap,
    (select count(*)::int from folders c join folders p on p.id = c.parent_id
      where (c.kind, c.owner_id, c.group_id) is distinct from (p.kind, p.owner_id, p.group_id)) as parent_child,
    (select count(*)::int from notes n join folders f on f.id = n.folder_id
      where not ((f.kind = 'personal' and f.owner_id is not distinct from n.owner_id) or (f.kind = 'group' and f.group_id is not distinct from n.group_id))) as note_folder`);
  expect(rows[0]).toEqual({ dangling: 0, dangling_pl: 0, live_snap: 0, parent_child: 0, note_folder: 0 });
  expect(await cycles(pool)).toBe(0);
}

/** 遞迴 CTE 由每個資料夾往上走（`CYCLE` 子句偵測重複）；回成環的路徑數。 */
async function cycles(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`with recursive up(start_id, id, parent_id) as (
      select id, id, parent_id from folders
      union all
      select up.start_id, f.id, f.parent_id from up join folders f on f.id = up.parent_id
    ) cycle id set is_cycle using trail
    select count(*)::int as n from up where is_cycle`);
  return rows[0]!.n;
}

async function noteIn(s: Scene, owner: { ownerId: string } | { groupId: string }, folderId: string | null, title?: string): Promise<string> {
  const n = await seedNote(s.db, owner, title !== undefined ? { title } : {});
  if (folderId !== null) await setNoteFolder(s.pool, n.id, folderId);
  return n.id;
}

async function ownerOf(pool: Pool, noteId: string): Promise<{ owner_id: string | null; group_id: string | null } | undefined> {
  const { rows } = await pool.query<{ owner_id: string | null; group_id: string | null }>("select owner_id, group_id from notes where id = $1", [noteId]);
  return rows[0];
}
async function groupExists(pool: Pool, groupId: string): Promise<boolean> {
  return (await pool.query("select 1 from groups where id = $1", [groupId])).rowCount === 1;
}
async function personalRoots(pool: Pool, ownerId: string): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    "select id, name from folders where kind = 'personal' and owner_id = $1 and parent_id is null order by name, id",
    [ownerId],
  );
  return rows;
}
async function folderCountNamed(pool: Pool, name: string): Promise<number> {
  return (await pool.query<{ n: number }>("select count(*)::int as n from folders where name = $1", [name])).rows[0]!.n;
}

/** 內建管理員 q（發動者）與 r（接收者）的群組。 */
async function groupScene(s: Scene) {
  const [q, r] = [await seedUser(s.db), await seedUser(s.db)];
  const g = await seedGroup(s.db, GROUP_NAME, [{ userId: q.id, role: "admin" }, { userId: r.id, role: "admin" }]);
  return { q: q.id, r: r.id, g: g.id };
}

/** 測試連線持一篇的列鎖；回放鎖函式。 */
async function holdRow(pool: Pool, id: string): Promise<() => Promise<void>> {
  const client: PoolClient = await pool.connect();
  await client.query("begin");
  await client.query("select 1 from notes where id = $1 for update", [id]);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await client.query("rollback");
    client.release();
  };
}

/** holder 持 rowId → first 排在它上（等 1）→ second 排上（等 2）→ 放掉。斷言兩段等待都有發生、都不是 server_busy／5xx。 */
async function queueBehind(s: Scene, rowId: string, first: () => Promise<Res>, second: () => Promise<Res>): Promise<[Res, Res]> {
  const release = await holdRow(s.pool, rowId);
  let p1: Promise<Res> | undefined;
  let p2: Promise<Res> | undefined;
  const waited: boolean[] = [];
  try {
    p1 = first();
    waited.push(await sawLockWaiters(s.pool, 1));
    p2 = second();
    waited.push(await sawLockWaiters(s.pool, 2));
  } finally {
    await release();
  }
  const out: [Res, Res] = [await p1, await p2!];
  expect(waited, "兩方依序排在測試連線持有的列鎖上").toEqual([true, true]);
  noBusy(...out);
  return out;
}

/**
 * RG-PG／RG-DA 的場景（r3 `deleteall3`／`purgeB` 形）：群組資料夾 F 裡兩篇垃圾桶筆記 a < b（id），但 b 先插（heap 序在前）、
 * slug 較小、created_at 較早——舊的全刪（不帶 ORDER BY）與轉移（依 created_at）都是 b 先鎖；永久刪除依 id 是 a 先。
 */
async function lockOrderScene(s: Scene) {
  const t = await groupScene(s);
  const F = (await seedFolder(s.db, { group: t.g }, { name: "F" })).id;
  const [a, b] = [randomUUID(), randomUUID()].sort() as [string, string];
  const now = Date.now();
  await s.db.insert(notes).values({ id: b, groupId: t.g, slug: "dl-1", folderId: F, createdAt: new Date(now - 60_000) });
  await s.db.insert(notes).values({ id: a, groupId: t.g, slug: "dl-2", folderId: F, createdAt: new Date(now) });
  // 移入是 UPDATE、寫新的 tuple：照 b、a 的順序一句寫完，新版本的實體順序才維持 b 先。
  for (const id of [b, a]) {
    await s.pool.query(`update notes set deleted_at = now(), deleted_by = $2, trash_folder_path = '["F"]'::jsonb where id = $1`, [id, t.q]);
  }
  const { rows } = await s.pool.query<{ id: string }>("select id from notes where group_id = $1", [t.g]);
  expect(rows.map(r => r.id), "前提：不帶 ORDER BY 的掃描順序是 b、a").toEqual([b, a]);
  return { ...t, F, a, b };
}

describe("RG-PG 轉移與多 id 永久刪除群組垃圾桶筆記（依 id 鎖，讀碼發現 1）", () => {
  it("永久刪除先（排在 a 上）：永久刪除 200 purged [a, b]；轉移 204、轉走 0 篇，F 照樣收進接收者的新頂層", async () => {
    const s = await scene();
    const t = await lockOrderScene(s);
    const [pr, dr] = await queueBehind(s, t.a, () => purge(s.app, t.q, [t.a, t.b]), () => transfer(s.app, t.q, t.g, t.r));
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [t.a, t.b], skipped: [] });
    expect(dr.statusCode, dr.body).toBe(204);
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.b)]).toEqual([undefined, undefined]);
    expect(await groupExists(s.pool, t.g)).toBe(false);
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r, group_id: null, parent_id: roots[0]!.id });
    await expectConsistent(s.pool);
  });

  it("轉移先（排在 b 上、已鎖 a）：轉移 204、兩篇成了接收者垃圾桶裡的個人筆記（仍在 F）；永久刪除等 a → 發動者已無垃圾桶權 → 兩篇都 skipped not_found", async () => {
    const s = await scene();
    const t = await lockOrderScene(s);
    const [dr, pr] = await queueBehind(s, t.b, () => transfer(s.app, t.q, t.g, t.r), () => purge(s.app, t.q, [t.a, t.b]));
    expect(dr.statusCode, dr.body).toBe(204);
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [], skipped: [{ id: t.a, reason: "not_found" }, { id: t.b, reason: "not_found" }] });
    for (const id of [t.a, t.b]) {
      expect(await ownerOf(s.pool, id), id).toEqual({ owner_id: t.r, group_id: null });
      expect((await trashCols(s.pool, id))?.deleted_at, id).not.toBeNull();
      expect(await noteFolderCols(s.pool, id), id).toEqual({ folder_id: t.F, trash_folder_path: ["F"] });
    }
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r, group_id: null });
    await expectConsistent(s.pool);
  });
});

describe("RG-DA 全刪與多 id 永久刪除（heap 序與 id 序相反，讀碼發現 1）", () => {
  it("永久刪除先（排在 a 上）：永久刪除 200 purged [a, b]；全刪 204、群組與資料夾都不在", async () => {
    const s = await scene();
    const t = await lockOrderScene(s);
    const [pr, dr] = await queueBehind(s, t.a, () => purge(s.app, t.q, [t.a, t.b]), () => deleteAll(s.app, t.q, t.g));
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [t.a, t.b], skipped: [] });
    expect(dr.statusCode, dr.body).toBe(204);
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.b)]).toEqual([undefined, undefined]);
    expect(await groupExists(s.pool, t.g)).toBe(false);
    expect(await folderRow(s.pool, t.F)).toBeUndefined();
    await expectConsistent(s.pool);
  });

  it("全刪先（排在 b 上、已鎖 a）：全刪 204；永久刪除等 a → 兩篇已不在 → 兩篇都 skipped not_found", async () => {
    const s = await scene();
    const t = await lockOrderScene(s);
    const [dr, pr] = await queueBehind(s, t.b, () => deleteAll(s.app, t.q, t.g), () => purge(s.app, t.q, [t.a, t.b]));
    expect(dr.statusCode, dr.body).toBe(204);
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [], skipped: [{ id: t.a, reason: "not_found" }, { id: t.b, reason: "not_found" }] });
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.b)]).toEqual([undefined, undefined]);
    expect(await groupExists(s.pool, t.g)).toBe(false);
    expect(await folderRow(s.pool, t.F)).toBeUndefined();
    await expectConsistent(s.pool);
  });
});

describe("RG-FC 轉移與建群組資料夾", () => {
  it("轉移先（停在 group-delete-locked，持 lockGroup、還沒取結構鎖）：建在群組根層的請求在 groups KS 上等 → 轉移 commit 後 404 group_not_found、沒有建出資料夾", async () => {
    const s = await scene();
    const t = await groupScene(s);
    const A = (await seedFolder(s.db, { group: t.g }, { name: "A" })).id;
    const [dr, cr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () =>
      createFolder(s.app, t.q, { name: "S", space: { kind: "group", groupId: t.g } }));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(cr, 404, "group_not_found");
    expect(await folderCountNamed(s.pool, "S")).toBe(0);
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, A)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[0]!.id });
    await expectConsistent(s.pool);
  });

  it("轉移先，建在群組資料夾 A 底下：在 groups KS 上等 → 404 folder_not_found（以資料夾 id 進來）、A 底下沒有新資料夾", async () => {
    const s = await scene();
    const t = await groupScene(s);
    const A = (await seedFolder(s.db, { group: t.g }, { name: "A" })).id;
    const [dr, cr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () =>
      createFolder(s.app, t.q, { name: "S", parentId: A }));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(cr, 404, "folder_not_found");
    expect(await folderCountNamed(s.pool, "S")).toBe(0);
    expect(await folderRow(s.pool, A)).toMatchObject({ kind: "personal", owner_id: t.r });
    await expectConsistent(s.pool);
  });

  it("建立先（停在 folder-structure-locked，持 groups KS 與結構鎖）：轉移在 lockGroup 上等 → 建立 201；轉移看得到它，它在接收者的新頂層底下", async () => {
    const s = await scene();
    const t = await groupScene(s);
    const [cr, dr] = await race(s, "folder-structure-locked", () =>
      createFolder(s.app, t.q, { name: "S", space: { kind: "group", groupId: t.g } }), () => transfer(s.app, t.q, t.g, t.r));
    const S = okJson<FolderDto>(cr, 201).id;
    expect(dr.statusCode, dr.body).toBe(204);
    // 群組原本沒有資料夾：新頂層是因為轉移看到了 S 才建的。
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, S)).toMatchObject({ kind: "personal", owner_id: t.r, group_id: null, parent_id: roots[0]!.id, name: "S" });
    await expectConsistent(s.pool);
  });
});

describe("RG-FD 轉移與刪群組資料夾", () => {
  async function setup(s: Scene) {
    const t = await groupScene(s);
    const [F, G] = await seedFolderChain(s.db, { group: t.g }, ["F", "G"]);
    const a = await noteIn(s, { groupId: t.g }, F!);
    return { ...t, F: F!, G: G!, a };
  }

  it("轉移先（停在 group-delete-locked）：刪在 groups KS 上等 → 404 folder_not_found、什麼都沒移入垃圾桶；F 整棵在接收者的新頂層底下、a 活在 F、閘門已收", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, fr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () => delFolder(s.app, t.r, t.F));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(fr, 404, "folder_not_found");
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[0]!.id });
    expect(await folderRow(s.pool, t.G)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: t.F });
    expect((await trashCols(s.pool, t.a))?.deleted_at).toBeNull();
    expect(await ownerOf(s.pool, t.a)).toEqual({ owner_id: t.r, group_id: null });
    expect(await noteFolderCols(s.pool, t.a)).toEqual({ folder_id: t.F, trash_folder_path: null });
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });

  it("刪先（停在 folder-delete-notes-locked）：轉移在 lockGroup 上等 → 刪 200；轉移後 F 不在、a 在垃圾桶並轉給接收者、快照前接新頂層名", async () => {
    const s = await scene();
    const t = await setup(s);
    const [fr, dr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.r, t.F), () => transfer(s.app, t.q, t.g, t.r));
    expect(okJson<FolderDeleteResultDto>(fr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    expect(dr.statusCode, dr.body).toBe(204);
    expect(await folderRow(s.pool, t.F)).toBeUndefined();
    expect(await folderRow(s.pool, t.G)).toBeUndefined();
    expect((await trashCols(s.pool, t.a))?.deleted_at).not.toBeNull();
    expect(await ownerOf(s.pool, t.a)).toEqual({ owner_id: t.r, group_id: null });
    expect(await noteFolderCols(s.pool, t.a)).toEqual({ folder_id: null, trash_folder_path: [GROUP_NAME, "F"] });
    // 群組已沒有資料夾，新頂層是為了帶快照的垃圾桶筆記建的（n-r4-2）。
    expect((await personalRoots(s.pool, t.r)).map(f => f.name)).toEqual([GROUP_NAME]);
    await expectConsistent(s.pool);
  });

  it("刪的預讀與開閘門之後、交易之前群組被轉移完（T8 concern 3）：交易內 404 folder_not_found、接收者的 F 與 a 都沒動、閘門已收", async () => {
    const s = await scene();
    const t = await setup(s);
    const h = s.seams.hold("folder-delete-gated");
    const deleting = delFolder(s.app, t.r, t.F);
    await entered(h.entered, deleting);
    let dr: Res;
    try {
      dr = await transfer(s.app, t.q, t.g, t.r);
    } finally {
      h.open();
    }
    const fr = await deleting;
    noBusy(dr, fr);
    expect(dr.statusCode, dr.body).toBe(204);
    failed(fr, 404, "folder_not_found");
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r });
    expect(await folderRow(s.pool, t.G)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: t.F });
    expect((await trashCols(s.pool, t.a))?.deleted_at).toBeNull();
    expect(await noteFolderCols(s.pool, t.a)).toEqual({ folder_id: t.F, trash_folder_path: null });
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("RG-RS 轉移與還原群組垃圾桶筆記（照路徑重建）", () => {
  /** tn 在群組垃圾桶、根層、快照 ["F","X"]：F 還在、X 已不在。 */
  async function setup(s: Scene) {
    const t = await groupScene(s);
    const F = (await seedFolder(s.db, { group: t.g }, { name: "F" })).id;
    const tn = await noteIn(s, { groupId: t.g }, null);
    await markTrashed(s.pool, tn, t.q);
    await setSnapshot(s.pool, tn, ["F", "X"]);
    return { ...t, F, tn };
  }

  it("還原先（停在 note-restore-locked，持 groups KS、結構鎖、筆記鎖）：轉移在 lockGroup 上等 → 還原 200、X 重建在 F 底下；轉移把 F›X 與 tn 一起收進接收者的新頂層", async () => {
    const s = await scene();
    const t = await setup(s);
    const rh = s.seams.hold("note-restore-locked");
    // 轉移拿到鎖之後卡在第一個 slug 候選，等還原的回應（commit 後的重讀）回完才放行——否則重讀與轉移 commit 競速。
    const th = s.seams.hold("group-transfer-slug-candidate");
    const restoring = restore(s.app, t.q, [t.tn]);
    await entered(rh.entered, restoring);
    const deleting = transfer(s.app, t.q, t.g, t.r);
    const waited = await sawLockWaiters(s.pool, 1);
    rh.open();
    let rr: Res;
    try {
      rr = await restoring;
    } finally {
      th.open();
    }
    const dr = await deleting;
    expect(waited, "轉移在還原持有的 groups KS 上等").toBe(true);
    noBusy(rr, dr);
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.tn]);
    expect(dr.statusCode, dr.body).toBe(204);
    expect((await trashCols(s.pool, t.tn))?.deleted_at).toBeNull();
    expect(await ownerOf(s.pool, t.tn)).toEqual({ owner_id: t.r, group_id: null });
    const leaf = (await noteFolderCols(s.pool, t.tn))!.folder_id!;
    const X = await folderRow(s.pool, leaf);
    expect(X).toMatchObject({ kind: "personal", owner_id: t.r, name: "X", parent_id: t.F });
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME]);
    expect(await folderRow(s.pool, t.F)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[0]!.id });
    await expectConsistent(s.pool);
  });

  it("轉移先（停在 group-delete-locked），由另一位管理員還原：還原在 groups KS 上等 → 轉移後已無垃圾桶權 → skipped not_found；tn 在接收者垃圾桶、快照前接新頂層名", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, rr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () => restore(s.app, t.q, [t.tn]));
    expect(dr.statusCode, dr.body).toBe(204);
    expect(okJson<TrashRestoreResultDto>(rr, 200)).toEqual({ restored: [], skipped: [{ id: t.tn, reason: "not_found" }] });
    expect((await trashCols(s.pool, t.tn))?.deleted_at).not.toBeNull();
    expect(await ownerOf(s.pool, t.tn)).toEqual({ owner_id: t.r, group_id: null });
    expect(await noteFolderCols(s.pool, t.tn)).toEqual({ folder_id: null, trash_folder_path: [GROUP_NAME, "F", "X"] });
    expect(await folderCountNamed(s.pool, "X")).toBe(0);
    await expectConsistent(s.pool);
  });

  it("轉移先，由接收者還原：還原在 groups KS 上等 → 轉移後是接收者的個人筆記、空間不在已取的鎖鍵裡 → 不重建、還原到接收者根層（§5.8-1）", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, rr] = await race(s, "group-delete-locked", () => transfer(s.app, t.q, t.g, t.r), () => restore(s.app, t.r, [t.tn]));
    expect(dr.statusCode, dr.body).toBe(204);
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.tn]);
    expect((await trashCols(s.pool, t.tn))?.deleted_at).toBeNull();
    expect(await ownerOf(s.pool, t.tn)).toEqual({ owner_id: t.r, group_id: null });
    expect(await noteFolderCols(s.pool, t.tn)).toEqual({ folder_id: null, trash_folder_path: null });
    expect(await folderCountNamed(s.pool, "X")).toBe(0);
    expect((await personalRoots(s.pool, t.r)).map(f => f.name)).toEqual([GROUP_NAME]);
    await expectConsistent(s.pool);
  });
});

describe("RG-RN 轉移與接收者改名個人根層資料夾（改成群組名，M6）", () => {
  /** 群組有資料夾 A（轉移會建新頂層）；接收者根層有 O「Old」。轉移由 q 發動、轉給 r（發動者 ≠ 接收者，T11 I-1）。 */
  async function setup(s: Scene) {
    const t = await groupScene(s);
    const A = (await seedFolder(s.db, { group: t.g }, { name: "A" })).id;
    const O = (await seedFolder(s.db, { personal: t.r }, { name: "Old" })).id;
    return { ...t, A, O };
  }

  it("改名先（停在 folder-structure-locked，持接收者結構鎖）：轉移在接收者結構鎖上等 → 改名 200；新頂層是「研發組 (2)」、A 在它底下", async () => {
    const s = await scene();
    const t = await setup(s);
    const [nr, dr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.r, t.O, { name: GROUP_NAME }), () => transfer(s.app, t.q, t.g, t.r));
    expect(okJson<FolderDto>(nr, 200).name).toBe(GROUP_NAME);
    expect(dr.statusCode, dr.body).toBe(204);
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual([GROUP_NAME, `${GROUP_NAME} (2)`]);
    expect(roots[0]!.id).toBe(t.O);
    expect(await folderRow(s.pool, t.A)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[1]!.id });
    await expectConsistent(s.pool);
  });

  it("轉移先（停在 folder-structure-locked，持群組與接收者結構鎖）：改名在接收者結構鎖上等 → 轉移 204、新頂層「研發組」；改名 409 folder_name_taken、O 仍叫 Old", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, nr] = await race(s, "folder-structure-locked", () => transfer(s.app, t.q, t.g, t.r), () => patchFolder(s.app, t.r, t.O, { name: GROUP_NAME }));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(nr, 409, "folder_name_taken");
    const roots = await personalRoots(s.pool, t.r);
    expect(roots.map(f => f.name)).toEqual(["Old", GROUP_NAME]);
    expect(roots[0]!.id).toBe(t.O);
    expect(await folderRow(s.pool, t.A)).toMatchObject({ kind: "personal", owner_id: t.r, parent_id: roots[1]!.id });
    await expectConsistent(s.pool);
  });
});

describe("RG-DF 全刪與刪群組資料夾", () => {
  /** 群組 F›G；F 裡活筆記 a、G 裡垃圾桶筆記 tg。 */
  async function setup(s: Scene) {
    const t = await groupScene(s);
    const [F, G] = await seedFolderChain(s.db, { group: t.g }, ["F", "G"]);
    const a = await noteIn(s, { groupId: t.g }, F!);
    const tg = await noteIn(s, { groupId: t.g }, G!);
    await markTrashed(s.pool, tg, t.q);
    await setSnapshot(s.pool, tg, ["F", "G"]);
    return { ...t, F: F!, G: G!, a, tg };
  }

  it("全刪先（停在 group-delete-locked）：刪資料夾在 groups KS 上等 → 404 folder_not_found；全刪 204、群組、資料夾、兩篇都不在", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, fr] = await race(s, "group-delete-locked", () => deleteAll(s.app, t.q, t.g), () => delFolder(s.app, t.q, t.F));
    expect(dr.statusCode, dr.body).toBe(204);
    failed(fr, 404, "folder_not_found");
    expect(await groupExists(s.pool, t.g)).toBe(false);
    expect([await folderRow(s.pool, t.F), await folderRow(s.pool, t.G)]).toEqual([undefined, undefined]);
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.tg)]).toEqual([undefined, undefined]);
    await expectConsistent(s.pool);
  });

  it("刪資料夾先（停在 folder-delete-notes-locked）：全刪在 lockGroup 上等 → 刪 200（a 移入垃圾桶、F›G 刪掉）；全刪 204、垃圾桶裡的兩篇也被刪掉", async () => {
    const s = await scene();
    const t = await setup(s);
    const [fr, dr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.q, t.F), () => deleteAll(s.app, t.q, t.g));
    expect(okJson<FolderDeleteResultDto>(fr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    expect(dr.statusCode, dr.body).toBe(204);
    expect(await groupExists(s.pool, t.g)).toBe(false);
    expect([await folderRow(s.pool, t.F), await folderRow(s.pool, t.G)]).toEqual([undefined, undefined]);
    expect([await trashCols(s.pool, t.a), await trashCols(s.pool, t.tg)]).toEqual([undefined, undefined]);
    await expectConsistent(s.pool);
  });
});

describe("RG-CN 全刪與在群組資料夾建立筆記（FK 檢查序是 pg_dump 還原後的樣子，最終審查 m-1）", () => {
  /**
   * 同表的 RI 觸發器依名稱（`RI_ConstraintTrigger_c_<oid>`）序觸發。重建群組 FK 讓它的 OID 變大 → INSERT 先檢查資料夾 FK
   * （pg_dump 依名稱建 FK、還原後就是這個序）。只動本案的資料庫（每案一個新庫）。
   */
  async function flipFkOrder(pool: Pool): Promise<void> {
    await pool.query(`alter table notes drop constraint notes_group_id_groups_id_fk;
      alter table notes add constraint notes_group_id_groups_id_fk foreign key (group_id) references groups(id) on delete restrict on update no action`);
    const { rows } = await pool.query<{ conname: string }>(`select c.conname from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
      where t.tgrelid = 'notes'::regclass and t.tgisinternal and t.tgtype & 4 = 4 and c.conname in ('notes_folder_fk', 'notes_group_id_groups_id_fk')
      order by t.tgname`);
    expect(rows.map(r => r.conname), "前提：INSERT 先檢查資料夾 FK、再檢查群組 FK").toEqual(["notes_folder_fk", "notes_group_id_groups_id_fk"]);
  }

  for (const withContent of [false, true]) {
    it(`全刪先（停在 group-delete-locked）${withContent ? "、帶 content" : ""}：INSERT 持 F 的 KS、在 groups KS 上等，全刪 CASCADE 刪 F 等 INSERT → 40P01；犧牲方 409 server_busy、另一方成功，建立方不是 5xx`, async () => {
      const s = await scene();
      const t = await groupScene(s);
      const F = (await seedFolder(s.db, { group: t.g }, { name: "F" })).id;
      await flipFkOrder(s.pool);
      const h = s.seams.hold("group-delete-locked");
      const pd = deleteAll(s.app, t.q, t.g);
      await entered(h.entered, pd);
      const pc = inject(s.app, "POST", "/api/notes", t.q, { groupId: t.g, folderId: F, ...(withContent ? { content: "hello" } : {}) });
      const waited = await sawLockWaiters(s.pool, 1);
      h.open();
      const [dr, cr] = [await pd, await pc];
      expect(waited, "建立在全刪持有的群組列鎖上等").toBe(true);
      expect(cr.statusCode, cr.body).toBeLessThan(500);
      expect(dr.statusCode, dr.body).toBeLessThan(500);
      if (errCode(cr) === "server_busy") {
        // 一般時序：先開始等的 INSERT 先跑死結偵測、是犧牲者。
        expect(cr.statusCode, cr.body).toBe(409);
        expect(dr.statusCode, dr.body).toBe(204);
        expect(await groupExists(s.pool, t.g)).toBe(false);
        expect(await folderRow(s.pool, F)).toBeUndefined();
        expect((await s.pool.query("select 1 from notes where group_id = $1", [t.g])).rowCount).toBe(0);
      } else {
        // INSERT 的偵測在成環前就跑過了 → 全刪是犧牲者、什麼都沒刪。
        failed(dr, 409, "server_busy");
        const n = okJson<NoteDto>(cr, 201);
        expect(await noteFolderCols(s.pool, n.id)).toEqual({ folder_id: F, trash_folder_path: null });
        expect(await groupExists(s.pool, t.g)).toBe(true);
      }
      await expectConsistent(s.pool);
    });
  }
});

describe("RP-US 共享放置與撤分享（API 版，r3 m-7）", () => {
  /** 擁有者 o 把 n 分享給 editor e；e 有自己的共享私人資料夾 SE。 */
  async function setup(s: Scene) {
    const [o, e] = [await seedUser(s.db), await seedUser(s.db)];
    const n = await noteIn(s, { ownerId: o.id }, null);
    await seedShare(s.db, n, e.id, "editor");
    const SE = (await seedFolder(s.db, { shared: e.id }, { name: "SE" })).id;
    return { o: o.id, e: e.id, n, SE };
  }

  it("放置先（停在 note-folder-locked，交易內已重判、upsert 之前）：撤分享不鎖 notes、直接 204 → 放行 → 放置撞分享 FK → 404 not_found、沒有放置列", async () => {
    const s = await scene();
    const t = await setup(s);
    const h = s.seams.hold("note-folder-locked");
    const placing = place(s.app, t.e, t.n, t.SE);
    await entered(h.entered, placing);
    const revoking = revoke(s.app, t.o, t.n, t.e);
    let settled: string;
    try {
      settled = await waitForBlockedOrSettled(s.pool, revoking);
    } finally {
      h.open();
    }
    const [pr, rv] = [await placing, await revoking];
    expect(settled, "撤分享沒有等任何鎖").toBe("settled");
    noBusy(pr, rv);
    expect(rv.statusCode, rv.body).toBe(204);
    failed(pr, 404, "not_found");
    expect(await placementOf(s.pool, t.e, t.n)).toBeNull();
    expect(await sharesOf(s.db, t.n)).toEqual([]);
    await expectConsistent(s.pool);
  });

  it("撤分享先（放置停在 note-folder-authorized，交易外授權之後）：撤分享 204 → 放置的交易內重判看不到這篇 → 404 not_found、沒有放置列", async () => {
    const s = await scene();
    const t = await setup(s);
    const h = s.seams.hold("note-folder-authorized");
    const placing = place(s.app, t.e, t.n, t.SE);
    await entered(h.entered, placing);
    let rv: Res;
    try {
      rv = await revoke(s.app, t.o, t.n, t.e);
    } finally {
      h.open();
    }
    const pr = await placing;
    noBusy(pr, rv);
    expect(rv.statusCode, rv.body).toBe(204);
    failed(pr, 404, "not_found");
    expect(await placementOf(s.pool, t.e, t.n)).toBeNull();
    await expectConsistent(s.pool);
  });
});

describe("RS-MM 搬資料夾與搬資料夾（互為父子）", () => {
  async function setup(s: Scene) {
    const u = (await seedUser(s.db)).id;
    const A = (await seedFolder(s.db, { personal: u }, { name: "A" })).id;
    const B = (await seedFolder(s.db, { personal: u }, { name: "B" })).id;
    return { u, A, B };
  }

  it("A 進 B 先（停在 folder-structure-locked）：B 進 A 在結構鎖上等 → A 200 在 B 底下；B 409 folder_cycle、仍在根層；樹無環", async () => {
    const s = await scene();
    const t = await setup(s);
    const [ar, br] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.A, { parentId: t.B }), () => patchFolder(s.app, t.u, t.B, { parentId: t.A }));
    expect(okJson<FolderDto>(ar, 200).parentId).toBe(t.B);
    failed(br, 409, "folder_cycle");
    expect((await folderRow(s.pool, t.A))?.parent_id).toBe(t.B);
    expect((await folderRow(s.pool, t.B))?.parent_id).toBeNull();
    await expectConsistent(s.pool);
  });

  it("B 進 A 先：A 進 B 在結構鎖上等 → B 200 在 A 底下；A 409 folder_cycle、仍在根層；樹無環", async () => {
    const s = await scene();
    const t = await setup(s);
    const [br, ar] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.B, { parentId: t.A }), () => patchFolder(s.app, t.u, t.A, { parentId: t.B }));
    expect(okJson<FolderDto>(br, 200).parentId).toBe(t.A);
    failed(ar, 409, "folder_cycle");
    expect((await folderRow(s.pool, t.B))?.parent_id).toBe(t.A);
    expect((await folderRow(s.pool, t.A))?.parent_id).toBeNull();
    await expectConsistent(s.pool);
  });
});

describe("RS-CC 建立與建立同名（lower() 比對）", () => {
  async function setup(s: Scene) {
    const u = (await seedUser(s.db)).id;
    const P = (await seedFolder(s.db, { personal: u }, { name: "P" })).id;
    return { u, P };
  }
  async function childrenOf(pool: Pool, parentId: string): Promise<string[]> {
    return (await pool.query<{ name: string }>("select name from folders where parent_id = $1 order by name", [parentId])).rows.map(r => r.name);
  }

  for (const [first, second] of [["Docs", "docs"], ["docs", "Docs"]] as const) {
    it(`「${first}」先（停在 folder-structure-locked）：「${second}」在結構鎖上等 → 「${first}」201；「${second}」409 folder_name_taken、P 底下只有一個`, async () => {
      const s = await scene();
      const t = await setup(s);
      const [r1, r2] = await race(s, "folder-structure-locked", () => createFolder(s.app, t.u, { name: first, parentId: t.P }), () =>
        createFolder(s.app, t.u, { name: second, parentId: t.P }));
      expect(okJson<FolderDto>(r1, 201).name).toBe(first);
      failed(r2, 409, "folder_name_taken");
      expect(await childrenOf(s.pool, t.P)).toEqual([first]);
      await expectConsistent(s.pool);
    });
  }
});

describe("RS-RR 改名與還原照路徑重建同名", () => {
  /** 根層 O「Old」；tn 在垃圾桶、根層、快照 ["Docs"]（原資料夾已不在）。 */
  async function setup(s: Scene) {
    const u = (await seedUser(s.db)).id;
    const O = (await seedFolder(s.db, { personal: u }, { name: "Old" })).id;
    const tn = await noteIn(s, { ownerId: u }, null);
    await markTrashed(s.pool, tn, u);
    await setSnapshot(s.pool, tn, ["Docs"]);
    return { u, O, tn };
  }

  it("還原先（停在 note-restore-locked，持結構鎖）：改名在結構鎖上等 → 還原 200、重建出新的「Docs」；改名 409 folder_name_taken、O 仍叫 Old", async () => {
    const s = await scene();
    const t = await setup(s);
    const [rr, nr] = await race(s, "note-restore-locked", () => restore(s.app, t.u, [t.tn]), () => patchFolder(s.app, t.u, t.O, { name: "Docs" }));
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.tn]);
    failed(nr, 409, "folder_name_taken");
    const leaf = (await noteFolderCols(s.pool, t.tn))!.folder_id!;
    expect(leaf).not.toBe(t.O);
    expect(await folderRow(s.pool, leaf)).toMatchObject({ name: "Docs", parent_id: null, owner_id: t.u });
    expect((await personalRoots(s.pool, t.u)).map(f => f.name)).toEqual(["Docs", "Old"]);
    await expectConsistent(s.pool);
  });

  it("改名先（停在 folder-structure-locked）：還原在結構鎖上等 → 改名 200「DOCS」；還原以 lower() 併進 O、不另建", async () => {
    const s = await scene();
    const t = await setup(s);
    const [nr, rr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.O, { name: "DOCS" }), () => restore(s.app, t.u, [t.tn]));
    expect(okJson<FolderDto>(nr, 200).name).toBe("DOCS");
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.tn]);
    expect(await noteFolderCols(s.pool, t.tn)).toEqual({ folder_id: t.O, trash_folder_path: null });
    expect(await personalRoots(s.pool, t.u)).toEqual([{ id: t.O, name: "DOCS" }]);
    await expectConsistent(s.pool);
  });
});

describe("RN-TR 放置與移入垃圾桶（同篇）", () => {
  async function setup(s: Scene) {
    const u = (await seedUser(s.db)).id;
    const F1 = (await seedFolder(s.db, { personal: u }, { name: "F1" })).id;
    const F2 = (await seedFolder(s.db, { personal: u }, { name: "F2" })).id;
    const n = await noteIn(s, { ownerId: u }, F1);
    return { u, F1, F2, n };
  }

  it("放置先（停在 note-folder-locked，持筆記 FU）：移入在筆記鎖上等 → 放置 200；移入 204、快照是新位置", async () => {
    const s = await scene();
    const t = await setup(s);
    // 移入在放置 commit 時拿到筆記鎖；停在 note-trash-locked 等放置回完應答，不和放置 commit 後的重讀競速。
    const [pr, tr] = await race(s, "note-folder-locked", () => place(s.app, t.u, t.n, t.F2), () => trashNote(s.app, t.u, t.n), "note-trash-locked");
    expect(okJson<NoteDto>(pr, 200).folderId).toBe(t.F2);
    expect(tr.statusCode, tr.body).toBe(204);
    expect((await trashCols(s.pool, t.n))?.deleted_at).not.toBeNull();
    expect(await noteFolderCols(s.pool, t.n)).toEqual({ folder_id: t.F2, trash_folder_path: ["F2"] });
    await expectConsistent(s.pool);
  });

  it("移入先（停在 note-trash-locked）：放置在筆記鎖上等 → 移入 204；放置 404 not_found、位置與快照是原處", async () => {
    const s = await scene();
    const t = await setup(s);
    const [tr, pr] = await race(s, "note-trash-locked", () => trashNote(s.app, t.u, t.n), () => place(s.app, t.u, t.n, t.F2));
    expect(tr.statusCode, tr.body).toBe(204);
    failed(pr, 404, "not_found");
    expect((await trashCols(s.pool, t.n))?.deleted_at).not.toBeNull();
    expect(await noteFolderCols(s.pool, t.n)).toEqual({ folder_id: t.F1, trash_folder_path: ["F1"] });
    await expectConsistent(s.pool);
  });
});

describe("RN-CM 複製（建立副本）與來源移入群組", () => {
  /** 管理員 u 的個人資料夾 P 裡一篇 n；群組資料夾 GF。 */
  async function setup(s: Scene) {
    const g = await sixRoleScene(s.db);
    const u = g.admin.id;
    const P = (await seedFolder(s.db, { personal: u }, { name: "P" })).id;
    const GF = (await seedFolder(s.db, { group: g.groupId }, { name: "GF" })).id;
    const title = `RNCM-${u.slice(0, 8)}`;
    const n = await noteIn(s, { ownerId: u }, P, title);
    return { u, groupId: g.groupId, P, GF, n, title };
  }
  async function copiesOf(pool: Pool, title: string, exceptId: string) {
    const { rows } = await pool.query<{ id: string; owner_id: string | null; group_id: string | null; folder_id: string | null }>(
      "select id, owner_id, group_id, folder_id from notes where title = $1 and id <> $2", [title, exceptId],
    );
    return rows;
  }

  it("複製先（停在 note-copy-locked，持 P 與來源 KS）：移入在來源 FU 上等 → 複製 201 在 P；移入 200 到 GF", async () => {
    const s = await scene();
    const t = await setup(s);
    const [cr, mr] = await race(s, "note-copy-locked", () => copy(s.app, t.u, t.n, { folderId: t.P }), () => move(s.app, t.u, t.n, { groupId: t.groupId, folderId: t.GF }));
    const dup = okJson<NoteDto>(cr, 201);
    expect(dup.folderId).toBe(t.P);
    expect(okJson<NoteDto>(mr, 200).folderId).toBe(t.GF);
    expect(await ownerOf(s.pool, t.n)).toEqual({ owner_id: null, group_id: t.groupId });
    expect(await noteFolderCols(s.pool, t.n)).toEqual({ folder_id: t.GF, trash_folder_path: null });
    expect(await copiesOf(s.pool, t.title, t.n)).toEqual([{ id: dup.id, owner_id: t.u, group_id: null, folder_id: t.P }]);
    await expectConsistent(s.pool);
  });

  it("移入先（停在 note-move-locked，持來源 FU、groups KS、GF KS）：複製在來源 KS 上等 → 移入 200；複製 201、副本仍在 P（個人）", async () => {
    const s = await scene();
    const t = await setup(s);
    const [mr, cr] = await race(s, "note-move-locked", () => move(s.app, t.u, t.n, { groupId: t.groupId, folderId: t.GF }), () => copy(s.app, t.u, t.n, { folderId: t.P }));
    expect(okJson<NoteDto>(mr, 200).folderId).toBe(t.GF);
    const dup = okJson<NoteDto>(cr, 201);
    expect(dup.folderId).toBe(t.P);
    expect(await ownerOf(s.pool, t.n)).toEqual({ owner_id: null, group_id: t.groupId });
    expect(await copiesOf(s.pool, t.title, t.n)).toEqual([{ id: dup.id, owner_id: t.u, group_id: null, folder_id: t.P }]);
    await expectConsistent(s.pool);
  });
});
