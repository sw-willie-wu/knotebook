/**
 * #175 PR4 T6／T7 的交易本體（`groups/tx/delete-group.ts`）以 `db.transaction(tx => xInTx(tx, …))` 直呼——不經路由。
 * HTTP 功能面（body 驗證、授權、踢線、磁碟檔）在 `groups-v2-delete.test.ts`；交錯案在 `groups-v2-delete-race.test.ts`。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, inArray, or } from "drizzle-orm";
import * as Y from "yjs";
import { validateSlug } from "@knotebook/shared";
import { groupMembers, groupRoles, groups, noteAiEdits, noteLinks, noteRedirects, noteStates, notes, uploads } from "../src/db/schema.js";
import { GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE } from "../src/groups/queries.js";
import type { GroupRacePoint } from "../src/groups/test-hook.js";
import { deleteGroupWithNotesInTx, transferGroupInTx } from "../src/groups/tx/delete-group.js";
import { TxAbort } from "../src/http/tx-abort.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import type { Db } from "../src/db/index.js";
import { nextSlugCandidate } from "../src/notes/slug.js";
import { buildTestApp } from "./helpers.js";
import { noteState, seedGroup, seedNote, seedRedirect, seedRole, seedUser, setMemberRole } from "./group-helpers.js";
import { seedUpload } from "./copy-helpers.js";

const sorted = <T>(xs: readonly T[]): T[] => [...xs].sort();

async function groupRows(db: Db, groupId: string): Promise<{ groups: number; roles: number; members: number }> {
  const [g, r, m] = await Promise.all([
    db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)),
    db.select({ id: groupRoles.id }).from(groupRoles).where(eq(groupRoles.groupId, groupId)),
    db.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, groupId)),
  ]);
  return { groups: g.length, roles: r.length, members: m.length };
}

async function redirectsOf(db: Db): Promise<Array<{ oldPath: string; noteId: string }>> {
  const rows = await db.select({ oldPath: noteRedirects.oldPath, noteId: noteRedirects.noteId }).from(noteRedirects);
  return rows.sort((a, b) => (a.oldPath < b.oldPath ? -1 : a.oldPath > b.oldPath ? 1 : 0));
}

describe("#175 PR4 transferGroupInTx（T6）", () => {
  it("轉移：每篇 owner＝transferTo、group_id NULL、slug 保留或 -N、slug_is_custom 不變、prev_slug NULL、public_token NULL、public_slug NULL（Willie 2026-10-02 裁決：轉移清公開連結，C1／W1）、legacy_slug 不變、updated_at 不動；轉址恰每篇一列 /g/<g 小寫>/<舊 slug>；群組／角色／成員消失；AI 紀錄／links／uploads／note_states 跟著 UUID；回傳 noteIds 與 memberIds", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const legacy = `legacy-${randomUUID().slice(0, 12)}`;
    const n1 = await seedNote(db, { groupId: g.id }, { slug: "plan", slugIsCustom: true, prevSlug: "old", publicToken: "t".repeat(43), legacySlug: legacy });
    const n2 = await seedNote(db, { groupId: g.id }, { slug: "x" });
    const n3 = await seedNote(db, { groupId: g.id }, { slug: "y" });
    await seedNote(db, { ownerId: b.id }, { slug: "x" });
    await seedNote(db, { ownerId: b.id }, { slug: "y" });
    await seedNote(db, { ownerId: b.id }, { slug: "y-2" });
    await db.insert(noteAiEdits).values({ noteId: n1.id, userId: a.id, op: "append" });
    await db.insert(noteLinks).values({ sourceNoteId: n1.id, targetNoteId: n2.id });
    const [up] = await db.insert(uploads).values({ noteId: n1.id, uploaderId: a.id, mime: "image/png", size: 1 }).returning({ id: uploads.id });
    await db.insert(noteStates).values({ noteId: n1.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    const before = await Promise.all([n1, n2, n3].map(n => noteState(pool, n.id)));

    const out = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect(await noteState(pool, n1.id)).toEqual({
      owner_id: b.id, group_id: null, slug: "plan", prev_slug: null, slug_is_custom: true, public_token: null, public_slug: null,
      updated_at: before[0]!.updated_at,
    });
    expect(await noteState(pool, n2.id)).toEqual({
      owner_id: b.id, group_id: null, slug: "x-2", prev_slug: null, slug_is_custom: false, public_token: null, public_slug: null,
      updated_at: before[1]!.updated_at,
    });
    expect(await noteState(pool, n3.id)).toEqual({
      owner_id: b.id, group_id: null, slug: "y-3", prev_slug: null, slug_is_custom: false, public_token: null, public_slug: null,
      updated_at: before[2]!.updated_at,
    });
    const { rows: legacyRows } = await pool.query("select legacy_slug from notes where id = $1", [n1.id]);
    expect(legacyRows).toEqual([{ legacy_slug: legacy }]);
    // 只寫現行 slug（B12）：沒有 /g/<g>/old。
    expect(await redirectsOf(db)).toEqual([
      { oldPath: `/g/${g.id.toLowerCase()}/plan`, noteId: n1.id },
      { oldPath: `/g/${g.id.toLowerCase()}/x`, noteId: n2.id },
      { oldPath: `/g/${g.id.toLowerCase()}/y`, noteId: n3.id },
    ]);
    expect(await groupRows(db, g.id)).toEqual({ groups: 0, roles: 0, members: 0 });
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, n1.id))).toHaveLength(1);
    expect(await db.select().from(noteLinks).where(and(eq(noteLinks.sourceNoteId, n1.id), eq(noteLinks.targetNoteId, n2.id)))).toHaveLength(1);
    expect(await db.select({ noteId: uploads.noteId }).from(uploads).where(eq(uploads.id, up!.id))).toEqual([{ noteId: n1.id }]);
    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, n1.id))).toHaveLength(1);
    expect(sorted(out.noteIds)).toEqual(sorted([n1.id, n2.id, n3.id]));
    expect(sorted(out.memberIds)).toEqual(sorted([a.id, b.id, c.id]));
  });

  it("RF1：撞名鏈依 created_at, id 處理——較早的 a-2 保留、較晚的 a 得 a-3", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    await seedNote(db, { ownerId: b.id }, { slug: "a" });
    // 實體插入序 Q→P＝slug 序（a < a-2），與建立序（P 較早）相反——依 slug 序或實體序處理都會得 Q＝a-2、P＝a-2-2。
    const q = await seedNote(db, { groupId: g.id }, { slug: "a" });
    const p = await seedNote(db, { groupId: g.id }, { slug: "a-2" });
    await pool.query("update notes set created_at = now() - interval '1 hour' where id = $1", [p.id]);
    await pool.query("update notes set created_at = now() where id = $1", [q.id]);

    const out = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect((await noteState(pool, p.id)).slug).toBe("a-2");
    expect((await noteState(pool, q.id)).slug).toBe("a-3");
    expect(await redirectsOf(db)).toEqual([
      { oldPath: `/g/${g.id}/a`, noteId: q.id },
      { oldPath: `/g/${g.id}/a-2`, noteId: p.id },
    ]);
    expect(out.noteIds).toEqual([p.id, q.id]);
  });

  it("RF2：100 字元自訂 slug 在 transferTo 範圍撞名 → ≤60、-2 結尾、通過 validateSlug、slug_is_custom 仍 true；轉址鍵是 100 字元的舊 slug", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    const base = "b".repeat(100);
    const n = await seedNote(db, { groupId: g.id }, { slug: base, slugIsCustom: true });
    await seedNote(db, { ownerId: b.id }, { slug: base });

    await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    const expected = nextSlugCandidate(base, 2);
    expect(Array.from(expected).length).toBeLessThanOrEqual(60);
    expect(expected.endsWith("-2")).toBe(true);
    expect(validateSlug(expected)).toBeNull();
    expect(await noteState(pool, n.id)).toMatchObject({ slug: expected, slug_is_custom: true, owner_id: b.id, group_id: null });
    expect(await redirectsOf(db)).toEqual([{ oldPath: `/g/${g.id}/${base}`, noteId: n.id }]);
  });

  it("transferTo 不是內建管理員 → TxAbort 409 not_admin：非成員、一般成員、勾滿七旗標的自訂角色成員三形；交易 rollback：群組、筆記、成員原封不動", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, c, d, outsider] = await Promise.all([seedUser(db), seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }, { userId: d.id, role: "member" }]);
    const boss = await seedRole(db, g.id, "Boss", {
      canRead: true, canCreate: true, canEdit: true, canDelete: true, canManagePublicLink: true, canManageMembers: true, canManageGroup: true,
    });
    await setMemberRole(db, g.id, d.id, boss);
    const n = await seedNote(db, { groupId: g.id }, { slug: "keep", publicToken: "k".repeat(43) });
    const noteBefore = await noteState(pool, n.id);
    const rowsBefore = await groupRows(db, g.id);

    const errs: unknown[] = [];
    for (const who of [outsider, c, d]) {
      const err = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: who.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS })).then(
        () => null,
        (e: unknown) => e,
      );
      errs.push(err);
    }

    for (const err of errs) {
      expect(err).toBeInstanceOf(TxAbort);
      expect(err).toMatchObject({ status: 409, errCode: "not_admin", message: NOT_ADMIN_MESSAGE });
    }
    expect(new Set(errs.map(e => (e as TxAbort).message)).size).toBe(1);
    expect(await noteState(pool, n.id)).toEqual(noteBefore);
    expect(await groupRows(db, g.id)).toEqual(rowsBefore);
    expect(rowsBefore).toEqual({ groups: 1, roles: 3, members: 3 });
    expect(await redirectsOf(db)).toEqual([]);
  });

  it("群組不存在 → TxAbort 404 not_found（GROUP_NOT_FOUND_MESSAGE）", async () => {
    const { db } = await buildTestApp();
    const b = await seedUser(db);
    const err = await db.transaction(tx => transferGroupInTx(tx, { groupId: randomUUID(), transferTo: b.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxAbort);
    expect(err).toMatchObject({ status: 404, errCode: "not_found", message: GROUP_NOT_FOUND_MESSAGE });
  });

  it("空群組：回 noteIds []、群組消失、轉址 0 列", async () => {
    const { db } = await buildTestApp();
    const [a, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }]);

    const out = await db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: a.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }));

    expect(out.noteIds).toEqual([]);
    expect(sorted(out.memberIds)).toEqual(sorted([a.id, c.id]));
    expect(await groupRows(db, g.id)).toEqual({ groups: 0, roles: 0, members: 0 });
    expect(await redirectsOf(db)).toEqual([]);
  });
});

describe("#175 PR4 deleteGroupWithNotesInTx（T7）", () => {
  it("全刪：L 內每篇與其 uploads 列／states／轉址／AI 紀錄／兩方向 links 消失；群組外的筆記（含 link 的另一端）仍在；回傳 uploadIds＝被刪的 uploads id、noteIds＝L、memberIds＝全體成員；群組／角色／成員消失", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const [a, c] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const other = await seedGroup(db, "Other", [{ userId: a.id, role: "admin" }]);
    const g1 = await seedNote(db, { groupId: g.id }, { slug: "g1" });
    const g2 = await seedNote(db, { groupId: g.id }, { slug: "g2" });
    const p = await seedNote(db, { ownerId: c.id }, { slug: "p" });
    const elsewhere = await seedNote(db, { groupId: other.id }, { slug: "g1" });
    await db.insert(noteLinks).values([{ sourceNoteId: p.id, targetNoteId: g1.id }, { sourceNoteId: g1.id, targetNoteId: p.id }]);
    const up = await seedUpload(db, uploadsDir, g1.id, a.id);
    const keptUp = await seedUpload(db, uploadsDir, p.id, c.id);
    await db.insert(noteStates).values({ noteId: g1.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    await db.insert(noteAiEdits).values({ noteId: g2.id, userId: a.id, op: "append" });
    await seedRedirect(db, `/g/${g.id}/old-g1`, g1.id);
    const linkWhere = or(inArray(noteLinks.sourceNoteId, [g1.id, g2.id]), inArray(noteLinks.targetNoteId, [g1.id, g2.id]));
    expect(await db.select().from(noteLinks).where(linkWhere)).toHaveLength(2);

    const out = await db.transaction(tx => deleteGroupWithNotesInTx(tx, { groupId: g.id }));

    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [g1.id, g2.id]))).toEqual([]);
    expect(await db.select().from(noteLinks).where(linkWhere)).toEqual([]);
    expect(await db.select().from(uploads).where(eq(uploads.id, up))).toEqual([]);
    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, g1.id))).toEqual([]);
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, g2.id))).toEqual([]);
    expect(await redirectsOf(db)).toEqual([]);
    expect(await db.select({ id: notes.id }).from(notes).where(inArray(notes.id, [p.id, elsewhere.id]))).toHaveLength(2);
    expect(await db.select().from(uploads).where(eq(uploads.id, keptUp))).toHaveLength(1);
    expect(out.uploadIds).toEqual([up]);
    expect(sorted(out.noteIds)).toEqual(sorted([g1.id, g2.id]));
    expect(sorted(out.memberIds)).toEqual(sorted([a.id, c.id]));
    expect(await groupRows(db, g.id)).toEqual({ groups: 0, roles: 0, members: 0 });
    expect(await groupRows(db, other.id)).toEqual({ groups: 1, roles: 2, members: 1 });
  });

  it("全刪：群組不存在 → TxAbort 404 not_found", async () => {
    const { db } = await buildTestApp();
    const err = await db.transaction(tx => deleteGroupWithNotesInTx(tx, { groupId: randomUUID() })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TxAbort);
    expect(err).toMatchObject({ status: 404, errCode: "not_found", message: GROUP_NOT_FOUND_MESSAGE });
  });

  it("全刪：空群組 → 回三個 []、群組消失", async () => {
    const { db } = await buildTestApp();
    const g = await seedGroup(db, "G", []);

    const out = await db.transaction(tx => deleteGroupWithNotesInTx(tx, { groupId: g.id }));

    expect(out).toEqual({ noteIds: [], memberIds: [], uploadIds: [] });
    expect(await groupRows(db, g.id)).toEqual({ groups: 0, roles: 0, members: 0 });
  });
});

describe("#175 PR4 刪群組的測試縫", () => {
  /**
   * 「鎖之後、取筆記之前」以另一條連線的 `FOR UPDATE NOWAIT` 判定：groups 列已被 `lockGroup` 鎖住 → 55P03；
   * 該群組筆記尚未被 `FOR UPDATE` → 成功（autocommit，立即放鎖）。
   */
  const probeLocks = async (pool: Db["$client"], groupId: string) => {
    const tryLock = (q: string) => pool.query(q, [groupId]).then(() => "free", (e: { code?: string }) => (e.code === "55P03" ? "locked" : `error:${e.code}`));
    return {
      group: await tryLock("select id from groups where id = $1 for update nowait"),
      notes: await tryLock("select id from notes where group_id = $1 for update nowait"),
    };
  };

  it("group-transfer-slug-candidate 每輪呼叫一次、ctx 帶 noteId 與本輪候選；group-delete-locked 在 T6 的 transferTo 檢查之後、T7 的取 L 之前各呼叫一次", async () => {
    const { db } = await buildTestApp();
    const pool = db.$client;
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const n3 = await seedNote(db, { groupId: g.id }, { slug: "y" });
    await seedNote(db, { ownerId: b.id }, { slug: "y" });
    await seedNote(db, { ownerId: b.id }, { slug: "y-2" });

    // not_admin 形：不呼叫 group-delete-locked（檢查在縫之前）。
    const rejected: GroupRacePoint[] = [];
    await expect(
      db.transaction(tx => transferGroupInTx(tx, { groupId: g.id, transferTo: c.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }, async point => { rejected.push(point); })),
    ).rejects.toBeInstanceOf(TxAbort);
    expect(rejected).toEqual([]);

    const calls: Array<{ point: GroupRacePoint; ctx: unknown; locks?: unknown }> = [];
    await db.transaction(tx =>
      transferGroupInTx(tx, { groupId: g.id, transferTo: b.id, lockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }, async (point, ctx) => {
        calls.push({ point, ctx, ...(point === "group-delete-locked" ? { locks: await probeLocks(pool, g.id) } : {}) });
      }),
    );
    expect(calls).toEqual([
      { point: "group-delete-locked", ctx: { groupId: g.id }, locks: { group: "locked", notes: "free" } },
      { point: "group-transfer-slug-candidate", ctx: { noteId: n3.id, groupId: g.id, slug: "y-3" } },
    ]);

    const g2 = await seedGroup(db, "G2", [{ userId: a.id, role: "admin" }]);
    await seedNote(db, { groupId: g2.id }, { slug: "z" });
    const calls2: Array<{ point: GroupRacePoint; ctx: unknown; locks: unknown }> = [];
    await db.transaction(tx =>
      deleteGroupWithNotesInTx(tx, { groupId: g2.id }, async (point, ctx) => {
        calls2.push({ point, ctx, locks: await probeLocks(pool, g2.id) });
      }),
    );
    expect(calls2).toEqual([{ point: "group-delete-locked", ctx: { groupId: g2.id }, locks: { group: "locked", notes: "free" } }]);
  });
});
