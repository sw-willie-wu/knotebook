/**
 * 頭貼（`original_size + display_size`）算進個人空間配額的四個加總點，各一案：
 * `readSpaceUsage`、`assertSpaceRoomInTx`、`listSpaceUsage`、`readSpaceUsageByKind`。群組空間不含頭貼。
 */
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";
import { adminApp } from "./helpers/admin-auth.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { giveGroupQuota, giveUserQuota, seedAttachment, seedPlan, setUserPlan, usedOf } from "./storage-helpers.js";
import { seedAvatarRow } from "./avatar-helpers.js";
import { StorageQuotaExceeded, assertSpaceRoomInTx } from "../src/storage/tx/quota.js";
import { listSpaceUsage, readSpaceUsage, readSpaceUsageByKind } from "../src/storage/usage.js";

const opts = { lockTimeoutMs: 60_000 };

describe("頭貼用量算進個人空間", () => {
  it("readSpaceUsage(user)＝附件＋頭貼（original_size＋display_size 逐位元組）；別人的頭貼不算進來", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const n = await seedNote(db, { ownerId: alice.id });
    await seedAttachment(db, uploadsDir, n.id, alice.id, 400);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0 });
    await seedAvatarRow(db, { userId: bob.id, originalSize: 9000, displaySize: 900, isCurrent: true });
    const usage = await readSpaceUsage(db, { kind: "user", id: alice.id });
    expect(usage?.usedBytes).toBe(400 + 5000 + 300 + 70);
    expect(typeof usage?.usedBytes).toBe("number");
    // 只有頭貼的 bob：沒有附件也算
    expect((await readSpaceUsage(db, { kind: "user", id: bob.id }))?.usedBytes).toBe(9900);
  });

  it("群組空間不含頭貼：成員有頭貼、群組用量不變", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, alice.id, 250);
    const before = await readSpaceUsage(db, { kind: "group", id: g.id });
    await seedAvatarRow(db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    const after = await readSpaceUsage(db, { kind: "group", id: g.id });
    expect(before?.usedBytes).toBe(250);
    expect(after?.usedBytes).toBe(250);
    expect((await listSpaceUsage(db, "group")).get(g.id)).toBe(250);
  });

  it("assertSpaceRoomInTx：配額 1000、附件 400、頭貼 500 → 需要 100 通過、101 拋 StorageQuotaExceeded（usedBytes 含頭貼）", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    await giveUserQuota(db, alice.id, 1000);
    const n = await seedNote(db, { ownerId: alice.id });
    await seedAttachment(db, uploadsDir, n.id, alice.id, 400);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 400, displaySize: 100, isCurrent: true });
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: alice.id }, 100, opts));
    const err = await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: alice.id }, 101, opts)).catch(e => e);
    expect(err).toBeInstanceOf(StorageQuotaExceeded);
    expect(err).toMatchObject({ usedBytes: 900, quotaBytes: 1000, incomingBytes: 101 });
  });

  it("assertSpaceRoomInTx：別人的頭貼不佔 alice 的額度", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    await giveUserQuota(db, alice.id, 1000);
    await seedAvatarRow(db, { userId: bob.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "user", id: alice.id }, 1000, opts));
  });

  it("assertSpaceRoomInTx：群組空間的額度不受成員頭貼影響", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 100);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    await db.transaction(tx => assertSpaceRoomInTx(tx, { kind: "group", id: g.id }, 100, opts));
  });

  it("listSpaceUsage(user)：只有頭貼沒有附件的 carol 也在 Map 裡；alice（兩者都有）是相加值；什麼都沒有的 dave 不在", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const carol = await seedUser(db);
    const dave = await seedUser(db);
    const n = await seedNote(db, { ownerId: alice.id });
    await seedAttachment(db, uploadsDir, n.id, alice.id, 400);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 1000, displaySize: 20, isCurrent: true });
    await seedAvatarRow(db, { userId: carol.id, originalSize: 800, displaySize: 60, isCurrent: true });
    // 非目前的候選也佔額度
    await seedAvatarRow(db, { userId: alice.id, originalSize: 300, displaySize: 10, isCurrent: false });
    const m = await listSpaceUsage(db, "user");
    expect(m.get(alice.id)).toBe(1730);
    expect(m.get(carol.id)).toBe(860);
    expect(typeof m.get(carol.id)).toBe("number");
    expect(m.has(dave.id)).toBe(false);
  });

  it("readSpaceUsageByKind：user 的 avatar＝頭貼總和、image 不含頭貼；群組的 avatar 恆 0", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: alice.id });
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, n.id, alice.id, 400);
    await seedAttachment(db, uploadsDir, gn.id, alice.id, 30);
    await seedAvatarRow(db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    await seedAvatarRow(db, { userId: alice.id, originalSize: 70, displaySize: 0 });
    await seedAvatarRow(db, { userId: bob.id, originalSize: 9000, displaySize: 900, isCurrent: true });
    expect(await readSpaceUsageByKind(db, { kind: "user", id: alice.id })).toEqual({ image: 400, audio: 0, video: 0, document: 0, other: 0, avatar: 5370 });
    expect(await readSpaceUsageByKind(db, { kind: "group", id: g.id })).toEqual({ image: 30, audio: 0, video: 0, document: 0, other: 0, avatar: 0 });
    // 只有頭貼的使用者：其他類型 0、avatar 有值
    expect((await readSpaceUsageByKind(db, { kind: "user", id: bob.id })).avatar).toBe(9900);
  });

  it("GET /api/storage：byKind.avatar 有值、各類之和＝usedBytes", async () => {
    const b = await buildTestApp();
    const alice = await seedUser(b.db);
    const n = await seedNote(b.db, { ownerId: alice.id });
    await seedAttachment(b.db, b.uploadsDir, n.id, alice.id, 400);
    await seedAvatarRow(b.db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    const body = (await b.app.inject({ method: "GET", url: "/api/storage", cookies: await cookieOf(alice.id) })).json();
    expect(body.byKind).toEqual({ image: 400, audio: 0, video: 0, document: 0, other: 0, avatar: 5300 });
    expect(body.usedBytes).toBe(5700);
    expect(Object.values(body.byKind as Record<string, number>).reduce((a, x) => a + x, 0)).toBe(body.usedBytes);
  });

  it("GET /api/groups/:id/storage：byKind.avatar 恆 0", async () => {
    const b = await buildTestApp();
    const alice = await seedUser(b.db);
    const g = await seedGroup(b.db, "G", [{ userId: alice.id, role: "admin" }]);
    await seedAvatarRow(b.db, { userId: alice.id, originalSize: 5000, displaySize: 300, isCurrent: true });
    const body = (await b.app.inject({ method: "GET", url: `/api/groups/${g.id}/storage`, cookies: await cookieOf(alice.id) })).json();
    expect(body.byKind.avatar).toBe(0);
    expect(body.usedBytes).toBe(0);
  });

  it("GET /api/admin/users：用量欄含頭貼（只有頭貼的使用者也有值）", async () => {
    const b = await adminApp();
    const carol = await seedUser(b.db);
    await giveUserQuota(b.db, carol.id, 10_000);
    await seedAvatarRow(b.db, { userId: carol.id, originalSize: 800, displaySize: 60, isCurrent: true });
    const list = (await b.app.inject({ method: "GET", url: "/api/admin/users", cookies: b.cookies })).json();
    const row = list.find((r: { id: string }) => r.id === carol.id);
    expect(row.storage.usedBytes).toBe(860);
    expect(row.storage.quotaBytes).toBe(10_000);
    // 附件的現場 SQL 不含頭貼：860 全來自頭貼
    expect(await usedOf(b.db.$client, { kind: "user", id: carol.id })).toBe(0);
  });

  it("GET /api/admin/storage-plans：overQuotaCount 的使用者用量含頭貼（只有頭貼就超額的 carol 算一個；恰好等於上限的 bob 不算；目前頭貼未超額、加上非目前候選才超額的 eve 算一個）", async () => {
    const b = await adminApp();
    const carol = await seedUser(b.db);
    const bob = await seedUser(b.db);
    const plan = await seedPlan(b.db, "Small", 1000);
    await setUserPlan(b.db, carol.id, plan);
    await setUserPlan(b.db, bob.id, plan);
    await seedAvatarRow(b.db, { userId: carol.id, originalSize: 900, displaySize: 101, isCurrent: true });
    await seedAvatarRow(b.db, { userId: bob.id, originalSize: 900, displaySize: 100, isCurrent: true });
    // eve 的目前頭貼 500 未超額，加上非目前的候選 501 才超額
    const eve = await seedUser(b.db);
    await setUserPlan(b.db, eve.id, plan);
    await seedAvatarRow(b.db, { userId: eve.id, originalSize: 400, displaySize: 100, isCurrent: true });
    await seedAvatarRow(b.db, { userId: eve.id, originalSize: 400, displaySize: 101, isCurrent: false });
    const plans = (await b.app.inject({ method: "GET", url: "/api/admin/storage-plans", cookies: b.cookies })).json().plans;
    expect(plans.find((x: { id: string }) => x.id === plan)).toMatchObject({ userCount: 3, overQuotaCount: 2 });
  });
});
