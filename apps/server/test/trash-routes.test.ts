/**
 * #181 PR-2a T9：垃圾桶 REST——`GET /api/trash`、`POST /api/trash/restore`、`POST /api/trash/purge`（spec 2026-10-21 §6.3.3–§6.3.5、
 * §6.7、A2-4 六角色矩陣、AG2）。造垃圾桶狀態一律打 `DELETE /api/notes/:id`（T8 起＝移入）；只有「同時刻」與大量資料兩案直改 DB。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { NoteDto, TrashListDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../src/auth/tx/admin-site-settings.js";
import { noopCollabHooks } from "../src/collab/hooks.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { purgeTrashed } from "../src/trash/service.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedGroup, seedNote, seedShare, seedUser, spyCollabHooks, type SeededUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { captureLogs } from "./helpers/admin-auth.js";
import { giveUserQuota, seedAttachment } from "./storage-helpers.js";
import { inject, sixRoleScene, trashCols, type SixRoleScene } from "./trash-helpers.js";

const INVALID = { error: { code: "invalid_body", message: "請求格式錯誤：ids 須為 1 到 200 個筆記 id" } };
const inTrash = (noteId: string) => ({ error: { code: "in_trash", message: "這篇筆記在垃圾桶裡" }, noteId });
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
/** 把回應 body 裡的某個 id 換成另一個（AG2：與「不存在」逐欄相同，只差 id 本身）。 */
const withId = (body: unknown, from: string, to: string): unknown => JSON.parse(JSON.stringify(body).split(from).join(to));
const noteExists = async (db: Db, id: string) => (await db.$client.query(`select 1 from notes where id = $1`, [id])).rowCount === 1;
const uploadExists = async (db: Db, id: string) => (await db.$client.query(`select 1 from uploads where id = $1`, [id])).rowCount === 1;

async function expect204(res: Promise<LightMyRequestResponse>): Promise<void> {
  const r = await res;
  expect(r.statusCode, r.body).toBe(204);
}

describe("TR-L1 兩區與排序", () => {
  it("個人 a、b 與群組 g 依序移入 → items 依 deleted_at 新到舊（g、b、a）；retentionDays 7、truncated false", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const grp = await seedGroup(db, "L1", [{ userId: owner.id, role: "admin" }]);
    const a = await seedNote(db, { ownerId: owner.id });
    const b = await seedNote(db, { ownerId: owner.id });
    const g = await seedNote(db, { groupId: grp.id });
    // 資料夾 PR-3d Q3：同一毫秒改依 id 排，所以每次移入後把剛移入那篇的 deleted_at 設成前一篇＋2 ms（順序不靠微秒）。
    const spaceAfter = (id: string, prev: string) =>
      db.$client.query(`update notes set deleted_at = (select deleted_at from notes where id = $2) + interval '2 milliseconds' where id = $1`, [id, prev]);
    await expect204(del(app, a.id, owner.id));
    await expect204(del(app, b.id, owner.id));
    await spaceAfter(b.id, a.id);
    await expect204(del(app, g.id, owner.id));
    await spaceAfter(g.id, b.id);

    const body = await listOf(app, owner.id);
    expect(body.items.map(i => i.id)).toEqual([g.id, b.id, a.id]);
    expect(body.retentionDays).toBe(7);
    expect(body.truncated).toBe(false);
  });

  it("同一個 deleted_at → id 由大到小", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    // 六篇：沒有 id 次序時，碰巧排成 id 由大到小的機率是 1/720。
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push((await seedNote(db, { ownerId: owner.id })).id);
    // 一句 UPDATE 裡 now() 是同一個值。
    await db.$client.query(`update notes set deleted_at = now(), deleted_by = $2 where id = any($1::uuid[])`, [ids, owner.id]);
    const { rows } = await db.$client.query<{ n: number }>(`select count(distinct deleted_at)::int n from notes where id = any($1::uuid[])`, [ids]);
    expect(rows[0]!.n).toBe(1);

    expect(await listIds(app, owner.id)).toEqual([...ids].sort().reverse());
  });

  it("TR-MS（資料夾 PR-3d Q3）：同一毫秒、差 1 µs，µs 序與 id 序相反（µs 較大的給 id 較小者）→ 依 id DESC；回應 key 集合逐字不變", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await seedNote(db, { ownerId: owner.id });
    const y = await seedNote(db, { ownerId: owner.id });
    const [small, large] = [x.id, y.id].sort() as [string, string];
    const ms = "2026-10-01T00:00:00.123Z";
    await db.$client.query(`update notes set deleted_at = $2::timestamptz + interval '501 microseconds', deleted_by = $3 where id = $1`, [small, ms, owner.id]);
    await db.$client.query(`update notes set deleted_at = $2::timestamptz + interval '500 microseconds', deleted_by = $3 where id = $1`, [large, ms, owner.id]);
    const { rows } = await db.$client.query<{ n: number }>(`select count(*)::int n from notes where date_trunc('milliseconds', deleted_at) = $1::timestamptz`, [ms]);
    expect(rows[0]!.n).toBe(2); // 前提：同一毫秒

    const body = await listOf(app, owner.id);
    expect(body.items.map(i => i.id)).toEqual([large, small]);
    expect(Object.keys(body)).toEqual(["retentionDays", "items", "truncated"]);
    for (const item of body.items) {
      expect(Object.keys(item)).toEqual(["id", "title", "deletedAt", "purgeAt", "deletedBy", "group", "folderPath"]);
    }
  });
});

describe("TR-L2 DTO 欄", () => {
  it("群組項 group／deletedBy；個人項 group null；purgeAt＝deletedAt＋7 天；保留天數 NULL → purgeAt 全 null", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { displayName: "Deleter L2" });
    const grp = await seedGroup(db, "Group L2", [{ userId: admin.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: grp.id }, { title: "GN" });
    const pn = await seedNote(db, { ownerId: admin.id }, { title: "PN" });
    await expect204(del(app, gn.id, admin.id));
    await expect204(del(app, pn.id, admin.id));

    const body = await listOf(app, admin.id);
    const gi = body.items.find(i => i.id === gn.id)!;
    const pi = body.items.find(i => i.id === pn.id)!;
    expect(gi).toMatchObject({ title: "GN", group: { id: grp.id, name: "Group L2" }, deletedBy: { handle: admin.handle, displayName: "Deleter L2" } });
    expect(pi).toMatchObject({ title: "PN", group: null, deletedBy: { handle: admin.handle, displayName: "Deleter L2" } });
    for (const item of [gi, pi]) {
      expect(item.deletedAt).toBe(new Date(item.deletedAt).toISOString());
      // 「+ 7 天」恰為 7×24 h 只在 session TimeZone 沒有 DST 時成立（測試 DB 是 UTC）；`make_interval(days)` 照 session 時區跨 DST。
      expect(item.purgeAt).toBe(new Date(new Date(item.deletedAt).getTime() + 7 * DAY_MS).toISOString());
    }

    await db.$client.query(`update site_settings set trash_retention_days = null`);
    const none = await listOf(app, admin.id);
    expect(none.retentionDays).toBeNull();
    expect(none.items.map(i => i.purgeAt)).toEqual([null, null]);
  });
});

describe("TR-L3 只列有垃圾桶權的（A2-4「列出」欄）", () => {
  it("群組垃圾桶：admin、editDelete 列得到，其餘列不到；別人的個人垃圾桶、活筆記從不出現", async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const g = await seedNote(db, { groupId: s.groupId });
    await seedNote(db, { groupId: s.groupId }); // 活的群組筆記
    await seedNote(db, { ownerId: s.admin.id }); // admin 自己的活筆記
    const other = await seedUser(db);
    const op = await seedNote(db, { ownerId: other.id });
    await expect204(del(app, g.id, s.admin.id));
    await expect204(del(app, op.id, other.id));

    const roles = ["admin", "editDelete", "member", "deleteOnly", "editOnly", "readOnly", "outsider"] as const;
    const got: Record<string, string[]> = {};
    for (const r of roles) got[r] = await listIds(app, s[r].id);
    expect(got).toEqual({ admin: [g.id], editDelete: [g.id], member: [], deleteOnly: [], editOnly: [], readOnly: [], outsider: [] });
    expect(await listIds(app, other.id)).toEqual([op.id]);
  });
});

describe("TR-L4 刪除者帳號已刪", () => {
  it("deletedBy 變 null、仍列出", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await seedUser(db);
    const grp = await seedGroup(db, "L4", [{ userId: owner.id, role: "admin" }, { userId: x.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: grp.id });
    await expect204(del(app, n.id, x.id));
    await db.$client.query(`delete from users where id = $1`, [x.id]);

    const body = await listOf(app, owner.id);
    expect(body.items.map(i => [i.id, i.deletedBy])).toEqual([[n.id, null]]);
  });

  it("個人區：deleted_by 是另一個帳號（§6.5 群組轉移後的形）、該帳號被刪 → 仍列出、deletedBy null", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));
    await db.$client.query(`update notes set deleted_by = $2 where id = $1`, [n.id, x.id]);
    expect((await listOf(app, owner.id)).items.map(i => i.deletedBy?.handle)).toEqual([x.handle]);
    await db.$client.query(`delete from users where id = $1`, [x.id]); // notes_deleted_by_fk：SET NULL

    const body = await listOf(app, owner.id);
    expect(body.items.map(i => [i.id, i.deletedBy])).toEqual([[n.id, null]]);
  });
});

describe("TR-L6 讀不到 site_settings 列", () => {
  it("GET /api/trash → 500 internal，log { table: \"site_settings\" }", async () => {
    const logs = captureLogs();
    const { app, db } = await buildTestApp({}, logs.options);
    const owner = await seedUser(db);
    await db.$client.query(`delete from site_settings`);

    const res = await inject(app, "GET", "/api/trash", owner.id);
    expect([res.statusCode, res.json()]).toEqual([500, { error: { code: "internal", message: "伺服器內部錯誤" } }]);
    const line = logs.lines.find(l => l.msg === SITE_SETTINGS_MISSING_MESSAGE);
    expect(line?.obj).toEqual({ table: "site_settings" });
  });
});

describe("TR-L5 truncated", () => {
  it("1001 篇 → 1000 筆、truncated true；恰 1000 篇 → truncated false", async () => {
    const { app, db } = await buildTestApp();
    const big = await seedUser(db);
    const exact = await seedUser(db);
    const seedMany = (u: SeededUser, n: number) => db.$client.query(
      `insert into notes (owner_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'T' || g, 'tl5-' || g, now() - make_interval(secs => g), $1::uuid from generate_series(1, $2::int) g`,
      [u.id, n],
    );
    await seedMany(big, 1001);
    await seedMany(exact, 1000);

    const b = await listOf(app, big.id);
    expect([b.items.length, b.truncated]).toEqual([1000, true]);
    const e = await listOf(app, exact.id);
    expect([e.items.length, e.truncated]).toEqual([1000, false]);
  });
});

describe.each(["restore", "purge"] as const)("TR-V 輸入驗證（%s）", ep => {
  const url = `/api/trash/${ep}`;

  it("V1–V4：空陣列、201 個、含非 UUID、多一個鍵 → 400 invalid_body，DB 不變", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));
    const before = await trashCols(db.$client, n.id);

    const bodies: Array<[string, unknown]> = [
      ["V1 空陣列", { ids: [] }],
      // 上限算原始個數：201 個、去重後只剩 2 個，仍要 400（gate r1 M6）。
      ["V2 201 個", { ids: [n.id, ...Array<string>(200).fill(randomUUID())] }],
      ["V3 非 UUID", { ids: [n.id, "not-a-uuid"] }],
      ["V4 多一個鍵", { ids: [n.id], x: 1 }],
    ];
    for (const [name, body] of bodies) {
      const res = await inject(app, "POST", url, owner.id, body);
      expect(res.statusCode, name).toBe(400);
      expect(res.json(), name).toEqual(INVALID);
    }
    expect(await trashCols(db.$client, n.id)).toEqual(before);
  });

  it("同一個不存在的 id 送大小寫兩份 → 200、skipped 恰一筆、id 小寫", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const r = randomUUID();
    const res = await inject(app, "POST", url, owner.id, { ids: [r.toUpperCase(), r] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { skipped: unknown }).skipped).toEqual([{ id: r, reason: "not_found" }]);
  });

  it("200 個不同 id → 200（不是 400），其中的垃圾桶筆記照做", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));
    const res = await inject(app, "POST", url, owner.id, { ids: [n.id, ...Array.from({ length: 199 }, () => randomUUID())] });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { skipped: unknown[]; restored?: NoteDto[]; purged?: string[] };
    expect(ep === "restore" ? body.restored!.map(x => x.id) : body.purged).toEqual([n.id]);
    expect(body.skipped).toHaveLength(199);
  });
});

describe("TR-R1 還原正路（A2-11 的 server 面）", () => {
  it("帶分享與公開連結的個人筆記 → restored[0] 是 NoteDto；分享者又看得到；公開兩形 200；空間已滿照樣還原", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const friend = await seedUser(db);
    const tok = token();
    const n = await seedNote(db, { ownerId: owner.id }, { title: "R1", publicToken: tok, publicSlug: "r1-pub" });
    await seedShare(db, n.id, friend.id, "editor");
    await seedAttachment(db, uploadsDir, n.id, owner.id, 10);
    await giveUserQuota(db, owner.id, 1); // 用量 10 bytes > 上限 1 byte（§6.3.3-5：還原不檢查容量）
    const anon = (url: string) => app.inject({ method: "GET", url });
    const friendIds = async () => ((await inject(app, "GET", "/api/notes", friend.id)).json() as NoteDto[]).map(x => x.id);

    await expect204(del(app, n.id, owner.id));
    expect(await friendIds()).not.toContain(n.id);
    expect((await anon(`/api/public/notes/${tok}`)).statusCode).toBe(404);

    const res = await restore(app, owner.id, [n.id]);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as TrashRestoreResultDto;
    expect(body.skipped).toEqual([]);
    expect(body.restored).toHaveLength(1);
    expect(body.restored[0]).toMatchObject({ id: n.id, title: "R1", role: "owner", slug: n.slug, ownerId: owner.id, group: null });
    expect(Object.values(body.restored[0]!.permissions).every(v => v === true)).toBe(true);
    expect(body.restored[0]).toEqual((await inject(app, "GET", `/api/notes/${n.id}`, owner.id)).json());
    expect(await trashCols(db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });

    expect(await friendIds()).toContain(n.id);
    expect((await anon(`/api/public/notes/${tok}`)).statusCode).toBe(200);
    expect((await anon(`/api/public/notes/${owner.handle}/r1-pub`)).statusCode).toBe(200);
  });
});

describe("TR-R2 閘門收掉", () => {
  it("onNotesRestored 以 [id] 呼叫一次；全部略過時不呼叫", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));

    expect((await restore(app, owner.id, [n.id])).statusCode).toBe(200);
    expect(hooks.onNotesRestored.mock.calls).toEqual([[[n.id]]]);

    hooks.onNotesRestored.mockClear();
    const res = await restore(app, owner.id, [n.id, randomUUID()]); // n 已是活筆記
    expect((res.json() as TrashRestoreResultDto).restored).toEqual([]);
    expect(hooks.onNotesRestored).not.toHaveBeenCalled();
  });
});

/** sixRoleScene ＋ 群組垃圾桶 g、別人的個人垃圾桶 p、活的群組筆記 l、隨機 r。 */
async function mixedScene(app: FastifyInstance, db: Db) {
  const s = await sixRoleScene(db);
  const g = await seedNote(db, { groupId: s.groupId });
  const l = await seedNote(db, { groupId: s.groupId });
  const owner = await seedUser(db);
  const p = await seedNote(db, { ownerId: owner.id });
  await expect204(del(app, g.id, s.admin.id));
  await expect204(del(app, p.id, owner.id));
  return { s, g: g.id, l: l.id, p: p.id, r: randomUUID() };
}

describe("TR-R3 矩陣與混批（還原）", () => {
  it("admin 送 [r, g, l, p] → 只還原 g；skipped 依序 r、l、p 都 not_found；deleteOnly、editOnly 對 g → not_found", async () => {
    const { app, db } = await buildTestApp();
    const { s, g, l, p, r } = await mixedScene(app, db);

    const res = await restore(app, s.admin.id, [r, g, l, p]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as TrashRestoreResultDto;
    expect(body.restored.map(x => x.id)).toEqual([g]);
    expect(body.skipped).toEqual([{ id: r, reason: "not_found" }, { id: l, reason: "not_found" }, { id: p, reason: "not_found" }]);
    expect((await trashCols(db.$client, p))?.deleted_at).not.toBeNull();

    await expect204(del(app, g, s.admin.id));
    for (const who of ["deleteOnly", "editOnly"] as const) {
      expect((await restore(app, s[who].id, [g])).json(), who).toEqual({ restored: [], skipped: [{ id: g, reason: "not_found" }] });
    }
    expect((await trashCols(db.$client, g))?.deleted_at).not.toBeNull();
  });
});

describe.each(["restore", "purge"] as const)("TR-R3b 交易內略過與預判略過依輸入順序合併（%s）", ep => {
  it("預判放行的 g 在鎖後被降權（交易內 not_found），夾在兩個預判略過之間 → skipped 照輸入順序 [p, g, r]", async () => {
    let demote: (() => Promise<void>) | null = null;
    const hook: GroupTestHook = async point => {
      if (demote && (point === "note-restore-locked" || point === "note-purge-locked")) {
        const run = demote;
        demote = null;
        await run();
      }
    };
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ groupTestHook: hook, collabHooks: hooks });
    const { s, g, p, r } = await mixedScene(app, db);
    // 鎖住的是 notes 列；角色列不在鎖內，另一條連線改得動，交易內的下一句重判（READ COMMITTED）看得到。
    const arm = () => {
      demote = async () => {
        await db.$client.query(
          `update group_roles set can_delete = false where id = (select role_id from group_members where group_id = $1 and user_id = $2)`,
          [s.groupId, s.editDelete.id],
        );
      };
    };

    arm();
    const res = await inject(app, "POST", `/api/trash/${ep}`, s.editDelete.id, { ids: [p, g, r] });
    expect(res.statusCode, res.body).toBe(200);
    expect(demote, "hook 有跑到").toBeNull();
    expect((res.json() as { skipped: unknown }).skipped).toEqual([
      { id: p, reason: "not_found" },
      { id: g, reason: "not_found" },
      { id: r, reason: "not_found" },
    ]);
    expect((await trashCols(db.$client, g))?.deleted_at).not.toBeNull();
    // 進了交易但一篇也沒還原 → 不呼叫 onNotesRestored（T6：只傳實際還原的 id）。
    expect(hooks.onNotesRestored).not.toHaveBeenCalled();
  });
});

describe("TR-AG2 沒有垃圾桶權與不存在逐欄相同", () => {
  it("outsider 對 g 的 restore／purge 與對隨機 uuid 的回應只差 id", async () => {
    const { app, db } = await buildTestApp();
    const { s, g, r } = await mixedScene(app, db);
    for (const call of [restore, purge]) {
      const onG = await call(app, s.outsider.id, [g]);
      const onR = await call(app, s.outsider.id, [r]);
      expect([onG.statusCode, onR.statusCode]).toEqual([200, 200]);
      expect(withId(onG.json(), g, r)).toEqual(onR.json());
    }
    expect((await trashCols(db.$client, g))?.deleted_at).not.toBeNull();
  });
});

describe("TR-P1 永久刪除（A2-10 的釋放面）", () => {
  it("有附件的垃圾桶筆記 → purged [id]；列、uploads 列、磁碟檔都不在；用量減少；旁觀者垃圾桶筆記仍在", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const bystander = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 100);
    const bup = await seedAttachment(db, uploadsDir, bystander.id, owner.id, 7);
    await expect204(del(app, n.id, owner.id));
    await expect204(del(app, bystander.id, owner.id));
    const before = (await readSpaceUsage(db, { kind: "user", id: owner.id }))!.usedBytes;

    const res = await purge(app, owner.id, [n.id]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ purged: [n.id], skipped: [] } satisfies TrashPurgeResultDto);
    expect(await noteExists(db, n.id)).toBe(false);
    expect(await uploadExists(db, up)).toBe(false);
    expect(existsSync(uploadFilePath(uploadsDir, up)), "磁碟檔").toBe(false);
    expect((await readSpaceUsage(db, { kind: "user", id: owner.id }))!.usedBytes).toBe(before - 100);

    expect((await trashCols(db.$client, bystander.id))?.deleted_at).not.toBeNull();
    expect(await uploadExists(db, bup)).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, bup)), "旁觀者磁碟檔").toBe(true);
  });

  it("uploads 列在、磁碟檔不在 → 照常刪列（REST 200）；服務層記一筆 log、不 throw", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const a = await seedNote(db, { ownerId: owner.id });
    const b = await seedNote(db, { ownerId: owner.id });
    const upA = await seedAttachment(db, uploadsDir, a.id, owner.id, 5, { noFile: true });
    const upB = await seedAttachment(db, uploadsDir, b.id, owner.id, 5, { noFile: true });
    await expect204(del(app, a.id, owner.id));
    await expect204(del(app, b.id, owner.id));

    const res = await purge(app, owner.id, [a.id]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ purged: [a.id], skipped: [] });
    expect([await noteExists(db, a.id), await uploadExists(db, upA)]).toEqual([false, false]);

    const log = { error: vi.fn() };
    const out = await purgeTrashed({ db, collabHooks: noopCollabHooks, uploadsDir, storageLockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }, { ids: [b.id], by: owner.id }, log);
    expect(out).toEqual({ done: [b.id], skipped: [] });
    expect([await noteExists(db, b.id), await uploadExists(db, upB)]).toEqual([false, false]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toMatchObject({ uploadId: upB });
  });
});

describe("TR-P2 活筆記一律不刪（AG5）", () => {
  it("owner purge 自己的活筆記 → 預判不過、skipped not_found；筆記與附件都在", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 9);

    const res = await purge(app, owner.id, [n.id]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ purged: [], skipped: [{ id: n.id, reason: "not_found" }] });
    expect(await trashCols(db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await uploadExists(db, up)).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, up))).toBe(true);
  });
});

describe("TR-P3 矩陣與混批（永久刪除）", () => {
  it("admin 送 [r, g, l, p] → 只刪 g；skipped 依序 r、l、p 都 not_found；deleteOnly、editOnly 對 g2 → not_found", async () => {
    const { app, db } = await buildTestApp();
    const { s, g, l, p, r } = await mixedScene(app, db);

    const res = await purge(app, s.admin.id, [r, g, l, p]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      purged: [g],
      skipped: [{ id: r, reason: "not_found" }, { id: l, reason: "not_found" }, { id: p, reason: "not_found" }],
    });
    expect([await noteExists(db, g), await noteExists(db, l), await noteExists(db, p)]).toEqual([false, true, true]);

    const g2 = await seedNote(db, { groupId: s.groupId });
    await expect204(del(app, g2.id, s.admin.id));
    for (const who of ["deleteOnly", "editOnly"] as const) {
      expect((await purge(app, s[who].id, [g2.id])).json(), who).toEqual({ purged: [], skipped: [{ id: g2.id, reason: "not_found" }] });
    }
    expect(await noteExists(db, g2.id)).toBe(true);
  });
});

describe("TR-P4 交易爆不先刪檔", () => {
  it("BEFORE DELETE ON notes trigger 對該篇 raise → 500；列、uploads 列、磁碟檔都還在", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 11);
    await expect204(del(app, n.id, owner.id));
    await db.$client.query(
      `create function t9_boom() returns trigger language plpgsql as $$ begin if old.id = '${n.id}' then raise exception 't9 boom'; end if; return old; end $$`,
    );
    await db.$client.query(`create trigger t9_boom before delete on notes for each row execute function t9_boom()`);
    try {
      const res = await purge(app, owner.id, [n.id]);
      expect(res.statusCode).toBe(500);
    } finally {
      await db.$client.query(`drop trigger t9_boom on notes; drop function t9_boom()`);
    }
    expect((await trashCols(db.$client, n.id))?.deleted_at).not.toBeNull();
    expect(await uploadExists(db, up)).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, up)), "磁碟檔").toBe(true);
  });
});

type Role = keyof Omit<SixRoleScene, "groupId">;
/** spec §6.3.1 第二張表：DELETE 回應碼、有沒有垃圾桶權（列出／還原／永久刪除／in_trash 四格一致）。 */
const MATRIX: Array<[Role, number, boolean]> = [
  ["admin", 204, true],
  ["editDelete", 204, true],
  ["deleteOnly", 204, false],
  ["member", 403, false],
  ["editOnly", 403, false],
  ["readOnly", 403, false],
  ["outsider", 404, false],
];

describe.each(MATRIX)("TR-M1 六角色矩陣：%s", (role, delStatus, trashRight) => {
  it(`DELETE ${delStatus}；垃圾桶權 ${trashRight}`, async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const u = s[role];
    const n = (await seedNote(db, { groupId: s.groupId })).id;

    expect((await del(app, n, u.id)).statusCode).toBe(delStatus);
    if (delStatus !== 204) await expect204(del(app, n, s.admin.id)); // 代為移入，再測其餘四欄

    const listed = (await listIds(app, u.id)).includes(n);
    const get = await inject(app, "GET", `/api/notes/${n}`, u.id);
    if (trashRight) {
      expect(listed).toBe(true);
      expect([get.statusCode, get.json()]).toEqual([404, inTrash(n)]);
      const res = (await restore(app, u.id, [n])).json() as TrashRestoreResultDto;
      expect([res.restored.map(x => x.id), res.skipped]).toEqual([[n], []]);
      // 還原回應的 NoteDto 與之後單篇讀取的逐欄相同（群組筆記的 role／permissions／group 來自呼叫者的角色）。
      expect(res.restored[0]).toEqual((await inject(app, "GET", `/api/notes/${n}`, u.id)).json());
      await expect204(del(app, n, u.id));
      expect((await purge(app, u.id, [n])).json()).toEqual({ purged: [n], skipped: [] });
      expect(await noteExists(db, n)).toBe(false);
    } else {
      const r = randomUUID();
      expect(listed).toBe(false);
      const getR = await inject(app, "GET", `/api/notes/${r}`, u.id);
      expect([get.statusCode, get.body]).toEqual([getR.statusCode, getR.body]);
      for (const call of [restore, purge]) {
        const onN = await call(app, u.id, [n]);
        const onR = await call(app, u.id, [r]);
        expect([onN.statusCode, onR.statusCode]).toEqual([200, 200]);
        expect(withId(onN.json(), n, r)).toEqual(onR.json());
      }
      expect((await trashCols(db.$client, n))?.deleted_at).not.toBeNull();
    }
  });
});

describe("TR-C1 清空語意（§6.3.4-5）", () => {
  it("送清單上的全部 id → 之後才移入的那篇不受影響", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const a = await seedNote(db, { ownerId: owner.id });
    const b = await seedNote(db, { ownerId: owner.id });
    const c = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, a.id, owner.id));
    await expect204(del(app, b.id, owner.id));
    const listed = await listIds(app, owner.id);
    await expect204(del(app, c.id, owner.id));

    expect((await purge(app, owner.id, listed)).json()).toEqual({ purged: [b.id, a.id], skipped: [] });
    expect(await listIds(app, owner.id)).toEqual([c.id]);
  });
});

describe("TR-A1 cookie-only", () => {
  it("三支以 Bearer（讀寫搬移）呼叫 → 401，垃圾桶不變", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));
    const { token: pat } = await seedTokenForUser(db, owner.id, "notes:read notes:write notes:move");
    const calls = [
      app.inject({ method: "GET", url: "/api/trash", headers: bearer(pat) }),
      app.inject({ method: "POST", url: "/api/trash/restore", headers: bearer(pat), payload: { ids: [n.id] } }),
      app.inject({ method: "POST", url: "/api/trash/purge", headers: bearer(pat), payload: { ids: [n.id] } }),
    ];
    expect((await Promise.all(calls)).map(r => r.statusCode)).toEqual([401, 401, 401]);
    expect((await trashCols(db.$client, n.id))?.deleted_at).not.toBeNull();
  });
});
