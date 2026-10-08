/**
 * 複製與移入群組的配額（spec 2026-10-08 §6.4、§6.5、§8.1；§11.1 S5（複製／移入）、S6、S7、S14（複製／移動）、S15(b)；
 * Review Focus RF2、RF5）。
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, freshLimiters, type TestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedShare, seedUser, sharesOf } from "./group-helpers.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { imageDoc, seedDoc } from "./copy-helpers.js";
import { filesIn, giveGroupQuota, giveUserQuota, quotaBody, seedAttachment, usedOf } from "./storage-helpers.js";

const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload });
const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });
const noteCount = async (pool: import("pg").Pool) => (await pool.query("select count(*)::int n from notes")).rows[0].n as number;

/** 來源筆記：每個 size 一個附件（DB size 照給、磁碟小 PNG），文件引用全部。 */
async function srcWith(db: TestApp["db"], uploadsDir: string, owner: { ownerId: string } | { groupId: string }, uploaderId: string, sizes: number[], title = "Src") {
  const n = await seedNote(db, owner, { title });
  const ids: string[] = [];
  for (const s of sizes) ids.push(await seedAttachment(db, uploadsDir, n.id, uploaderId, s));
  await seedDoc(db, n.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
  return { id: n.id, uploadIds: ids };
}

describe("複製（S6、S5 複製形、RF2、RF5）", () => {
  it("到已滿個人空間（有附件）→ 預檢 409（incomingBytes null、owner 看得到三數）；不建筆記、磁碟無新檔、不扣 upload 桶", async () => {
    // upload 桶只給 1 張：被拒後桶裡那 1 張還在，才證明預檢在 consumeMany 之前。
    const uploadBucket = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ upload: uploadBucket }) });
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, b.id, 100);
    const bn = await seedNote(db, { ownerId: b.id });
    await seedAttachment(db, uploadsDir, bn.id, b.id, 100);
    const src = await srcWith(db, uploadsDir, { ownerId: a.id }, a.id, [10]);
    await seedShare(db, src.id, b.id, "viewer");
    const [notesBefore, filesBefore] = [await noteCount(db.$client), await filesIn(uploadsDir)];
    const r = await copy(app, src.id, b.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 100, quotaBytes: 100 }));
    expect(await noteCount(db.$client)).toBe(notesBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
    expect(uploadBucket.consume(b.id)).toBe(true);
  });

  it("未滿但放不下 → 交易內 409（incomingBytes＝實際複製的位元組）；無新筆記、被拒後已複製的檔清掉", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const a = await seedUser(db);
    await giveUserQuota(db, a.id, 1000);
    const src = await srcWith(db, uploadsDir, { ownerId: a.id }, a.id, [300, 400]); // 用量已 700，副本要再 700
    const [notesBefore, filesBefore] = [await noteCount(db.$client), await filesIn(uploadsDir)];
    const r = await copy(app, src.id, a.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 700, usedBytes: 700, quotaBytes: 1000 }));
    expect(await noteCount(db.$client)).toBe(notesBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
  });

  it("到已滿群組：manageGroup → 三數；一般成員 → 只有 incomingBytes", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [gAdmin, gMember] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: gAdmin.id, role: "admin" }, { userId: gMember.id, role: "member" }]);
    await giveGroupQuota(db, g.id, 50);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, gAdmin.id, 50);
    const s1 = await srcWith(db, uploadsDir, { ownerId: gAdmin.id }, gAdmin.id, [10]);
    const s2 = await srcWith(db, uploadsDir, { ownerId: gMember.id }, gMember.id, [10]);
    const [notesBefore, filesBefore] = [await noteCount(db.$client), await filesIn(uploadsDir)];
    const r1 = await copy(app, s1.id, gAdmin.id, { groupId: g.id });
    expect(r1.statusCode).toBe(409);
    expect(r1.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 50, quotaBytes: 50 }));
    const r2 = await copy(app, s2.id, gMember.id, { groupId: g.id });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toEqual(quotaBody({ incomingBytes: null }));
    expect(await noteCount(db.$client)).toBe(notesBefore);
    expect(await filesIn(uploadsDir)).toEqual(filesBefore);
  });

  it("磁碟遺失的附件不計 incoming：恰好因此放得下 → 201（S6）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const a = await seedUser(db);
    await giveUserQuota(db, a.id, 1000);
    const n = await seedNote(db, { ownerId: a.id }, { title: "Src" });
    const ok = await seedAttachment(db, uploadsDir, n.id, a.id, 200);
    const gone = await seedAttachment(db, uploadsDir, n.id, a.id, 500, { noFile: true });
    await seedDoc(db, n.id, imageDoc([`/api/uploads/${ok}`, `/api/uploads/${gone}`]));
    // 用量 700；副本若算兩個要 700（超）、只算實際複製的 200 → 900 ≤ 1000
    const r = await copy(app, n.id, a.id);
    expect(r.statusCode).toBe(201);
    expect(await usedOf(db.$client, { kind: "user", id: a.id })).toBe(900);
  });

  it("RF5：來源文件引用同一附件兩次、剩餘恰好一份 → 201（incoming 只算一次）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const a = await seedUser(db);
    await giveUserQuota(db, a.id, 600);
    const n = await seedNote(db, { ownerId: a.id }, { title: "Src" });
    const u1 = await seedAttachment(db, uploadsDir, n.id, a.id, 300);
    await seedDoc(db, n.id, imageDoc([`/api/uploads/${u1}`, `/api/uploads/${u1}`]));
    const r = await copy(app, n.id, a.id);
    expect(r.statusCode).toBe(201);
    expect(await usedOf(db.$client, { kind: "user", id: a.id })).toBe(600);
  });

  it("RF2：配額 0 的空間、與已超額的空間——無附件的複製都 201（預檢只在有附件要複製時做）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [z, over] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, z.id, 0);
    await giveUserQuota(db, over.id, 10);
    const on = await seedNote(db, { ownerId: over.id });
    await seedAttachment(db, uploadsDir, on.id, over.id, 500);
    const plain1 = await seedNote(db, { ownerId: z.id }, { title: "P1" });
    const plain2 = await seedNote(db, { ownerId: over.id }, { title: "P2" });
    expect((await copy(app, plain1.id, z.id)).statusCode).toBe(201);
    expect((await copy(app, plain2.id, over.id)).statusCode).toBe(201);
  });
});

describe("移入群組（S7、S5 移入形）", () => {
  it("移進已滿群組（有附件）→ 409；owner／shares／轉址／slug 全不變", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [o, s] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 100);
    const n = await seedNote(db, { ownerId: o.id }, { slug: "keep" });
    await seedAttachment(db, uploadsDir, n.id, o.id, 101);
    await seedShare(db, n.id, s.id, "editor");
    const before = await noteState(db.$client, n.id);
    const r = await move(app, n.id, o.id, g.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 101, usedBytes: 0, quotaBytes: 100 }));
    expect(await noteState(db.$client, n.id)).toEqual(before);
    expect(await sharesOf(db, n.id)).toEqual([{ userId: s.id, role: "editor" }]);
    expect((await db.$client.query("select count(*)::int n from note_redirects")).rows[0].n).toBe(0);
  });

  it("成功 → 個人用量降、群組用量升；無附件筆記移進已滿（含配額 0）群組 → 200", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 1000);
    const n = await seedNote(db, { ownerId: o.id });
    await seedAttachment(db, uploadsDir, n.id, o.id, 700);
    expect((await move(app, n.id, o.id, g.id)).statusCode).toBe(200);
    expect(await usedOf(db.$client, { kind: "user", id: o.id })).toBe(0);
    expect(await usedOf(db.$client, { kind: "group", id: g.id })).toBe(700);
    const g0 = await seedGroup(db, "Z", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g0.id, 0);
    const plain = await seedNote(db, { ownerId: o.id });
    expect((await move(app, plain.id, o.id, g0.id)).statusCode).toBe(200);
  });

  it("一般成員（可新建）移入被拒 → 只有 incomingBytes", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [admin, m] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: m.id, role: "member" }]);
    await giveGroupQuota(db, g.id, 10);
    const n = await seedNote(db, { ownerId: m.id });
    await seedAttachment(db, uploadsDir, n.id, m.id, 11);
    const r = await move(app, n.id, m.id, g.id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(quotaBody({ incomingBytes: 11 }));
  });
});

describe("busy 映射（S14 複製／移動形）與 S15(b)", () => {
  for (const code of ["40P01", "55P03"]) {
    it(`縫 storage-space-locked 拋 ${code}：複製 → 409 server_busy、已複製的檔已清、無新筆記；移動 → 409 server_busy、筆記不變`, async () => {
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => { if (point === "storage-space-locked") throw Object.assign(new Error(code), { code }); },
      });
      const o = await seedUser(db);
      const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
      const src = await srcWith(db, uploadsDir, { ownerId: o.id }, o.id, [10, 20]);
      const [nb, fb] = [await noteCount(db.$client), await filesIn(uploadsDir)];
      const c = await copy(app, src.id, o.id);
      expect(c.statusCode).toBe(409);
      expect(c.json().error.code).toBe("server_busy");
      expect(await noteCount(db.$client)).toBe(nb);
      expect(await filesIn(uploadsDir)).toEqual(fb);
      const before = await noteState(db.$client, src.id);
      const m = await move(app, src.id, o.id, g.id);
      expect(m.statusCode).toBe(409);
      expect(m.json().error.code).toBe("server_busy");
      expect(await noteState(db.$client, src.id)).toEqual(before);
    });
  }

  it("S15(b)：storageLockTimeoutMs=200；複製取得空間鎖之後，insertNoteWithAutoSlug 等另一連線未 commit 的同 slug 300 ms → 對方 rollback 後複製 201（取鎖後的列鎖等待不受 lock_timeout 限）", async () => {
    const holder: { ownerId?: string; started?: boolean; inserted?: boolean; pool?: import("pg").Pool } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      storageLockTimeoutMs: 200,
      groupTestHook: async point => {
        if (point !== "storage-space-locked" || holder.started) return;
        holder.started = true;
        const c = await holder.pool!.connect();
        try {
          await c.query("begin");
          // holder 自己的等待設上限：若副本的 slug 寫入跑到空間鎖之前（Q-S7 被破壞），副本未 commit 的 'plan' 已在，這句等複製、
          // 複製又在縫上等這個 hook——JS 層互等、PG 偵測不到（突變實測：卡到測試逾時）。設上限後 2 s 即 55P03，案子快速紅。
          await c.query("set local lock_timeout = '2000ms'");
          await c.query("insert into notes (owner_id, slug, title) values ($1, 'plan', 'Other')", [holder.ownerId]);
        } catch (err) {
          await c.query("rollback").catch(() => {});
          c.release();
          throw err;
        }
        holder.inserted = true;
        setTimeout(() => { void c.query("rollback").finally(() => c.release()); }, 300);
      },
    });
    holder.pool = db.$client;
    const o = await seedUser(db);
    holder.ownerId = o.id;
    await giveUserQuota(db, o.id, 10_000);
    // 來源的 slug 是 seedNote 給的隨機值；副本以標題 "Plan" 派生 'plan'——正是 holder 未 commit 的那個。
    const src = await srcWith(db, uploadsDir, { ownerId: o.id }, o.id, [10], "Plan");
    const t0 = Date.now();
    const r = await copy(app, src.id, o.id);
    expect(holder.inserted).toBe(true);
    expect(r.statusCode).toBe(201);
    expect(r.json().slug).toBe("plan");
    // 至少等到對方 rollback（300 ms，留 50 ms 量測誤差）：證明複製真的在唯一索引上等過、且等超過 200 ms 沒被 lock_timeout 打斷。
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});
