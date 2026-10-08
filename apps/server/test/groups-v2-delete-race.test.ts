/**
 * #175 PR4（spec §6.8、§11）刪群組兩模式的交錯案：C9a／C9b（轉移 × 成員異動）、C10（轉移的 savepoint 重試）、
 * C12／C12b／C12c（全刪 × gate 之後才進群組的筆記）、C17（全刪 gate 之後被轉移）、C20a–d（複製／移動／PATCH × 刪群組）、
 * C13 反向（token PUT × 轉移）、C21（別名 PUT × 轉移＋接手者重開 token，三方形）、C22（全刪持 L 時的上傳；Task 2 review r1 M1；#188 起 T7 與 `deleteNotesInTx` 的 `FOR UPDATE` 任一把都守得住這條）。
 * 要證明「測到的是交錯」的案在注入縫裡呼叫 `waitForBlockedOrSettled`，最後斷言 `"blocked"`；標「序列」的案在縫裡
 * `await` 一次完整的請求（窗在授權／gate 之後、交易或 UPDATE 之前，序列即可）。
 * C11（同一個舊網址兩次寫入轉址）不寫：轉移只寫 `/g/<被刪群組>/<現行 slug>` 鍵；移動與 0012 只寫 `/n/` 鍵；同群組的現行 slug
 * 由 S12 互異、群組轉移後即不存在——結構上不會同鍵（plan Task 4 第 12 條）。
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { noteRedirects, notes, uploads } from "../src/db/schema.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { NOT_ADMIN_MESSAGE } from "../src/groups/queries.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedRole, seedUser, setMemberRole, sleep, spyCollabHooks, waitForBlockedOrSettled } from "./group-helpers.js";
import { PNG, imageDoc, seedDoc, seedUpload } from "./copy-helpers.js";

const transfer = async (app: FastifyInstance, groupId: string, userId: string, transferTo: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "transfer", transferTo } });
const deleteAll = async (app: FastifyInstance, groupId: string, userId: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "delete" } });
const createInGroup = async (app: FastifyInstance, groupId: string, userId: string, title: string) =>
  app.inject({ method: "POST", url: "/api/notes", cookies: await cookieOf(userId), payload: { groupId, title } });
const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload });
const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });

const BOUNDARY = "kbDeleteRaceBoundary";
/** 單一 PNG file part 的 multipart body（同 `uploads.test.ts` 的手組形）。 */
function pngMultipart(): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`, "utf-8"),
    PNG,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf-8"),
  ]);
}
const upload = async (app: FastifyInstance, noteId: string, userId: string) =>
  app.inject({
    method: "POST",
    url: `/api/notes/${noteId}/uploads`,
    cookies: await cookieOf(userId),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: pngMultipart(),
  });

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const groupRows = async (pool: Pool, groupId: string): Promise<number> =>
  (await pool.query<{ n: number }>("select count(*)::int as n from groups where id = $1", [groupId])).rows[0]!.n;
const notesOfGroup = async (pool: Pool, groupId: string): Promise<string[]> =>
  (await pool.query<{ id: string }>("select id from notes where group_id = $1 order by id", [groupId])).rows.map(r => r.id);
const noteCount = async (pool: Pool): Promise<number> => (await pool.query<{ n: number }>("select count(*)::int as n from notes")).rows[0]!.n;

const NOT_ADMIN_BODY = { error: { code: "not_admin", message: NOT_ADMIN_MESSAGE } };
const GROUP_NOT_FOUND_BODY = { error: { code: "not_found", message: "找不到此群組" } };
const CREATE_GROUP_NOT_FOUND_BODY = { error: { code: "group_not_found", message: "找不到此群組" } };
const CONFLICT_BODY = { error: { code: "conflict", message: "筆記的歸屬已變更，請重新整理後再試" } };
const ALIAS_REJECTED_BODY = {
  error: { code: "invalid_body", message: "筆記尚未開啟公開分享、它是群組筆記，或在你送出後換了歸屬，無法設定公開網址" },
};

type RaceState = { fire?: () => Promise<LightMyRequestResponse>; second?: Promise<LightMyRequestResponse>; interleave?: string };

/** 在 `point` 第一次出現時發第二個請求，並等到它卡在鎖上（或沒被擋就結束）。 */
function raceHook(point: GroupRacePoint, state: RaceState, holder: { pool?: Pool }) {
  return async (p: GroupRacePoint) => {
    if (p !== point || !state.fire || state.second) return;
    state.second = state.fire();
    state.interleave = await waitForBlockedOrSettled(holder.pool!, state.second);
  };
}

/** 在 `point` 第一次出現時 `await` 一次完整的請求（序列案：窗在 gate／授權之後、交易之前，不需要 blocked）。 */
function serialHook(point: GroupRacePoint, state: { fire?: () => Promise<LightMyRequestResponse>; done?: LightMyRequestResponse; fired?: boolean }) {
  return async (p: GroupRacePoint) => {
    if (p !== point || !state.fire || state.fired) return;
    state.fired = true;
    state.done = await state.fire();
  };
}

/** `spyCollabHooks` 再把 `beforeNoteDeleted` 換成「每個 gate 一個 `release` spy」的版本。 */
function gatedHooks() {
  const gates: Array<{ noteId: string; release: ReturnType<typeof vi.fn<() => void>> }> = [];
  const hooks = {
    ...spyCollabHooks(),
    beforeNoteDeleted: vi.fn(async (noteId: string) => {
      const release = vi.fn<() => void>();
      gates.push({ noteId, release });
      return { release };
    }),
  };
  return { hooks, gates };
}

describe("#175 PR4 轉移 × 成員異動（C9a／C9b）", () => {
  it("C9a transferTo 被降級先拿到 lockGroup（group-members-checked）→ 轉移的 lockGroup 等它 → 降級 200、轉移 409 not_admin；群組與筆記原封不動", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: raceHook("group-members-checked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "plan" });
    const before = await noteState(db.$client, n.id);
    state.fire = () => transfer(app, g.id, a.id, b.id);

    const demoted = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}/members/${b.id}`, cookies: await cookieOf(a.id), payload: { roleId: g.memberRoleId } });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(demoted.statusCode).toBe(200);
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toEqual(NOT_ADMIN_BODY);
    expect(await groupRows(db.$client, g.id)).toBe(1);
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await db.select().from(noteRedirects)).toEqual([]);
  });

  it("C9b 轉移先持鎖（group-delete-locked）→ transferTo 退出的 lockGroup 等它 → 轉移 204、退出 404 not_found（群組已不在）", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: raceHook("group-delete-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "plan" });
    state.fire = async () => app.inject({ method: "DELETE", url: `/api/groups/${g.id}/members/${b.id}`, cookies: await cookieOf(b.id) });

    const moved = await transfer(app, g.id, a.id, b.id);
    const left = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(moved.statusCode).toBe(204);
    expect(left.statusCode).toBe(404);
    expect(left.json()).toEqual(GROUP_NOT_FOUND_BODY);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, group_id: null, slug: "plan" });
  });
});

describe("#175 PR4 轉移的 slug 重試（C10）", () => {
  it("C10 轉移探測到候選 x 之後（group-transfer-slug-candidate）transferTo 的個人範圍被另一連線佔走 x → savepoint 撞 notes_owner_slug_idx 重試 → x-2；外層交易 commit、轉址 /g/<g>/x 指向轉移的那篇", async () => {
    const holder: { db?: Parameters<typeof seedNote>[0]; ownerId?: string; seeded?: Promise<{ id: string; slug: string }>; interleave?: string } = {};
    const candidates: string[] = [];
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async (p, ctx) => {
        if (p !== "group-transfer-slug-candidate") return;
        candidates.push(ctx.slug!);
        if (ctx.slug !== "x" || holder.seeded) return;
        // 另一條 pool 連線、自動提交：插入不碰轉移持有的任何鎖（轉移還沒寫 (B, x)）——序列，所以期望 "settled"。
        holder.seeded = seedNote(holder.db!, { ownerId: holder.ownerId! }, { slug: "x" });
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.seeded);
      },
    });
    const { app, db } = built;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    Object.assign(holder, { db, ownerId: b.id });
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "x" });

    const res = await transfer(app, g.id, a.id, b.id);
    const squatter = await holder.seeded!;

    expect(holder.interleave).toBe("settled");
    expect(res.statusCode).toBe(204);
    expect(candidates).toEqual(["x", "x-2"]);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, group_id: null, slug: "x-2" });
    expect(await noteState(db.$client, squatter.id)).toMatchObject({ owner_id: b.id, slug: "x" });
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/g/${g.id}/x`, noteId: n.id },
    ]);
  });
});

describe("#175 PR4 全刪 × gate 之後才進群組的筆記（C12／C12b／C12c）", () => {
  it("C12 全刪：gate 之後（group-delete-gated）才在群組建的筆記 → 不經 gate 被刪；onGroupAccessChanged 恰一次 (那一篇, 全體成員)；beforeNoteDeleted 只對原本的 P0 呼叫", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; done?: LightMyRequestResponse; fired?: boolean } = {};
    const { hooks, gates } = gatedHooks();
    const built = await buildTestApp({ collabHooks: hooks, groupTestHook: serialHook("group-delete-gated", state) });
    const { app, db } = built;
    const [a, m1, m2] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m1.id, role: "member" }, { userId: m2.id, role: "member" }]);
    const p1 = await seedNote(db, { groupId: g.id });
    const p2 = await seedNote(db, { groupId: g.id });
    state.fire = () => createInGroup(app, g.id, m1.id, "Late");

    const res = await deleteAll(app, g.id, a.id);

    expect(state.done!.statusCode).toBe(201);
    const late = state.done!.json().id as string;
    expect(res.statusCode).toBe(204);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await noteCount(db.$client)).toBe(0);
    expect(sorted(hooks.beforeNoteDeleted.mock.calls.map(c => c[0]))).toEqual(sorted([p1.id, p2.id]));
    expect(gates.every(x => x.release.mock.calls.length === 0)).toBe(true);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([late]);
    expect(sorted(userIds)).toEqual(sorted([a.id, m1.id, m2.id]));
  });

  it("C12b 全刪：lockGroup 之後（group-delete-locked）才到的建立 → 卡在 FK KEY SHARE → 刪除 204、建立 404 group_not_found、沒有孤兒", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const { hooks } = gatedHooks();
    const built = await buildTestApp({ collabHooks: hooks, groupTestHook: raceHook("group-delete-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    await seedNote(db, { groupId: g.id });
    state.fire = () => createInGroup(app, g.id, m.id, "Late");

    const res = await deleteAll(app, g.id, a.id);
    const created = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(res.statusCode).toBe(204);
    expect(created.statusCode).toBe(404);
    expect(created.json()).toEqual(CREATE_GROUP_NOT_FOUND_BODY);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await noteCount(db.$client)).toBe(0);
    expect(hooks.onGroupAccessChanged).not.toHaveBeenCalled();
  });

  it("C12c 全刪：gate 之後（group-delete-gated）才複製進群組的筆記 → 不經 gate 被刪；onGroupAccessChanged 含那一篇", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; done?: LightMyRequestResponse; fired?: boolean } = {};
    const { hooks } = gatedHooks();
    const built = await buildTestApp({ collabHooks: hooks, groupTestHook: serialHook("group-delete-gated", state) });
    const { app, db } = built;
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const p1 = await seedNote(db, { groupId: g.id });
    const personal = await seedNote(db, { ownerId: m.id }, { title: "Mine" });
    state.fire = () => copy(app, personal.id, m.id, { groupId: g.id });

    const res = await deleteAll(app, g.id, a.id);

    expect(state.done!.statusCode).toBe(201);
    const copied = state.done!.json().id as string;
    expect(res.statusCode).toBe(204);
    expect(await notesOfGroup(db.$client, g.id)).toEqual([]);
    expect(await db.select({ id: notes.id }).from(notes)).toEqual([{ id: personal.id }]);
    expect(hooks.beforeNoteDeleted.mock.calls.map(c => c[0])).toEqual([p1.id]);
    expect(hooks.onGroupAccessChanged).toHaveBeenCalledTimes(1);
    const [noteIds, userIds] = hooks.onGroupAccessChanged.mock.calls[0]!;
    expect(noteIds).toEqual([copied]);
    expect(sorted(userIds)).toEqual(sorted([a.id, m.id]));
  });
});

describe("#175 PR4 全刪 × 轉移（C17）", () => {
  it("C17 全刪開完 gate 之後（group-delete-gated），另一位管理員的轉移先完成 → 全刪 404 not_found、每個 gate release；筆記以 transferTo 的個人筆記存活", async () => {
    const state: { fire?: () => Promise<LightMyRequestResponse>; done?: LightMyRequestResponse; fired?: boolean } = {};
    const { hooks, gates } = gatedHooks();
    const built = await buildTestApp({ collabHooks: hooks, groupTestHook: serialHook("group-delete-gated", state) });
    const { app, db } = built;
    const [a, a2] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: a2.id, role: "admin" }]);
    const p1 = await seedNote(db, { groupId: g.id }, { slug: "one" });
    const p2 = await seedNote(db, { groupId: g.id }, { slug: "two" });
    state.fire = () => transfer(app, g.id, a2.id, a2.id);

    const res = await deleteAll(app, g.id, a.id);

    expect(state.done!.statusCode).toBe(204);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(GROUP_NOT_FOUND_BODY);
    expect(sorted(gates.map(x => x.noteId))).toEqual(sorted([p1.id, p2.id]));
    expect(gates.map(x => x.release.mock.calls.length)).toEqual([1, 1]);
    expect(await noteState(db.$client, p1.id)).toMatchObject({ owner_id: a2.id, group_id: null, slug: "one" });
    expect(await noteState(db.$client, p2.id)).toMatchObject({ owner_id: a2.id, group_id: null, slug: "two" });
  });
});

describe("#175 PR4 複製／移動 × 刪群組（C20a／C20b／C20c）", () => {
  it("C20a 複製（群組筆記 → 個人）持來源 KEY SHARE（note-copy-locked）時全刪 → 全刪的 FOR UPDATE 等複製 commit → 複製 201（副本是複製者的個人筆記、附件獨立）、全刪 204、來源消失", async () => {
    const holder: { app?: FastifyInstance; pool?: Pool; groupId?: string; adminId?: string; del?: Promise<LightMyRequestResponse>; interleave?: string } = {};
    const { hooks } = gatedHooks();
    const built = await buildTestApp({
      collabHooks: hooks,
      groupTestHook: async p => {
        if (p !== "note-copy-locked" || holder.del) return;
        holder.del = deleteAll(holder.app!, holder.groupId!, holder.adminId!);
        holder.interleave = await waitForBlockedOrSettled(holder.pool!, holder.del);
      },
    });
    const { app, db, uploadsDir } = built;
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    Object.assign(holder, { app, pool: db.$client, groupId: g.id, adminId: a.id });
    const src = await seedNote(db, { groupId: g.id }, { title: "Src" });
    const u1 = await seedUpload(db, uploadsDir, src.id, a.id);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${u1}`]));

    // 註（Task 4–6 review r1 N2）：M8（拿掉 T7 的 FOR UPDATE）下本案仍綠——等待改由 deleteNotesInTx 取得（#188 起是它第一步的 FOR UPDATE，之前是 DELETE notes）
    // （同樣要等複製持有的 KEY SHARE），複製在自己的快照讀附件、磁碟檔在 T7 commit 後才刪，結果逐項相同，屬等價。
    // FOR UPDATE 的承重由 C22 守（#188 起 `deleteNotesInTx` 也取 FOR UPDATE，M8 對 C22 亦等價；見 C22 的註）。
    const copied = await copy(app, src.id, m.id);
    const del = await holder.del!;

    expect(holder.interleave).toBe("blocked");
    expect(copied.statusCode).toBe(201);
    expect(copied.json()).toMatchObject({ ownerId: m.id, groupId: null, title: "Src" });
    expect(del.statusCode).toBe(204);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await db.select({ id: notes.id, ownerId: notes.ownerId }).from(notes)).toEqual([{ id: copied.json().id, ownerId: m.id }]);
    const copyUploads = await db.select({ id: uploads.id }).from(uploads);
    expect(copyUploads).toHaveLength(1);
    expect(copyUploads[0]!.id).not.toBe(u1);
    expect(existsSync(uploadFilePath(uploadsDir, copyUploads[0]!.id))).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, u1))).toBe(false);
  });

  it("C20b 同群組複製持 (g) 目標 groups KEY SHARE（note-copy-target-locked）時轉移 → lockGroup 等它 → 兩邊完成、沒有 40P01；副本也被轉給 transferTo", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: raceHook("note-copy-target-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: m.id, role: "member" }]);
    const src = await seedNote(db, { groupId: g.id }, { title: "Same group" });
    state.fire = () => transfer(app, g.id, a.id, a.id);

    const copied = await copy(app, src.id, m.id, { groupId: g.id });
    const moved = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(copied.statusCode).toBe(201);
    expect(moved.statusCode).toBe(204);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    const rows = await db.select({ id: notes.id, ownerId: notes.ownerId, groupId: notes.groupId }).from(notes);
    expect(sorted(rows.map(r => r.id))).toEqual(sorted([src.id, copied.json().id]));
    for (const r of rows) expect(r).toMatchObject({ ownerId: a.id, groupId: null });
  });

  it("C20c 移動（個人 → G）持筆記 FOR UPDATE＋groups KEY SHARE（note-move-locked）時轉移 G → lockGroup 等它 → 移動 200、轉移把它撈進去；/n/<mover>/<s> 與 /g/<g>/<s> 兩條轉址都指向它", async () => {
    const state: RaceState = {};
    const holder: { pool?: Pool } = {};
    const built = await buildTestApp({ collabHooks: spyCollabHooks(), groupTestHook: raceHook("note-move-locked", state, holder) });
    holder.pool = built.db.$client;
    const { app, db } = built;
    const [a, mover] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: mover.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: mover.id }, { slug: "plan" });
    state.fire = () => transfer(app, g.id, a.id, a.id);

    const moved = await move(app, n.id, mover.id, g.id);
    const transferred = await state.second!;

    expect(state.interleave).toBe("blocked");
    expect(moved.statusCode).toBe(200);
    expect(transferred.statusCode).toBe(204);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null, slug: "plan" });
    const redirects = await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects);
    expect(redirects.sort((x, y) => x.oldPath.localeCompare(y.oldPath))).toEqual([
      { oldPath: `/g/${g.id}/plan`, noteId: n.id },
      { oldPath: `/n/${mover.handle}/plan`, noteId: n.id },
    ]);
  });
});

describe("#175 PR4 授權之後群組被轉移（C20d／C13 反向）", () => {
  it("C20d 自訂 slug PATCH 授權之後（slugPatchTestHook authorized）群組被轉移 → PATCH 409 conflict；slug 未寫", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      slugPatchTestHook: async (point, ctx) => {
        if (point !== "authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const { app, db } = built;
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "baz", slugIsCustom: true });
    Object.assign(state, { noteId: n.id, fire: () => transfer(app, g.id, a.id, a.id) });

    const res = await app.inject({ method: "PATCH", url: `/api/notes/${n.id}`, cookies: await cookieOf(a.id), payload: { slug: "qux" } });

    expect(state.moved!.statusCode).toBe(204);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(CONFLICT_BODY);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null, slug: "baz", prev_slug: null });
    expect(await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects)).toEqual([
      { oldPath: `/g/${g.id}/baz`, noteId: n.id },
    ]);
  });

  it("C13 反向 token PUT 授權之後（public-link-authorized）群組被轉移 → PUT 409 conflict；token 仍為 null（轉移已清、遲到的 PUT 沒有在接手者的個人筆記上重新開出公開連結）", async () => {
    const state: { noteId?: string; fire?: () => Promise<LightMyRequestResponse>; moved?: LightMyRequestResponse } = {};
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async (point, ctx) => {
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.moved) return;
        state.moved = await state.fire!();
      },
    });
    const { app, db } = built;
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { publicToken: "t".repeat(43) });
    Object.assign(state, { noteId: n.id, fire: () => transfer(app, g.id, a.id, a.id) });

    const put = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(a.id) });

    expect(state.moved!.statusCode).toBe(204);
    expect(put.statusCode).toBe(409);
    expect(put.json()).toEqual(CONFLICT_BODY);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: a.id, group_id: null, public_token: null, public_slug: null });
  });
});

describe("#175 PR4 全刪 × 上傳（C22，Task 2 review r1 M1）", () => {
  /** 等到這個測試 DB 上至少有 `n` 條連線在等鎖，或 `other` 已結束。 */
  async function waitForWaiters(pool: Pool, n: number, other?: Promise<unknown>, timeoutMs = 5_000): Promise<"blocked" | "settled"> {
    let settled = false;
    void other?.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (settled) return "settled";
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (rows[0]!.n >= n) return "blocked";
      await sleep(20);
    }
    throw new Error(`waitForWaiters(${n}) 逾時（${timeoutMs}ms）`);
  }

  it("C22 全刪持 L（群組筆記 FOR UPDATE）時上傳到其中一篇 → 上傳交易的筆記 KEY SHARE 讀等全刪 commit → 刪除 204、上傳 404 not_found（讀到 0 列 → TxAbort，路由已 unlink）；uploads 0 列、磁碟沒有孤兒檔", async () => {
    // 把 T7 停在「已持 L、`deleteNotesInTx` 的 DELETE uploads 還沒做完」：另一條連線先對該篇既有的附件列 u0 取 FOR UPDATE，
    // T7 的 DELETE uploads 就卡在 u0 上（此時 L 已到手）。在這個窗裡發上傳：有 L 時上傳交易（`insertUploadInTx`）對 notes 列的
    // `FOR KEY SHARE` 讀 → 與 FOR UPDATE 互斥 → 等 T7 commit 後讀到 0 列 → TxAbort 404（儲存配額 PR1 以前是 INSERT 的 FK 檢查
    // 取同一把鎖、撞 23503 → 404）；沒有 L 時上傳直接成功（201），之後 DELETE uploads 的快照看不到它、
    // DELETE notes 以 CASCADE 帶走它的列——它不在回傳的 uploadIds 裡，磁碟檔就成了孤兒（review r1 M1 的最小 schema 實測形）。
    // 鑑別（Task 4–6 review r1 N6）：PR4 時拿掉 T7 的 FOR UPDATE（M8），本案先紅在 interleave 斷言（上傳沒被擋、得 201），
    // 跑不到最後的 readdir；孤兒檔本身是靠測試側變體（拿掉 interleave 斷言後）才實際看到——readdir 那條不是 M8 的守衛。
    // #188 起 `deleteNotesInTx` 在 DELETE uploads 之前也對 L 取 FOR UPDATE：單拿掉 M8 或單拿掉那一把，本案都仍綠（等價）；
    // 兩把都拿掉才紅在 interleave。單篇刪除的同形由 `notes-delete-race.test.ts` 守（拿掉 `deleteNotesInTx` 那一把即紅）。
    // 上傳交易被拒（0 列 TxAbort；防禦縱深的 FK 23503 同）時路由先 unlink 再回 404 not_found（Task 4–6 review r1 M1）；本案的 readdir 斷言同時守住「先 unlink」。
    const holder: {
      app?: FastifyInstance; pool?: Pool; noteId?: string; userId?: string; u0?: string;
      up?: Promise<LightMyRequestResponse>; locker?: Promise<void>; t7Blocked?: string; interleave?: string;
    } = {};
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async p => {
        if (p !== "group-delete-locked" || holder.locker) return;
        const c = await holder.pool!.connect();
        await c.query("begin");
        await c.query("select id from uploads where id = $1 for update", [holder.u0]);
        // 不 await：讓 T7 繼續走到 L 與 DELETE uploads（卡在 u0），在那個窗裡發上傳，量完再放開 u0。
        holder.locker = (async () => {
          try {
            holder.t7Blocked = await waitForWaiters(holder.pool!, 1);
            holder.up = upload(holder.app!, holder.noteId!, holder.userId!);
            holder.interleave = await waitForWaiters(holder.pool!, 2, holder.up);
          } finally {
            await c.query("commit");
            c.release();
          }
        })();
      },
    });
    const { app, db, uploadsDir } = built;
    const a = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id });
    const u0 = await seedUpload(db, uploadsDir, n.id, a.id);
    Object.assign(holder, { app, pool: db.$client, noteId: n.id, userId: a.id, u0 });

    const del = await deleteAll(app, g.id, a.id);
    await holder.locker;
    const up = await holder.up!;

    expect(holder.t7Blocked).toBe("blocked");
    expect(holder.interleave).toBe("blocked");
    expect(del.statusCode).toBe(204);
    expect(up.statusCode).toBe(404);
    // 與「筆記本來就不存在」的 404 逐位元組相同（uploads.test.ts 的 404 案同形）。
    const missing = await upload(app, "22222222-2222-2222-2222-222222222222", a.id);
    expect(missing.statusCode).toBe(404);
    expect(up.body).toBe(missing.body);
    expect(await groupRows(db.$client, g.id)).toBe(0);
    expect(await db.select().from(uploads)).toEqual([]);
    expect(await readdir(uploadsDir)).toEqual([]);
  });
});

describe("#175 PR4 別名 PUT 授權之後群組被轉移、接手者重開公開連結（C21）", () => {
  // 轉移已清 token（Willie 裁決），兩方形（只轉移）被既有述詞 `public_token IS NOT NULL` 擋下；要接手者重開 token 的三方形
  // 才會讓舊述詞 `group_id IS NULL` 放行、把前成員選的名字寫進接手者的 `/p/<B>/…` 命名空間（plan Task 7、gate r1 W4）。
  it("C21 別名 PUT 授權之後（public-link-authorized）：群組被轉移給 B、B 重新開公開連結 → M 遲到的別名 PUT 400 invalid_body；B 那篇的 public_slug 仍 NULL、token 是 B 剛開的那個", async () => {
    const state: {
      noteId?: string;
      fired?: boolean;
      fire?: () => Promise<LightMyRequestResponse>;
      reopen?: () => Promise<LightMyRequestResponse>;
      moved?: LightMyRequestResponse;
      reopened?: LightMyRequestResponse;
    } = {};
    const built = await buildTestApp({
      collabHooks: spyCollabHooks(),
      groupTestHook: async (point, ctx) => {
        // 只在第一次（M 的別名 PUT）介入；B 重開 token 的 PUT 也會經過同一個點，`fired` 先立起來讓它直接放行。
        if (point !== "public-link-authorized" || ctx.noteId !== state.noteId || state.fired) return;
        state.fired = true;
        state.moved = await state.fire!();
        state.reopened = await state.reopen!();
      },
    });
    const { app, db } = built;
    const [a, b, m] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: m.id, role: "member" }]);
    await setMemberRole(db, g.id, m.id, await seedRole(db, g.id, "publisher", { canRead: true, canManagePublicLink: true }));
    const n = await seedNote(db, { groupId: g.id }, { publicToken: "t".repeat(43) });
    Object.assign(state, {
      noteId: n.id,
      fire: () => transfer(app, g.id, a.id, b.id),
      reopen: async () => app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link`, cookies: await cookieOf(b.id) }),
    });

    const res = await app.inject({ method: "PUT", url: `/api/notes/${n.id}/public-link/slug`, cookies: await cookieOf(m.id), payload: { slug: "m-pick" } });

    expect(state.moved!.statusCode).toBe(204);
    expect(state.reopened!.statusCode).toBe(200);
    const reopenedToken = state.reopened!.json().token as string;
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(ALIAS_REJECTED_BODY);
    expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: b.id, group_id: null, public_token: reopenedToken, public_slug: null });
  });
});
