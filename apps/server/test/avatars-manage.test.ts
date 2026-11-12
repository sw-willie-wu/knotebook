/**
 * 頭貼候選的管理：重新裁切（PUT …/:id/display）、選用（PUT /api/auth/avatar）、刪除（DELETE …/:id）、本人讀原圖（GET …/:id/original）。
 * 全部走真路由與真交易；並發案用 `avatarTestHooks.afterUserLock` 把第一條請求停在持有 users 列鎖之後。
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { userAvatars, userIdentities, users } from "../src/db/schema.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { giveUserQuota, pngOf } from "./storage-helpers.js";
import { DEFAULT_CROP, recropAvatar, seedAvatarRow, uploadAvatar, webpOf } from "./avatar-helpers.js";

type Ctx = Awaited<ReturnType<typeof buildTestApp>>;

const rowsOf = async (db: Ctx["db"], userId: string) =>
  db.select().from(userAvatars).where(eq(userAvatars.userId, userId)).orderBy(asc(userAvatars.createdAt), asc(userAvatars.id));

const rowOf = async (db: Ctx["db"], id: string) => {
  const [row] = await db.select().from(userAvatars).where(eq(userAvatars.id, id));
  return row;
};

const usedBytes = async (db: Ctx["db"], userId: string): Promise<number> => (await readSpaceUsage(db, { kind: "user", id: userId }))!.usedBytes;

const select = async (app: Ctx["app"], userId: string, body: unknown) =>
  app.inject({ method: "PUT", url: "/api/auth/avatar", payload: body as object, cookies: await cookieOf(userId) });

const remove = async (app: Ctx["app"], userId: string, id: string) =>
  app.inject({ method: "DELETE", url: `/api/auth/avatars/${id}`, cookies: await cookieOf(userId) });

const readOriginal = async (app: Ctx["app"], userId: string, id: string) =>
  app.inject({ method: "GET", url: `/api/auth/avatars/${id}/original`, cookies: await cookieOf(userId) });

/** 真路由上傳一張；回列 id。 */
async function uploaded(app: Ctx["app"], userId: string, opts: Parameters<typeof uploadAvatar>[2] = {}): Promise<string> {
  const res = await uploadAvatar(app, userId, opts);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

const NEW_CROP = { x: 1, y: 2, size: 30, width: 200, height: 150 };

function logCollector() {
  const out: string[] = [];
  return { out, logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } };
}

const levels = (out: string[]): number[] => out.map(line => (JSON.parse(line) as { level: number }).level);

describe("PUT /api/auth/avatars/:id/display：重新裁切", () => {
  it("200 回更新後的候選；version + 1、crop、原圖寬高與顯示圖都換掉；原圖檔與目前頭貼旗標不動；/me 立刻是新版本", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const before = (await rowOf(db, id))!;
    const cookies = await cookieOf(alice.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar).toEqual({ id, v: 1, pending: false });

    const display = webpOf(500);
    const res = await recropAvatar(app, alice.id, id, { display, crop: NEW_CROP, version: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      avatar: { id, v: 2 },
      pending: false,
      current: true,
      crop: { x: 1, y: 2, size: 30 },
      originalWidth: 200,
      originalHeight: 150,
      originalSize: before.originalSize,
      displaySize: 500,
    });
    const after = (await rowOf(db, id))!;
    expect(after).toMatchObject({ version: 2, cropX: 1, cropY: 2, cropSize: 30, originalWidth: 200, originalHeight: 150, displaySize: 500, displayMime: "image/webp", isCurrent: true });
    expect(Buffer.compare(after.displayData!, display)).toBe(0);
    expect(after.originalFile).toBe(before.originalFile);
    expect(await readdir(uploadsDir)).toEqual([before.originalFile]);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar).toEqual({ id, v: 2, pending: false });
  });

  it("待補顯示圖的 OIDC 候選也能補產：pending 變 false，用量多出整張顯示圖", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await seedAvatarRow(db, { userId: alice.id, originalSize: 700, displaySize: 0 });
    expect(await usedBytes(db, alice.id)).toBe(700);
    const res = await recropAvatar(app, alice.id, id, { display: webpOf(400), crop: NEW_CROP, version: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ source: "oidc", pending: false, displaySize: 400, avatar: { id, v: 2 } });
    expect(await usedBytes(db, alice.id)).toBe(1100);
  });

  it("用量只算差額：變小一定成功（即使配額已滿）；變大超過剩餘空間 → 409 且 DB 不變；剛好放得下 → 200", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id, { original: pngOf(2000), display: webpOf(300) });
    await giveUserQuota(db, alice.id, 2300);
    expect(await usedBytes(db, alice.id)).toBe(2300);

    const grow = await recropAvatar(app, alice.id, id, { display: webpOf(301), version: 1 });
    expect(grow.statusCode, grow.body).toBe(409);
    expect(grow.json().error.code).toBe("storage_quota_exceeded");
    expect(grow.json().storage).toEqual({ incomingBytes: 1, usedBytes: 2300, quotaBytes: 2300 });
    expect(await rowOf(db, id)).toMatchObject({ version: 1, displaySize: 300 });

    const shrink = await recropAvatar(app, alice.id, id, { display: webpOf(100), version: 1 });
    expect(shrink.statusCode, shrink.body).toBe(200);
    expect(await usedBytes(db, alice.id)).toBe(2100);

    const fits = await recropAvatar(app, alice.id, id, { display: webpOf(300), version: 2 });
    expect(fits.statusCode, fits.body).toBe(200);
    const over = await recropAvatar(app, alice.id, id, { display: webpOf(301), version: 3 });
    expect(over.statusCode).toBe(409);
    expect(over.json().storage.incomingBytes).toBe(1);
    expect(await rowOf(db, id)).toMatchObject({ version: 3, displaySize: 300 });
  });

  it("version 不符 → 409 avatar_outdated，DB 不變；version 缺、非正整數或超過 int4 → 400", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const before = (await rowOf(db, id))!;

    const stale = await recropAvatar(app, alice.id, id, { display: webpOf(500), crop: NEW_CROP, version: 2 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe("avatar_outdated");
    const after = (await rowOf(db, id))!;
    expect(after.version).toBe(1);
    expect(after.displaySize).toBe(before.displaySize);
    expect(Buffer.compare(after.displayData!, before.displayData!)).toBe(0);
    expect(after.cropX).toBe(before.cropX);

    for (const [label, version] of [["缺", null], ["0", 0], ["負數", -1], ["小數", "1.5"], ["字串", "abc"], ["超過 int4", "2147483648"], ["前導零", "01"]] as const) {
      const res = await recropAvatar(app, alice.id, id, { version });
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expect(res.json().error.code, label).toBe("invalid_body");
    }
    expect((await rowOf(db, id))!.version).toBe(1);
  });

  it("格式驗證同上傳：缺 display／crop、crop 壞或寬度超過 int4 → 400；GIF 或文字當顯示圖 → 415；顯示圖過大 → 413；都不動 DB", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const before = (await rowOf(db, id))!;
    const bad: Array<[string, Parameters<typeof recropAvatar>[3], number]> = [
      ["缺 display", { display: null }, 400],
      ["缺 crop", { crop: null }, 400],
      ["crop 越界", { crop: { ...DEFAULT_CROP, x: DEFAULT_CROP.width } }, 400],
      ["crop 不是 JSON", { crop: "nope" }, 400],
      ["寬度超過 int4 上限", { crop: { x: 0, y: 0, size: 10, width: 2 ** 31, height: 100 } }, 400],
      ["GIF 顯示圖", { display: Buffer.from("GIF89a-not-an-avatar") }, 415],
      ["文字當顯示圖", { display: Buffer.from("just text, not an image at all") }, 415],
      ["顯示圖過大", { display: webpOf(262_145) }, 413],
      ["顯示圖遠大於上限但小於站台上傳上限", { display: webpOf(1_000_000) }, 413],
    ];
    for (const [label, opts, status] of bad) {
      const res = await recropAvatar(app, alice.id, id, opts);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(status);
    }
    const after = (await rowOf(db, id))!;
    expect(after.version).toBe(before.version);
    expect(Buffer.compare(after.displayData!, before.displayData!)).toBe(0);
  });
});

describe("頭貼候選 id 的歸屬：他人、不存在、格式不對一律同形 404", () => {
  it("重新裁切、刪除、讀原圖：bob 的候選、不存在的 uuid、not-a-uuid 的 404 逐字相同；bob 的列與檔不動", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobsId = await uploaded(app, bob.id);
    const bobsBefore = (await rowOf(db, bobsId))!;
    const ghost = "00000000-0000-4000-8000-000000000000";

    const run = {
      recrop: (id: string) => recropAvatar(app, alice.id, id, { display: webpOf(500), crop: NEW_CROP, version: 1 }),
      remove: (id: string) => remove(app, alice.id, id),
      original: (id: string) => readOriginal(app, alice.id, id),
    };
    for (const [name, fn] of Object.entries(run)) {
      const others = await fn(bobsId);
      const missing = await fn(ghost);
      const malformed = await fn("not-a-uuid");
      expect(others.statusCode, name).toBe(404);
      expect(others.json().error.code, name).toBe("not_found");
      expect(missing.body, name).toBe(others.body);
      expect(malformed.body, name).toBe(others.body);
      expect(missing.statusCode, name).toBe(404);
      expect(malformed.statusCode, name).toBe(404);
    }
    // 版本不符也不能讓別人的候選露出 409：歸屬先於版本檢查。
    const staleOthers = await recropAvatar(app, alice.id, bobsId, { display: webpOf(500), crop: NEW_CROP, version: 7 });
    const staleMissing = await recropAvatar(app, alice.id, ghost, { display: webpOf(500), crop: NEW_CROP, version: 7 });
    expect(staleOthers.statusCode).toBe(404);
    expect(staleOthers.body).toBe(staleMissing.body);
    const bobsAfter = (await rowOf(db, bobsId))!;
    expect(bobsAfter).toEqual(bobsBefore);
    expect(await readdir(uploadsDir)).toEqual([bobsBefore.originalFile]);
  });

  it("大寫的 uuid 可用（重新裁切、讀原圖、刪除）", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const upper = id.toUpperCase();
    expect((await readOriginal(app, alice.id, upper)).statusCode).toBe(200);
    expect((await recropAvatar(app, alice.id, upper, { version: 1 })).statusCode).toBe(200);
    expect((await remove(app, alice.id, upper)).statusCode).toBe(204);
    expect(await rowsOf(db, alice.id)).toEqual([]);
  });
});

describe("PUT /api/auth/avatar：選用", () => {
  it("200 回新的 UserDto（不是 60 秒前的快取）；目標是目前頭貼、舊的不是；avatar_auto 關掉", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobsAvatar = await uploaded(app, bob.id);
    const first = await uploaded(app, alice.id);
    const second = await uploaded(app, alice.id, { original: pngOf(2500) });
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));
    const cookies = await cookieOf(alice.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar.id).toBe(second);

    const res = await select(app, alice.id, { candidateId: first });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().id).toBe(alice.id);
    expect(res.json().avatar).toEqual({ id: first, v: 1, pending: false });
    const rows = await rowsOf(db, alice.id);
    expect(rows.map(r => [r.id, r.isCurrent])).toEqual([[first, true], [second, false]]);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar.id).toBe(first);

    const again = await select(app, alice.id, { candidateId: first.toUpperCase() });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().avatar.id).toBe(first);
    // 旁觀者的目前頭貼不受影響。
    expect((await rowOf(db, bobsAvatar))!.isCurrent).toBe(true);
  });

  it("candidateId 為 null → avatar 為 null、候選都還在、都不是目前；avatar_auto 關掉", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobsAvatar = await uploaded(app, bob.id);
    await uploaded(app, alice.id);
    await uploaded(app, alice.id, { original: pngOf(2500) });
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));
    const res = await select(app, alice.id, { candidateId: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().avatar).toBeNull();
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.isCurrent)).toEqual([]);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(false);
    expect((await rowOf(db, bobsAvatar))!.isCurrent).toBe(true);
  });

  it("選 bob 的候選或不存在的 id → 404，alice 原本的目前頭貼與 avatar_auto 都不變（整筆回滾）", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const mine = await uploaded(app, alice.id);
    const bobsId = await uploaded(app, bob.id);
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));

    for (const target of [bobsId, "00000000-0000-4000-8000-000000000000"]) {
      const res = await select(app, alice.id, { candidateId: target });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows.map(r => [r.id, r.isCurrent])).toEqual([[mine, true]]);
    expect((await rowOf(db, bobsId))!.isCurrent).toBe(true);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(true);
  });

  it("body 不合 → 400 invalid_body（缺欄位、非 uuid、多餘欄位、非物件）", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const mine = await uploaded(app, alice.id);
    for (const body of [{}, { candidateId: "x" }, { candidateId: 5 }, { candidateId: mine, extra: 1 }, [mine]]) {
      const res = await select(app, alice.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect((await rowOf(db, mine))!.isCurrent).toBe(true);
  });
});

describe("DELETE /api/auth/avatars/:id：刪除", () => {
  it("刪非目前的候選：204；列與原圖檔消失；用量減掉原圖加顯示圖；avatar_auto 不變；目前頭貼不動", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const old = await uploaded(app, alice.id, { original: pngOf(1000), display: webpOf(200) });
    const current = await uploaded(app, alice.id, { original: pngOf(2000), display: webpOf(300) });
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));
    const oldFile = (await rowOf(db, old))!.originalFile;
    const currentFile = (await rowOf(db, current))!.originalFile;
    expect(await usedBytes(db, alice.id)).toBe(3500);

    const res = await remove(app, alice.id, old);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe("");
    expect(await rowOf(db, old)).toBeUndefined();
    expect(await readdir(uploadsDir)).toEqual([currentFile]);
    expect(oldFile).not.toBe(currentFile);
    expect(await usedBytes(db, alice.id)).toBe(2300);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(true);
    expect((await rowOf(db, current))!.isCurrent).toBe(true);
  });

  it("刪目前的那張：之後 avatar 為 null、avatar_auto 關掉、其他候選不會被自動選用；/me 立刻反映", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const a = await uploaded(app, alice.id);
    const b = await uploaded(app, alice.id, { original: pngOf(2200) });
    const c = await uploaded(app, alice.id, { original: pngOf(2400) });
    await db.update(users).set({ avatarAuto: true }).where(eq(users.id, alice.id));
    const cookies = await cookieOf(alice.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar.id).toBe(c);

    expect((await remove(app, alice.id, c)).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).json().avatar).toBeNull();
    const rows = await rowsOf(db, alice.id);
    expect(rows.map(r => [r.id, r.isCurrent])).toEqual([[a, false], [b, false]]);
    const [{ avatarAuto }] = await db.select({ avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, alice.id));
    expect(avatarAuto).toBe(false);
  });

  it("刪 OIDC 候選：該身分的 picture_dismissed_url 記下該列的圖片網址；bob 的身分列與候選不變；候選指到別人的身分列時也不動別人的列", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const identity = async (userId: string) => {
      const [row] = await db.insert(userIdentities).values({ userId, issuer: "https://sso.example", sub: `sub-${Math.random()}`, lastPictureUrl: "https://pics.example/x.png" }).returning({ id: userIdentities.id });
      return row!.id;
    };
    const aliceIdentity = await identity(alice.id);
    const bobIdentity = await identity(bob.id);
    const mine = await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0, identityId: aliceIdentity });
    const bobsCandidate = await seedAvatarRow(db, { userId: bob.id, originalSize: 80, displaySize: 0, identityId: bobIdentity });
    const dismissedOf = async (id: string) => (await db.select({ u: userIdentities.pictureDismissedUrl }).from(userIdentities).where(eq(userIdentities.id, id)))[0]!.u;
    const urlOf = async (id: string) => (await rowOf(db, id))!.oidcPictureUrl;
    const expected = await urlOf(mine);
    expect(expected).toMatch(/^https:\/\/idp\.example\.com\/pic\//);

    expect((await remove(app, alice.id, mine)).statusCode).toBe(204);
    expect(await dismissedOf(aliceIdentity)).toBe(expected);
    expect(await dismissedOf(bobIdentity)).toBeNull();
    expect(await rowOf(db, bobsCandidate)).toBeDefined();

    // 不該出現的資料：alice 的候選掛著 bob 的身分。刪它不能改到 bob 的身分列。
    // 一個身分至多一張候選（部分唯一索引）：bob 的候選先拿掉才放得進去。
    await db.delete(userAvatars).where(eq(userAvatars.id, bobsCandidate));
    const strayId = await seedAvatarRow(db, { userId: alice.id, originalSize: 90, displaySize: 0, identityId: bobIdentity });
    expect((await remove(app, alice.id, strayId)).statusCode).toBe(204);
    expect(await dismissedOf(bobIdentity)).toBeNull();
  });

  it("上傳來源的候選刪除不碰任何身分列", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const [ident] = await db.insert(userIdentities).values({ userId: alice.id, issuer: "https://sso.example", sub: "s1", lastPictureUrl: "https://pics.example/y.png" }).returning({ id: userIdentities.id });
    const id = await uploaded(app, alice.id);
    expect((await remove(app, alice.id, id)).statusCode).toBe(204);
    const [row] = await db.select({ u: userIdentities.pictureDismissedUrl }).from(userIdentities).where(eq(userIdentities.id, ident!.id));
    expect(row!.u).toBeNull();
  });

  it("刪除後檔案已不在磁碟：仍 204，log 只有 warn（沒有 error）", async () => {
    const { out, logger } = logCollector();
    const { app, db, uploadsDir } = await buildTestApp({}, { logger });
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const file = (await rowOf(db, id))!.originalFile;
    await rm(path.join(uploadsDir, file));
    out.length = 0;

    const res = await remove(app, alice.id, id);
    expect(res.statusCode, res.body).toBe(204);
    expect(await rowOf(db, id)).toBeUndefined();
    const seen = levels(out.filter(line => line.includes(file)));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(l => l === 40)).toBe(true);
    expect(levels(out).filter(l => l >= 50)).toEqual([]);
    await app.close();
  });
});

describe("GET /api/auth/avatars/:id/original：本人讀原圖", () => {
  it("200、位元組相等；content-type 是存的偵測值，另有 nosniff、CSP sandbox、private no-cache", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const original = pngOf(1800);
    const id = await uploaded(app, alice.id, { original });
    const res = await readOriginal(app, alice.id, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(Buffer.compare(res.rawPayload, original)).toBe(0);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toBe("private, no-cache");
  });

  it("bob 讀 alice 的原圖 → 404", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const id = await uploaded(app, alice.id);
    expect((await readOriginal(app, bob.id, id)).statusCode).toBe(404);
  });

  it("列在、檔不在磁碟 → 404，log 記一筆 warn（不帶檔案路徑）", async () => {
    const { out, logger } = logCollector();
    const { app, db, uploadsDir } = await buildTestApp({}, { logger });
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const file = (await rowOf(db, id))!.originalFile;
    await rm(path.join(uploadsDir, file));
    out.length = 0;
    const res = await readOriginal(app, alice.id, id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    const warns = out.filter(line => (JSON.parse(line) as { level: number }).level === 40);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some(line => line.includes(uploadsDir.replaceAll("\\", "\\\\")) || line.includes(uploadsDir))).toBe(false);
    await app.close();
  });

  it("OIDC 候選還沒補產顯示圖、原圖檔也不在 → 404（不丟 500）", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0 });
    expect((await readOriginal(app, alice.id, id)).statusCode).toBe(404);
  });
});

describe("同一人的並發寫入", () => {
  function held() {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let firstIn!: () => void;
    const firstEntered = new Promise<void>(r => (firstIn = r));
    return {
      get entered() {
        return entered;
      },
      release: () => release(),
      firstEntered,
      hooks: {
        afterUserLock: async () => {
          entered++;
          if (entered === 1) {
            firstIn();
            await gate;
          }
        },
      },
    };
  }

  it("上傳持 users 列鎖暫停時，同一人的選用被擋住；放行後選用生效，最後恰一張目前頭貼", async () => {
    const h = held();
    const { app, db } = await buildTestApp({ avatarTestHooks: h.hooks });
    const alice = await seedUser(db);
    // 用 seed 直插：hook 的第一次進入要留給接下來的上傳。
    const seeded = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    let pending: Array<Promise<unknown>> = [];
    try {
      const up = uploadAvatar(app, alice.id, { original: pngOf(1500) });
      pending.push(up);
      await h.firstEntered;
      const sel = select(app, alice.id, { candidateId: seeded });
      pending.push(sel);
      expect(await waitForBlockedOrSettled(db.$client, sel)).toBe("blocked");
      expect(h.entered).toBe(1);
      h.release();
      const [ru, rs] = await Promise.all([up, sel]);
      pending = [];
      expect(ru.statusCode, ru.body).toBe(201);
      expect(rs.statusCode, rs.body).toBe(200);
    } finally {
      h.release();
      await Promise.allSettled(pending);
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.isCurrent)).toHaveLength(1);
    // 選用排在上傳之後，所以最後的目前頭貼是被選用的那張。
    expect(rows.find(r => r.isCurrent)!.id).toBe(seeded);
  });

  it("上傳持 users 列鎖暫停時，同一人的重新裁切被擋住；放行後兩條都完成", async () => {
    const h = held();
    const { app, db } = await buildTestApp({ avatarTestHooks: h.hooks });
    const alice = await seedUser(db);
    const seeded = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    let pending: Array<Promise<unknown>> = [];
    try {
      const up = uploadAvatar(app, alice.id, { original: pngOf(1500) });
      pending.push(up);
      await h.firstEntered;
      const recrop = recropAvatar(app, alice.id, seeded, { display: webpOf(500), crop: NEW_CROP, version: 1 });
      pending.push(recrop);
      expect(await waitForBlockedOrSettled(db.$client, recrop)).toBe("blocked");
      expect(h.entered).toBe(1);
      h.release();
      const [ru, rr] = await Promise.all([up, recrop]);
      pending = [];
      expect(ru.statusCode, ru.body).toBe(201);
      expect(rr.statusCode, rr.body).toBe(200);
    } finally {
      h.release();
      await Promise.allSettled(pending);
    }
    expect((await rowOf(db, seeded))!.version).toBe(2);
    expect(await rowsOf(db, alice.id)).toHaveLength(2);
  });

  it("上傳持 users 列鎖暫停時，同一人的刪除被擋住；放行後兩條都完成", async () => {
    const h = held();
    const { app, db } = await buildTestApp({ avatarTestHooks: h.hooks });
    const alice = await seedUser(db);
    const seeded = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    let pending: Array<Promise<unknown>> = [];
    try {
      const up = uploadAvatar(app, alice.id, { original: pngOf(1500) });
      pending.push(up);
      await h.firstEntered;
      const del = remove(app, alice.id, seeded);
      pending.push(del);
      expect(await waitForBlockedOrSettled(db.$client, del)).toBe("blocked");
      expect(h.entered).toBe(1);
      h.release();
      const [ru, rd] = await Promise.all([up, del]);
      pending = [];
      expect(ru.statusCode, ru.body).toBe(201);
      expect(rd.statusCode, rd.body).toBe(204);
    } finally {
      h.release();
      await Promise.allSettled(pending);
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(seeded);
    expect(rows[0]!.isCurrent).toBe(true);
  });

  it("兩個選用互相等待：後拿到鎖的生效，兩條都 200，最後恰一張目前頭貼", async () => {
    const h = held();
    const { app, db } = await buildTestApp({ avatarTestHooks: h.hooks });
    const alice = await seedUser(db);
    const x = await seedAvatarRow(db, { userId: alice.id, originalSize: 900, displaySize: 100, isCurrent: true });
    const y = await seedAvatarRow(db, { userId: alice.id, originalSize: 800, displaySize: 100 });
    const z = await seedAvatarRow(db, { userId: alice.id, originalSize: 700, displaySize: 100 });
    let pending: Array<Promise<unknown>> = [];
    try {
      const first = select(app, alice.id, { candidateId: y });
      pending.push(first);
      await h.firstEntered;
      const second = select(app, alice.id, { candidateId: z });
      pending.push(second);
      expect(await waitForBlockedOrSettled(db.$client, second)).toBe("blocked");
      h.release();
      const [r1, r2] = await Promise.all([first, second]);
      pending = [];
      expect(r1.statusCode, r1.body).toBe(200);
      expect(r2.statusCode, r2.body).toBe(200);
    } finally {
      h.release();
      await Promise.allSettled(pending);
    }
    const rows = await rowsOf(db, alice.id);
    expect(rows.filter(r => r.isCurrent).map(r => r.id)).toEqual([z]);
    expect(rows.map(r => r.id).sort()).toEqual([x, y, z].sort());
  });
});

describe("頭貼管理端點的存取界線", () => {
  it("未登入 401、只帶 Bearer（API token）401；跨源 Origin 的重新裁切 403；都不動資料", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const id = await uploaded(app, alice.id);
    const before = (await rowOf(db, id))!;
    const { token } = await seedTokenForUser(db, alice.id);
    for (const headers of [{}, bearer(token)]) {
      const label = Object.keys(headers).length === 0 ? "未登入" : "Bearer";
      expect((await recropAvatar(app, alice.id, id, { cookies: null, headers })).statusCode, `${label} recrop`).toBe(401);
      expect((await app.inject({ method: "PUT", url: "/api/auth/avatar", payload: { candidateId: null }, headers })).statusCode, `${label} select`).toBe(401);
      expect((await app.inject({ method: "DELETE", url: `/api/auth/avatars/${id}`, headers })).statusCode, `${label} delete`).toBe(401);
      expect((await app.inject({ method: "GET", url: `/api/auth/avatars/${id}/original`, headers })).statusCode, `${label} original`).toBe(401);
    }
    const cross = await recropAvatar(app, alice.id, id, { headers: { origin: "https://evil.example" } });
    expect(cross.statusCode).toBe(403);
    expect(await rowOf(db, id)).toEqual(before);
  });
});
