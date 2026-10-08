/**
 * 儲存配額的並發案（spec 2026-10-08 §11.2 R1–R6、R13；R7–R12 在檔尾，Task 10）。
 * 先手停在 `storage-space-locked`（取得空間鎖、lock_timeout 復原之後）或既有縫，另一方在縫裡發出；`waitForBlockedOrSettled`
 * 回 "blocked" 才證明測到的是交錯。race 一律注入 storageLockTimeoutMs = 60000（spec §5.3 m7）。
 * 另一方從發出到結束的耗時一律 < 10 s：60 s 的空間鎖等待上限之下，「blocked 之後很快完成」分得出「先手放行後立刻輪到」與
 * 「一路等到逾時」；死結（40P01）由 PG 的 deadlock_timeout（預設 1 s）偵測，不受這個上限影響。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import type { Db } from "../src/db/index.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { imageDoc, seedDoc } from "./copy-helpers.js";
import { filesIn, giveGroupQuota, giveUserQuota, quotaBody, seedAttachment, upload, usedOf, waitForAdvisoryWaiters } from "./storage-helpers.js";

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
    pending.push(holder.other.finally(() => { holder.otherMs = Date.now() - t0; }));
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
    // 配額 500（不是 spec 字面的 1000）：app 的 pool 預設 10 條，同時在交易裡的至多 10 筆；配額恰為 10 × 100 時，就算空間鎖
    // 失效也至多超到 1000＝不超賣（其餘 10 筆等連線、等到前 10 筆 commit 才被 preHandler 預檢擋下）——放得下的筆數必須 < 10。
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
