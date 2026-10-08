/**
 * 儲存配額的並發案（spec 2026-10-08 §11.2 R1–R6、R13；R10–R12 在檔尾。R7–R9 是既有案的重驗、不在本檔：
 * C22（groups-v2-delete-race）、#188（notes-delete-race）、C5（groups-v2-move-race）、C20b（groups-v2-delete-race））。
 * 先手停在 `storage-space-locked`（取得空間鎖、lock_timeout 復原之後）或既有縫，另一方在縫裡發出；`waitForBlockedOrSettled`
 * 回 "blocked" 才證明測到的是交錯。race 一律注入 storageLockTimeoutMs = 60000（spec §5.3 m7）。
 * 另一方從發出到結束的耗時一律 < 10 s：60 s 的空間鎖等待上限之下，「blocked 之後很快完成」分得出「先手放行後立刻輪到」與
 * 「一路等到逾時」；死結（40P01）由 PG 的 deadlock_timeout（預設 1 s）偵測，不受這個上限影響。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { UserGate } from "../src/auth/session.js";
import { createDb, type Db } from "../src/db/index.js";
import { createPool } from "../src/db/pool.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshDb, freshLimiters } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { imageDoc, seedDoc } from "./copy-helpers.js";
import {
  filesIn, giveGroupQuota, giveUserQuota, quotaBody, seedAttachment, seedPlan, upload, usedOf, waitForAdvisoryWaiters,
} from "./storage-helpers.js";

const RACE = { storageLockTimeoutMs: 60_000 };
/** 另一方（在縫裡發出的那筆）從發出到結束的上限；超過＝有人在等 60 s 的 lock_timeout。 */
const OTHER_MAX_MS = 10_000;
const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload });
const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });
const transfer = async (app: FastifyInstance, groupId: string, userId: string, transferTo: string) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "transfer", transferTo } });

interface Holder {
  app?: FastifyInstance;
  db?: Db;
  fired?: boolean;
  other?: Promise<LightMyRequestResponse>;
  /** 另一方從發出到結束的耗時（ms）。 */
  otherMs?: number;
  interleave?: string;
  fire?: () => Promise<LightMyRequestResponse>;
}

/** 測試失敗（斷言丟出）時仍在跑的另一方：afterEach 等它們結束，不讓請求拖進下一案。 */
const pending: Array<Promise<unknown>> = [];
afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
});

/** 先手判斷式 match 為真的那一次 `point`（預設 storage-space-locked）：發 holder.fire()、等 blocked/settled、放行。 */
function raceHook(
  holder: Holder,
  match: (ctx: { noteId?: string; groupId?: string }) => boolean,
  point: GroupRacePoint = "storage-space-locked",
): GroupTestHook {
  return async (p, ctx) => {
    if (p !== point || holder.fired || !match(ctx)) return;
    holder.fired = true;
    const t0 = Date.now();
    holder.other = holder.fire!();
    // 存進 pending 的是 .finally() 衍生的新 promise：另一方 reject 時它也 reject，afterEach 收之前不接 catch 會被記成 unhandled rejection。
    pending.push(holder.other.finally(() => { holder.otherMs = Date.now() - t0; }).catch(() => {}));
    holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.other);
  };
}

/** 案尾共同斷言：交錯真的發生、另一方沒有等到逾時。 */
async function settleOther(holder: Holder): Promise<LightMyRequestResponse> {
  const res = await holder.other!;
  expect(holder.interleave).toBe("blocked");
  expect(holder.otherMs!).toBeLessThan(OTHER_MAX_MS);
  return res;
}

describe("R1 並發上傳搶配額", () => {
  it("確定性版：第一筆停在縫上時第二筆 blocked；第一筆 201、第二筆以第一筆 commit 後的 SUM 判定 → 409（三數）", async () => {
    const holder: Holder = {};
    const { app, db } = await buildTestApp({ ...RACE, groupTestHook: raceHook(holder, () => true) });
    Object.assign(holder, { app, db });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 1000);
    const n = await seedNote(db, { ownerId: u.id });
    holder.fire = () => upload(app, n.id, u.id, 600);
    const first = await upload(app, n.id, u.id, 600);
    const second = await settleOther(holder);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
  });

  it("剩 500、20 個並發各 100 → 恰 5 個 201；終態 SUM = quota；磁碟恰多 5 個檔", async () => {
    // 縫上的窗口：持鎖者停到「本庫有連線在等 advisory 鎖」或 300 ms。正常碼下其餘請求排在鎖上、持鎖者幾乎不停；空間鎖若
    // 失效，沒有人等 advisory 鎖，同時在交易裡的每一筆都在縫上停滿 300 ms、各自讀到舊 SUM → 超賣。沒有這個窗口時，拿掉空間鎖
    // （突變 M1）本機 5/5 次仍不超賣（交易太短、自然交錯碰不到）。
    // 配額 500（不是 spec 字面的 1000）：app 的 pool 預設 10 條，同時在交易裡的至多 10 筆；配額恰為 10 × 100 時，空間鎖失效下
    // 觀察到的終態也只到 1000＝看不出超賣（其餘 10 筆等連線，實測是等到前 10 筆 commit 後才被 preHandler 預檢擋下）。這是觀察、
    // 不是保證的上界（等連線的請求何時過預檢、何時讀 SUM 看排程）——放得下的筆數取 < 10，讓失效時同時在交易裡的筆數多於放得下的筆數。
    // 探測走獨立的 1 條連線：app 的 pool（預設 10 條）會被停在縫上的交易佔滿，在縫裡借它查 pg_stat_activity 會互等到測試逾時（實測）。
    const probe: { pool?: Pool } = {};
    const built = await buildTestApp({
      ...RACE,
      groupTestHook: async point => { if (point === "storage-space-locked") await waitForAdvisoryWaiters(probe.pool!, 1, 300); },
    });
    const { app, db, uploadsDir } = built;
    probe.pool = new Pool({ connectionString: db.$client.options.connectionString, max: 1 });
    const u = await seedUser(db);
    await giveUserQuota(db, u.id, 500);
    const n = await seedNote(db, { ownerId: u.id });
    const before = await filesIn(uploadsDir);
    const t0 = Date.now();
    let results: LightMyRequestResponse[];
    try {
      results = await Promise.all(Array.from({ length: 20 }, () => upload(app, n.id, u.id, 100)));
    } finally {
      await probe.pool.end();
    }
    expect(Date.now() - t0).toBeLessThan(OTHER_MAX_MS);
    expect(results.filter(r => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter(r => r.statusCode === 409)).toHaveLength(15);
    expect(results.filter(r => r.statusCode === 409).every(r => r.json().error.code === "storage_quota_exceeded")).toBe(true);
    expect(await usedOf(db.$client, { kind: "user", id: u.id })).toBe(500);
    expect((await filesIn(uploadsDir)).length).toBe(before.length + 5);
  });
});

describe("R2 上傳 ∥ 移入同群組（兩序）", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const o = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 1000);
    await giveUserQuota(db, o.id, null);
    const gn = await seedNote(db, { groupId: g.id });
    const pn = await seedNote(db, { ownerId: o.id });
    await seedAttachment(db, uploadsDir, pn.id, o.id, 500);
    return { holder, app, db, o, g, gn, pn };
  }

  it("上傳先持群組空間鎖 → 移入 blocked → 上傳 201（600）→ 移入 409（600+500>1000），筆記仍是個人筆記", async () => {
    let ids: { gn?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.gn));
    ids = { gn: s.gn.id };
    s.holder.fire = () => move(s.app, s.pn.id, s.o.id, s.g.id);
    const up = await upload(s.app, s.gn.id, s.o.id, 600);
    const mv = await settleOther(s.holder);
    expect(up.statusCode, up.body).toBe(201);
    expect(mv.statusCode, mv.body).toBe(409);
    expect(mv.json()).toEqual(quotaBody({ incomingBytes: 500, usedBytes: 600, quotaBytes: 1000 }));
    expect(await usedOf(s.db.$client, { kind: "group", id: s.g.id })).toBe(600);
    const { rows } = await s.db.$client.query("select owner_id, group_id from notes where id = $1", [s.pn.id]);
    expect(rows[0]).toEqual({ owner_id: s.o.id, group_id: null });
  });

  it("移入先持群組空間鎖 → 上傳 blocked → 移入 200（500）→ 上傳 409（500+600>1000）", async () => {
    let ids: { pn?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.pn));
    ids = { pn: s.pn.id };
    s.holder.fire = () => upload(s.app, s.gn.id, s.o.id, 600);
    const mv = await move(s.app, s.pn.id, s.o.id, s.g.id);
    const up = await settleOther(s.holder);
    expect(mv.statusCode, mv.body).toBe(200);
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 500, quotaBytes: 1000 }));
    expect(await usedOf(s.db.$client, { kind: "group", id: s.g.id })).toBe(500);
  });
});

describe("R3 移動持筆記 FOR UPDATE 時上傳同篇", () => {
  it("上傳的顯式 KEY SHARE 被擋（blocked）；移動 commit 後上傳算群組空間 → 群組放不下 → 409（個人空間無上限也沒用）", async () => {
    let ids: { n?: string } = {};
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: raceHook(holder, ctx => ctx.noteId === ids.n, "note-move-locked") });
    Object.assign(holder, { app, db });
    const o = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, 1000);
    await giveUserQuota(db, o.id, null);
    const n = await seedNote(db, { ownerId: o.id });
    await seedAttachment(db, uploadsDir, n.id, o.id, 900);
    ids = { n: n.id };
    holder.fire = () => upload(app, n.id, o.id, 200);
    const mv = await move(app, n.id, o.id, g.id);
    const up = await settleOther(holder);
    expect(mv.statusCode, mv.body).toBe(200);
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json()).toEqual(quotaBody({ incomingBytes: 200, usedBytes: 900, quotaBytes: 1000 }));
    expect(await usedOf(db.$client, { kind: "group", id: g.id })).toBe(900);
  });
});

describe("R4 複製 ∥ 上傳到同一目標空間（兩序）", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const [a, x] = await Promise.all([seedUser(db), seedUser(db)]);
    await giveUserQuota(db, a.id, 1000);
    await giveUserQuota(db, x.id, null);
    const src = await seedNote(db, { ownerId: x.id }, { title: "Src" });
    const att = await seedAttachment(db, uploadsDir, src.id, x.id, 600);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${att}`]));
    await seedShare(db, src.id, a.id, "viewer");
    const an = await seedNote(db, { ownerId: a.id });
    return { holder, app, db, uploadsDir, a, src, an };
  }

  it("複製先持 a 的空間鎖 → 上傳 blocked → 複製 201（600）→ 上傳 409", async () => {
    let ids: { src?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.src));
    ids = { src: s.src.id };
    s.holder.fire = () => upload(s.app, s.an.id, s.a.id, 600);
    const cp = await copy(s.app, s.src.id, s.a.id);
    const up = await settleOther(s.holder);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
    expect(await usedOf(s.db.$client, { kind: "user", id: s.a.id })).toBe(600);
  });

  it("上傳先持 a 的空間鎖 → 複製（已複製完檔）blocked → 上傳 201 → 複製 409、已複製的檔清掉、無副本", async () => {
    let ids: { an?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.an));
    ids = { an: s.an.id };
    s.holder.fire = () => copy(s.app, s.src.id, s.a.id);
    const filesBefore = await filesIn(s.uploadsDir);
    const up = await upload(s.app, s.an.id, s.a.id, 600);
    const cp = await settleOther(s.holder);
    expect(up.statusCode, up.body).toBe(201);
    expect(cp.statusCode, cp.body).toBe(409);
    expect(cp.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
    expect((await filesIn(s.uploadsDir)).length).toBe(filesBefore.length + 1);
    expect((await s.db.$client.query("select count(*)::int n from notes where owner_id = $1", [s.a.id])).rows[0].n).toBe(1);
  });
});

describe("R5 轉移 ∥ 上傳到接收者的個人筆記（兩序；無 40P01）", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveUserQuota(db, b.id, 1000);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 600);
    const bn = await seedNote(db, { ownerId: b.id });
    return { holder, app, db, b, g, bn };
  }

  it("轉移先持 b 的空間鎖 → 上傳 blocked → 轉移 204 → 上傳 409", async () => {
    let ids: { g?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.groupId === ids.g && ctx.noteId === undefined));
    ids = { g: s.g.id };
    s.holder.fire = () => upload(s.app, s.bn.id, s.b.id, 600);
    const tr = await transfer(s.app, s.g.id, s.b.id, s.b.id);
    const up = await settleOther(s.holder);
    expect(tr.statusCode, tr.body).toBe(204);
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
  });

  it("上傳先持 b 的空間鎖 → 轉移（已鎖群組與筆記）blocked → 上傳 201 → 轉移 409 storage_quota_exceeded（不是 server_busy）", async () => {
    let ids: { bn?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.bn));
    ids = { bn: s.bn.id };
    s.holder.fire = () => transfer(s.app, s.g.id, s.b.id, s.b.id);
    const up = await upload(s.app, s.bn.id, s.b.id, 600);
    const tr = await settleOther(s.holder);
    expect(up.statusCode, up.body).toBe(201);
    expect(tr.statusCode, tr.body).toBe(409);
    expect(tr.json()).toEqual(quotaBody({ incomingBytes: 600, usedBytes: 600, quotaBytes: 1000 }));
  });
});

describe("R6 上傳持被轉移群組某篇的 KEY SHARE", () => {
  it("轉移的群組筆記 FOR UPDATE blocked；上傳 201 算群組 → 轉移的 incoming 含它 → 接收者放不下 → 409", async () => {
    let ids: { gn?: string } = {};
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: raceHook(holder, ctx => ctx.noteId === ids.gn) });
    Object.assign(holder, { app, db });
    const b = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, null);
    await giveUserQuota(db, b.id, 500);
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 300);
    ids = { gn: gn.id };
    holder.fire = () => transfer(app, g.id, b.id, b.id);
    const up = await upload(app, gn.id, b.id, 400);
    const tr = await settleOther(holder);
    expect(up.statusCode, up.body).toBe(201);
    expect(tr.statusCode, tr.body).toBe(409);
    expect(tr.json()).toEqual(quotaBody({ incomingBytes: 700, usedBytes: 0, quotaBytes: 500 }));
    expect(await usedOf(db.$client, { kind: "group", id: g.id })).toBe(700);
  });
});

describe("R13 複製→接收者個人空間 ∥ 轉移→同一接收者（Q-S7：空間鎖先於 slug 寫入；兩序都不死結）", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const b = await seedUser(db);
    await giveUserQuota(db, b.id, null);
    const g = await seedGroup(db, "G", [{ userId: b.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: g.id }, { title: "X", slug: "x" });
    await seedAttachment(db, uploadsDir, gn.id, b.id, 10);
    const src = await seedNote(db, { ownerId: b.id }, { title: "X" }); // 副本以標題派生 slug "x"，與轉移那篇撞同一個 (b, x)
    const att = await seedAttachment(db, uploadsDir, src.id, b.id, 10);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${att}`]));
    return { holder, app, db, b, g, src };
  }
  const slugsOf = async (db: Db, ownerId: string) =>
    (await db.$client.query<{ slug: string }>("select slug from notes where owner_id = $1 and slug like 'x%' order by slug", [ownerId])).rows.map(r => r.slug);

  it("轉移先持 b 的空間鎖 → 複製 blocked（在 insertNoteWithAutoSlug 之前）→ 轉移 204、複製 201；slug x 與 x-2", async () => {
    let ids: { g?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.groupId === ids.g && ctx.noteId === undefined));
    ids = { g: s.g.id };
    s.holder.fire = () => copy(s.app, s.src.id, s.b.id);
    const tr = await transfer(s.app, s.g.id, s.b.id, s.b.id);
    const cp = await settleOther(s.holder);
    expect(tr.statusCode, tr.body).toBe(204);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(await slugsOf(s.db, s.b.id)).toEqual(["x", "x-2"]);
  });

  it("複製先持 b 的空間鎖 → 轉移 blocked（在 writeSlugInTx 之前）→ 複製 201、轉移 204", async () => {
    let ids: { src?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.src));
    ids = { src: s.src.id };
    s.holder.fire = () => transfer(s.app, s.g.id, s.b.id, s.b.id);
    const cp = await copy(s.app, s.src.id, s.b.id);
    const tr = await settleOther(s.holder);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(tr.statusCode, tr.body).toBe(204);
    expect(await slugsOf(s.db, s.b.id)).toEqual(["x", "x-2"]);
  });
});

describe("Q-S7 移動形：移入群組 ∥ 複製進同一群組（空間鎖先於群組範圍 slug 寫入；兩序都不死結）", () => {
  async function scene(hookOf: (h: Holder) => GroupTestHook) {
    const holder: Holder = {};
    const { app, db, uploadsDir } = await buildTestApp({ ...RACE, groupTestHook: hookOf(holder) });
    Object.assign(holder, { app, db });
    const o = await seedUser(db);
    await giveUserQuota(db, o.id, null);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    await giveGroupQuota(db, g.id, null);
    const pn = await seedNote(db, { ownerId: o.id }, { title: "Y", slug: "y" }); // 移入時以舊 slug "y" 在群組範圍去重
    await seedAttachment(db, uploadsDir, pn.id, o.id, 10);
    const src = await seedNote(db, { ownerId: o.id }, { title: "Y" }); // 副本以標題派生 slug "y"，與移入那篇撞同一個 (G, y)
    const att = await seedAttachment(db, uploadsDir, src.id, o.id, 10);
    await seedDoc(db, src.id, imageDoc([`/api/uploads/${att}`]));
    return { holder, app, db, o, g, pn, src };
  }
  const groupSlugs = async (db: Db, groupId: string) =>
    (await db.$client.query<{ slug: string }>("select slug from notes where group_id = $1 order by slug", [groupId])).rows.map(r => r.slug);

  it("移入先持群組空間鎖 → 複製 blocked（在 insertNoteWithAutoSlug 之前）→ 移入 200、複製 201；群組 slug y 與 y-2", async () => {
    let ids: { pn?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.pn));
    ids = { pn: s.pn.id };
    s.holder.fire = () => copy(s.app, s.src.id, s.o.id, { groupId: s.g.id });
    const mv = await move(s.app, s.pn.id, s.o.id, s.g.id);
    const cp = await settleOther(s.holder);
    expect(mv.statusCode, mv.body).toBe(200);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(await groupSlugs(s.db, s.g.id)).toEqual(["y", "y-2"]);
  });

  it("複製先持群組空間鎖 → 移入 blocked（在 writeSlugInTx 之前）→ 複製 201、移入 200", async () => {
    let ids: { src?: string } = {};
    const s = await scene(h => raceHook(h, ctx => ctx.noteId === ids.src));
    ids = { src: s.src.id };
    s.holder.fire = () => move(s.app, s.pn.id, s.o.id, s.g.id);
    const cp = await copy(s.app, s.src.id, s.o.id, { groupId: s.g.id });
    const mv = await settleOther(s.holder);
    expect(cp.statusCode, cp.body).toBe(201);
    expect(mv.statusCode, mv.body).toBe(200);
    expect(await groupSlugs(s.db, s.g.id)).toEqual(["y", "y-2"]);
  });
});

/** 管理端兩支指派（使用者方案、群組方案）一起發。 */
const assignBoth = async (app: FastifyInstance, adminId: string, ids: { userId: string; groupId: string }, planId: string) => {
  const cookies = await cookieOf(adminId);
  return Promise.all([
    app.inject({ method: "PATCH", url: `/api/admin/users/${ids.userId}/storage-plan`, cookies, payload: { planId } }),
    app.inject({ method: "PATCH", url: `/api/admin/groups/${ids.groupId}/storage-plan`, cookies, payload: { planId } }),
  ]);
};

describe("R10 指派方案不擋進行中的新增（§6.2：非鍵 UPDATE＝NO KEY UPDATE，與 FK KEY SHARE 互容）", () => {
  // 各案守的性質：
  // - 前兩案（上傳停在縫上）：指派**不取空間鎖**。上傳停在縫上時持的是筆記列 KEY SHARE＋空間 advisory 鎖，還沒 INSERT uploads、
  //   沒有 users／groups 列的鎖——所以這兩案抓不到「指派升成鍵鎖」，只抓得到「指派去取空間鎖」。個人筆記那案守使用者指派、
  //   群組筆記那案守群組指派（上傳的空間是哪一個，就只有那一支指派會撞到它的鎖）。
  // - 第三案（另一連線持 FK KEY SHARE）：指派的 UPDATE 是 **NO KEY UPDATE**（與 FK KEY SHARE 互容），兩支都守。
  // 縫裡只等「blocked 或 settled」、不等兩支指派完成：指派若被上傳交易的鎖擋住（blocked），在縫裡等它完成就是互等到測試逾時。
  async function assignDuringUpload(noteSpace: "user" | "group") {
    const holder: Holder & { both?: Promise<LightMyRequestResponse[]>; ids?: { userId: string; groupId: string }; admin?: string; plan?: string } = {};
    const { app, db } = await buildTestApp({
      ...RACE,
      groupTestHook: async point => {
        if (point !== "storage-space-locked" || holder.fired) return;
        holder.fired = true;
        holder.both = assignBoth(app, holder.admin!, holder.ids!, holder.plan!);
        pending.push(holder.both.catch(() => {}));
        holder.interleave = await waitForBlockedOrSettled(db.$client, holder.both);
      },
    });
    const [admin, o] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    const n = await seedNote(db, noteSpace === "user" ? { ownerId: o.id } : { groupId: g.id });
    Object.assign(holder, { admin: admin.id, ids: { userId: o.id, groupId: g.id }, plan: await giveUserQuota(db, o.id, 10_000) });
    const up = await upload(app, n.id, o.id, 100);
    expect(holder.fired).toBe(true);
    expect(holder.interleave).toBe("settled");
    expect((await holder.both!).map(r => r.statusCode)).toEqual([200, 200]);
    expect(up.statusCode, up.body).toBe(201);
  }

  it("上傳（個人筆記）停在 storage-space-locked 時，管理員改 owner 的方案、改群組方案 → 都 settled（200）", async () => {
    await assignDuringUpload("user");
  });

  it("上傳（群組筆記）停在 storage-space-locked 時，管理員改 owner 的方案、改群組方案 → 都 settled（200）", async () => {
    await assignDuringUpload("group");
  });

  it("另一連線持 users 列與 groups 列的 FK KEY SHARE（未 commit 的 uploads／notes INSERT）時，兩支指派 → settled", async () => {
    const { app, db } = await buildTestApp();
    const [admin, o] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: o.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: o.id });
    const plan = await giveUserQuota(db, o.id, 1);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("insert into uploads (note_id, uploader_id, mime, size) values ($1, $2, 'image/png', 1)", [n.id, o.id]);
      await holder.query("insert into notes (group_id, slug) values ($1, 'held')", [g.id]);
      const both = assignBoth(app, admin.id, { userId: o.id, groupId: g.id }, plan);
      pending.push(both.catch(() => {}));
      expect(await waitForBlockedOrSettled(db.$client, both)).toBe("settled");
      expect((await both).map(r => r.statusCode)).toEqual([200, 200]);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });
});

describe("R11 刪方案 ∥ 指派／改預設（FK 在 DB 端裁決，§7.1）", () => {
  // holder 交易在 finally 一律 rollback（已 commit 時是無害的 WARNING），連線不帶著未結束的交易回 pool。
  it("(a) 另一連線把使用者指派到 P（未 commit）→ 刪 P blocked → 對方 commit → 409 storage_plan_in_use", async () => {
    const { app, db } = await buildTestApp();
    const [admin, u] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db)]);
    const p = await seedPlan(db, "P", 1);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("update users set storage_plan_id = $1 where id = $2", [p, u.id]);
      const del = app.inject({ method: "DELETE", url: `/api/admin/storage-plans/${p}`, cookies: await cookieOf(admin.id) });
      pending.push(del.catch(() => {}));
      expect(await waitForBlockedOrSettled(db.$client, del)).toBe("blocked");
      await holder.query("commit");
      const res = await del;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe("storage_plan_in_use");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });

  it("(b) 另一連線刪 P（未 commit）→ 指派到 P blocked → 對方 commit → 404 storage_plan_not_found", async () => {
    const { app, db } = await buildTestApp();
    const [admin, u] = await Promise.all([seedUser(db, { isAdmin: true }), seedUser(db)]);
    const p = await seedPlan(db, "P", 1);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("delete from storage_plans where id = $1", [p]);
      const asg = app.inject({ method: "PATCH", url: `/api/admin/users/${u.id}/storage-plan`, cookies: await cookieOf(admin.id), payload: { planId: p } });
      pending.push(asg.catch(() => {}));
      expect(await waitForBlockedOrSettled(db.$client, asg)).toBe("blocked");
      await holder.query("commit");
      const res = await asg;
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe("storage_plan_not_found");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });

  it("(c) 另一連線把使用者預設改成 P（未 commit）→ 刪 P blocked（子查詢快照看不到）→ 對方 commit → 409 storage_plan_is_default", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const p = await seedPlan(db, "P", 1);
    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("update site_settings set default_user_storage_plan_id = $1", [p]);
      const del = app.inject({ method: "DELETE", url: `/api/admin/storage-plans/${p}`, cookies: await cookieOf(admin.id) });
      pending.push(del.catch(() => {}));
      expect(await waitForBlockedOrSettled(db.$client, del)).toBe("blocked");
      await holder.query("commit");
      const res = await del;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe("storage_plan_is_default");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });
});

describe("R12 S14 小 pool（max=3、借連線逾時 2 s：違反 S14 表現為 500 而不是卡死）", () => {
  /** app 用 max=3 的獨立 pool；種子與探測走 freshDb 自己的 pool（預設 10 條），不跟 app 搶連線。 */
  async function smallPoolApp(opts: { hook?: GroupTestHook; limiters?: ReturnType<typeof freshLimiters> } = {}) {
    const target = await freshDb();
    const pool = createPool({ databaseUrl: target.url, databasePoolMax: 3, databasePoolConnectionTimeoutMs: 2_000 });
    const db = createDb(pool);
    const built = await buildTestApp({
      db, gate: new UserGate(db), ...RACE,
      ...(opts.hook ? { groupTestHook: opts.hook } : {}),
      ...(opts.limiters ? { limiters: opts.limiters } : {}),
    });
    return { ...built, seedDb: target.db, pool };
  }
  /**
   * 第一個取得空間鎖的交易在縫上等「另外 2 條連線也在等 advisory 鎖」（或 5 s；正常時看到 2 就立刻返回，5 s 只防慢機器上請求晚到造成假紅）——讓 3 條連線同時被交易占住。
   * 看到的等待數記進 `ref.seen`：案尾斷言 2，證明 pool 的 3 條連線真的同時在交易裡（柵欄不是逾時放行的）。
   */
  const barrier = (ref: { pool?: Pool; seen?: number }): GroupTestHook => {
    let first = true;
    return async point => {
      if (point !== "storage-space-locked" || !first) return;
      first = false;
      ref.seen = await waitForAdvisoryWaiters(ref.pool!, 2, 5_000);
    };
  };

  it("max+1 個並發同空間上傳 → 全 201；之後 GET /api/storage 照常", async () => {
    const ref: { pool?: Pool; seen?: number } = {};
    const s = await smallPoolApp({ hook: barrier(ref) });
    ref.pool = s.seedDb.$client;
    try {
      const u = await seedUser(s.seedDb);
      await giveUserQuota(s.seedDb, u.id, null);
      const n = await seedNote(s.seedDb, { ownerId: u.id });
      const rs = await Promise.all(Array.from({ length: 4 }, () => upload(s.app, n.id, u.id, 100)));
      expect(rs.map(r => r.statusCode)).toEqual([201, 201, 201, 201]);
      expect(ref.seen).toBe(2);
      expect((await s.app.inject({ method: "GET", url: "/api/storage", cookies: await cookieOf(u.id) })).statusCode).toBe(200);
    } finally {
      await s.pool.end();
    }
  });

  it("max+1 個並發移入同群組（各有附件）→ 全 200", async () => {
    const ref: { pool?: Pool; seen?: number } = {};
    const s = await smallPoolApp({ hook: barrier(ref) });
    ref.pool = s.seedDb.$client;
    try {
      const o = await seedUser(s.seedDb);
      const g = await seedGroup(s.seedDb, "G", [{ userId: o.id, role: "admin" }]);
      const ns = await Promise.all(Array.from({ length: 4 }, () => seedNote(s.seedDb, { ownerId: o.id })));
      for (const n of ns) await seedAttachment(s.seedDb, s.uploadsDir, n.id, o.id, 10);
      const rs = await Promise.all(ns.map(n => move(s.app, n.id, o.id, g.id)));
      expect(rs.map(r => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(ref.seen).toBe(2);
    } finally {
      await s.pool.end();
    }
  });

  it("一筆大量附件（200 個）的複製：複製在 copyFile 之後、取空間鎖之前（note-copy-files-copied）時發 max+1 筆同空間上傳＋1 筆另一空間上傳 → 都在複製放行前完成、全 201", async () => {
    // I3（spec §6.4 改序）：copyFile 不持空間鎖。上傳從複製自己的縫裡發出，交錯是確定的：正常碼下複製只占 1 條連線、不持空間鎖，
    // 5 筆上傳輪流用剩下 2 條連線、在縫的 4 s 窗口內完成；若複製在 copyFile 前就取了空間鎖（I3 回歸），同空間上傳卡在鎖上占住
    // 那 2 條連線，其餘上傳借連線 2 s 逾時 → 500。
    // copy 依附件數扣 upload 桶（200 張 > 預設 UPLOAD_LIMIT 120）：本案換大桶（形照 test/groups-v2-copy.test.ts 的 freshLimiters({ upload })）。
    const box: { fired?: boolean; done?: boolean; reqs?: Array<Promise<LightMyRequestResponse>>; app?: FastifyInstance; a?: string; other?: string; an?: string; on?: string } = {};
    const hook: GroupTestHook = async point => {
      if (point !== "note-copy-files-copied" || box.fired) return;
      box.fired = true;
      box.reqs = [
        ...Array.from({ length: 4 }, () => upload(box.app!, box.an!, box.a!, 100)),
        upload(box.app!, box.on!, box.other!, 100),
      ];
      for (const r of box.reqs) pending.push(r.catch(() => {}));
      await Promise.race([
        Promise.allSettled(box.reqs).then(() => { box.done = true; }),
        new Promise(r => setTimeout(r, 4_000)),
      ]);
    };
    const s = await smallPoolApp({ hook, limiters: freshLimiters({ upload: new FixedWindowLimiter({ limit: 10_000, windowMs: 600_000 }) }) });
    box.app = s.app;
    try {
      const [a, other] = await Promise.all([seedUser(s.seedDb), seedUser(s.seedDb)]);
      await giveUserQuota(s.seedDb, a.id, null);
      const src = await seedNote(s.seedDb, { ownerId: a.id }, { title: "Big" });
      const ids: string[] = [];
      for (let i = 0; i < 200; i++) ids.push(await seedAttachment(s.seedDb, s.uploadsDir, src.id, a.id, 10));
      await seedDoc(s.seedDb, src.id, imageDoc(ids.map(id => `/api/uploads/${id}`)));
      const an = await seedNote(s.seedDb, { ownerId: a.id });
      const on = await seedNote(s.seedDb, { ownerId: other.id });
      Object.assign(box, { a: a.id, other: other.id, an: an.id, on: on.id });
      const cp = await copy(s.app, src.id, a.id);
      expect(box.fired).toBe(true);
      const ups = await Promise.all(box.reqs!);
      expect([cp.statusCode, ...ups.map(r => r.statusCode)]).toEqual([201, 201, 201, 201, 201, 201]);
      expect(box.done).toBe(true);
    } finally {
      await s.pool.end();
    }
  });
});
