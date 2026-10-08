/**
 * 刪群組・轉移的配額（spec 2026-10-08 §6.6、§8.1；§11.1 S8、S3（轉移形）、S5（轉移形）、S14（刪群組））；
 * 另有 Q-S7 的縫順序／advisory 鎖探測，與轉移路由的 `storageLockTimeoutMs` 透傳（比照上傳的 S15(a)）。
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { giveGroupQuota, giveUserQuota, quotaBody, seedAttachment, upload, usedOf } from "./storage-helpers.js";

const transfer = async (app: FastifyInstance, groupId: string, userId: string, transferTo: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "transfer", transferTo } });
const deleteAll = async (app: FastifyInstance, groupId: string, userId: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "delete" } });
const groupExists = async (pool: import("pg").Pool, id: string) => (await pool.query("select count(*)::int n from groups where id = $1", [id])).rows[0].n === 1;

describe("轉移（S8、S3、S5）", () => {
  it("接收者放不下 → 409，什麼都不發生（群組、筆記歸屬、轉址都原封）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 1000);
    const bn = await seedNote(db, { ownerId: b.id });
    await seedAttachment(db, uploadsDir, bn.id, b.id, 600);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 500);
    const before = await noteState(db.$client, gn.id);
    const r = await transfer(app, g.id, b.id, b.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 500, usedBytes: 600, quotaBytes: 1000 }));
    expect(await groupExists(db.$client, g.id)).toBe(true);
    expect(await noteState(db.$client, gn.id)).toEqual(before);
    expect((await db.$client.query("select count(*)::int n from note_redirects")).rows[0].n).toBe(0);
  });

  it("放得下 → 204；接收者用量＝原＋群組附件總和（含無附件筆記、多篇）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 1000);
    const bn = await seedNote(db, { ownerId: b.id });
    await seedAttachment(db, uploadsDir, bn.id, b.id, 100);
    for (const s of [200, 300]) {
      const n = await seedNote(db, { groupId: g.id });
      await seedAttachment(db, uploadsDir, n.id, b.id, s);
    }
    await seedNote(db, { groupId: g.id });
    expect((await transfer(app, g.id, b.id, b.id)).statusCode).toBe(204);
    expect(await usedOf(db.$client, { kind: "user", id: b.id })).toBe(600);
  });

  it("S3：操作者（manageGroup）不是接收者 → 只有 incomingBytes；站台 admin 操作 → 三數", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [op, b, site] = await Promise.all([seedUser(db), seedUser(db), seedUser(db, { isAdmin: true })]);
    const g = await seedGroup(db, "G", [{ userId: op.id, role: "admin" }, { userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 10);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, op.id, 11);
    expect((await transfer(app, g.id, op.id, b.id)).json()).toEqual(quotaBody({ incomingBytes: 11 }));
    expect((await transfer(app, g.id, site.id, b.id)).json()).toEqual(quotaBody({ incomingBytes: 11, usedBytes: 0, quotaBytes: 10 }));
  });

  it("S5：接收者已超額 → 有附件的轉移 409；群組沒有附件 → 204；全刪 → 群組用量隨之消失", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const b = await seedUser(db);
    await giveUserQuota(db, b.id, 10);
    const bn = await seedNote(db, { ownerId: b.id });
    await seedAttachment(db, uploadsDir, bn.id, b.id, 50);
    const g1 = await seedGroup(db, "G1", [{ userId: b.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g1.id });
    await seedAttachment(db, uploadsDir, n1.id, b.id, 1);
    expect((await transfer(app, g1.id, b.id, b.id)).statusCode).toBe(409);
    const g2 = await seedGroup(db, "G2", [{ userId: b.id, role: "admin" }]);
    await seedNote(db, { groupId: g2.id });
    expect((await transfer(app, g2.id, b.id, b.id)).statusCode).toBe(204);
    await giveGroupQuota(db, g1.id, null);
    expect(await usedOf(db.$client, { kind: "group", id: g1.id })).toBe(1);
    expect((await deleteAll(app, g1.id, b.id)).statusCode).toBe(204);
    expect(await usedOf(db.$client, { kind: "group", id: g1.id })).toBe(0);
  });
});

describe("busy 映射（S14 刪群組）", () => {
  for (const code of ["40P01", "55P03"]) {
    it(`轉移：縫 storage-space-locked 拋 ${code} → 409 server_busy、群組原封`, async () => {
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => { if (point === "storage-space-locked") throw Object.assign(new Error(code), { code }); },
      });
      const b = await seedUser(db);
      const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
      const gn = await seedNote(db, { groupId: g.id });
      await seedAttachment(db, uploadsDir, gn.id, b.id, 5);
      const r = await transfer(app, g.id, b.id, b.id);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("server_busy");
      expect(await groupExists(db.$client, g.id)).toBe(true);
    });
  }

  it("全刪：group-delete-locked 拋 55P03 → 409 server_busy（既有映射加認 55P03）", async () => {
    const { app, db } = await buildTestApp({
      groupTestHook: async point => { if (point === "group-delete-locked") throw Object.assign(new Error("55P03"), { code: "55P03" }); },
    });
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    const r = await deleteAll(app, g.id, b.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("server_busy");
  });
});

describe("轉移的空間鎖：位置與等待上限", () => {
  it("Q-S7：storage-space-locked 在第一個 group-transfer-slug-candidate 之前；slug 探測當下本庫已持有 1 把 advisory 鎖", async () => {
    const points: string[] = [];
    const advisoryAtSlug: number[] = [];
    const built = await buildTestApp({
      groupTestHook: async point => {
        if (point === "group-transfer-slug-candidate") {
          // 只算本測試資料庫的 advisory 鎖（同一台 PG 上可能有其他測試庫）。
          const { rows } = await built.db.$client.query(
            "select count(*)::int n from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())",
          );
          advisoryAtSlug.push(rows[0].n);
        }
        points.push(point);
      },
    });
    const { app, db, uploadsDir } = built;
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 1000);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 5);
    expect((await transfer(app, g.id, b.id, b.id)).statusCode).toBe(204);
    expect(points).toEqual(["group-delete-locked", "storage-space-locked", "group-transfer-slug-candidate"]);
    expect(advisoryAtSlug).toEqual([1]);
  });

  it("storageLockTimeoutMs=200：上傳 A 持接收者個人空間鎖（停在縫上）時轉移 → 真的 55P03 → 409 server_busy（< 3000 ms：注入值有傳到轉移交易，不是預設 5000）、群組原封；A 之後 201", async () => {
    const holder: { app?: FastifyInstance; groupId?: string; userId?: string; noteId?: string; t?: LightMyRequestResponse; tMs?: number } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      storageLockTimeoutMs: 200,
      groupTestHook: async (point, ctx) => {
        // 只在上傳 A（ctx.noteId＝接收者的個人筆記）停在縫上時發一次轉移；轉移在取鎖那句就逾時，到不了這個縫。
        if (point !== "storage-space-locked" || ctx.noteId !== holder.noteId || holder.t) return;
        const t0 = Date.now();
        holder.t = await transfer(holder.app!, holder.groupId!, holder.userId!, holder.userId!);
        holder.tMs = Date.now() - t0;
      },
    });
    const b = await seedUser(db);
    await giveUserQuota(db, b.id, 1000);
    const bn = await seedNote(db, { ownerId: b.id });
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 5);
    Object.assign(holder, { app, groupId: g.id, userId: b.id, noteId: bn.id });
    const a = await upload(app, bn.id, b.id, 10);
    expect(holder.t!.statusCode).toBe(409);
    expect(holder.t!.json().error.code).toBe("server_busy");
    // 200 與預設 5000 之間留寬裕：路由若沒把 deps.storageLockTimeoutMs 傳進交易（落回 5000），轉移要等約 5 s 才逾時 → 紅
    expect(holder.tMs!).toBeLessThan(3000);
    expect(await groupExists(db.$client, g.id)).toBe(true);
    expect(a.statusCode).toBe(201);
  });
});
