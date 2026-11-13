/**
 * OIDC 頭貼的交易與背景工作：`replaceOidcAvatarInTx`、OIDC 形的 `insertAvatarInTx`、`runOidcAvatarJob`。
 * 圖片伺服器是本機 `node:http`，下載政策注入「放行 loopback 與任意埠」；網址與位元組都是測試自己造的。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvatarFetchPolicy } from "../src/avatars/oidc-fetch.js";
import { runOidcAvatarJob, scheduleOidcAvatarJob, type OidcAvatarJobDeps, type OidcAvatarJobResult } from "../src/avatars/oidc-job.js";
import { AvatarIdentityGone, replaceOidcAvatarInTx } from "../src/avatars/tx/avatars.js";
import type { Db } from "../src/db/index.js";
import { userAvatars, userIdentities, users } from "../src/db/schema.js";
import { StorageQuotaExceeded } from "../src/storage/tx/quota.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { giveUserQuota, pngOf } from "./storage-helpers.js";

const ISSUER = "https://idp.example";
const OPEN_POLICY: AvatarFetchPolicy = { portAllowed: () => true, addressBlocked: () => false };

/** 內容由 `fill` 決定的 PNG（signature 相同、位元組不同 → sha256 不同）。 */
function pngFilled(size: number, fill: number): Buffer {
  const b = pngOf(size);
  b.fill(fill, 8);
  return b;
}

interface ImageRoute {
  status?: number;
  body?: Buffer;
  /** 收到請求後等這個 Promise 才回應。 */
  hold?: Promise<void>;
}

interface ImageServer {
  base: string;
  requests: () => number;
  /** 第 n 個（從 1 數）請求抵達。 */
  arrived: (n: number) => Promise<void>;
  setRoute: (p: string, r: ImageRoute) => void;
  close: () => Promise<void>;
}

async function imageServer(initial: Record<string, ImageRoute> = {}): Promise<ImageServer> {
  const routes = new Map<string, ImageRoute>(Object.entries(initial));
  let count = 0;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    count++;
    for (const w of waiters.filter(w => w.n <= count)) w.resolve();
    const route = routes.get((req.url ?? "").split("?")[0]!);
    void (async () => {
      if (route?.hold) await route.hold;
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      const status = route.status ?? 200;
      res.writeHead(status, { "content-type": "image/png" });
      res.end(route.body ?? Buffer.alloc(0));
    })();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return {
    base: `http://127.0.0.1:${port}`,
    requests: () => count,
    arrived: n => (count >= n ? Promise.resolve() : new Promise<void>(resolve => waiters.push({ n, resolve }))),
    setRoute: (p, r) => void routes.set(p, r),
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

async function seedIdentity(db: Db, userId: string, over: { dismissed?: string } = {}): Promise<{ id: string; sub: string }> {
  const sub = `sub-${randomUUID()}`;
  const [row] = await db
    .insert(userIdentities)
    .values({ userId, issuer: ISSUER, sub, ...(over.dismissed !== undefined ? { pictureDismissedUrl: over.dismissed } : {}) })
    .returning({ id: userIdentities.id });
  return { id: row!.id, sub };
}

interface Harness {
  db: Db;
  uploadsDir: string;
  deps: OidcAvatarJobDeps;
  settled: OidcAvatarJobResult[];
  logs: Array<{ obj: Record<string, unknown>; msg: string }>;
  invalidated: string[];
}

async function harness(over: Partial<OidcAvatarJobDeps> = {}): Promise<Harness> {
  const { db, uploadsDir } = await buildTestApp();
  const settled: OidcAvatarJobResult[] = [];
  const logs: Harness["logs"] = [];
  const invalidated: string[] = [];
  const deps: OidcAvatarJobDeps = {
    db,
    gate: { invalidate: (id: string) => void invalidated.push(id) },
    uploadsDir,
    storageLockTimeoutMs: 5000,
    avatarFetchPolicy: OPEN_POLICY,
    avatarJobHooks: { onSettled: r => void settled.push(r) },
    log: { info: (obj, msg) => void logs.push({ obj: obj as Record<string, unknown>, msg }) },
    ...over,
  };
  return { db, uploadsDir, deps, settled, logs, invalidated };
}

const rowsOf = (db: Db, userId: string) => db.select().from(userAvatars).where(eq(userAvatars.userId, userId));
const identityOf = async (db: Db, id: string) => (await db.select().from(userIdentities).where(eq(userIdentities.id, id)))[0]!;
const filesOf = async (dir: string) => (await readdir(dir)).sort();

/** 給候選填上顯示圖與裁切（模擬瀏覽器已補產、或使用者裁過）。 */
async function giveDisplay(db: Db, id: string): Promise<void> {
  await db
    .update(userAvatars)
    .set({ cropX: 1, cropY: 2, cropSize: 30, originalWidth: 40, originalHeight: 50, displayData: Buffer.alloc(120, 0x41), displayMime: "image/webp", displaySize: 120 })
    .where(eq(userAvatars.id, id));
}

describe("runOidcAvatarJob：建立與自動選用", () => {
  it("沒有候選、avatar_auto＝true、沒有目前頭貼 → 建 OIDC 候選並選用；avatar_auto 仍 true；顯示圖 NULL；last_picture_url 已寫", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const picture = `${img.base}/a.png`;
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture });
    const rows = await rowsOf(h.db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "oidc", identityId: idn.id, oidcPictureUrl: picture, isCurrent: true, displayData: null, displayMime: null, displaySize: 0, originalSize: 500, originalMime: "image/png", version: 1 });
    expect(rows[0]!.cropX).toBeNull();
    expect(rows[0]!.originalWidth).toBeNull();
    expect(existsSync(path.join(h.uploadsDir, rows[0]!.originalFile))).toBe(true);
    const [u] = await h.db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(u!.avatarAuto).toBe(true);
    expect((await identityOf(h.db, idn.id)).lastPictureUrl).toBe(picture);
    expect(h.settled).toEqual([expect.objectContaining({ outcome: "inserted" })]);
    expect(h.invalidated).toEqual([alice.id]);
  });

  it("已有目前頭貼（上傳的）→ OIDC 候選建立但不是目前頭貼", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const [up] = await h.db
      .insert(userAvatars)
      .values({ userId: alice.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 7), originalMime: "image/png", originalSize: 100, displayData: Buffer.alloc(50, 0x41), displayMime: "image/webp", displaySize: 50, isCurrent: true })
      .returning({ id: userAvatars.id });
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    const rows = await rowsOf(h.db, alice.id);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.source === "oidc")!.isCurrent).toBe(false);
    expect(rows.find(r => r.id === up!.id)!.isCurrent).toBe(true);
  });

  it("avatar_auto＝false 且沒有目前頭貼 → 不自動選用", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    await h.db.update(users).set({ avatarAuto: false }).where(eq(users.id, alice.id));
    const idn = await seedIdentity(h.db, alice.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    const rows = await rowsOf(h.db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isCurrent).toBe(false);
    const [u] = await h.db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(u!.avatarAuto).toBe(false);
  });
});

describe("runOidcAvatarJob：同網址、換網址", () => {
  it("同網址 → 不下載（請求數不增加）", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const args = { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` };
    await runOidcAvatarJob(h.deps, args);
    expect(img.requests()).toBe(1);
    await runOidcAvatarJob(h.deps, args);
    expect(img.requests()).toBe(1);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "same_url" });
    expect(await rowsOf(h.db, alice.id)).toHaveLength(1);
  });

  it("換網址、位元組不同 → 原地替換：同 id、version+1、裁切與顯示圖清空、舊檔刪、新檔在、is_current 不變、用量差額正確；bob 不受影響", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) }, "/b.png": { body: pngFilled(700, 2) } });
    const alice = await seedUser(h.db);
    const bob = await seedUser(h.db);
    const aIdn = await seedIdentity(h.db, alice.id);
    const bIdn = await seedIdentity(h.db, bob.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: `${img.base}/a.png` });
    await runOidcAvatarJob(h.deps, { userId: bob.id, issuer: ISSUER, sub: bIdn.sub, picture: `${img.base}/a.png` });
    const [before] = await rowsOf(h.db, alice.id);
    await giveDisplay(h.db, before!.id);
    const [bobBefore] = await rowsOf(h.db, bob.id);
    await giveDisplay(h.db, bobBefore!.id);
    const bobSnapshot = (await rowsOf(h.db, bob.id))[0]!;
    expect((await readSpaceUsage(h.db, { kind: "user", id: alice.id }))!.usedBytes).toBe(500 + 120);

    const second = `${img.base}/b.png`;
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: second });
    const rows = await rowsOf(h.db, alice.id);
    expect(rows).toHaveLength(1);
    const after = rows[0]!;
    expect(after).toMatchObject({ id: before!.id, version: 2, isCurrent: true, oidcPictureUrl: second, originalSize: 700, displayData: null, displayMime: null, displaySize: 0, cropX: null, cropY: null, cropSize: null, originalWidth: null, originalHeight: null });
    expect(after.originalFile).not.toBe(before!.originalFile);
    expect(existsSync(path.join(h.uploadsDir, before!.originalFile))).toBe(false);
    expect(existsSync(path.join(h.uploadsDir, after.originalFile))).toBe(true);
    expect((await readSpaceUsage(h.db, { kind: "user", id: alice.id }))!.usedBytes).toBe(700);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "replaced" });
    // 旁觀者：bob 的列與檔原樣
    expect((await rowsOf(h.db, bob.id))[0]).toEqual(bobSnapshot);
    expect(existsSync(path.join(h.uploadsDir, bobSnapshot.originalFile))).toBe(true);
  });

  it("換網址、位元組相同 → 只改 oidc_picture_url；裁切與顯示圖保留、version 不變、沒有多出檔案；bob 不受影響", async () => {
    const h = await harness();
    const same = pngFilled(500, 1);
    const img = await imageServer({ "/a.png": { body: same }, "/copy.png": { body: Buffer.from(same) } });
    const alice = await seedUser(h.db);
    const bob = await seedUser(h.db);
    const aIdn = await seedIdentity(h.db, alice.id);
    const bIdn = await seedIdentity(h.db, bob.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: `${img.base}/a.png` });
    await runOidcAvatarJob(h.deps, { userId: bob.id, issuer: ISSUER, sub: bIdn.sub, picture: `${img.base}/a.png` });
    const [before] = await rowsOf(h.db, alice.id);
    await giveDisplay(h.db, before!.id);
    const bobSnapshot = (await rowsOf(h.db, bob.id))[0]!;
    const filesBefore = await filesOf(h.uploadsDir);

    const second = `${img.base}/copy.png`;
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: second });
    const [after] = await rowsOf(h.db, alice.id);
    expect(after).toMatchObject({ id: before!.id, version: 1, oidcPictureUrl: second, originalFile: before!.originalFile, cropX: 1, cropSize: 30, displaySize: 120, originalWidth: 40 });
    expect(after!.displayData?.length).toBe(120);
    expect(await filesOf(h.uploadsDir)).toEqual(filesBefore);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "same_bytes" });
    expect((await rowsOf(h.db, bob.id))[0]).toEqual(bobSnapshot);
  });
});

describe("runOidcAvatarJob：失敗與已移除", () => {
  it("圖片伺服器 500 → 沒有候選、沒有檔、last_picture_url 仍寫；伺服器恢復後同網址再跑 → 建立", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { status: 500 } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const picture = `${img.base}/a.png`;
    const args = { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture };
    await runOidcAvatarJob(h.deps, args);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(await filesOf(h.uploadsDir)).toEqual([]);
    expect((await identityOf(h.db, idn.id)).lastPictureUrl).toBe(picture);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "http_status" });
    expect(h.invalidated).toEqual([]);
    img.setRoute("/a.png", { body: pngFilled(500, 1) });
    await runOidcAvatarJob(h.deps, args);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(1);
  });

  it("picture 等於 picture_dismissed_url → 不下載；換新網址 → 下載並建立；bob 同形資料不受影響", async () => {
    const h = await harness();
    const img = await imageServer({ "/old.png": { body: pngFilled(500, 1) }, "/new.png": { body: pngFilled(600, 2) } });
    const alice = await seedUser(h.db);
    const bob = await seedUser(h.db);
    const oldUrl = `${img.base}/old.png`;
    const aIdn = await seedIdentity(h.db, alice.id, { dismissed: oldUrl });
    const bIdn = await seedIdentity(h.db, bob.id, { dismissed: oldUrl });
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: oldUrl });
    expect(img.requests()).toBe(0);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "dismissed" });
    expect((await identityOf(h.db, aIdn.id)).lastPictureUrl).toBe(oldUrl);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: aIdn.sub, picture: `${img.base}/new.png` });
    expect(await rowsOf(h.db, alice.id)).toHaveLength(1);
    expect(img.requests()).toBe(1);
    // bob 沒有被觸發：他的身分列沒被動
    expect((await identityOf(h.db, bIdn.id)).lastPictureUrl).toBeNull();
    expect((await identityOf(h.db, bIdn.id)).pictureDismissedUrl).toBe(oldUrl);
    expect(await rowsOf(h.db, bob.id)).toHaveLength(0);
  });

  it("下載期間使用者刪掉了同一個網址（picture_dismissed_url 被設）→ 不插入、新檔被清掉、reason 是 dismissed", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const picture = `${img.base}/a.png`;
    const deps: OidcAvatarJobDeps = {
      ...h.deps,
      avatarTestHooks: { afterUserLock: async () => void (await h.db.update(userIdentities).set({ pictureDismissedUrl: picture }).where(eq(userIdentities.id, idn.id))) },
    };
    await runOidcAvatarJob(deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture });
    expect(img.requests()).toBe(1);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(await filesOf(h.uploadsDir)).toEqual([]);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "dismissed" });
    expect(h.invalidated).toEqual([]);
  });

  it("沒有 picture → 不下載，last_picture_url 清成 NULL", async () => {
    const h = await harness();
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    await h.db.update(userIdentities).set({ lastPictureUrl: "https://img.example/x.png" }).where(eq(userIdentities.id, idn.id));
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: null });
    expect((await identityOf(h.db, idn.id)).lastPictureUrl).toBeNull();
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "no_picture" });
  });

  it("身分列不存在（或不屬於這個人）→ 結束，不下載", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const bob = await seedUser(h.db);
    const bIdn = await seedIdentity(h.db, bob.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: bIdn.sub, picture: `${img.base}/a.png` });
    expect(img.requests()).toBe(0);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "skipped", reason: "no_identity" });
  });

  it("下載期間解除連結 → 沒有候選、沒有留檔、reason 是 unlinked", async () => {
    const h = await harness();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const running = runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    await img.arrived(1);
    await h.db.delete(userIdentities).where(eq(userIdentities.id, idn.id));
    release();
    await running;
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(await filesOf(h.uploadsDir)).toEqual([]);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "unlinked" });
  });
});

describe("runOidcAvatarJob：配額", () => {
  it("剩餘不足 → 不建候選、不留檔、reason＝quota", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(2000, 1) } });
    const alice = await seedUser(h.db);
    await giveUserQuota(h.db, alice.id, 1000);
    const idn = await seedIdentity(h.db, alice.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    expect(img.requests()).toBe(1);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(0);
    expect(await filesOf(h.uploadsDir)).toEqual([]);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "quota" });
    expect(h.logs.at(-1)!.obj).toMatchObject({ reason: "quota" });
  });

  it("已滿 → 不下載（請求數 0）、reason＝quota", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(200, 1) } });
    const alice = await seedUser(h.db);
    await giveUserQuota(h.db, alice.id, 300);
    await h.db
      .insert(userAvatars)
      .values({ userId: alice.id, source: "upload", originalFile: randomUUID(), originalSha256: Buffer.alloc(32, 7), originalMime: "image/png", originalSize: 250, displayData: Buffer.alloc(50, 0x41), displayMime: "image/webp", displaySize: 50 });
    const idn = await seedIdentity(h.db, alice.id);
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    expect(img.requests()).toBe(0);
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "quota" });
  });
});

describe("runOidcAvatarJob：去重與記錄", () => {
  it("同一使用者同一身分連排兩次、伺服器 hold → 只有一個請求；後來的略過", async () => {
    const h = await harness();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const args = { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` };
    const first = runOidcAvatarJob(h.deps, args);
    await img.arrived(1);
    const second = await runOidcAvatarJob(h.deps, args);
    expect(second).toMatchObject({ outcome: "skipped", reason: "in_flight" });
    release();
    expect(await first).toMatchObject({ outcome: "inserted" });
    expect(img.requests()).toBe(1);
    expect(await rowsOf(h.db, alice.id)).toHaveLength(1);
    // 結束後鍵被釋放：換網址可以再跑
    img.setRoute("/b.png", { body: pngFilled(600, 2) });
    expect(await runOidcAvatarJob(h.deps, { ...args, picture: `${img.base}/b.png` })).toMatchObject({ outcome: "replaced" });
  });

  it("進行中又來一次（換了網址）→ 後來的被略過，但 last_picture_url 是後來那個值", async () => {
    const h = await harness();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold }, "/b.png": { body: pngFilled(600, 2) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const first = runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    await img.arrived(1);
    const second = `${img.base}/b.png`;
    expect(await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: second })).toMatchObject({ outcome: "skipped", reason: "in_flight" });
    release();
    await first;
    expect((await identityOf(h.db, idn.id)).lastPictureUrl).toBe(second);
  });

  it("失敗時 info 一行含 userId、identityId、reason；不含網址字串（帶 token 的 query 不出現）", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { status: 500 } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const picture = `${img.base}/a.png?token=secretvalue`;
    await runOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.obj).toEqual({ userId: alice.id, identityId: idn.id, reason: "http_status" });
    const text = JSON.stringify(h.logs) + JSON.stringify(h.settled);
    expect(text).not.toContain("secretvalue");
    expect(text).not.toContain("127.0.0.1");
  });

  it("資料庫錯誤只記 name 與 code，不帶原始錯誤", async () => {
    const h = await harness();
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1) } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    // 用交易的測試縫丟一個帶 params 的錯誤（模擬 drizzle 把 SQL 參數串進 message）。
    const boom = Object.assign(new Error(`insert into "user_avatars" params: secretvalue`), { code: "XX000" });
    const deps: OidcAvatarJobDeps = { ...h.deps, avatarTestHooks: { afterUserLock: () => Promise.reject(boom) } };
    await runOidcAvatarJob(deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    expect(h.settled.at(-1)).toMatchObject({ outcome: "failed", reason: "error" });
    expect(h.logs.at(-1)!.obj).toEqual({ userId: alice.id, identityId: idn.id, reason: "error", name: "Error", code: "XX000" });
    expect(JSON.stringify(h.logs)).not.toContain("secretvalue");
    expect(await filesOf(h.uploadsDir)).toEqual([]);
  });
});

describe("scheduleOidcAvatarJob", () => {
  it("同步回傳（不等下載）；背景跑完後 onSettled 被呼叫", async () => {
    const h = await harness();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const img = await imageServer({ "/a.png": { body: pngFilled(500, 1), hold } });
    const alice = await seedUser(h.db);
    const idn = await seedIdentity(h.db, alice.id);
    const done = new Promise<OidcAvatarJobResult>(resolve => {
      h.deps.avatarJobHooks = { onSettled: resolve };
    });
    const ret = scheduleOidcAvatarJob(h.deps, { userId: alice.id, issuer: ISSUER, sub: idn.sub, picture: `${img.base}/a.png` });
    expect(ret).toBeUndefined();
    expect(img.requests()).toBe(0);
    await img.arrived(1);
    release();
    expect(await done).toMatchObject({ outcome: "inserted" });
  });

  it("run 丟錯不外洩成未處理的 rejection", async () => {
    const h = await harness();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const done = new Promise<void>(resolve => {
        h.deps.avatarJobHooks = {
          onSettled: () => {
            resolve();
            throw new Error("hook exploded");
          },
        };
      });
      scheduleOidcAvatarJob(h.deps, { userId: randomUUID(), issuer: ISSUER, sub: "nobody", picture: null });
      await done;
      await new Promise(r => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("replaceOidcAvatarInTx", () => {
  const lockTimeoutMs = 5000;
  const input = (userId: string, identityId: string, size: number, fill: number, url = "https://img.example/a.png") => ({
    userId,
    identityId,
    oidcPictureUrl: url,
    originalFile: randomUUID(),
    originalSha256: Buffer.alloc(32, fill),
    originalMime: "image/png",
    originalSize: size,
    lockTimeoutMs,
  });

  it("找不到候選 → inserted（自動選用條件同插入）", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const idn = await seedIdentity(db, alice.id);
    const r = await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, idn.id, 100, 1)));
    expect(r.outcome).toBe("inserted");
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isCurrent: true, identityId: idn.id });
  });

  it("身分列不是這個人的 → AvatarIdentityGone，不留列", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bIdn = await seedIdentity(db, bob.id);
    await expect(db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, bIdn.id, 100, 1)))).rejects.toBeInstanceOf(AvatarIdentityGone);
    expect(await rowsOf(db, alice.id)).toHaveLength(0);
    expect(await rowsOf(db, bob.id)).toHaveLength(0);
  });

  it("位元組不同：回傳舊檔名；原圖變大而空間不夠 → StorageQuotaExceeded 且列不變", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const idn = await seedIdentity(db, alice.id);
    const first = input(alice.id, idn.id, 400, 1);
    await db.transaction(tx => replaceOidcAvatarInTx(tx, first));
    await giveUserQuota(db, alice.id, 500);
    const bigger = input(alice.id, idn.id, 900, 2);
    await expect(db.transaction(tx => replaceOidcAvatarInTx(tx, bigger))).rejects.toBeInstanceOf(StorageQuotaExceeded);
    expect((await rowsOf(db, alice.id))[0]).toMatchObject({ originalFile: first.originalFile, originalSize: 400, version: 1 });
    const smaller = input(alice.id, idn.id, 300, 3);
    const r = await db.transaction(tx => replaceOidcAvatarInTx(tx, smaller));
    expect(r).toEqual({ outcome: "replaced", oldFile: first.originalFile });
    expect((await rowsOf(db, alice.id))[0]).toMatchObject({ originalFile: smaller.originalFile, originalSize: 300, version: 2 });
  });

  it("替換的配額差額含舊顯示圖：舊原圖 400＋舊顯示圖 120、新原圖 500、額度 600 → 可以（差額 −20）；額度 500 且新原圖 700 → 拒絕", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const idn = await seedIdentity(db, alice.id);
    await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, idn.id, 400, 1)));
    await giveDisplay(db, (await rowsOf(db, alice.id))[0]!.id);
    await giveUserQuota(db, alice.id, 600);
    const ok = await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, idn.id, 500, 2)));
    expect(ok.outcome).toBe("replaced");
    expect((await readSpaceUsage(db, { kind: "user", id: alice.id }))!.usedBytes).toBe(500);
    // 用量 500、額度 600：新原圖 700 → 差額 +200，500+200 > 600
    await expect(db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, idn.id, 700, 3)))).rejects.toBeInstanceOf(StorageQuotaExceeded);
  });

  it("每句 UPDATE 都限定 user_id／identity_id：bob 有同形候選時不受影響", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const aIdn = await seedIdentity(db, alice.id);
    const bIdn = await seedIdentity(db, bob.id);
    await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, aIdn.id, 100, 1)));
    await db.transaction(tx => replaceOidcAvatarInTx(tx, input(bob.id, bIdn.id, 100, 1)));
    const bobBefore = (await rowsOf(db, bob.id))[0]!;
    await db.transaction(tx => replaceOidcAvatarInTx(tx, input(alice.id, aIdn.id, 200, 2, "https://img.example/b.png")));
    expect((await rowsOf(db, bob.id))[0]).toEqual(bobBefore);
    const [other] = await db.select({ n: userAvatars.version }).from(userAvatars).where(and(eq(userAvatars.userId, bob.id), eq(userAvatars.identityId, bIdn.id)));
    expect(other!.n).toBe(1);
  });
});
