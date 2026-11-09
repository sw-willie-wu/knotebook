/**
 * bulk transfer spec 2026-11-02 §9.2-8、§9.7；plan PR-2 T9（RN1–RN9）：改名與 `unchanged`／`renamed` 的扣桶規則。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notes, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { deriveTransferKey, hmacOf } from "../src/transfer/base-hash.js";
import { normalizeBody } from "../src/transfer/normalize.js";
import { buildCollabTestApp, testConfig, testEditingRuntime, type CollabTestCtx } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, issueBulkDirect, renameIn, seedBlocks, seedMd } from "./bulk-transfer-helpers.js";

type Opts = Parameters<typeof buildCollabTestApp>[0];
async function scene(opts: Opts = {}, title = "Title") {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title });
  await seedMd(ctx.db, note.id, "Para 0\n\nPara 1\n\nPara 2");
  return { ctx, u, pat, bulk, note };
}
const titleOf = async (ctx: CollabTestCtx, id: string) => (await ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, id)))[0]!.title;
const baseOf = async (ctx: CollabTestCtx, key: string) => (await ctx.db.select().from(transferBases).where(eq(transferBases.key, key)))[0]!;
const one = () => new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });

describe("改名（§9.7）", () => {
  it("RN1 只改 title → 200 renamed、不 mount（判內文動過沒用結構比對，審查 I2）、transferWrite 扣 1、applied_title_sha 寫入；RN2 同檔再送 → unchanged、不扣", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = renameIn(d.text, "New title");
    const m0 = testEditingRuntime.mounts;
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.json()).toMatchObject({ result: "renamed", renamed: true, applied: 0 });
    expect(testEditingRuntime.mounts - m0).toBe(0);
    expect(await titleOf(s.ctx, s.note.id)).toBe("New title");
    expect((await baseOf(s.ctx, d.fm.base!)).appliedTitleSha).not.toBeNull();
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "unchanged", renamed: false });
    // limit 2：RN1 扣 1、RN2 沒扣 → 還剩 1（另一次只改名仍成功），第三次 429
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Third title"))).statusCode).toBe(200);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Fourth title"))).statusCode).toBe(429);
  });

  it("RN3 內容＋改名 → 一次扣、renamed: true、result applied", async () => {
    const transferWrite = one();
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, b => b.replace("Para 1", "x")), "Both"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", renamed: true });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Both");
  });

  it("RN4 ownership_changed（renameHook 在 UPDATE 前把筆記移進群組）→ 200、renamed: false＋renameFailed、不寫 applied_title_sha；移回後同檔重送會重試並 renamed", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ slugUpdateTestHook: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } });
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = async () => { await s.ctx.db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, s.note.id)); };
    const text = renameIn(d.text, "Moved title");
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ renamed: false, renameFailed: "ownership_changed" });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
    expect((await baseOf(s.ctx, d.fm.base!)).appliedTitleSha).toBeNull();
    await s.ctx.db.update(notes).set({ ownerId: s.u.id, groupId: null }).where(eq(notes.id, s.note.id));
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "renamed", renamed: true });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Moved title");
  });

  it("RN5a gone（合併記錄後、改名前移進垃圾桶）→ 200、renameFailed gone", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ editingTestHooks: { afterRecord: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = async () => { await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, s.note.id)); };
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, b => b.replace("Para 1", "x")), "Gone title"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ renamed: false, renameFailed: "gone" });
  });

  it("RN5b 只改名、改名時已進垃圾桶 → 404", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ slugUpdateTestHook: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = async () => { await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, s.note.id)); };
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Gone only"))).statusCode).toBe(404);
  });

  it("RN6 改名後把 title 改回原值再送（同一份 base）→ 改名（比 applied_title_sha，不是下載時的）", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Changed"))).json()).toMatchObject({ result: "renamed" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, d.text);
    expect(r.json()).toMatchObject({ result: "renamed" });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
  });

  it("RN7 特殊字元的標題原樣重送 → 不觸發改名", async () => {
    for (const title of ['a"b', "back\\slash", "it's", "# hash", "key: value", "- dash", "emoji 😀"]) {
      const s = await scene({}, title);
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      expect((await bulkPut(s.ctx.app, s.bulk.token, d.text)).json(), title).toMatchObject({ result: "unchanged", renamed: false });
    }
  });

  it("RN8 not_mergeable 的筆記只改 title → renamed", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Renamed unmergeable"))).json()).toMatchObject({ result: "renamed" });
  });

  it("RN8b（全分支審查 M5）#393 之前下載、mergeable:false 的筆記只改標題 → 409 note_changed、沒改名（讀出格式變了，整篇匯出比對不再相等）", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } });
    const note = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Title" });
    await seedBlocks(s.ctx.db, note.id, [{ type: "paragraph", content: "2*3*4 and 5*6" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, note.id);
    // 造「舊格式匯出」的副本：#393 起讀出會跳脫 `*`；舊版匯出不跳脫。基底的 body_sha 換成舊版本文的雜湊（＝那時下載留下的基底），
    // 檔案本文也是舊版本文（使用者手上的檔）。
    const oldBody = d.body.split("\\*").join("*");
    expect(oldBody, "前提：現行匯出有跳脫").not.toBe(d.body);
    const row = await baseOf(s.ctx, d.fm.base!);
    expect(row.segments, "前提：mergeable:false").toBeNull();
    const key = deriveTransferKey(testConfig.appSecret);
    await s.ctx.db.update(transferBases).set({ bodySha: hmacOf(key, Buffer.from(row.salt), normalizeBody(oldBody)) }).where(eq(transferBases.key, row.key));
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, () => oldBody), "Renamed old copy"));
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { reason: string } }).error.reason).toBe("note_changed");
    expect(await titleOf(s.ctx, note.id)).toBe("Title");
  });

  it("RN9 transferWrite 滿時只改名 → 429、標題未變", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 0, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Blocked"))).statusCode).toBe(429);
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
  });

  it("RN10（第三輪改）合併前別人做了同樣的內文修改 → 不合併、重來時判 note_changed → 409、沒改名（原 T9-M7「重試變零區＋改名」已不存在）", async () => {
    const ref = {} as { ctx: CollabTestCtx };
    let noteRef = "";
    let n = 0;
    const s = await scene({
      limiters: { transferWrite: one() },
      editingTestHooks: {
        beforeMerge: async () => {
          if (noteRef === "" || n++ > 0) return;
          const { humanEdit } = await import("./bulk-transfer-helpers.js");
          await humanEdit(ref.ctx, noteRef, ed => ed.replaceBlocks([ed.document[1]!.id], [{ type: "paragraph", content: "Same" }]));
        },
      },
    });
    ref.ctx = s.ctx;
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    noteRef = s.note.id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, b => b.replace("Para 1", "Same")), "After retry"));
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { reason: string } }).error.reason).toBe("note_changed");
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
  });

  it("RN11（T9-M5）同檔同時兩發只改名 → 只改一次：一發 renamed、一發 unchanged", async () => {
    // 第一發在改名 UPDATE 前停 300 ms：佇列內時第二發只能排隊等；若改名移到佇列外，第二發會在這段時間讀到同一份基底而再改一次。
    let first = true;
    const s = await scene({ slugUpdateTestHook: async () => { if (first) { first = false; await new Promise(r => setTimeout(r, 300)); } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = renameIn(d.text, "Concurrent title");
    const rs = await Promise.all([bulkPut(s.ctx.app, s.bulk.token, text), bulkPut(s.ctx.app, s.bulk.token, text)]);
    expect(rs.map(r => r.statusCode)).toEqual([200, 200]);
    expect(rs.map(r => (r.json() as { result: string }).result).sort()).toEqual(["renamed", "unchanged"]);
    expect(await titleOf(s.ctx, s.note.id)).toBe("Concurrent title");
  });
});
