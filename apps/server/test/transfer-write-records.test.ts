/**
 * bulk transfer spec 2026-11-02 §9.5 第 8 步、§13；plan PR-2 §0.1-6、-7、T7（R1–R3b）：檔案寫回的紀錄交易（`recordFileSyncInTx`）。
 * T11（R4–R7c、反例二兩序、PR3b）：`file_sync` 列經 REST 的列出與撤回。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, transferBases } from "../src/db/schema.js";
import { recordFileSyncInTx } from "../src/transfer/tx/record-file-sync.js";
import { buildCollabTestApp, freshDb } from "./helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, humanEdit, issueBulkDirect, liveMarkdown, seedBlocks, seedMd, topIdsOf } from "./bulk-transfer-helpers.js";

const SHA = Buffer.alloc(32, 9);
async function scene() {
  const { db } = await freshDb();
  const u = await seedUser(db);
  const note = await seedNote(db, { ownerId: u.id }, { title: "N" });
  const other = await seedNote(db, { ownerId: u.id }, { title: "Bystander" });
  const key = "0123456789abcdef";
  await db.insert(transferBases).values({
    key,
    userId: u.id,
    noteId: note.id,
    salt: Buffer.alloc(16, 1),
    keyId: "deadbeef",
    bodySha: Buffer.alloc(32, 2),
    titleSha: Buffer.alloc(32, 3),
    lineHashes: Buffer.alloc(0),
    lineKinds: Buffer.alloc(0),
    segments: [],
  });
  await db.execute(sql`update transfer_bases set last_used_at = now() - interval '3 days' where key = ${key}`);
  return { db, u, note, other, key };
}
type Row = typeof noteAiEdits.$inferInsert;
const rewriteRow = (noteId: string, userId: string, n = 0): Row => ({
  noteId,
  userId,
  op: "file_sync",
  sectionId: null,
  beforeBlocks: [{ id: `old${n}`, type: "paragraph", content: [] }],
  afterBlockIds: [`new${n}`],
  afterFingerprint: "0123456789abcdef",
  anchor: null,
});
const deleteRow = (noteId: string, userId: string): Row => ({
  noteId,
  userId,
  op: "file_sync",
  sectionId: null,
  beforeBlocks: [{ id: "gone", type: "paragraph", content: [] }],
  afterBlockIds: [],
  afterFingerprint: null,
  anchor: { block_id: "prev", position: "after" },
});
const insertRow = (noteId: string, userId: string): Row => ({
  noteId,
  userId,
  op: "file_sync",
  sectionId: null,
  beforeBlocks: [],
  afterBlockIds: ["ins"],
  afterFingerprint: "fedcba9876543210",
  anchor: null,
});
const record = (db: Db, input: Parameters<typeof recordFileSyncInTx>[1]) => db.transaction(tx => recordFileSyncInTx(tx, input));
const editsOf = (db: Db, noteId: string) => db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId));
const baseOf = async (db: Db, key: string) => (await db.select().from(transferBases).where(eq(transferBases.key, key)))[0]!;

describe("R1 三種列＋基底更新", () => {
  it("改寫、刪除、插入三列 → CHECK 全過；applied_body_sha 與 last_used_at 更新；回傳 id＝文件順序", async () => {
    const s = await scene();
    const before = await baseOf(s.db, s.key);
    const ids = await record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [rewriteRow(s.note.id, s.u.id), deleteRow(s.note.id, s.u.id), insertRow(s.note.id, s.u.id)] });
    expect(ids).toHaveLength(3);
    const rows = await editsOf(s.db, s.note.id);
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(ids.map(id => byId.get(id)!.afterBlockIds)).toEqual([["new0"], [], ["ins"]]);
    expect(ids.map(id => byId.get(id)!.anchor)).toEqual([null, { block_id: "prev", position: "after" }, null]);
    // created_at 依文件順序嚴格遞增（now() + i 微秒）
    const t = await s.db.execute<{ id: string; us: string }>(sql`select id, (extract(epoch from created_at) * 1000000)::bigint::text as us from note_ai_edits where note_id = ${s.note.id}`);
    const us = new Map(t.rows.map(r => [r.id, BigInt(r.us)]));
    expect(us.get(ids[0]!)! < us.get(ids[1]!)!).toBe(true);
    expect(us.get(ids[1]!)! < us.get(ids[2]!)!).toBe(true);
    const after = await baseOf(s.db, s.key);
    expect(Buffer.from(after.appliedBodySha!).equals(SHA)).toBe(true);
    expect(after.lastUsedAt.getTime()).toBeGreaterThan(before.lastUsedAt.getTime());
  });
  it("零列（全是 same 區的呼叫形）→ 不寫紀錄、只更新基底", async () => {
    const s = await scene();
    expect(await record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [] })).toEqual([]);
    expect(await editsOf(s.db, s.note.id)).toHaveLength(0);
    expect((await baseOf(s.db, s.key)).appliedBodySha).not.toBeNull();
  });
  it("對照：刪除列不帶 anchor → note_ai_edits_anchor_chk 擋下", async () => {
    const s = await scene();
    const bad = { ...deleteRow(s.note.id, s.u.id), anchor: null };
    await expect(record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [bad] })).rejects.toMatchObject({ cause: { constraint: "note_ai_edits_anchor_chk" } });
  });
});

describe("R2 同一個交易（gate r1 I3：失敗點在 INSERT 之後）", () => {
  it("transfer_bases 的 before update trigger 丟錯 → 這篇 note_ai_edits 0 列、applied_body_sha 仍 NULL", async () => {
    const s = await scene();
    await s.db.execute(sql.raw(`create function kn_r2_fail() returns trigger language plpgsql as $$ begin raise exception 'r2 boom'; end $$`));
    await s.db.execute(sql.raw(`create trigger kn_r2 before update on transfer_bases for each row execute function kn_r2_fail()`));
    try {
      await expect(record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [rewriteRow(s.note.id, s.u.id), insertRow(s.note.id, s.u.id)] })).rejects.toThrow();
      expect(await editsOf(s.db, s.note.id)).toHaveLength(0);
      expect((await baseOf(s.db, s.key)).appliedBodySha).toBeNull();
    } finally {
      await s.db.execute(sql.raw(`drop trigger if exists kn_r2 on transfer_bases`));
      await s.db.execute(sql.raw(`drop function if exists kn_r2_fail()`));
    }
  });
  it("R2b 多列 INSERT 失敗（trigger）→ 0 列、基底未寫", async () => {
    const s = await scene();
    await s.db.execute(sql.raw(`create function kn_r2b_fail() returns trigger language plpgsql as $$ begin if new.after_block_ids = array['ins'] then raise exception 'r2b boom'; end if; return new; end $$`));
    await s.db.execute(sql.raw(`create trigger kn_r2b before insert on note_ai_edits for each row execute function kn_r2b_fail()`));
    try {
      await expect(record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [rewriteRow(s.note.id, s.u.id), insertRow(s.note.id, s.u.id)] })).rejects.toThrow();
      expect(await editsOf(s.db, s.note.id)).toHaveLength(0);
      expect((await baseOf(s.db, s.key)).appliedBodySha).toBeNull();
    } finally {
      await s.db.execute(sql.raw(`drop trigger if exists kn_r2b on note_ai_edits`));
      await s.db.execute(sql.raw(`drop function if exists kn_r2b_fail()`));
    }
  });
});

describe("R3 裁切到 100", () => {
  async function seedOld(db: Db, noteId: string, userId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await db.insert(noteAiEdits).values({ ...rewriteRow(noteId, userId, 1000 + i), createdAt: sql`now() - interval '1 day' + ${i}::int * interval '1 second'` });
    }
  }
  it("先 seed 99 列、寫 3 列 → 恰 100、最舊的 2 列被刪；旁觀者（別篇）的列不受影響", async () => {
    const s = await scene();
    await seedOld(s.db, s.note.id, s.u.id, 99);
    await seedOld(s.db, s.other.id, s.u.id, 5);
    const ids = await record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [rewriteRow(s.note.id, s.u.id, 1), rewriteRow(s.note.id, s.u.id, 2), rewriteRow(s.note.id, s.u.id, 3)] });
    expect(ids).toHaveLength(3);
    const rows = await editsOf(s.db, s.note.id);
    expect(rows).toHaveLength(100);
    const olds = rows.map(r => (r.beforeBlocks as Array<{ id: string }>)[0]!.id).filter(x => x.startsWith("old1"));
    expect(olds).not.toContain("old1000");
    expect(olds).not.toContain("old1001");
    expect(olds).toContain("old1002");
    expect(await editsOf(s.db, s.other.id)).toHaveLength(5);
  });
  it("R3b 一次寫 105 區 → 留下本請求較晚的 100 列、回傳的 editIds 只含存活的 100 個（文件順序）", async () => {
    const s = await scene();
    const rows = Array.from({ length: 105 }, (_, i) => rewriteRow(s.note.id, s.u.id, i));
    const ids = await record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows });
    expect(ids).toHaveLength(100);
    const left = await editsOf(s.db, s.note.id);
    expect(left).toHaveLength(100);
    const byId = new Map(left.map(r => [r.id, r]));
    expect(ids.map(id => byId.get(id)!.afterBlockIds[0])).toEqual(Array.from({ length: 100 }, (_, i) => `new${i + 5}`));
  });
});

// ── T11：file_sync 列的撤回（§13、§0.1-14、總管追加 T11 1–4）──────────────────────────────
type Opts = Parameters<typeof buildCollabTestApp>[0];
type EditItem = { id: string; op: string; revertable: boolean; revertedAt: string | null };
async function writeScene(md: string, opts: Opts = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "T" });
  if (md !== "") await seedMd(ctx.db, note.id, md);
  const list = async () =>
    ((await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/edits`, headers: bearer(pat.token) })).json() as { edits: EditItem[] }).edits;
  const revert = (editId: string) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits/${editId}/revert`, headers: bearer(pat.token) });
  const md0 = async () => (await liveMarkdown(ctx, note.id)).replace(/\n+$/, "");
  const top = () => topIdsOf(ctx, note.id);
  return { ctx, u, pat, bulk, note, list, revert, md: md0, top };
}
const PARAS5 = "Para 0\n\nPara 1\n\nPara 2\n\nPara 3\n\nPara 4";
/** 改寫 Para 1、刪 Para 3、在最後插一段 → 三列（文件順序：改寫、刪除、插入）。 */
const threeRegions = (b: string) => b.replace("Para 1", "Rewritten").replace("Para 3\n\n", "").replace(/\n*$/, "\n\nInserted\n");
const errCode = (r: { json(): unknown }) => (r.json() as { error: { code: string } }).error.code;

describe("T11 撤回 file_sync", () => {
  it("R4 三列經 GET …/edits 列出、op file_sync、revertable；R5 逐列撤回：改寫還原、刪除插回（再撤 → already_reverted）、插入移除 → 回到原文", async () => {
    const s = await writeScene(PARAS5);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const w = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, threeRegions));
    expect(w.json()).toMatchObject({ result: "applied", applied: 3 });
    const edits = await s.list();
    expect(edits).toHaveLength(3);
    for (const e of edits) expect(e).toMatchObject({ op: "file_sync", revertable: true, revertedAt: null });
    const [ins, del, rew] = edits; // 列表新到舊；同一請求的三列 id 照文件順序寫入
    const rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(rew!.id)!.beforeBlocks).toHaveLength(1);
    expect(byId.get(del!.id)!.anchor).not.toBeNull();
    expect(byId.get(ins!.id)!.beforeBlocks).toEqual([]);

    expect((await s.revert(rew!.id)).statusCode).toBe(201);
    expect(await s.md()).toBe("Para 0\n\nPara 1\n\nPara 2\n\nPara 4\n\nInserted");
    expect((await s.revert(del!.id)).statusCode).toBe(201);
    expect(await s.md()).toBe("Para 0\n\nPara 1\n\nPara 2\n\nPara 3\n\nPara 4\n\nInserted");
    const again = await s.revert(del!.id);
    expect(again.statusCode).toBe(409);
    expect(errCode(again)).toBe("already_reverted");
    expect((await s.revert(ins!.id)).statusCode).toBe(201);
    expect(await s.md()).toBe(PARAS5);
    const t = await s.top();
    expect(new Set(t).size).toBe(t.length);
  });

  it("R5b 空筆記的插入列 → 撤回 → 頂層恰一顆空段落", async () => {
    const s = await writeScene("");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, `${d.text}First para\n\nSecond para`)).statusCode).toBe(200);
    const [e] = await s.list();
    expect(e).toMatchObject({ op: "file_sync", revertable: true });
    expect((await s.revert(e!.id)).statusCode).toBe(201);
    expect(await s.top()).toHaveLength(1);
    expect(await s.md()).toBe("");
  });

  it("R6 人改了寫回的 block → 該列 revertable false、撤回 409 stale", async () => {
    const s = await writeScene(PARAS5);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Rewritten")))).statusCode).toBe(200);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[1]!.id, { content: "Human touched" }));
    const [e] = await s.list();
    expect(e).toMatchObject({ op: "file_sync", revertable: false });
    const r = await s.revert(e!.id);
    expect(r.statusCode).toBe(409);
    expect(errCode(r)).toBe("stale");
  });

  it("R7 刪除列撤回後再打 → 不重複插入；R7b beforeRevertRecord throw → 500（內容已還原、紀錄沒寫）→ 再撤 409 stale、頂層 id 唯一、before_blocks 只一份", async () => {
    let boom = true;
    const s = await writeScene(PARAS5, { editingTestHooks: { beforeRevertRecord: async () => { if (boom) throw new Error("boom"); } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 3\n\n", "")))).statusCode).toBe(200);
    const [e] = await s.list();
    expect(e).toMatchObject({ op: "file_sync", revertable: true });
    expect((await s.revert(e!.id)).statusCode).toBe(500);
    expect(await s.md()).toBe(PARAS5);
    const failed = await s.list();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ revertable: false, revertedAt: null });
    boom = false;
    const second = await s.revert(e!.id);
    expect(second.statusCode).toBe(409);
    expect(errCode(second)).toBe("stale");
    const t = await s.top();
    expect(new Set(t).size).toBe(t.length);
    expect((await s.md()).split("Para 3").length - 1).toBe(1);
  });

  it("PR3b（審查 M3，純基底形）：基底 [B, 空段落, A, C]、檔案刪 A → anchor＝使用者自己的空段落（after，非佔位）→ 撤回後 A 回到它後面、空段落仍在", async () => {
    const s = await writeScene("");
    await seedBlocks(s.ctx.db, s.note.id, [{ type: "paragraph", content: "B" }, { type: "paragraph" }, { type: "paragraph", content: "A" }, { type: "paragraph", content: "C" }]);
    const [, userEmpty] = await s.top();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body).toContain("B\n\n\n\nA\n\nC");
    const w = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("A\n\nC", "C")));
    expect(w.statusCode).toBe(200);
    expect(w.json()).toMatchObject({ result: "applied", applied: 1 });
    const t1 = await s.top();
    expect(t1).toHaveLength(3);
    expect(t1[1]).toBe(userEmpty);
    const [e] = await s.list();
    const row = (await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.id, e!.id)))[0]!;
    expect(row.anchor).toEqual({ block_id: userEmpty, position: "after" });
    expect((await s.revert(e!.id)).statusCode).toBe(201);
    const t2 = await s.top();
    expect(t2).toHaveLength(4);
    expect(t2[1]).toBe(userEmpty);
    expect(await s.md()).toMatch(/^B\n\n\n\nA\n\nC$/);
  });

  it("R7c 刪除列正常撤回後再打 → already_reverted、頂層 id 唯一", async () => {
    const s = await writeScene(PARAS5);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 3\n\n", "")))).statusCode).toBe(200);
    const [e] = await s.list();
    expect((await s.revert(e!.id)).statusCode).toBe(201);
    expect(errCode(await s.revert(e!.id))).toBe("already_reverted");
    const t = await s.top();
    expect(new Set(t).size).toBe(t.length);
    expect(await s.md()).toBe(PARAS5);
  });
});
