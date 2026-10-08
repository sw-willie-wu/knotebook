/**
 * #200 spec §5、§9.2：兩支上傳／下載端點加收 transfer token。每一個對抗案都斷言「磁碟與 DB 沒有多出任何東西」。
 * 測資：`issueDirect`（直接跑簽發交易）；經 MCP 工具簽、照 curl 形重現的那一條在 `mcp-transfer-flow.test.ts`（T1 後半）。
 */
import { readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { TRANSFER_INVALID_MESSAGE, TRANSFER_PAT_MESSAGE } from "../src/auth/transfer-auth.js";
import { apiTokens, noteShares, notes, uploads, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildCollabTestApp, buildTestApp, freshLimiters } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedRole, seedShare, seedUser, setMemberRole, waitForBlockedOrSettled } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { MULTIPART, PNG_BYTES, expireToken, fieldOnlyBody, fileBody, issueDirect, ownerWithPat, tokenRow, upload } from "./transfer-helpers.js";

const NOT_AN_IMAGE = Buffer.from("plain text, not an image", "utf-8");

describe("POST /api/notes/:id/uploads × transfer token（spec §5.2）", () => {
  it("T1（REST 半）：upload token → 201 {id, url: /api/uploads/<id>}；uploader＝母憑證使用者；token 已消費", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; url: string };
    expect(body.url).toBe(`/api/uploads/${body.id}`);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, body.id));
    expect(row).toMatchObject({ noteId: o.noteId, uploaderId: o.userId, mime: "image/png", size: PNG_BYTES.length });
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(1);
  });

  it("T3：重用已消費的 upload token → 401（帶 challenge）；磁碟檔數不變", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(201);
    const again = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: { code: "unauthorized", message: TRANSFER_INVALID_MESSAGE } });
    expect(again.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    expect(readdirSync(uploadsDir)).toHaveLength(1);
  });

  it("T4（POST）：子 token 過期 → 401；母憑證過期（子 token 未過期）→ 401；兩者都零寫入", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const a = await issueDirect(db, o.patId, o.noteId, "upload");
    await expireToken(db, a.id);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: a.token })).statusCode).toBe(401);
    const b = await issueDirect(db, o.patId, o.noteId, "upload");
    await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 minute'` }).where(eq(apiTokens.id, o.patId));
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: b.token })).statusCode).toBe(401);
    expect((await tokenRow(db, b.id))!.consumedAt).toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("T5：A 篇的 token 打 B 篇 → 403；B 不存在時同樣 403、body 逐位元組相同；token 未被消費", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const other = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const toExisting = await upload(app, other.noteId, fileBody(PNG_BYTES), { token: t.token });
    const toMissing = await upload(app, randomUUID(), fileBody(PNG_BYTES), { token: t.token });
    expect(toExisting.statusCode).toBe(403);
    expect(toExisting.json().error.code).toBe("forbidden");
    expect(toMissing.statusCode).toBe(403);
    expect(toMissing.body).toBe(toExisting.body);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("T7（POST 半）：download token 打 POST → 403 forbidden、零寫入", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "download");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("T9（POST）：簽發後降成 viewer → 403、token 未消費；移除分享 → 404、token 仍未消費", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await ownerWithPat(db);
    const editor = await seedUser(db);
    const { tokenId } = await seedTokenForUser(db, editor.id);
    await seedShare(db, owner.noteId, editor.id, "editor");
    const t = await issueDirect(db, tokenId, owner.noteId, "upload");
    await db.update(noteShares).set({ role: "viewer" }).where(and(eq(noteShares.noteId, owner.noteId), eq(noteShares.userId, editor.id)));
    expect((await upload(app, owner.noteId, fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(403);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    await db.delete(noteShares).where(eq(noteShares.noteId, owner.noteId));
    const gone = await upload(app, owner.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe("not_found");
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("T10：同一支 upload token 真 socket 並發兩發 → 恰一發 201、另一發 401；磁碟恰多一個檔（20 輪）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("listen 後取不到 port");
      const o = await ownerWithPat(db);
      for (let round = 0; round < 20; round++) {
        const t = await issueDirect(db, o.patId, o.noteId, "upload");
        const send = () =>
          fetch(`http://127.0.0.1:${address.port}/api/notes/${o.noteId}/uploads`, {
            method: "POST",
            headers: { "content-type": MULTIPART, authorization: `Bearer ${t.token}` },
            body: new Uint8Array(fileBody(PNG_BYTES)),
          }).then(r => r.status);
        const statuses = (await Promise.all([send(), send()])).sort();
        expect(statuses, `round ${round}`).toEqual([201, 401]);
        expect(readdirSync(uploadsDir), `round ${round}`).toHaveLength(round + 1);
      }
    } finally {
      await app.close();
    }
  }, 60_000);

  it("T11：10 MiB＋1 → 413 file_too_large；token 已消費；磁碟無殘留（含暫名檔）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_UPLOAD_BYTES, 0x41)])), { token: t.token });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("file_too_large");
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  }, 20_000);

  it("T12：宣稱 image/png 實為文字 → 415；token 已消費", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(NOT_AN_IMAGE), { token: t.token });
    expect(res.statusCode).toBe(415);
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("RF5：沒有 file part 的 multipart → 400 invalid_body；token 已消費；磁碟零新檔", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fieldOnlyBody(), { token: t.token });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    expect((await tokenRow(db, t.id))!.consumedAt).not.toBeNull();
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("T13：transfer token 打 authenticateAny 路由一律 401 且不查 DB；cookie-only 路由不看 header（無 cookie 401）", async () => {
    const ctx = await buildCollabTestApp();
    const o = await ownerWithPat(ctx.db);
    const t = await issueDirect(ctx.db, o.patId, o.noteId, "download");
    const auth = { authorization: `Bearer ${t.token}` };
    const spy = vi.spyOn(ctx.db, "select");
    const probes: Array<{ method: "GET" | "POST"; url: string; payload?: unknown }> = [
      { method: "GET", url: "/api/notes" },
      { method: "GET", url: `/api/notes/${o.noteId}` },
      { method: "GET", url: `/api/notes/${o.noteId}/content` },
      { method: "POST", url: `/api/notes/${o.noteId}/edits`, payload: { op: "append", markdown: "x" } },
      { method: "POST", url: "/api/notes", payload: {} },
    ];
    for (const p of probes) {
      spy.mockClear();
      const res = await ctx.app.inject({ method: p.method, url: p.url, headers: auth, ...(p.payload ? { payload: p.payload } : {}) });
      expect(res.statusCode, `${p.method} ${p.url}`).toBe(401);
      expect(spy, `${p.method} ${p.url} 不得查 DB`).not.toHaveBeenCalled();
    }
    spy.mockClear();
    const mcp = await mcpPost(ctx.app, rpc("tools/list"), { token: t.token });
    expect(mcp.statusCode).toBe(401);
    expect(spy, "POST /api/mcp 不得查 DB").not.toHaveBeenCalled();
    spy.mockRestore();
    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: auth });
    expect(me.statusCode).toBe(401);
  });

  it("T14（POST）：有效的讀寫 PAT 直接打上傳端點 → 401 專屬訊息、帶 invalid_token；吃 bearerMiss", async () => {
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const o = await ownerWithPat(db);
    const first = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: o.pat });
    expect(first.statusCode).toBe(401);
    expect(first.json()).toEqual({ error: { code: "unauthorized", message: TRANSFER_PAT_MESSAGE } });
    expect(first.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    const second = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: o.pat });
    expect(second.statusCode).toBe(429);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("T15：有效 session cookie＋無效 transfer token → 401，不回退 cookie", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_bogus", cookies: await cookieOf(o.userId) });
    expect(res.statusCode).toBe(401);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("RF2：有效 transfer token＋另一位使用者的 session cookie → 201，uploader 是 token 的使用者", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const stranger = await seedUser(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token, cookies: await cookieOf(stranger.id) });
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, (res.json() as { id: string }).id));
    expect(row!.uploaderId).toBe(o.userId);
  });

  it("T16：使用者停權、或需改密碼 → 401；token 未消費", async () => {
    const { app, db } = await buildTestApp();
    const a = await ownerWithPat(db);
    const ta = await issueDirect(db, a.patId, a.noteId, "upload");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, a.userId));
    expect((await upload(app, a.noteId, fileBody(PNG_BYTES), { token: ta.token })).statusCode).toBe(401);
    const b = await ownerWithPat(db);
    const tb = await issueDirect(db, b.patId, b.noteId, "upload");
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, b.userId));
    expect((await upload(app, b.noteId, fileBody(PNG_BYTES), { token: tb.token })).statusCode).toBe(401);
    expect((await tokenRow(db, ta.id))!.consumedAt).toBeNull();
    expect((await tokenRow(db, tb.id))!.consumedAt).toBeNull();
  });

  it("T17：UPLOAD_LIMIT 用完 → transfer POST 429，token 未被燒", async () => {
    const uploadLimiter = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ upload: uploadLimiter }) });
    const o = await ownerWithPat(db);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { cookies: await cookieOf(o.userId) })).statusCode).toBe(201);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(429);
    expect((await tokenRow(db, t.id))!.consumedAt).toBeNull();
  });

  it("T18：大 body（數 MiB）＋transfer 早退（401 無效、403 錯筆記）仍收到結構化 error body", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const other = await ownerWithPat(db);
    const big = fileBody(Buffer.alloc(2 * MAX_UPLOAD_BYTES - 1024, 0x42));
    const bad = await upload(app, o.noteId, big, { token: "knbt_bogus" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: "unauthorized" } });
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const wrong = await upload(app, other.noteId, big, { token: t.token });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: { code: "forbidden" } });
  }, 30_000);

  it("T19：bearerMiss 注入 limit:1 → 第二發無效 transfer token 429、無 WWW-Authenticate", async () => {
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const o = await ownerWithPat(db);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" })).statusCode).toBe(401);
    const second = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" });
    expect(second.statusCode).toBe(429);
    expect(second.headers["www-authenticate"]).toBeUndefined();
  });

  it("T20：路徑用大寫的同一個 UUID → 201（比對不分大小寫）", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    expect((await upload(app, o.noteId.toUpperCase(), fileBody(PNG_BYTES), { token: t.token })).statusCode).toBe(201);
  });

  it("T22：transfer 的 401 都不含 resource_metadata；Basic → 不帶 error，且吃 bearerMiss；沒帶 header 的 401 不吃", async () => {
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const o = await ownerWithPat(db);
    const anon1 = await upload(app, o.noteId, fileBody(PNG_BYTES));
    const anon2 = await upload(app, o.noteId, fileBody(PNG_BYTES));
    expect([anon1.statusCode, anon2.statusCode]).toEqual([401, 401]);
    // 沒帶 Authorization：回退 app.authenticate，401 不帶任何 challenge（docs/api.md 的那句以此為界，I4）
    expect(anon1.headers["www-authenticate"]).toBeUndefined();
    const basic = await upload(app, o.noteId, fileBody(PNG_BYTES), { headers: { authorization: "Basic dXNlcjpwYXNz" } });
    expect(basic.statusCode).toBe(401);
    expect(basic.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer"');
    const afterBasic = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" });
    expect(afterBasic.statusCode).toBe(429);
  });

  it("T22b：帶 header 的每一種 transfer 401（無效形、查無、PAT、已消費、母憑證過期、使用者停權）的 challenge 都是 realm 形、不含 resource_metadata", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const used = await issueDirect(db, o.patId, o.noteId, "upload");
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: used.token })).statusCode).toBe(201);
    const expiredParent = await ownerWithPat(db);
    const tExp = await issueDirect(db, expiredParent.patId, expiredParent.noteId, "upload");
    await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 minute'` }).where(eq(apiTokens.id, expiredParent.patId));
    const disabled = await ownerWithPat(db);
    const tDis = await issueDirect(db, disabled.patId, disabled.noteId, "upload");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.userId));
    const cases: Array<[string, string, string]> = [
      ["無效 knbt_", o.noteId, "knbt_unknown"],
      ["非 knbt_", o.noteId, "garbage"],
      ["PAT", o.noteId, o.pat],
      ["已消費", o.noteId, used.token],
      ["母憑證過期", expiredParent.noteId, tExp.token],
      ["使用者停權", disabled.noteId, tDis.token],
    ];
    for (const [label, noteId, token] of cases) {
      const res = await upload(app, noteId, fileBody(PNG_BYTES), { token });
      expect(res.statusCode, label).toBe(401);
      expect(res.headers["www-authenticate"], label).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    }
  });

  it("消費那一步的 401（原子 UPDATE 0 列）也吃 bearerMiss，且零寫入（spec §4.5 bearerMiss 清單的「§5.2 第 5 步」）", async () => {
    // 確定性造法：holder 先鎖住 token 列 → 被測請求過了認證查表（plain select 不被擋）、卡在原子 UPDATE 上（blocked）→
    // holder 把 consumed_at 設上並 commit → UPDATE 重新評估述詞 → 0 列 → 401 從**消費那一步**發出（不是快速路徑）。
    const bearerMiss = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ bearerMiss }) });
    const pool = db.$client;
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from transfer_tokens where id = $1 for update", [t.id]);
      const req = upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
      expect(await waitForBlockedOrSettled(pool, req)).toBe("blocked");
      await holder.query("update transfer_tokens set consumed_at = now() where id = $1", [t.id]);
      await holder.query("commit");
      const res = await req;
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    expect(readdirSync(uploadsDir)).toHaveLength(0);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: "knbt_nope" })).statusCode).toBe(429);
  });

  it("T24：上傳途中筆記被刪（真 socket；已過消費、正在送 body）→ 404 not_found；token 列已被 cascade 刪；磁碟零殘留", async () => {
    // spec §6.4 `next`「a 404 means the note is gone」的「消費之後」那個來源、§12.3「刪筆記 ∥ 正在上傳」。
    // 造法：先送 headers＋multipart 前段＋一半檔案 → 輪詢到 consumed_at 非 NULL（preHandler 已過）→ 刪筆記 → 送完剩下 → INSERT 撞 FK。
    const { app, db, uploadsDir } = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("listen 後取不到 port");
      const o = await ownerWithPat(db);
      const t = await issueDirect(db, o.patId, o.noteId, "upload");
      const body = fileBody(Buffer.concat([PNG_BYTES, Buffer.alloc(256 * 1024, 0x41)]));
      const half = Math.floor(body.length / 2);
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: address.port,
            path: `/api/notes/${o.noteId}/uploads`,
            method: "POST",
            headers: { "content-type": MULTIPART, authorization: `Bearer ${t.token}`, "content-length": String(body.length) },
          },
          res => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.write(body.subarray(0, half));
        void (async () => {
          await vi.waitFor(async () => expect((await tokenRow(db, t.id))?.consumedAt ?? null).not.toBeNull(), { timeout: 5_000 });
          await db.delete(notes).where(eq(notes.id, o.noteId));
          req.end(body.subarray(half));
        })().catch(reject);
      });
      const res = await response;
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "not_found" } });
      expect(await tokenRow(db, t.id)).toBeUndefined();
      expect(readdirSync(uploadsDir)).toHaveLength(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("T23：簽發後筆記被移進群組 → 依使用當下的群組角色：可編輯 201、只能讀 403", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    const g = await seedGroup(db, `g-${randomUUID().slice(0, 8)}`, [{ userId: o.userId, role: "admin" }]);
    const t1 = await issueDirect(db, o.patId, o.noteId, "upload");
    const t2 = await issueDirect(db, o.patId, o.noteId, "upload");
    const moved = await app.inject({ method: "POST", url: `/api/notes/${o.noteId}/move`, cookies: await cookieOf(o.userId), payload: { groupId: g.id } });
    expect(moved.statusCode).toBe(200);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t1.token })).statusCode).toBe(201);
    const reader = await seedRole(db, g.id, "reader", { canRead: true });
    await setMemberRole(db, g.id, o.userId, reader);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t2.token })).statusCode).toBe(403);
    expect((await tokenRow(db, t2.id))!.consumedAt).toBeNull();
  });

  it("RF1：簽發後筆記被刪 → 子 token 已被 cascade 刪 → 401；磁碟零新檔", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const o = await ownerWithPat(db);
    const t = await issueDirect(db, o.patId, o.noteId, "upload");
    await db.delete(notes).where(eq(notes.id, o.noteId));
    expect(await tokenRow(db, t.id)).toBeUndefined();
    const res = await upload(app, o.noteId, fileBody(PNG_BYTES), { token: t.token });
    expect(res.statusCode).toBe(401);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("session 路徑不變：cookie 上傳仍 201（authKind 走 session）", async () => {
    const { app, db } = await buildTestApp();
    const o = await ownerWithPat(db);
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { cookies: await cookieOf(o.userId) })).statusCode).toBe(201);
  });
});
