/**
 * #181：群組與垃圾桶。
 * 造垃圾桶狀態一律打 `DELETE /api/notes/:id`；只有「把刪除時刻往前推」直改 DB（證明保留期照原刪除時間算）。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { NoteDto, StorageUsageDto, TrashListDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { noteState, seedGroup, seedNote, seedUser, sharesOf } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { seedAttachment, usedOf } from "./storage-helpers.js";
import { inject, sixRoleScene, trashCols } from "./trash-helpers.js";

const DAY_MS = 86_400_000;
const token = () => randomBytes(32).toString("base64url");

const del = (app: FastifyInstance, noteId: string, userId: string) => inject(app, "DELETE", `/api/notes/${noteId}`, userId);
const listOf = async (app: FastifyInstance, userId: string): Promise<TrashListDto> => {
  const res = await inject(app, "GET", "/api/trash", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TrashListDto;
};
const listIds = async (app: FastifyInstance, userId: string) => (await listOf(app, userId)).items.map(i => i.id);
const restore = (app: FastifyInstance, userId: string, ids: string[]) => inject(app, "POST", "/api/trash/restore", userId, { ids });
const purge = (app: FastifyInstance, userId: string, ids: string[]) => inject(app, "POST", "/api/trash/purge", userId, { ids });
const withId = (body: unknown, from: string, to: string): unknown => JSON.parse(JSON.stringify(body).split(from).join(to));
const rowExists = async (db: Db, table: "notes" | "uploads", id: string) =>
  (await db.$client.query(`select 1 from ${table} where id = $1`, [id])).rowCount === 1;
/** `deleted_at` 的毫秒（epoch）；DTO 的 `deletedAt` 是毫秒精度。 */
const deletedAtMs = async (db: Db, id: string): Promise<number> => {
  const { rows } = await db.$client.query<{ ms: number }>(`select (extract(epoch from deleted_at) * 1000)::float8 as ms from notes where id = $1`, [id]);
  return rows[0]!.ms;
};
const roleIdOf = async (db: Db, groupId: string, userId: string): Promise<string> => {
  const { rows } = await db.$client.query<{ role_id: string }>(`select role_id from group_members where group_id = $1 and user_id = $2`, [groupId, userId]);
  return rows[0]!.role_id;
};
const setRoleFlags = (db: Db, roleId: string, flags: { can_edit: boolean; can_delete: boolean }) =>
  db.$client.query(`update group_roles set can_edit = $2, can_delete = $3 where id = $1`, [roleId, flags.can_edit, flags.can_delete]);

async function expect204(res: Promise<LightMyRequestResponse>): Promise<void> {
  const r = await res;
  expect(r.statusCode, r.body).toBe(204);
}

describe("G1 刪群組・轉移", () => {
  it("垃圾桶裡的群組筆記成為接收者的個人筆記、仍在垃圾桶（刪除時刻／刪除者不變、公開連結清掉）；接收者還原後是沒有分享的個人筆記", async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const d = s.editDelete; // 移入者 D：自訂角色（閱讀＋編輯＋刪除）
    const a = await seedNote(db, { groupId: s.groupId }, { title: "G1 活" });
    const t = await seedNote(db, { groupId: s.groupId }, { title: "G1 垃圾桶", publicToken: token() });
    const other = await seedNote(db, { ownerId: s.outsider.id }); // 旁觀者：別人的個人垃圾桶筆記
    await expect204(del(app, t.id, d.id));
    await expect204(del(app, other.id, s.outsider.id));
    // 往前推兩天：轉移若重寫 deleted_at（＝now()），下面的時刻比對就紅。
    await db.$client.query(`update notes set deleted_at = deleted_at - interval '2 days' where id = $1`, [t.id]);
    const before = await trashCols(db.$client, t.id);
    const beforeMs = await deletedAtMs(db, t.id);
    const otherBefore = await trashCols(db.$client, other.id);
    expect(before?.deleted_by).toBe(d.id);
    expect((await noteState(db.$client, t.id)).public_token).not.toBeNull();

    const res = await inject(app, "DELETE", `/api/groups/${s.groupId}`, s.admin.id, { mode: "transfer", transferTo: s.admin.id });
    expect(res.statusCode, res.body).toBe(204);

    expect(await trashCols(db.$client, t.id)).toEqual(before);
    expect(await noteState(db.$client, t.id)).toMatchObject({ owner_id: s.admin.id, group_id: null, public_token: null, public_slug: null });
    expect(await trashCols(db.$client, a.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await noteState(db.$client, a.id)).toMatchObject({ owner_id: s.admin.id, group_id: null });
    expect(await trashCols(db.$client, other.id)).toEqual(otherBefore);

    const list = await listOf(app, s.admin.id);
    expect(list.items.map(i => i.id)).toEqual([t.id]);
    const item = list.items[0]!;
    expect(item).toMatchObject({ id: t.id, title: "G1 垃圾桶", group: null, deletedBy: { handle: d.handle } });
    expect(Math.abs(Date.parse(item.deletedAt) - beforeMs)).toBeLessThan(1);
    expect(Date.parse(item.purgeAt!) - Date.parse(item.deletedAt)).toBe(7 * DAY_MS);
    // 移入者 D 已不是任何群組的成員：他的垃圾桶裡沒有它。
    expect(await listIds(app, d.id)).toEqual([]);

    const r = await restore(app, s.admin.id, [t.id]);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as TrashRestoreResultDto;
    expect(body.skipped).toEqual([]);
    expect(body.restored).toHaveLength(1);
    expect(body.restored[0]).toMatchObject({ id: t.id, ownerId: s.admin.id, role: "owner", groupId: null, group: null });
    expect(await trashCols(db.$client, t.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await sharesOf(db, t.id)).toEqual([]);
    expect((await noteState(db.$client, t.id)).public_token).toBeNull();
    const mine = (await inject(app, "GET", "/api/notes", s.admin.id)).json() as NoteDto[];
    expect(mine.map(n => n.id).sort()).toEqual([a.id, t.id].sort());
    expect(await listIds(app, s.admin.id)).toEqual([]);
  });
});

describe("G2 刪群組・全刪", () => {
  it("活筆記與垃圾桶裡的群組筆記連同附件列、磁碟檔一起不在；別處的垃圾桶筆記不受影響", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G2", [{ userId: admin.id, role: "admin" }]);
    const a = await seedNote(db, { groupId: g.id });
    const t = await seedNote(db, { groupId: g.id });
    const p = await seedNote(db, { ownerId: admin.id }); // 旁觀者：同一人的個人垃圾桶筆記
    const ua = await seedAttachment(db, uploadsDir, a.id, admin.id, 10);
    const ut = await seedAttachment(db, uploadsDir, t.id, admin.id, 20);
    const up = await seedAttachment(db, uploadsDir, p.id, admin.id, 30);
    await expect204(del(app, t.id, admin.id));
    await expect204(del(app, p.id, admin.id));
    expect((await listIds(app, admin.id)).sort()).toEqual([t.id, p.id].sort());

    const res = await inject(app, "DELETE", `/api/groups/${g.id}`, admin.id, { mode: "delete" });
    expect(res.statusCode, res.body).toBe(204);

    const state = async (noteId: string, uploadId: string) => ({
      note: await rowExists(db, "notes", noteId),
      upload: await rowExists(db, "uploads", uploadId),
      file: existsSync(uploadFilePath(uploadsDir, uploadId)),
    });
    expect({ a: await state(a.id, ua), t: await state(t.id, ut), p: await state(p.id, up) }).toEqual({
      a: { note: false, upload: false, file: false },
      t: { note: false, upload: false, file: false },
      p: { note: true, upload: true, file: true },
    });
    expect(await listIds(app, admin.id)).toEqual([p.id]);
  });
});

describe("G3 角色即時", () => {
  it("編輯＋刪除角色列得到 → 拿掉刪除旗標立刻列不到、restore 得 not_found；改成拿掉編輯旗標同樣；旗標都回來又列得到、可還原", async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const n = await seedNote(db, { groupId: s.groupId });
    await expect204(del(app, n.id, s.admin.id));
    const roleId = await roleIdOf(db, s.groupId, s.editDelete.id);
    expect(await listIds(app, s.editDelete.id)).toEqual([n.id]);

    const ghost = randomUUID();
    const notFound = (await restore(app, s.editDelete.id, [ghost])).json();
    for (const flags of [{ can_edit: true, can_delete: false }, { can_edit: false, can_delete: true }]) {
      await setRoleFlags(db, roleId, flags);
      expect(await listIds(app, s.editDelete.id), JSON.stringify(flags)).toEqual([]);
      const r = await restore(app, s.editDelete.id, [n.id]);
      expect([r.statusCode, withId(r.json(), n.id, ghost)], JSON.stringify(flags)).toEqual([200, notFound]);
      expect(r.json(), JSON.stringify(flags)).toEqual({ restored: [], skipped: [{ id: n.id, reason: "not_found" }] });
      expect((await trashCols(db.$client, n.id))?.deleted_at, JSON.stringify(flags)).not.toBeNull();
    }

    await setRoleFlags(db, roleId, { can_edit: true, can_delete: true });
    expect(await listIds(app, s.editDelete.id)).toEqual([n.id]);
    const ok = (await restore(app, s.editDelete.id, [n.id])).json() as TrashRestoreResultDto;
    expect(ok.restored.map(x => x.id)).toEqual([n.id]);
  });
});

describe("G4 能刪不能編輯", () => {
  it("deleteOnly 移入群組筆記 → 204；他的垃圾桶沒有它、restore 得 not_found；管理員列得到並能還原", async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const n = await seedNote(db, { groupId: s.groupId });
    await expect204(del(app, n.id, s.deleteOnly.id));
    expect((await trashCols(db.$client, n.id))?.deleted_by).toBe(s.deleteOnly.id);

    expect(await listIds(app, s.deleteOnly.id)).toEqual([]);
    const r = await restore(app, s.deleteOnly.id, [n.id]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ restored: [], skipped: [{ id: n.id, reason: "not_found" }] });
    expect((await trashCols(db.$client, n.id))?.deleted_at).not.toBeNull();

    const adminList = await listOf(app, s.admin.id);
    expect(adminList.items.map(i => i.id)).toEqual([n.id]);
    expect(adminList.items[0]).toMatchObject({ group: { id: s.groupId }, deletedBy: { handle: s.deleteOnly.handle } });
    const ok = (await restore(app, s.admin.id, [n.id])).json() as TrashRestoreResultDto;
    expect(ok.restored.map(x => x.id)).toEqual([n.id]);
    expect(await trashCols(db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
  });
});

describe("G5 容量", () => {
  it("個人與群組各一篇附件筆記：移入後用量（現場 SUM 與兩支用量端點）不變；永久刪除後減少", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G5", [{ userId: u.id, role: "admin" }]);
    const p = await seedNote(db, { ownerId: u.id });
    const q = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, p.id, u.id, 1000);
    await seedAttachment(db, uploadsDir, q.id, u.id, 2000);
    const usage = async () => ({
      user: await usedOf(db.$client, { kind: "user", id: u.id }),
      group: await usedOf(db.$client, { kind: "group", id: g.id }),
      userApi: ((await inject(app, "GET", "/api/storage", u.id)).json() as StorageUsageDto).usedBytes,
      groupApi: ((await inject(app, "GET", `/api/groups/${g.id}/storage`, u.id)).json() as StorageUsageDto).usedBytes,
    });
    const full = { user: 1000, group: 2000, userApi: 1000, groupApi: 2000 };
    expect(await usage()).toEqual(full);

    await expect204(del(app, p.id, u.id));
    await expect204(del(app, q.id, u.id));
    expect(await usage()).toEqual(full);

    const res = await purge(app, u.id, [p.id, q.id]);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as TrashPurgeResultDto).purged).toEqual([p.id, q.id]);
    expect(await usage()).toEqual({ user: 0, group: 0, userApi: 0, groupApi: 0 });
  });
});

describe("G6 群組筆記的公開連結", () => {
  it("管理員移入 → 公開 token 404；另一位編輯＋刪除成員還原 → 公開 token 200、欄位未被改", async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const tok = token();
    const n = await seedNote(db, { groupId: s.groupId }, { publicToken: tok });
    const anon = () => app.inject({ method: "GET", url: `/api/public/notes/${tok}` });
    expect((await anon()).statusCode).toBe(200);

    await expect204(del(app, n.id, s.admin.id));
    expect((await anon()).statusCode).toBe(404);
    expect((await noteState(db.$client, n.id)).public_token).toBe(tok);

    const ok = (await restore(app, s.editDelete.id, [n.id])).json() as TrashRestoreResultDto;
    expect(ok.restored.map(x => x.id)).toEqual([n.id]);
    expect(ok.restored[0]).toMatchObject({ groupId: s.groupId, ownerId: null });
    expect((await anon()).statusCode).toBe(200);
  });
});
