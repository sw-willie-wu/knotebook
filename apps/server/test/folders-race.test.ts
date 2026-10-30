/**
 * 資料夾 PR-3a T12：併發（上）——刪資料夾與各操作（spec docs/superpowers/specs/2026-10-22-folders-design.md §6.18 第三點、
 * §5.4；plan 附錄 A 鎖序表）。以拋棄式 pg 實跑：一方卡在自己交易內的縫，另一方送出後以 `waitForLockWaiters` 確認它真的在等鎖，
 * 放行後斷言結果只會是指定的那一種。每組兩種先後（「刪先」與「對方先」）；每案都斷言沒有 409 `server_busy`（40P01 經
 * `isRetryableTxError` 會變成它）與資料一致（沒有指向不存在資料夾的筆記或放置、活筆記沒有快照）。
 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import type { FolderDeleteResultDto, FolderDto, NoteDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { Db } from "../src/db/index.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import { folderRow, noteFolderCols, seedFolder, seedFolderChain, setNoteFolder, setSnapshot } from "./folder-helpers.js";
import { seedNote, seedUser, waitForLockWaiters } from "./group-helpers.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

type Res = LightMyRequestResponse;
const CHANGED = "資料夾內容剛變動，請再試一次";

const delFolder = (app: FastifyInstance, by: string, id: string) => inject(app, "DELETE", `/api/folders/${id}`, by);
const place = (app: FastifyInstance, by: string, noteId: string, folderId: string | null) => inject(app, "PUT", `/api/notes/${noteId}/folder`, by, { folderId });
const trashNote = (app: FastifyInstance, by: string, noteId: string) => inject(app, "DELETE", `/api/notes/${noteId}`, by);
const restore = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/restore", by, { ids });
const purge = (app: FastifyInstance, by: string, ids: string[]) => inject(app, "POST", "/api/trash/purge", by, { ids });
const createFolder = (app: FastifyInstance, by: string, parentId: string, name: string) => inject(app, "POST", "/api/folders", by, { name, parentId });
const patchFolder = (app: FastifyInstance, by: string, id: string, body: { name?: string; parentId?: string | null }) => inject(app, "PATCH", `/api/folders/${id}`, by, body);
const copy = (app: FastifyInstance, by: string, noteId: string, body: { folderId: string; groupId?: string }) => inject(app, "POST", `/api/notes/${noteId}/copy`, by, body);
const move = (app: FastifyInstance, by: string, noteId: string, body: { groupId: string; folderId: string }) => inject(app, "POST", `/api/notes/${noteId}/move`, by, body);
const createNote = (app: FastifyInstance, by: string, body: { title: string; folderId: string; groupId?: string }) => inject(app, "POST", "/api/notes", by, body);

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
function conflicted(r: Res): void {
  failed(r, 409, "conflict");
  expect((r.json() as { error: { message: string } }).error.message).toBe(CHANGED);
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

/** 等 n 條連線卡在鎖上；逾時就先放行、讓在途請求收尾，再把逾時丟出去（不留懸著的請求）。 */
async function blockedOrBail(pool: Pool, n: number, bail: () => void, inflight: Array<Promise<unknown>>): Promise<void> {
  try {
    await waitForLockWaiters(pool, n);
  } catch (err) {
    bail();
    await Promise.allSettled(inflight);
    throw err;
  }
}

/** 沒有 409 server_busy（40P01／55P03 的映射）、沒有 5xx。鎖序倒置（例：複製的資料夾 KS 排到來源之後）會以 server_busy 在這裡紅。 */
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
 * first 卡在 point；second 送出並確認在等鎖；放行。回 [first, second] 的回應，並斷言都不是 server_busy／5xx。
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
  await blockedOrBail(s.pool, 1, h.open, [p1, p2]);
  h.open();
  const out: [Res, Res] = [await p1, await p2];
  noBusy(...out);
  return out;
}

/** 全庫不變量：沒有筆記或放置指向不存在的資料夾；活筆記沒有路徑快照。 */
async function expectConsistent(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ dangling: number; dangling_pl: number; live_snap: number }>(`select
    (select count(*)::int from notes n where n.folder_id is not null and not exists (select 1 from folders f where f.id = n.folder_id)) as dangling,
    (select count(*)::int from note_placements p where not exists (select 1 from folders f where f.id = p.folder_id)) as dangling_pl,
    (select count(*)::int from notes where deleted_at is null and trash_folder_path is not null) as live_snap`);
  expect(rows[0]).toEqual({ dangling: 0, dangling_pl: 0, live_snap: 0 });
}

async function noteIn(s: Scene, owner: { ownerId: string } | { groupId: string }, folderId: string | null, title?: string): Promise<string> {
  const n = await seedNote(s.db, owner, title !== undefined ? { title } : {});
  if (folderId !== null) await setNoteFolder(s.pool, n.id, folderId);
  return n.id;
}

async function expectLiveAt(pool: Pool, noteId: string, folderId: string | null): Promise<void> {
  expect((await trashCols(pool, noteId))?.deleted_at, noteId).toBeNull();
  expect(await noteFolderCols(pool, noteId), noteId).toEqual({ folder_id: folderId, trash_folder_path: null });
}
async function expectTrashedWith(pool: Pool, noteId: string, path: string[]): Promise<void> {
  expect((await trashCols(pool, noteId))?.deleted_at, noteId).not.toBeNull();
  expect(await noteFolderCols(pool, noteId), noteId).toEqual({ folder_id: null, trash_folder_path: path });
}
async function expectFolders(pool: Pool, present: readonly string[], gone: readonly string[]): Promise<void> {
  for (const id of present) expect(await folderRow(pool, id), id).toBeDefined();
  for (const id of gone) expect(await folderRow(pool, id), id).toBeUndefined();
}

/** 由葉往根讀名稱路徑與根 id。 */
async function pathOf(pool: Pool, folderId: string): Promise<{ names: string[]; rootId: string }> {
  const names: string[] = [];
  let cur: string | null = folderId;
  let rootId = folderId;
  while (cur !== null) {
    const f = await folderRow(pool, cur);
    if (!f) throw new Error(`pathOf: ${cur} 不存在`);
    names.unshift(f.name);
    rootId = f.id;
    cur = f.parent_id;
  }
  return { names, rootId };
}

async function countTitled(pool: Pool, title: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from notes where title = $1", [title]);
  return rows[0]!.n;
}

/** 個人樹 F›G（F 在根層）、F 裡一篇活筆記 a。 */
async function personalTree(s: Scene) {
  const u = await seedUser(s.db);
  const [F, G] = await seedFolderChain(s.db, { personal: u.id }, ["F", "G"]);
  const a = await noteIn(s, { ownerId: u.id }, F!);
  return { u: u.id, F: F!, G: G!, a };
}

describe("RF-PL 刪資料夾與放置進子樹", () => {
  it("刪先：放置 404 folder_not_found、筆記留在根層活著；刪 200", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, null);
    const [dr, pr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => place(s.app, t.u, n, t.G));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    failed(pr, 404, "folder_not_found");
    await expectLiveAt(s.pool, n, null);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectFolders(s.pool, [], [t.F, t.G]);
    await expectConsistent(s.pool);
  });

  it("放置先：放置 200；刪 409 conflict（新進的活筆記沒開閘門）、什麼都沒刪、閘門全收", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, null);
    const [pr, dr] = await race(s, "note-folder-locked", () => place(s.app, t.u, n, t.G), () => delFolder(s.app, t.u, t.F));
    expect(okJson<NoteDto>(pr, 200).folderId).toBe(t.G);
    conflicted(dr);
    await expectLiveAt(s.pool, n, t.G);
    await expectLiveAt(s.pool, t.a, t.F);
    await expectFolders(s.pool, [t.F, t.G], []);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("RF-PO 刪資料夾與放置出子樹", () => {
  it("刪先：放置等筆記鎖、放行後那篇已在垃圾桶 → 404 not_found；刪 200 含它", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const H = (await seedFolder(s.db, { personal: t.u }, { name: "H" })).id;
    const [dr, pr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => place(s.app, t.u, t.a, H));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    failed(pr, 404, "not_found");
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectFolders(s.pool, [H], [t.F, t.G]);
    await expectConsistent(s.pool);
  });

  it("放置先：刪重評述詞、不再鎖到它 → 刪 200、trashedNoteIds 不含它、它的閘門被收（M1）、筆記在新位置活著", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    const H = (await seedFolder(s.db, { personal: t.u }, { name: "H" })).id;
    const [pr, dr] = await race(s, "note-folder-locked", () => place(s.app, t.u, n, H), () => delFolder(s.app, t.u, t.F));
    expect(okJson<NoteDto>(pr, 200).folderId).toBe(H);
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    await expectLiveAt(s.pool, n, H);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(n)).toBe(false);
    expect(s.ctx.collab.isDeleting(t.a)).toBe(true);
    await expectConsistent(s.pool);
  });
});

describe("RF-PI 刪資料夾與子樹內放置", () => {
  it("刪先：放置 404 not_found（筆記已在垃圾桶）；刪 200、快照是原位置", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const H = (await seedFolder(s.db, { personal: t.u }, { parentId: t.F, name: "H" })).id;
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    const [dr, pr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => place(s.app, t.u, n, H));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, n]), deletedFolderIds: sorted([t.F, t.G, H]) });
    failed(pr, 404, "not_found");
    await expectTrashedWith(s.pool, n, ["F", "G"]);
    await expectConsistent(s.pool);
  });

  it("放置先：放置 200；刪 200、筆記在子樹另一處一起進垃圾桶、快照是新位置", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const H = (await seedFolder(s.db, { personal: t.u }, { parentId: t.F, name: "H" })).id;
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    // 刪資料夾鎖完子樹筆記後停在 folder-delete-notes-locked 等放置回完應答，不和放置 commit 後的重讀競速
    // （刪資料夾呼叫 `trashNotesInTx` 不帶 hook，note-trash-locked 不會觸發）。
    const [pr, dr] = await race(s, "note-folder-locked", () => place(s.app, t.u, n, H), () => delFolder(s.app, t.u, t.F), "folder-delete-notes-locked");
    expect(okJson<NoteDto>(pr, 200).folderId).toBe(H);
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, n]), deletedFolderIds: sorted([t.F, t.G, H]) });
    await expectTrashedWith(s.pool, n, ["F", "H"]);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });
});

describe("RF-TR 刪資料夾與單篇移入垃圾桶", () => {
  it("刪先：移入 404 not_found；刪 200 含它", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    const [dr, tr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => trashNote(s.app, t.u, n));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, n]), deletedFolderIds: sorted([t.F, t.G]) });
    failed(tr, 404, "not_found");
    await expectTrashedWith(s.pool, n, ["F", "G"]);
    await expectConsistent(s.pool);
  });

  it("移入先：移入 204；刪 200、那篇是垃圾桶組（不在 trashedNoteIds）、快照是刪除當下的路徑、folder_id 清掉", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const n = await noteIn(s, { ownerId: t.u }, t.G);
    const [tr, dr] = await race(s, "note-trash-locked", () => trashNote(s.app, t.u, n), () => delFolder(s.app, t.u, t.F));
    expect(tr.statusCode, tr.body).toBe(204);
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    await expectTrashedWith(s.pool, n, ["F", "G"]);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });
});

describe("RF-PG 刪資料夾與多 id 永久刪除（含已還原回子樹的活 id 與子樹內的垃圾桶 id，m5）", () => {
  it("刪先：永久刪除等筆記鎖 → 垃圾桶的兩篇被刪、已還原的活 id 略過；刪 200、trashedNoteIds 不含被永久刪除的", async () => {
    const s = await scene();
    const t = await personalTree(s);
    // a 先移入再還原回子樹（活 id）。
    await markTrashed(s.pool, t.a, t.u);
    await setSnapshot(s.pool, t.a, ["F"]);
    expect(okJson<TrashRestoreResultDto>(await restore(s.app, t.u, [t.a]), 200).restored.map(r => r.id)).toEqual([t.a]);
    await expectLiveAt(s.pool, t.a, t.F);
    const t1 = await noteIn(s, { ownerId: t.u }, t.F);
    const t2 = await noteIn(s, { ownerId: t.u }, t.G);
    for (const [id, path] of [[t1, ["F"]], [t2, ["F", "G"]]] as const) {
      await markTrashed(s.pool, id, t.u);
      await setSnapshot(s.pool, id, path);
    }
    const [dr, pr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => purge(s.app, t.u, [t.a, t2, t1]));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [t2, t1], skipped: [{ id: t.a, reason: "not_found" }] });
    expect(await trashCols(s.pool, t1)).toBeUndefined();
    expect(await trashCols(s.pool, t2)).toBeUndefined();
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });

  it("永久刪除先（預判時在垃圾桶、鎖時已還原回子樹的活 id）：永久刪除 200（活 id not_in_trash、垃圾桶那篇刪掉）；刪 200 只含活的那篇", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const tr = await noteIn(s, { ownerId: t.u }, t.G);
    for (const [id, path] of [[t.a, ["F"]], [tr, ["F", "G"]]] as const) {
      await markTrashed(s.pool, id, t.u);
      await setSnapshot(s.pool, id, path);
    }
    // 還原 a 卡在鎖後 → 永久刪除 [a, tr] 預判通過、等 a 的鎖 → 還原 commit（a 回到 F）→ 永久刪除鎖到活的 a 與 tr、卡住 → 刪 F 等。
    const rh = s.seams.hold("note-restore-locked");
    const ph = s.seams.hold("note-purge-locked");
    const restoring = restore(s.app, t.u, [t.a]);
    await entered(rh.entered, restoring);
    const purging = purge(s.app, t.u, [t.a, tr]);
    await blockedOrBail(s.pool, 1, rh.open, [restoring, purging]);
    rh.open();
    const rr = await restoring;
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(r => r.id)).toEqual([t.a]);
    await entered(ph.entered, purging);
    const deleting = delFolder(s.app, t.u, t.F);
    await blockedOrBail(s.pool, 1, ph.open, [purging, deleting]);
    ph.open();
    const [pr, dr] = [await purging, await deleting];
    noBusy(rr, pr, dr);
    expect(okJson<TrashPurgeResultDto>(pr, 200)).toEqual({ purged: [tr], skipped: [{ id: t.a, reason: "not_in_trash" }] });
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    expect(await trashCols(s.pool, tr)).toBeUndefined();
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });
});

describe("RF-RS 刪資料夾與還原（照路徑重建到子樹內）", () => {
  /** r 在垃圾桶、原資料夾 F›G 的 G 已不在（folder_id NULL、快照 ["F","G"]）。 */
  async function setup(s: Scene) {
    const t = await personalTree(s);
    const r = await noteIn(s, { ownerId: t.u }, null);
    await markTrashed(s.pool, r, t.u);
    await setSnapshot(s.pool, r, ["F", "G"]);
    await s.pool.query("delete from folders where id = $1", [t.G]);
    return { ...t, r };
  }

  it("刪先：還原在結構鎖上等 → 刪 commit 後照快照重建出新的同名路徑、筆記活在新路徑上", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, rr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => restore(s.app, t.u, [t.r]));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: [t.F] });
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.r]);
    const leaf = (await noteFolderCols(s.pool, t.r))!.folder_id!;
    await expectLiveAt(s.pool, t.r, leaf);
    const p = await pathOf(s.pool, leaf);
    expect(p.names).toEqual(["F", "G"]);
    expect(p.rootId).not.toBe(t.F);
    await expectFolders(s.pool, [], [t.F]);
    await expectTrashedWith(s.pool, t.a, ["F"]);
    await expectConsistent(s.pool);
  });

  it("還原先：還原把 G 重建在 F 裡並 commit；刪拿到鎖後鎖到這篇沒開閘門的活筆記 → 409 conflict、什麼都沒刪、閘門全收（gate r1 I2）", async () => {
    const s = await scene();
    const t = await setup(s);
    const [rr, dr] = await race(s, "note-restore-locked", () => restore(s.app, t.u, [t.r]), () => delFolder(s.app, t.u, t.F));
    expect(okJson<TrashRestoreResultDto>(rr, 200).restored.map(n => n.id)).toEqual([t.r]);
    conflicted(dr);
    const leaf = (await noteFolderCols(s.pool, t.r))!.folder_id!;
    await expectLiveAt(s.pool, t.r, leaf);
    expect(await pathOf(s.pool, leaf)).toEqual({ names: ["F", "G"], rootId: t.F });
    expect((await folderRow(s.pool, leaf))?.parent_id).toBe(t.F);
    await expectLiveAt(s.pool, t.a, t.F);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("RF-SC 刪資料夾與建子資料夾", () => {
  it("刪先：建立 404 folder_not_found、沒有建出資料夾；刪 200", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const [dr, cr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => createFolder(s.app, t.u, t.F, "S"));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    failed(cr, 404, "folder_not_found");
    const { rows } = await s.pool.query<{ n: number }>("select count(*)::int as n from folders where owner_id = $1", [t.u]);
    expect(rows[0]!.n).toBe(0);
    await expectConsistent(s.pool);
  });

  it("建立先：建立 201；刪 200、新子資料夾一起被刪", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const [cr, dr] = await race(s, "folder-structure-locked", () => createFolder(s.app, t.u, t.F, "S"), () => delFolder(s.app, t.u, t.F));
    const S = okJson<FolderDto>(cr, 201).id;
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G, S]) });
    await expectFolders(s.pool, [], [t.F, t.G, S]);
    await expectConsistent(s.pool);
  });
});

describe("RF-MV 刪資料夾與搬子資料夾（出子樹、進子樹）", () => {
  async function setup(s: Scene) {
    const t = await personalTree(s);
    const g = await noteIn(s, { ownerId: t.u }, t.G);
    const O = (await seedFolder(s.db, { personal: t.u }, { name: "O" })).id;
    return { ...t, g, O };
  }

  it("刪先：搬移 404 folder_not_found；刪 200 含 G 與其筆記", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, mr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => patchFolder(s.app, t.u, t.G, { parentId: t.O }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, t.g]), deletedFolderIds: sorted([t.F, t.G]) });
    failed(mr, 404, "folder_not_found");
    await expectTrashedWith(s.pool, t.g, ["F", "G"]);
    await expectFolders(s.pool, [t.O], [t.F, t.G]);
    await expectConsistent(s.pool);
  });

  it("搬先：搬移 200；刪 200、搬出去的子資料夾與其筆記不受影響（筆記的閘門被收）", async () => {
    const s = await scene();
    const t = await setup(s);
    const [mr, dr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.G, { parentId: t.O }), () => delFolder(s.app, t.u, t.F));
    expect(okJson<FolderDto>(mr, 200).parentId).toBe(t.O);
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: [t.F] });
    expect((await folderRow(s.pool, t.G))?.parent_id).toBe(t.O);
    await expectLiveAt(s.pool, t.g, t.G);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.g)).toBe(false);
    await expectConsistent(s.pool);
  });

  it("搬進子樹，刪先：搬移 404 folder_not_found、X 與其筆記留在根層；刪 200 不含它們", async () => {
    const s = await scene();
    const t = await setup(s);
    const x = await noteIn(s, { ownerId: t.u }, t.O);
    const [dr, mr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => patchFolder(s.app, t.u, t.O, { parentId: t.F }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, t.g]), deletedFolderIds: sorted([t.F, t.G]) });
    failed(mr, 404, "folder_not_found");
    expect((await folderRow(s.pool, t.O))?.parent_id).toBeNull();
    await expectLiveAt(s.pool, x, t.O);
    await expectConsistent(s.pool);
  });

  it("搬進子樹，搬先：搬移 200；刪 409 conflict（多出一整棵、裡面的活筆記沒開閘門）、什麼都沒刪、閘門全收", async () => {
    const s = await scene();
    const t = await setup(s);
    const x = await noteIn(s, { ownerId: t.u }, t.O);
    const [mr, dr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.O, { parentId: t.F }), () => delFolder(s.app, t.u, t.F));
    expect(okJson<FolderDto>(mr, 200).parentId).toBe(t.F);
    conflicted(dr);
    expect((await folderRow(s.pool, t.O))?.parent_id).toBe(t.F);
    await expectLiveAt(s.pool, x, t.O);
    await expectLiveAt(s.pool, t.a, t.F);
    await expectLiveAt(s.pool, t.g, t.G);
    await expectFolders(s.pool, [t.F, t.G, t.O], []);
    await s.gatesSettled();
    for (const id of [t.a, t.g]) expect(s.ctx.collab.isDeleting(id), id).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("RF-RN 刪資料夾與改名子資料夾", () => {
  /** G 裡一篇活筆記 a2、一篇垃圾桶筆記 tr（快照是舊名）。 */
  async function setup(s: Scene) {
    const t = await personalTree(s);
    const a2 = await noteIn(s, { ownerId: t.u }, t.G);
    const tr = await noteIn(s, { ownerId: t.u }, t.G);
    await markTrashed(s.pool, tr, t.u);
    await setSnapshot(s.pool, tr, ["F", "G"]);
    return { ...t, a2, tr };
  }

  it("刪先：改名 404 folder_not_found；刪 200、快照用舊名", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, nr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => patchFolder(s.app, t.u, t.G, { name: "G2" }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, t.a2]), deletedFolderIds: sorted([t.F, t.G]) });
    failed(nr, 404, "folder_not_found");
    await expectTrashedWith(s.pool, t.a2, ["F", "G"]);
    await expectTrashedWith(s.pool, t.tr, ["F", "G"]);
    await expectConsistent(s.pool);
  });

  it("改名先：改名 200；刪 200、移入與刷新的快照都用新名", async () => {
    const s = await scene();
    const t = await setup(s);
    const [nr, dr] = await race(s, "folder-structure-locked", () => patchFolder(s.app, t.u, t.G, { name: "G2" }), () => delFolder(s.app, t.u, t.F));
    expect(okJson<FolderDto>(nr, 200).name).toBe("G2");
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([t.a, t.a2]), deletedFolderIds: sorted([t.F, t.G]) });
    await expectTrashedWith(s.pool, t.a2, ["F", "G2"]);
    await expectTrashedWith(s.pool, t.tr, ["F", "G2"]);
    await expectConsistent(s.pool);
  });
});

describe("RF-CP 刪資料夾與複製進子樹（I-1）", () => {
  interface CpForm {
    name: string;
    setup(s: Scene): Promise<{ by: string; F: string; G: string; others: string[]; src: string; srcAt: string | null; title: string; body: { folderId: string; groupId?: string } }>;
  }
  const forms: CpForm[] = [
    {
      name: "個人「建立副本」（來源與目標同一資料夾）",
      async setup(s) {
        const t = await personalTree(s);
        const title = `RFCP-p-${t.u.slice(0, 8)}`;
        const src = await noteIn(s, { ownerId: t.u }, t.G, title);
        return { by: t.u, F: t.F, G: t.G, others: [t.a], src, srcAt: t.G, title, body: { folderId: t.G } };
      },
    },
    {
      name: "群組「建立副本」",
      async setup(s) {
        const g = await sixRoleScene(s.db);
        const [F, G] = await seedFolderChain(s.db, { group: g.groupId }, ["F", "G"]);
        const a = await noteIn(s, { groupId: g.groupId }, F!);
        const title = `RFCP-g-${g.groupId.slice(0, 8)}`;
        const src = await noteIn(s, { groupId: g.groupId }, G!, title);
        return { by: g.admin.id, F: F!, G: G!, others: [a], src, srcAt: G!, title, body: { groupId: g.groupId, folderId: G! } };
      },
    },
    {
      name: "從子樹外複製進子樹",
      async setup(s) {
        const t = await personalTree(s);
        const title = `RFCP-o-${t.u.slice(0, 8)}`;
        const src = await noteIn(s, { ownerId: t.u }, null, title);
        return { by: t.u, F: t.F, G: t.G, others: [t.a], src, srcAt: null, title, body: { folderId: t.G } };
      },
    },
  ];

  for (const form of forms) {
    it(`${form.name}：刪先 → 複製 404 folder_not_found、沒有建出副本；刪 200`, async () => {
      const s = await scene();
      const c = await form.setup(s);
      const [dr, cr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, c.by, c.F), () => copy(s.app, c.by, c.src, c.body));
      const inTree = c.srcAt !== null ? [c.src] : [];
      expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: sorted([...c.others, ...inTree]), deletedFolderIds: sorted([c.F, c.G]) });
      failed(cr, 404, "folder_not_found");
      expect(await countTitled(s.pool, c.title)).toBe(1);
      await expectFolders(s.pool, [], [c.F, c.G]);
      await expectConsistent(s.pool);
    });

    it(`${form.name}：複製先 → 複製 201 在 G；刪 409 conflict、什麼都沒刪、閘門全收`, async () => {
      const s = await scene();
      const c = await form.setup(s);
      // 停在來源 KS 之後（`note-copy-locked`）：資料夾 KS 若被排到來源之後，這裡就只持來源 → 與刪成環 → server_busy。
      const [cr, dr] = await race(s, "note-copy-locked", () => copy(s.app, c.by, c.src, c.body), () => delFolder(s.app, c.by, c.F));
      const dup = okJson<NoteDto>(cr, 201);
      expect(dup.folderId).toBe(c.G);
      conflicted(dr);
      await expectLiveAt(s.pool, dup.id, c.G);
      await expectLiveAt(s.pool, c.src, c.srcAt);
      for (const o of c.others) await expectLiveAt(s.pool, o, c.F);
      await expectFolders(s.pool, [c.F, c.G], []);
      await s.gatesSettled();
      for (const id of [...c.others, c.src]) expect(s.ctx.collab.isDeleting(id), id).toBe(false);
      await expectConsistent(s.pool);
    });
  }
});

describe("RF-CN 刪資料夾與在子樹資料夾建立筆記（POST /api/notes，無交易）", () => {
  it("刪先：建立的 INSERT 在 FK KS 上等 → 23503 → 404 folder_not_found、沒有建出筆記；刪 200", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const title = `RFCN-${t.u.slice(0, 8)}`;
    const [dr, cr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.u, t.F), () => createNote(s.app, t.u, { title, folderId: t.G }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.a], deletedFolderIds: sorted([t.F, t.G]) });
    failed(cr, 404, "folder_not_found");
    expect(await countTitled(s.pool, title)).toBe(0);
    await expectConsistent(s.pool);
  });

  it("建立先（FD-C1 形：刪停在預讀與開閘門之後，建立整個完成再放行）：建立 201；刪 409 conflict、什麼都沒刪、閘門全收", async () => {
    const s = await scene();
    const t = await personalTree(s);
    const title = `RFCN-${t.u.slice(0, 8)}`;
    const h = s.seams.hold("folder-delete-gated");
    const deleting = delFolder(s.app, t.u, t.F);
    await entered(h.entered, deleting);
    let cr: Res;
    try {
      cr = await createNote(s.app, t.u, { title, folderId: t.G });
    } finally {
      h.open();
    }
    const dr = await deleting;
    noBusy(cr, dr);
    const created = okJson<NoteDto>(cr, 201);
    expect(created.folderId).toBe(t.G);
    conflicted(dr);
    await expectLiveAt(s.pool, created.id, t.G);
    await expectLiveAt(s.pool, t.a, t.F);
    await expectFolders(s.pool, [t.F, t.G], []);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.a)).toBe(false);
    await expectConsistent(s.pool);
  });
});

describe("RF-MG 刪群組資料夾與個人筆記移入群組子樹資料夾", () => {
  async function setup(s: Scene) {
    const g = await sixRoleScene(s.db);
    const [F, G] = await seedFolderChain(s.db, { group: g.groupId }, ["F", "G"]);
    const ga = await noteIn(s, { groupId: g.groupId }, F!);
    const n = await noteIn(s, { ownerId: g.admin.id }, null);
    return { by: g.admin.id, groupId: g.groupId, F: F!, G: G!, ga, n };
  }
  async function ownerOf(pool: Pool, noteId: string) {
    const { rows } = await pool.query<{ owner_id: string | null; group_id: string | null }>("select owner_id, group_id from notes where id = $1", [noteId]);
    return rows[0];
  }

  it("刪先：移入 404 folder_not_found、筆記仍是個人根層；刪 200", async () => {
    const s = await scene();
    const t = await setup(s);
    const [dr, mr] = await race(s, "folder-delete-notes-locked", () => delFolder(s.app, t.by, t.F), () => move(s.app, t.by, t.n, { groupId: t.groupId, folderId: t.G }));
    expect(okJson<FolderDeleteResultDto>(dr, 200)).toEqual({ trashedNoteIds: [t.ga], deletedFolderIds: sorted([t.F, t.G]) });
    failed(mr, 404, "folder_not_found");
    expect(await ownerOf(s.pool, t.n)).toEqual({ owner_id: t.by, group_id: null });
    await expectLiveAt(s.pool, t.n, null);
    await expectTrashedWith(s.pool, t.ga, ["F"]);
    await expectConsistent(s.pool);
  });

  it("移入先：移入 200 到 G；刪 409 conflict、什麼都沒刪、閘門全收", async () => {
    const s = await scene();
    const t = await setup(s);
    const [mr, dr] = await race(s, "note-move-locked", () => move(s.app, t.by, t.n, { groupId: t.groupId, folderId: t.G }), () => delFolder(s.app, t.by, t.F));
    expect(okJson<NoteDto>(mr, 200).folderId).toBe(t.G);
    conflicted(dr);
    expect(await ownerOf(s.pool, t.n)).toEqual({ owner_id: null, group_id: t.groupId });
    await expectLiveAt(s.pool, t.n, t.G);
    await expectLiveAt(s.pool, t.ga, t.F);
    await expectFolders(s.pool, [t.F, t.G], []);
    await s.gatesSettled();
    expect(s.ctx.collab.isDeleting(t.ga)).toBe(false);
    await expectConsistent(s.pool);
  });
});
