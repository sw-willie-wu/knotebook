/**
 * `POST /api/auth/avatars/oidc/:identityId/refresh`：手動「改用 X 的頭貼」。
 * 走真路由與真交易；圖片伺服器是本機 `node:http`，除專門測生產位址政策的案外，下載政策注入「放行 loopback 與任意埠」。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { AvatarFetchPolicy } from "../src/avatars/oidc-fetch.js";
import type { Db } from "../src/db/index.js";
import { userAvatars, userIdentities, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { giveUserQuota, pngOf } from "./storage-helpers.js";

const ISSUER = "https://idp.example";
const OPEN_POLICY: AvatarFetchPolicy = { portAllowed: () => true, addressBlocked: () => false };

/** 內容由 `fill` 決定的 PNG（signature 相同、位元組不同 → sha256 不同）。 */
function pngFilled(size: number, fill: number): Buffer {
  const b = pngOf(size);
  b.fill(fill, 8);
  return b;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

interface ImageRoute {
  status?: number;
  body?: Buffer;
  /** 收到請求後等這個 Promise 才回應。 */
  hold?: Promise<void>;
}

async function imageServer(routes: Record<string, ImageRoute>): Promise<{ base: string; requests: () => number; arrived: () => Promise<void> }> {
  let count = 0;
  let onFirst: () => void = () => {};
  const first = new Promise<void>(r => (onFirst = r));
  const server = createServer((req, res) => {
    count++;
    onFirst();
    const route = routes[(req.url ?? "").split("?")[0]!];
    void (async () => {
      if (route?.hold) await route.hold;
      if (!route) return void res.writeHead(404).end();
      res.writeHead(route.status ?? 200, { "content-type": "image/png" });
      res.end(route.body ?? Buffer.alloc(0));
    })();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => count, arrived: () => first };
}

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;

async function seedIdentity(db: Db, userId: string, over: { lastPictureUrl?: string | null; dismissed?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(userIdentities)
    .values({
      userId,
      issuer: ISSUER,
      sub: `sub-${randomUUID()}`,
      lastPictureUrl: over.lastPictureUrl === undefined ? null : over.lastPictureUrl,
      pictureDismissedUrl: over.dismissed === undefined ? null : over.dismissed,
    })
    .returning({ id: userIdentities.id });
  return row!.id;
}

const refresh = async (app: Ctx["app"], userId: string | null, identityId: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: `/api/auth/avatars/oidc/${identityId}/refresh`,
    ...(userId !== null ? { cookies: await cookieOf(userId) } : {}),
    headers,
  });

const rowsOf = (db: Db, userId: string) => db.select().from(userAvatars).where(eq(userAvatars.userId, userId));
const identityOf = async (db: Db, id: string) => (await db.select().from(userIdentities).where(eq(userIdentities.id, id)))[0]!;
const autoOf = async (db: Db, userId: string) => (await db.select({ a: users.avatarAuto }).from(users).where(eq(users.id, userId)))[0]!.a;
const usedBytes = async (db: Db, userId: string) => (await readSpaceUsage(db, { kind: "user", id: userId }))!.usedBytes;
const filesOf = async (dir: string) => (await readdir(dir)).sort();

function logCollector() {
  const out: string[] = [];
  return { out, logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } };
}

/** 給候選填上顯示圖與裁切。 */
async function giveDisplay(db: Db, id: string): Promise<void> {
  await db
    .update(userAvatars)
    .set({ cropX: 1, cropY: 2, cropSize: 30, originalWidth: 40, originalHeight: 50, displayData: Buffer.alloc(120, 0x41), displayMime: "image/webp", displaySize: 120 })
    .where(eq(userAvatars.id, id));
}

describe("POST /api/auth/avatars/oidc/:identityId/refresh：成功", () => {
  it("使用者刪過這張 → 200 回清單：候選回來且是目前頭貼、avatar_auto＝false、picture_dismissed_url 清空、refreshable 不再含它；用量與檔案對得上", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    await seedAuthProvider(db, { issuerUrl: ISSUER, displayName: "Company SSO" });
    const picture = `${img.base}/a.png`;
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: picture, dismissed: picture });
    expect(await autoOf(db, alice.id)).toBe(true);
    const listed = await app.inject({ method: "GET", url: "/api/auth/avatars", cookies: await cookieOf(alice.id) });
    expect(listed.json().refreshable).toEqual([{ identityId, providerName: "Company SSO" }]);

    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.refreshable).toEqual([]);
    expect(body.auto).toBe(false);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({ source: "oidc", providerName: "Company SSO", current: true, pending: true });
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ identityId, oidcPictureUrl: picture, isCurrent: true, originalSize: 500, version: 1 });
    expect(await autoOf(db, alice.id)).toBe(false);
    expect((await identityOf(db, identityId)).pictureDismissedUrl).toBeNull();
    expect(await filesOf(uploadsDir)).toEqual([rows[0]!.originalFile]);
    expect(await usedBytes(db, alice.id)).toBe(500);
    // 目前頭貼立刻反映在 /me。
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(alice.id) });
    expect(me.json().avatar).toMatchObject({ id: rows[0]!.id, pending: true });
  });

  it("已有這個身分的候選（位元組不同）→ 原地替換並選用：同一個 id、version + 1、裁切與顯示圖清空、舊檔刪掉、上傳的那張不再是目前頭貼", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/new.png": { body: pngFilled(700, 2) } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/new.png` });
    const [old] = await db
      .insert(userAvatars)
      .values({
        userId: alice.id,
        source: "oidc",
        identityId,
        oidcPictureUrl: `${img.base}/old.png`,
        originalFile: randomUUID(),
        originalSha256: Buffer.alloc(32, 9),
        originalMime: "image/png",
        originalSize: 300,
      })
      .returning();
    await giveDisplay(db, old!.id);
    const [upload] = await db
      .insert(userAvatars)
      .values({ userId: alice.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 7), originalMime: "image/png", originalSize: 100, displayData: Buffer.alloc(50, 0x41), displayMime: "image/webp", displaySize: 50, isCurrent: true })
      .returning();
    const usedBefore = await usedBytes(db, alice.id);
    await writeFile(uploadFilePath(uploadsDir, old!.originalFile), pngFilled(300, 9));
    expect(await filesOf(uploadsDir)).toEqual([old!.originalFile]);

    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(2);
    const replaced = rows.find(r => r.id === old!.id)!;
    expect(replaced).toMatchObject({ isCurrent: true, version: 2, displayData: null, displaySize: 0, cropX: null, originalWidth: null, originalSize: 700, oidcPictureUrl: `${img.base}/new.png` });
    expect(rows.find(r => r.id === upload!.id)!.isCurrent).toBe(false);
    expect(await autoOf(db, alice.id)).toBe(false);
    expect(await usedBytes(db, alice.id)).toBe(usedBefore + (700 - 300 - 120));
    expect(await filesOf(uploadsDir)).toEqual([replaced.originalFile]);
    expect(existsSync(path.join(uploadsDir, old!.originalFile))).toBe(false);
  });

  it("位元組相同 → 不換原圖、不升 version、顯示圖保留，但仍選用；新下載的檔不留", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const bytes = pngFilled(400, 3);
    const img = await imageServer({ "/a.png": { body: bytes } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const { createHash } = await import("node:crypto");
    const [cand] = await db
      .insert(userAvatars)
      .values({ userId: alice.id, source: "oidc", identityId, oidcPictureUrl: `${img.base}/a.png`, originalFile: randomUUID(), originalSha256: createHash("sha256").update(bytes).digest(), originalMime: "image/png", originalSize: 400 })
      .returning();
    await giveDisplay(db, cand!.id);
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await rowsOf(db, alice.id);
    expect(row).toMatchObject({ id: cand!.id, isCurrent: true, version: 1, displaySize: 120, originalFile: cand!.originalFile });
    expect(await autoOf(db, alice.id)).toBe(false);
    expect(await filesOf(uploadsDir)).toEqual([]);
  });

  it("旁觀者：bob 有同形資料（身分、被刪過的網址、目前頭貼）時完全不受影響", async () => {
    const { app, db } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const picture = `${img.base}/a.png`;
    const aliceIdentity = await seedIdentity(db, alice.id, { lastPictureUrl: picture, dismissed: picture });
    const bobIdentity = await seedIdentity(db, bob.id, { lastPictureUrl: picture, dismissed: picture });
    const [bobAvatar] = await db
      .insert(userAvatars)
      .values({ userId: bob.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 5), originalMime: "image/png", originalSize: 100, displayData: Buffer.alloc(50, 0x41), displayMime: "image/webp", displaySize: 50, isCurrent: true })
      .returning();
    const res = await refresh(app, alice.id, aliceIdentity);
    expect(res.statusCode, res.body).toBe(200);
    expect((await identityOf(db, bobIdentity)).pictureDismissedUrl).toBe(picture);
    expect(await autoOf(db, bob.id)).toBe(true);
    expect(await rowsOf(db, bob.id)).toEqual([bobAvatar]);
  });
});

describe("POST /api/auth/avatars/oidc/:identityId/refresh：失敗", () => {
  it("圖片伺服器 500 → 422 avatar_fetch_failed；訊息與 log 都不含網址（含 token）；沒有候選、沒有檔；avatar_auto 與 picture_dismissed_url 不動", async () => {
    const { out, logger } = logCollector();
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY }, { logger });
    const img = await imageServer({ "/a.png": { status: 500 } });
    const alice = await seedUser(db);
    const picture = `${img.base}/a.png?token=sekret-token`;
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: picture, dismissed: picture });
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("avatar_fetch_failed");
    expect(res.body).not.toContain("sekret-token");
    expect(res.body).not.toContain("127.0.0.1");
    expect(await rowsOf(db, alice.id)).toEqual([]);
    expect(await filesOf(uploadsDir)).toEqual([]);
    expect(await autoOf(db, alice.id)).toBe(true);
    expect((await identityOf(db, identityId)).pictureDismissedUrl).toBe(picture);
    const logged = out.join("");
    expect(logged).not.toContain("sekret-token");
    expect(logged).toContain("http_status");
  });

  it("生產位址政策（不注入）→ 指向 loopback 的網址 422 avatar_fetch_failed，且沒有送出請求", async () => {
    const { app, db } = await buildTestApp();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("avatar_fetch_failed");
    expect(img.requests()).toBe(0);
  });

  it("空間已滿 → 409 storage_quota_exceeded，不下載（請求數 0）", async () => {
    const { app, db } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 1000);
    await db.insert(userAvatars).values({ userId: alice.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 7), originalMime: "image/png", originalSize: 1000, displayData: Buffer.alloc(10, 0x41), displayMime: "image/webp", displaySize: 10 });
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("storage_quota_exceeded");
    expect(img.requests()).toBe(0);
  });

  it("放不下這張 → 409 storage_quota_exceeded；整筆回滾：沒有候選、沒有檔、avatar_auto 與 picture_dismissed_url 不動", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 400);
    const picture = `${img.base}/a.png`;
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: picture, dismissed: picture });
    const res = await refresh(app, alice.id, identityId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("storage_quota_exceeded");
    expect(img.requests()).toBe(1);
    expect(await rowsOf(db, alice.id)).toEqual([]);
    expect(await filesOf(uploadsDir)).toEqual([]);
    expect(await autoOf(db, alice.id)).toBe(true);
    expect((await identityOf(db, identityId)).pictureDismissedUrl).toBe(picture);
  });

  it("下載期間解除連結 → 404；沒有候選、沒有留檔", async () => {
    const { app, db, uploadsDir } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const pending = refresh(app, alice.id, identityId);
    await img.arrived();
    await db.delete(userIdentities).where(eq(userIdentities.id, identityId));
    release();
    const res = await pending;
    expect(res.statusCode, res.body).toBe(404);
    expect(await rowsOf(db, alice.id)).toEqual([]);
    expect(await filesOf(uploadsDir)).toEqual([]);
  });
});

describe("POST /api/auth/avatars/oidc/:identityId/refresh：身分檢查、節流、認證", () => {
  it("別人的身分、last_picture_url 為 NULL、不是 UUID → 404，且不扣桶（上限 1 次，三次 404 之後第一次真的請求仍是 200）", async () => {
    const { app, db } = await buildTestApp(
      { avatarFetchPolicy: OPEN_POLICY, limiters: { avatarRefresh: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) } },
    );
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobIdentity = await seedIdentity(db, bob.id, { lastPictureUrl: `${img.base}/a.png` });
    const noPicture = await seedIdentity(db, alice.id, { lastPictureUrl: null });
    const own = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    for (const id of [bobIdentity, noPicture, "not-a-uuid"]) {
      const res = await refresh(app, alice.id, id);
      expect(res.statusCode, `${id}: ${res.body}`).toBe(404);
    }
    expect(img.requests()).toBe(0);
    expect(await rowsOf(db, bob.id)).toEqual([]);
    expect((await refresh(app, alice.id, own)).statusCode).toBe(200);
  });

  it("每人每小時的上限：第 2 次 429（上限 1 次時）；bob 另有自己的額度；被擋的那次不下載", async () => {
    const { app, db } = await buildTestApp(
      { avatarFetchPolicy: OPEN_POLICY, limiters: { avatarRefresh: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) } },
    );
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const aliceIdentity = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    const bobIdentity = await seedIdentity(db, bob.id, { lastPictureUrl: `${img.base}/a.png` });
    expect((await refresh(app, alice.id, aliceIdentity)).statusCode).toBe(200);
    expect(img.requests()).toBe(1);
    const limited = await refresh(app, alice.id, aliceIdentity);
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json().error.code).toBe("too_many_requests");
    expect(img.requests()).toBe(1);
    expect((await refresh(app, bob.id, bobIdentity)).statusCode).toBe(200);
  });

  it("預設桶是每人每小時 10 次：第 11 次 429", async () => {
    const { app, db } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { status: 500 } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    for (let i = 0; i < 10; i++) expect((await refresh(app, alice.id, identityId)).statusCode).toBe(422);
    expect((await refresh(app, alice.id, identityId)).statusCode).toBe(429);
  });

  it("未登入 401；Bearer（個人 token）也是 401", async () => {
    const { app, db } = await buildTestApp({ avatarFetchPolicy: OPEN_POLICY });
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(db);
    const identityId = await seedIdentity(db, alice.id, { lastPictureUrl: `${img.base}/a.png` });
    expect((await refresh(app, null, identityId)).statusCode).toBe(401);
    const { token } = await seedTokenForUser(db, alice.id);
    expect((await refresh(app, null, identityId, bearer(token))).statusCode).toBe(401);
    expect(img.requests()).toBe(0);
    expect(await db.select().from(userAvatars).where(and(eq(userAvatars.userId, alice.id)))).toEqual([]);
  });
});
