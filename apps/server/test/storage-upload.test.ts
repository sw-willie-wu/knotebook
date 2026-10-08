/**
 * 上傳的配額（spec 2026-10-08 §6.3、§8.1；§11.1 S2、S3（上傳形）、S4、S5（上傳形）、S14（上傳形）、S15(a)）。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { MAX_UPLOAD_BYTES, SESSION_COOKIE } from "@knotebook/shared";
import { uploads } from "../src/db/schema.js";
import { signSession } from "../src/auth/session.js";
import { buildTestApp, testConfig } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { QUOTA_BOUNDARY, filesIn, giveGroupQuota, giveUserQuota, multipartFile, pngOf, quotaBody, seedAttachment, upload, usedOf } from "./storage-helpers.js";

const rowsOf = async (db: Awaited<ReturnType<typeof buildTestApp>>["db"], noteId: string) =>
  db.select({ size: uploads.size }).from(uploads).where(eq(uploads.noteId, noteId));

describe("上傳：配額判定（S2）", () => {
  it("方案 1000：600 → 201；600 → 409（owner 看得到三數）、磁碟無新檔、無新列；400 → 201（等於上限）；之後 preHandler 409（incomingBytes null）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });

    expect((await upload(app, n.id, u.id, 600)).statusCode).toBe(201);
    const files1 = await filesIn(uploadsDir);
    const r2 = await upload(app, n.id, u.id, 600);
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
    expect(await filesIn(uploadsDir)).toEqual(files1);
    expect(await rowsOf(db, n.id)).toEqual([{ size: 600 }]);

    expect((await upload(app, n.id, u.id, 400)).statusCode).toBe(201);
    const r4 = await upload(app, n.id, u.id, 8);
    expect(r4.statusCode).toBe(409);
    expect(r4.json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 1000, quotaBytes: 1000 }));
    expect(await usedOf(db.$client, { kind: "user", id: u.id })).toBe(1000);
  });

  it("preHandler 預檢在讀 body 之前回應：真 socket 送 9 MB body，回應的 409 在 body 送完前就到（且仍是結構化 JSON）", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 0);
    const n = await seedNote(db, { ownerId: u.id });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const body = multipartFile(pngOf(9 * 1024 * 1024));
    const cookie = `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId: u.id, tv: 0 })}`;
    let sentWhenResponded = -1;
    let written = 0;
    let clientReq: http.ClientRequest | undefined;
    let guard: NodeJS.Timeout | undefined;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: `/api/notes/${n.id}/uploads`, method: "POST", headers: {
        "content-type": `multipart/form-data; boundary=${QUOTA_BOUNDARY}`, "content-length": String(body.length), cookie,
      } }, r => {
        sentWhenResponded = written;
        const chunks: Buffer[] = [];
        r.on("data", c => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
      });
      clientReq = req;
      req.on("error", () => { /* server 讀完上限後砍線屬預期（drainWithCap） */ });
      req.once("socket", s => s.on("error", () => {}));
      // 64 KB 一塊、每塊之間讓出事件迴圈，讓回應有機會在送完前到達
      const CHUNK = 64 * 1024;
      const pump = (): void => {
        while (written < body.length) {
          const ok = req.write(body.subarray(written, written + CHUNK));
          written += Math.min(CHUNK, body.length - written);
          if (!ok) { req.once("drain", pump); return; }
          if (written % (CHUNK * 8) === 0) { setImmediate(pump); return; }
        }
        req.end();
      };
      pump();
      guard = setTimeout(() => reject(new Error("timeout")), 20_000);
    });
    clearTimeout(guard);
    // client 端的連線生死不是本案要驗的東西：先砍 client socket 再 app.close()，否則 keep-alive／仍在寫的 body 會讓
    // graceful shutdown 等它自然結束（同 test/uploads.test.ts `rawSocketPost` 的說明）。
    clientReq!.destroy();
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual(quotaBody({ incomingBytes: null, usedBytes: 0, quotaBytes: 0 }));
    expect(sentWhenResponded).toBeLessThan(body.length);
    await app.close();
  }, 30_000);
});

describe("上傳：依空間計量與數字可見性（S3 上傳形）", () => {
  it("A 的個人筆記分享給 B（editor），B 上傳 → 算 A；B 被拒時只有 incomingBytes；A 被拒時三數", async () => {
    const { app, db } = await buildTestApp();
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, a.id, 1000);
    await giveUserQuota(db, b.id, null);
    const n = await seedNote(db, { ownerId: a.id });
    await seedShare(db, n.id, b.id, "editor");
    expect((await upload(app, n.id, b.id, 900)).statusCode).toBe(201);
    expect(await usedOf(db.$client, { kind: "user", id: a.id })).toBe(900);
    expect(await usedOf(db.$client, { kind: "user", id: b.id })).toBe(0);
    const rb = await upload(app, n.id, b.id, 200);
    expect(rb.statusCode).toBe(409);
    expect(rb.json()).toEqual(quotaBody({ incomingBytes: 200 }));
    const ra = await upload(app, n.id, a.id, 200);
    expect(ra.json()).toEqual(quotaBody({ incomingBytes: 200, usedBytes: 900, quotaBytes: 1000 }));
  });

  it("群組筆記：一般成員被拒 → 只有 incomingBytes；manageGroup 被拒 → 三數；非成員的站台 admin 對筆記沒有角色 → 404；manageGroup 的預檢 409 → 三數（null incoming）", async () => {
    const { app, db } = await buildTestApp();
    const [gAdmin, gMember, site] = await Promise.all([seedUser(db), seedUser(db), seedUser(db, { isAdmin: true })]);
    const g = await seedGroup(db, "G", [{ userId: gAdmin.id, role: "admin" }, { userId: gMember.id, role: "member" }]);
    await giveGroupQuota(db, g.id, 1000);
    const n = await seedNote(db, { groupId: g.id });
    expect((await upload(app, n.id, gMember.id, 900)).statusCode).toBe(201);
    expect((await upload(app, n.id, gMember.id, 200)).json()).toEqual(quotaBody({ incomingBytes: 200 }));
    expect((await upload(app, n.id, gAdmin.id, 200)).json()).toEqual(quotaBody({ incomingBytes: 200, usedBytes: 900, quotaBytes: 1000 }));
    expect((await upload(app, n.id, gAdmin.id, 100)).statusCode).toBe(201);
    // 站台 admin 不是成員：對筆記沒有角色 → 404（不是配額問題）；以「群組管理者」的 preHandler 形確認三數
    expect((await upload(app, n.id, site.id, 8)).statusCode).toBe(404);
    expect((await upload(app, n.id, gAdmin.id, 8)).json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 1000, quotaBytes: 1000 }));
  });

  it("站台 admin 是他人個人筆記的 editor 分享對象：被拒時看得到三數（交易內 409 與預檢 409 皆然）；一般 editor 同情境只有 incomingBytes", async () => {
    const { app, db } = await buildTestApp();
    const [a, site, plain] = await Promise.all([seedUser(db), seedUser(db, { isAdmin: true }), seedUser(db)]);
    await giveUserQuota(db, a.id, 1000);
    const n = await seedNote(db, { ownerId: a.id });
    await seedShare(db, n.id, site.id, "editor");
    await seedShare(db, n.id, plain.id, "editor");
    expect((await upload(app, n.id, site.id, 900)).statusCode).toBe(201);
    expect((await upload(app, n.id, site.id, 200)).json()).toEqual(quotaBody({ incomingBytes: 200, usedBytes: 900, quotaBytes: 1000 }));
    expect((await upload(app, n.id, plain.id, 200)).json()).toEqual(quotaBody({ incomingBytes: 200 }));
    expect((await upload(app, n.id, site.id, 100)).statusCode).toBe(201);
    expect((await upload(app, n.id, site.id, 8)).json()).toEqual(quotaBody({ incomingBytes: null, usedBytes: 1000, quotaBytes: 1000 }));
    expect((await upload(app, n.id, plain.id, 8)).json()).toEqual(quotaBody({ incomingBytes: null }));
  });
});

describe("上傳：無上限與已超額（S4、S5 上傳形）", () => {
  it("S4：配額 NULL → 大量上傳皆 201", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, null);
    const n = await seedNote(db, { ownerId: u.id });
    for (let i = 0; i < 3; i++) expect((await upload(app, n.id, u.id, 5 * 1024 * 1024)).statusCode).toBe(201);
  });

  it("S5：直插使 used > quota → 上傳 409；刪掉大附件的筆記後可再上傳", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const big = await seedNote(db, { ownerId: u.id });
    await seedAttachment(db, uploadsDir, big.id, u.id, 5000);
    const n = await seedNote(db, { ownerId: u.id });
    expect((await upload(app, n.id, u.id, 8)).statusCode).toBe(409);
    const del = await app.inject({ method: "DELETE", url: `/api/notes/${big.id}`, cookies: await cookieOf(u.id) });
    expect(del.statusCode).toBe(204);
    expect((await upload(app, n.id, u.id, 8)).statusCode).toBe(201);
  });
});

describe("上傳：busy 映射與真逾時（S14 上傳形、S15(a)）", () => {
  for (const [label, code] of [["40P01", "40P01"], ["55P03", "55P03"], ["40001", "40001"]] as const) {
    it(`S14：縫 storage-space-locked 拋 ${label} → 409 server_busy、已寫的檔已 unlink、無新列`, async () => {
      const { app, db, uploadsDir } = await buildTestApp({
        groupTestHook: async point => {
          if (point === "storage-space-locked") throw Object.assign(new Error(label), { code });
        },
      });
      const u = await seedUser(db);
      await giveUserQuota(db, u.id, 1000);
      const n = await seedNote(db, { ownerId: u.id });
      const before = await filesIn(uploadsDir);
      const r = await upload(app, n.id, u.id, 100);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: { code: "server_busy", message: "伺服器忙碌，請稍後再試" } });
      expect(await filesIn(uploadsDir)).toEqual(before);
      expect(await rowsOf(db, n.id)).toEqual([]);
    });
  }

  it("交易內任何其他拋出（非 pg 錯誤）→ 500，檔一樣 unlink（M4）", async () => {
    const { app, db, uploadsDir } = await buildTestApp({
      groupTestHook: async point => { if (point === "storage-space-locked") throw new Error("boom"); },
    });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    const before = await filesIn(uploadsDir);
    expect((await upload(app, n.id, u.id, 100)).statusCode).toBe(500);
    expect(await filesIn(uploadsDir)).toEqual(before);
  });

  it("S15(a)：storageLockTimeoutMs=200；上傳 A 停在縫上，同空間上傳 B 真的拿到 55P03 → 409 server_busy（< 3000 ms：注入值有生效，不是預設 5000）、B 的檔已 unlink；A 之後 201", async () => {
    const holder: { app?: FastifyInstance; noteId?: string; userId?: string; b?: LightMyRequestResponse; bMs?: number } = {};
    const { app, db, uploadsDir } = await buildTestApp({
      storageLockTimeoutMs: 200,
      groupTestHook: async point => {
        if (point !== "storage-space-locked" || holder.b) return;
        const t0 = Date.now();
        holder.b = await upload(holder.app!, holder.noteId!, holder.userId!, 50);
        holder.bMs = Date.now() - t0;
      },
    });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    Object.assign(holder, { app, noteId: n.id, userId: u.id });
    const before = await filesIn(uploadsDir);
    const a = await upload(app, n.id, u.id, 100);
    expect(holder.b!.statusCode).toBe(409);
    expect(holder.b!.json().error.code).toBe("server_busy");
    // 200 與預設 5000 之間留寬裕：注入值若沒一路傳到 `assertSpaceRoomInTx`（落回預設），B 要等約 5 s 才逾時 → 紅
    expect(holder.bMs!).toBeLessThan(3000);
    expect(a.statusCode).toBe(201);
    const after = await filesIn(uploadsDir);
    expect(after.length).toBe(before.length + 1);
    expect(await rowsOf(db, n.id)).toEqual([{ size: 100 }]);
  });
});

describe("上傳：既有契約不變", () => {
  it("筆記不存在 → 404 not_found（preHandler）；viewer → 403；上限 413 仍先於配額交易", async () => {
    const { app, db } = await buildTestApp();
    const [o, v] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, o.id, 10);
    const n = await seedNote(db, { ownerId: o.id });
    await seedShare(db, n.id, v.id, "viewer");
    expect((await upload(app, "00000000-0000-4000-8000-000000000000", o.id, 8)).statusCode).toBe(404);
    expect((await upload(app, n.id, v.id, 8)).statusCode).toBe(403);
    const tooBig = await upload(app, n.id, o.id, MAX_UPLOAD_BYTES + 1);
    expect(tooBig.statusCode).toBe(413);
  });
});
