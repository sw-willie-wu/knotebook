/**
 * `POST /api/auth/avatars`（上傳即選用）與 `GET /api/auth/avatars`（候選清單）。
 * 上傳走真路由；用量與鎖序走真交易；並發案用 `avatarTestHooks.afterUserLock` 把第一條請求停在持有 users 列鎖之後。
 */
import { readFile, readdir } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { MAX_AVATAR_DISPLAY_BYTES, SESSION_COOKIE } from "@knotebook/shared";
import { userAvatars, userIdentities, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshLimiters, signTestSession } from "./helpers.js";
import { cookieOf, seedNote, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { GIF_BYTES, ICON_BOUNDARY, TEXT_BYTES } from "./helpers/provider-icon.js";
import { giveUserQuota, pngOf, upload } from "./storage-helpers.js";
import { DEFAULT_CROP, avatarUploadBody, seedAvatarRow, uploadAvatar, webpOf } from "./avatar-helpers.js";

const MIB = 1_048_576;

const rowsOf = async (db: Awaited<ReturnType<typeof buildTestApp>>["db"], userId: string) =>
  db.select().from(userAvatars).where(eq(userAvatars.userId, userId)).orderBy(asc(userAvatars.createdAt));

describe("POST /api/auth/avatars：成功", () => {
  it("201 回候選 DTO；DB 一列目前頭貼、avatar_auto 關掉；原圖落在 uploads 目錄且位元組相等、沒有暫存殘檔；/me 立刻反映", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const cookies = await cookieOf(alice.id);
    // 先讀一次 /me，讓閘門的 60 秒快取裝著「沒有頭貼」；上傳之後若沒 invalidate，下一次讀仍會是 null。
    const before = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect(before.json().avatar).toBeNull();
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(true);

    const original = pngOf(2000);
    const display = webpOf(300);
    const res = await uploadAvatar(app, alice.id, { original, display });
    expect(res.statusCode, res.body).toBe(201);

    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(res.json()).toEqual({
      id: row.id,
      source: "upload",
      providerName: null,
      avatar: { id: row.id, v: 1 },
      pending: false,
      current: true,
      crop: { x: DEFAULT_CROP.x, y: DEFAULT_CROP.y, size: DEFAULT_CROP.size },
      originalWidth: DEFAULT_CROP.width,
      originalHeight: DEFAULT_CROP.height,
      originalSize: 2000,
      displaySize: 300,
      createdAt: row.createdAt.toISOString(),
    });
    expect(row).toMatchObject({ isCurrent: true, source: "upload", originalMime: "image/png", displayMime: "image/webp", originalSize: 2000, displaySize: 300, version: 1 });
    expect(Buffer.compare(row.displayData!, display)).toBe(0);
    const [{ avatarAuto: after }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(after).toBe(false);

    expect(await readdir(uploadsDir)).toEqual([row.originalFile]);
    expect(Buffer.compare(await readFile(path.join(uploadsDir, row.originalFile)), original)).toBe(0);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect(me.json().avatar).toEqual({ id: row.id, v: 1, pending: false });
  });

  it("第二張上傳：第一張變非目前、第二張是目前；清單新到舊、兩張都在；別人的目前頭貼不受影響", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobs = await seedAvatarRow(db, { userId: bob.id, originalSize: 900, displaySize: 100, isCurrent: true });
    const first = await uploadAvatar(app, alice.id);
    const second = await uploadAvatar(app, alice.id, { original: pngOf(2500) });
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);

    const rows = await rowsOf(db, alice.id);
    expect(rows.map(r => [r.id, r.isCurrent])).toEqual([[first.json().id, false], [second.json().id, true]]);
    const [bobRow] = await rowsOf(db, bob.id);
    expect(bobRow).toMatchObject({ id: bobs, isCurrent: true });

    const list = await app.inject({ method: "GET", url: "/api/auth/avatars", cookies: await cookieOf(alice.id) });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.candidates.map((c: { id: string; current: boolean }) => [c.id, c.current])).toEqual([[second.json().id, true], [first.json().id, false]]);
    expect(body.auto).toBe(false);
  });
});

describe("POST /api/auth/avatars：大小與格式", () => {
  it("原圖上限跟站台限制：把上限設 1 MiB → 1.5 MiB 原圖 413 file_too_large、0.9 MiB 成功；413 不留檔不留列", async () => {
    const ctx = await buildTestApp();
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const alice = await seedUser(ctx.db);
    await ctx.siteLimits.update(admin.id, { uploadMaxBytes: MIB });

    const tooBig = await uploadAvatar(ctx.app, alice.id, { original: pngOf(Math.round(1.5 * MIB)) });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe("file_too_large");
    expect(await readdir(ctx.uploadsDir)).toEqual([]);
    expect(await rowsOf(ctx.db, alice.id)).toEqual([]);

    const ok = await uploadAvatar(ctx.app, alice.id, { original: pngOf(Math.round(0.9 * MIB)) });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await readdir(ctx.uploadsDir)).toHaveLength(1);
    expect(await rowsOf(ctx.db, alice.id)).toHaveLength(1);
  });

  it("顯示圖超過上限一個位元組 → 413 file_too_large；剛好等於上限成功", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const over = await uploadAvatar(app, alice.id, { display: webpOf(MAX_AVATAR_DISPLAY_BYTES + 1) });
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe("file_too_large");
    expect(await readdir(uploadsDir)).toEqual([]);
    expect(await rowsOf(db, alice.id)).toEqual([]);
    const exact = await uploadAvatar(app, alice.id, { display: webpOf(MAX_AVATAR_DISPLAY_BYTES) });
    expect(exact.statusCode, exact.body).toBe(201);
  });

  it("GIF（原圖或顯示圖）、不是圖的文字（含副檔名假裝成 png）→ 415 unsupported_media_type；不留檔不留列", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>', "utf-8");
    const cases: Array<[string, { original?: Buffer; display?: Buffer }]> = [
      ["GIF 原圖", { original: GIF_BYTES }],
      ["GIF 顯示圖", { display: GIF_BYTES }],
      ["SVG 文字原圖", { original: svg }],
      ["文字檔冒充 png（副檔名與 Content-Type 都說是圖）", { original: TEXT_BYTES }],
      ["文字檔當顯示圖", { display: TEXT_BYTES }],
    ];
    for (const [label, opts] of cases) {
      const res = await uploadAvatar(app, alice.id, opts);
      expect(res.statusCode, label).toBe(415);
      expect(res.json().error.code, label).toBe("unsupported_media_type");
    }
    expect(await readdir(uploadsDir)).toEqual([]);
    expect(await rowsOf(db, alice.id)).toEqual([]);
  });

  it("缺 original／display／crop、crop 越界或負數或非整數或 size 為 0 或含 NUL 或不是 JSON → 400 invalid_body；不留檔不留列", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const c = DEFAULT_CROP;
    const cases: Array<[string, Parameters<typeof uploadAvatar>[2]]> = [
      ["缺 original", { original: null }],
      ["缺 display", { display: null }],
      ["缺 crop", { crop: null }],
      ["x + size 超過寬", { crop: { ...c, x: c.width - c.size + 1 } }],
      ["y + size 超過高", { crop: { ...c, y: c.height - c.size + 1 } }],
      ["x 為負", { crop: { ...c, x: -1 } }],
      ["y 為負", { crop: { ...c, y: -1 } }],
      ["x 非整數", { crop: { ...c, x: 1.5 } }],
      ["size 非整數", { crop: { ...c, size: 10.5 } }],
      ["size 為 0", { crop: { ...c, size: 0 } }],
      ["width 為 0", { crop: { ...c, width: 0 } }],
      ["數字不是安全整數", { crop: { ...c, width: 2 ** 60 } }],
      ["數字是字串", { crop: { ...c, size: "64" } }],
      ["缺欄位", { crop: { x: 0, y: 0, size: 10 } }],
      ["含 NUL 的字串", { crop: `${JSON.stringify(c)}\u0000` }],
      ["不是 JSON", { crop: "not json" }],
      ["JSON 陣列", { crop: "[1,2,3]" }],
    ];
    for (const [label, opts] of cases) {
      const res = await uploadAvatar(app, alice.id, opts);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expect(res.json().error.code, label).toBe("invalid_body");
    }
    expect(await readdir(uploadsDir)).toEqual([]);
    expect(await rowsOf(db, alice.id)).toEqual([]);
  });
});

describe("POST /api/auth/avatars：配額", () => {
  it("空間已滿 → 預檢 409 storage_quota_exceeded（本人看得到三數，incomingBytes 為 null）；不留檔不留列", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 1000);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    const res = await uploadAvatar(app, alice.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: "storage_quota_exceeded", message: "This space's storage quota is full." },
      storage: { incomingBytes: null, usedBytes: 1000, quotaBytes: 1000 },
    });
    expect(await readdir(uploadsDir)).toEqual([]);
    expect(await rowsOf(db, alice.id)).toHaveLength(1);
  });

  it("預檢在讀 body 之前回應：真 socket 送 9 MB 原圖，409 在 body 送完前就到", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 0);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const body = avatarUploadBody({ original: pngOf(9 * MIB) });
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: alice.id, tv: 0 })}`;
    let sentWhenResponded = -1;
    let written = 0;
    let clientReq: http.ClientRequest | undefined;
    let guard: NodeJS.Timeout | undefined;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/auth/avatars",
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${ICON_BOUNDARY}`, "content-length": String(body.length), cookie },
        },
        r => {
          sentWhenResponded = written;
          const chunks: Buffer[] = [];
          r.on("data", ch => chunks.push(ch));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
        },
      );
      clientReq = req;
      req.on("error", () => {});
      req.once("socket", s => s.on("error", () => {}));
      const CHUNK = 64 * 1024;
      const pump = (): void => {
        while (written < body.length) {
          const ok = req.write(body.subarray(written, written + CHUNK));
          written += Math.min(CHUNK, body.length - written);
          if (!ok) {
            req.once("drain", pump);
            return;
          }
          if (written % (CHUNK * 8) === 0) {
            setImmediate(pump);
            return;
          }
        }
        req.end();
      };
      pump();
      guard = setTimeout(() => reject(new Error("timeout")), 20_000);
    });
    clearTimeout(guard);
    clientReq!.destroy();
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("storage_quota_exceeded");
    expect(sentWhenResponded).toBeLessThan(body.length);
    await app.close();
  }, 30_000);

  it("沒滿但放不下 → 交易內 409（incomingBytes 是原圖＋顯示圖）；不留檔、不留新列，原本的目前頭貼仍是目前", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 1000);
    const existing = await seedAvatarRow(db, { userId: alice.id, originalSize: 100, displaySize: 50, isCurrent: true });
    const res = await uploadAvatar(app, alice.id, { original: pngOf(800), display: webpOf(300) });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("storage_quota_exceeded");
    expect(res.json().storage).toEqual({ incomingBytes: 1100, usedBytes: 150, quotaBytes: 1000 });
    expect(await readdir(uploadsDir)).toEqual([]);
    const rows = await rowsOf(db, alice.id);
    expect(rows.map(r => [r.id, r.isCurrent])).toEqual([[existing, true]]);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(true);
  });

  it("恰好放得下（等於上限）→ 201", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 1100);
    const res = await uploadAvatar(app, alice.id, { original: pngOf(800), display: webpOf(300) });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe("POST /api/auth/avatars：限流", () => {
  it("每人每窗口一次時第二次 429；與筆記附件共用同一桶（先傳附件再傳頭貼 → 429）", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ upload: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    expect((await uploadAvatar(app, alice.id)).statusCode).toBe(201);
    const second = await uploadAvatar(app, alice.id);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("too_many_requests");

    const note = await seedNote(db, { ownerId: bob.id });
    expect((await upload(app, note.id, bob.id, 100)).statusCode).toBe(201);
    expect((await uploadAvatar(app, bob.id)).statusCode).toBe(429);
  });
});

describe("POST /api/auth/avatars：同一人的並發", () => {
  it("第一條請求持 users 列鎖暫停時，同一人的第二條請求被擋住；放行後兩張都在、恰一張是目前", async () => {
    let entered = 0;
    let release!: () => void;
    const held = new Promise<void>(r => (release = r));
    let firstIn!: () => void;
    const firstEntered = new Promise<void>(r => (firstIn = r));
    const { app, db } = await buildTestApp({
      avatarTestHooks: {
        afterUserLock: async () => {
          entered++;
          if (entered === 1) {
            firstIn();
            await held;
          }
        },
      },
    });
    const alice = await seedUser(db);
    let pending: Array<Promise<unknown>> = [];
    try {
      const a = uploadAvatar(app, alice.id, { original: pngOf(1500) });
      pending.push(a);
      await firstEntered;
      const b = uploadAvatar(app, alice.id, { original: pngOf(1600) });
      pending.push(b);
      expect(await waitForBlockedOrSettled(db.$client, b)).toBe("blocked");
      expect(entered).toBe(1);
      release();
      const [ra, rb] = await Promise.all([a, b]);
      pending = [];
      expect(ra.statusCode, ra.body).toBe(201);
      expect(rb.statusCode, rb.body).toBe(201);
    } finally {
      release();
      await Promise.allSettled(pending);
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.isCurrent)).toHaveLength(1);
    // 後拿到鎖的那條上傳最後寫入，所以是目前頭貼。
    expect(rows.find(r => r.isCurrent)!.originalSize).toBe(1600);
  });
});

describe("GET /api/auth/avatars", () => {
  it("refreshable：已連結、有最後看到的圖片網址、沒有它的候選、且對得到啟用中的登入服務才列；providerName 是服務顯示名", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    await seedAuthProvider(db, { issuerUrl: "https://sso-a.example", displayName: "Company SSO", sortOrder: 0 });
    // issuer 取 resolved 值：比對的是 effective issuer，不是設定的網址。
    await seedAuthProvider(db, { issuerUrl: "https://sso-b.example/start", resolvedIssuer: "https://sso-b.example", displayName: "Partner SSO", sortOrder: 1 });
    await seedAuthProvider(db, { issuerUrl: "https://sso-off.example", displayName: "Retired SSO", enabled: false, sortOrder: 2 });

    const ident = async (userId: string, issuer: string, lastPictureUrl: string | null) => {
      const [row] = await db.insert(userIdentities).values({ userId, issuer, sub: `sub-${Math.random()}`, lastPictureUrl }).returning({ id: userIdentities.id });
      return row!.id;
    };
    const refreshA = await ident(alice.id, "https://sso-a.example", "https://pics.example/a.png");
    const refreshB = await ident(alice.id, "https://sso-b.example", "https://pics.example/b.png");
    const hasCandidate = await ident(alice.id, "https://sso-c.example", "https://pics.example/c.png");
    await ident(alice.id, "https://sso-d.example", null);
    await ident(alice.id, "https://sso-off.example", "https://pics.example/off.png");
    await ident(alice.id, "https://sso-gone.example", "https://pics.example/gone.png");
    await ident(bob.id, "https://sso-a.example", "https://pics.example/bob.png");
    await seedAuthProvider(db, { issuerUrl: "https://sso-c.example", displayName: "Third SSO", sortOrder: 3 });
    const candidate = await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0, identityId: hasCandidate });
    // bob 的目前頭貼與候選不會出現在 alice 的清單裡。
    await seedAvatarRow(db, { userId: bob.id, originalSize: 500, displaySize: 50, isCurrent: true });

    const res = await app.inject({ method: "GET", url: "/api/auth/avatars", cookies: await cookieOf(alice.id) });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.auto).toBe(true);
    expect([...body.refreshable].sort((x: { identityId: string }, y: { identityId: string }) => x.identityId.localeCompare(y.identityId))).toEqual(
      [
        { identityId: refreshA, providerName: "Company SSO" },
        { identityId: refreshB, providerName: "Partner SSO" },
      ].sort((x, y) => x.identityId.localeCompare(y.identityId)),
    );
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      id: candidate,
      source: "oidc",
      providerName: "Third SSO",
      pending: true,
      current: false,
      crop: null,
      originalWidth: null,
      originalHeight: null,
      originalSize: 70,
      displaySize: 0,
    });
  });

  it("沒有任何東西時回空清單；bob 的候選不會出現在 alice 的清單", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    await seedAvatarRow(db, { userId: bob.id, originalSize: 500, displaySize: 50, isCurrent: true });
    const res = await app.inject({ method: "GET", url: "/api/auth/avatars", cookies: await cookieOf(alice.id) });
    expect(res.json()).toEqual({ candidates: [], auto: true, refreshable: [] });
  });
});

describe("頭貼上傳與清單的存取界線", () => {
  it("未登入 401；只帶 Bearer（API token）401；跨源 Origin 的上傳 403", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const { token } = await seedTokenForUser(db, alice.id);
    expect((await uploadAvatar(app, alice.id, { cookies: null })).statusCode).toBe(401);
    expect((await uploadAvatar(app, alice.id, { cookies: null, headers: bearer(token) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/avatars" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/avatars", headers: bearer(token) })).statusCode).toBe(401);
    const cross = await uploadAvatar(app, alice.id, { headers: { origin: "https://evil.example" } });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().error.code).toBe("forbidden");
    expect(await rowsOf(db, alice.id)).toEqual([]);
  });

  it("頭貼不進附件讀取路徑：候選 id 與原圖檔名都讀不到（404）", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const res = await uploadAvatar(app, alice.id);
    const [row] = await rowsOf(db, alice.id);
    const cookies = await cookieOf(alice.id);
    for (const id of [res.json().id, row!.originalFile]) {
      const get = await app.inject({ method: "GET", url: `/api/uploads/${id}`, cookies });
      expect(get.statusCode, id).toBe(404);
    }
  });
});
