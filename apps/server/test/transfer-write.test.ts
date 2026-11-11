/**
 * bulk transfer 寫回既有筆記（W1–W17）。流程：`downloadNote` → `editBody` → `bulkPut`。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { noteAiEdits, noteStates, notes, noteVersions, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { BASE_UNAVAILABLE_MESSAGES, NOT_MERGEABLE_MESSAGE, TRANSFER_NOTE_NOT_FOUND_MESSAGE, TRANSFER_RATE_LIMITED_MESSAGE, transferParseMessage } from "../src/routes/transfer.js";
import { UNCLOSED_FENCE_MESSAGE, unclosedFenceMessage } from "../src/transfer/regions.js";
import { UNCLOSED_FRONT_MATTER_MESSAGE } from "../src/transfer/frontmatter.js";
import { buildCollabTestApp, testConfig, type CollabTestCtx } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { seedDoc } from "./copy-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { cookieOf, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { basesOf, bulkPut, downloadNote, editBody, humanEdit, issueBulkDirect, liveBlocks, liveMarkdown, renameIn, seedBlocks, seedMd, topIdsOf } from "./bulk-transfer-helpers.js";

type Opts = Parameters<typeof buildCollabTestApp>[0];
const PARAS = (n: number, p = "Para") => Array.from({ length: n }, (_, i) => `${p} ${i}`).join("\n\n");

async function scene(opts: Opts = {}, md = PARAS(4)) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  if (md !== "") await seedMd(ctx.db, note.id, md);
  return { ctx, u, pat, bulk, note };
}
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string; reason?: string } }).error;
const edits = (ctx: CollabTestCtx, noteId: string) => ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId));
const baseRow = async (ctx: CollabTestCtx, key: string) => (await ctx.db.select().from(transferBases).where(eq(transferBases.key, key)))[0]!;
const norm = (s: string) => s.replace(/\n+$/, "");

describe("W1–W7 狀態表", () => {
  it("W1 原樣重送 → unchanged；transferWrite 未扣；tokenRead 扣 1；筆記未變；紀錄 0 列", async () => {
    const tokenRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { tokenRead, transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const before = await liveMarkdown(s.ctx, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, d.text);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: s.note.id, created: false, result: "unchanged", applied: 0, base: null });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    expect(await edits(s.ctx, s.note.id)).toHaveLength(0);
    // tokenRead 已扣 1（limit 1）：再一次 unchanged → 429
    expect((await bulkPut(s.ctx.app, s.bulk.token, d.text)).statusCode).toBe(429);
    // transferWrite 沒扣：真的改一段仍可寫（limit 1）
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Para 1 new")))).statusCode).toBe(200);
  });

  it("W2 改一段 → applied 1、內容＝agent 檔、其餘 id 不變、一列 file_sync、applied_body_sha 已寫、沒有 version", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const ids0 = await topIdsOf(s.ctx, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 1", "Para 1 new"));
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    expect(body).toMatchObject({ result: "applied", applied: 1, same: 0, renamed: false, base: null, created: false });
    expect(body).not.toHaveProperty("version");
    expect(body).not.toHaveProperty("conflicts");
    expect((body.editIds as string[]).length).toBe(1);
    expect(norm(await liveMarkdown(s.ctx, s.note.id))).toBe(norm(editBody(d.text, b => b.replace("Para 1", "Para 1 new")).split("\n").slice(8).join("\n")));
    const ids1 = await topIdsOf(s.ctx, s.note.id);
    expect([ids1[0], ids1[2], ids1[3]]).toEqual([ids0[0], ids0[2], ids0[3]]);
    expect(ids1[1]).not.toBe(ids0[1]);
    const rows = await edits(s.ctx, s.note.id);
    expect(rows.map(x => x.op)).toEqual(["file_sync"]);
    expect((await baseRow(s.ctx, d.fm.base!)).appliedBodySha).not.toBeNull();
  });

  // isBlocked 預檢在佇列之前：桶滿時連同檔重送都 429，所以這裡用 limit 2——寫一次、重送、再寫一篇仍成功＝重送沒扣。
  it("W3 寫回後同檔重送 → unchanged、不扣 transferWrite；W4 舊 base 改別段 → 409 base_unavailable、筆記未變", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 1", "Para 1 new"));
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).statusCode).toBe(200);
    const w3 = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(w3.statusCode).toBe(200);
    expect(w3.json()).toMatchObject({ result: "unchanged" });
    const after = await liveMarkdown(s.ctx, s.note.id);
    const w4 = await bulkPut(s.ctx.app, s.bulk.token, editBody(text, b => b.replace("Para 2", "Para 2 other")));
    expect(w4.statusCode).toBe(409);
    expect(errOf(w4)).toEqual({ code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES.already_sent, reason: "already_sent" });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(after);
    // 重送與 409 都沒扣 → limit 2 還剩 1：再寫一篇仍 200
    const n2 = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "N2" });
    await seedMd(s.ctx.db, n2.id, "Only para");
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, n2.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, () => "Changed para"))).statusCode).toBe(200);
  });

  it("色碼：上傳 #F60 → 下載回小寫 #ff6600；原上傳檔與重新下載的檔重送都判 unchanged", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const addColor = (b: string) => b.replace("Para 1", 'Para <span style="color:#F60">1</span>');
    const put = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, addColor));
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ result: "applied", applied: 1 });
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d2.body).toContain('<span style="color:#ff6600">1</span>');
    expect(d2.body).not.toContain("#F60");
    const rowsBefore = (await edits(s.ctx, s.note.id)).length;
    // 重新下載的副本把色碼改回上傳時的寫法（大寫短寫）：位元組與本文雜湊都跟下載的不同，要靠解析後的正規形比對才判得出沒有新改動。
    const again = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, b => b.replace("#ff6600", "#F60")));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ applied: 0 });
    expect((again.json() as { same: number }).same).toBeGreaterThanOrEqual(1);
    expect((await edits(s.ctx, s.note.id)).length).toBe(rowsBefore);
  });

  it("409 三形：別人的 base、別篇的 base → reason other_note；不存在的 16 hex → expired（各帶對應訊息）", async () => {
    const s = await scene();
    const other = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Other" });
    await seedMd(s.ctx.db, other.id, "Other para");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const od = await downloadNote(s.ctx.app, s.bulk.token, other.id);
    const v = await seedUser(s.ctx.db);
    await seedShare(s.ctx.db, s.note.id, v.id, "editor");
    const vpat = await seedTokenForUser(s.ctx.db, v.id, "notes:read notes:write");
    const vbulk = await issueBulkDirect(s.ctx.db, vpat.tokenId, { access: "write" });
    const vd = await downloadNote(s.ctx.app, vbulk.token, s.note.id);
    const changed = (base: string) => editBody(d.text.replace(/^base: .*$/m, `base: ${base}`), b => b.replace("Para 1", "x"));
    for (const [label, base, reason] of [["別人的", vd.fm.base!, "other_note"], ["別篇的", od.fm.base!, "other_note"], ["不存在", "ffffffffffffffff", "expired"]] as const) {
      const r = await bulkPut(s.ctx.app, s.bulk.token, changed(base));
      expect(r.statusCode, label).toBe(409);
      expect(errOf(r), label).toEqual({ code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES[reason], reason });
    }
  });

  it("W5b 換金鑰（同一個 DB、不同 APP_SECRET）→ 原樣重送 409 base_unavailable、筆記逐位元組未變、紀錄 0 列", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const before = await liveMarkdown(s.ctx, s.note.id);
    await s.ctx.destroy();
    const ctx2 = await buildCollabTestApp({ db: s.ctx.db, config: { ...testConfig, appSecret: `${testConfig.appSecret}-rotated` } });
    const r = await bulkPut(ctx2.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toMatchObject({ code: "base_unavailable", reason: "expired" });
    expect(await liveMarkdown(ctx2, s.note.id)).toBe(before);
    expect(await edits(ctx2, s.note.id)).toHaveLength(0);
  });

  it("W6 not_mergeable：改內容 → 409＋NOT_MERGEABLE_MESSAGE；原樣重送 → unchanged", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "x")));
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual({ code: "not_mergeable", message: NOT_MERGEABLE_MESSAGE });
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, d.text);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ result: "unchanged" });
  });

  it("W7 只插空行 → unchanged、applied_body_sha 不寫、不扣 transferWrite", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1\n", "Para 1\n\n\n")));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "unchanged" });
    expect((await baseRow(s.ctx, d.fm.base!)).appliedBodySha).toBeNull();
    // transferWrite 沒扣：另一篇的真寫入仍可（limit 1）
    const n2 = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "N2" });
    await seedMd(s.ctx.db, n2.id, "Only para");
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, n2.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, () => "Changed para"))).statusCode).toBe(200);
  });
});

describe("W8 400 整篇不寫（拿掉守衛會落到 500 那幾條：NUL／落單代理／非 uuid 進 SQL）", () => {
  const NUL = String.fromCodePoint(0);
  it("十二形各 400＋JSON；筆記、標題、基底都沒變；「A、空段落、B」中間插 X → 200", async () => {
    const s = await scene({}, "A\n\nB");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const before = await liveMarkdown(s.ctx, s.note.id);
    const basesBefore = JSON.stringify((await basesOf(s.ctx.db)).map(b => [b.key, b.appliedBodySha]));
    const lines = d.text.split("\n");
    const fm = (k: string, v: string) => d.text.replace(new RegExp(`^${k}: .*$`, "m"), `${k}: ${v}`);
    const cases: Array<[string, string, string]> = [
      ["本文含 NUL", editBody(d.text, b => b + NUL), "invalid_body"],
      ["base 含 NUL（JSON 逸出）", fm("base", '"0123456789abcde\\u0000"'), "invalid_body"],
      ["folder_id 非 uuid（新增檔）", "---\nknotebook: 1\nfolder_id: nope\n---\nx", "invalid_body"],
      ["title 含 NUL", fm("title", '"a\\u0000b"'), "invalid_body"],
      ["title 含落單代理", fm("title", '"a\\ud800b"'), "invalid_body"],
      ["id 非 uuid", fm("id", "not-a-uuid"), "invalid_body"],
      ["有 id 無 base", lines.filter(l => !l.startsWith("base: ")).join("\n"), "invalid_body"],
      ["重複 title 行", d.text.replace(/^(title: .*)$/m, '$1\ntitle: "again"'), "invalid_body"],
      ["unsupported_color", editBody(d.text, b => b.replace("B", 'x <span style="color:tomato">o</span>')), "unsupported_color"],
      ["empty_content 整份空白", editBody(d.text, () => "   "), "empty_content"],
      ["只剩註解", editBody(d.text, () => "<!-- a -->\n\n<!-- b -->"), "empty_content"],
      ["未閉合 <!--", editBody(d.text, b => b.replace("B", "<!--\nB")), "empty_content"],
    ];
    for (const [label, text, code] of cases) {
      const r = await bulkPut(s.ctx.app, s.bulk.token, text);
      expect(r.statusCode, label).toBe(400);
      expect(r.headers["content-type"], label).toMatch(/^application\/json/);
      expect(errOf(r).code, label).toBe(code);
    }
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    expect((await s.ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, s.note.id)))[0]!.title).toBe("Title");
    expect(JSON.stringify((await basesOf(s.ctx.db)).map(b => [b.key, b.appliedBodySha]))).toBe(basesBefore);
  });
  it("「A、空段落、B」中間插 X → 200", async () => {
    const s = await scene({}, "A");
    await humanEdit(s.ctx, s.note.id, ed => ed.replaceBlocks(ed.document, [{ type: "paragraph", content: "A" }, { type: "paragraph" }, { type: "paragraph", content: "B" }]));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("A\n\n", "A\n\nX\n\n")));
    expect(r.statusCode).toBe(200);
  });
  it("檔案層級未閉合的 ``` fence（agent 新增）→ 400 invalid_body＋UNCLOSED_FENCE_MESSAGE", async () => {
    const s = await scene({}, "A\n\nB");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("B", "```\nB")));
    expect(r.statusCode).toBe(400);
    expect(errOf(r)).toEqual({ code: "invalid_body", message: UNCLOSED_FENCE_MESSAGE });
  });
});

describe("W9–W12 權限、範圍、額度、佇列", () => {
  it("W9 viewer 403；範圍外 403；垃圾桶 404；範圍物件看不到 403；access=read 403", async () => {
    const s = await scene();
    const owner = await seedUser(s.ctx.db);
    const shared = await seedNote(s.ctx.db, { ownerId: owner.id }, { title: "S" });
    await seedMd(s.ctx.db, shared.id, "Shared para");
    await seedShare(s.ctx.db, shared.id, s.u.id, "viewer");
    const sd = await downloadNote(s.ctx.app, s.bulk.token, shared.id);
    const viewer = await bulkPut(s.ctx.app, s.bulk.token, editBody(sd.text, () => "x"));
    expect(viewer.statusCode).toBe(403);
    expect(errOf(viewer)).toEqual({ code: "forbidden", message: "You don't have edit access to this note." });
    // 範圍外：folder 範圍的權杖、筆記不在那個資料夾
    const f = (await seedFolder(s.ctx.db, { personal: s.u.id }, { name: "F" })).id;
    const fbulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write", range: { kind: "folder", folderId: f } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const out = await bulkPut(s.ctx.app, fbulk.token, editBody(d.text, b => b.replace("Para 1", "x")));
    expect(out.statusCode).toBe(403);
    expect(errOf(out).message).toBe("This note isn't in this transfer token's range.");
    // 範圍物件看不到：刪掉資料夾
    await s.ctx.db.execute(sql`delete from folders where id = ${f}`);
    const gone = await bulkPut(s.ctx.app, fbulk.token, editBody(d.text, b => b.replace("Para 1", "x")));
    expect(gone.statusCode).toBe(403);
    expect(errOf(gone).message).toBe("The group or folder this transfer token covers is no longer visible to you.");
    // access=read
    const rbulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "read" });
    const ro = await bulkPut(s.ctx.app, rbulk.token, editBody(d.text, b => b.replace("Para 1", "x")));
    expect(ro.statusCode).toBe(403);
    expect(errOf(ro)).toEqual({ code: "insufficient_scope", message: "This token's scope doesn't allow this action." });
    // 垃圾桶
    await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, s.note.id));
    const trashed = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "x")));
    expect(trashed.statusCode).toBe(404);
    expect(errOf(trashed)).toEqual({ code: "not_found", message: TRANSFER_NOTE_NOT_FOUND_MESSAGE });
  });

  it("W10 transferWrite limit 1 → 第二篇的寫回 429＋Retry-After ≥ 1、筆記未變", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const n2 = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "N2" });
    await seedMd(s.ctx.db, n2.id, "Second note para");
    const d1 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, n2.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d1.text, b => b.replace("Para 1", "x")))).statusCode).toBe(200);
    const before = await liveMarkdown(s.ctx, n2.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, () => "changed"));
    expect(r.statusCode).toBe(429);
    expect(errOf(r)).toEqual({ code: "too_many_requests", message: TRANSFER_RATE_LIMITED_MESSAGE });
    expect(String(r.headers["retry-after"])).toMatch(/^[1-9]\d*$/);
    expect(await liveMarkdown(s.ctx, n2.id)).toBe(before);
  });

  it("W10b 桶滿時「同檔重送」仍 200 unchanged（寫回額度只看有改的檔）；同一份副本改別的內容 → 409 already_sent", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 1", "x"));
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).statusCode).toBe(200);
    const again = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ result: "unchanged" });
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "y")))).statusCode).toBe(409);
  });

  it("W10c 寫回額度在解析之前扣：解析失敗的寫回 400 也算一次 → 另一篇的真寫入 429、筆記未變", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const n2 = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "N2" });
    await seedMd(s.ctx.db, n2.id, "Second note para");
    const d1 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, n2.id);
    const bad = await bulkPut(s.ctx.app, s.bulk.token, editBody(d1.text, b => b.replace("Para 1", 'x <span style="color:tomato">orange-ish</span>')));
    expect(bad.statusCode).toBe(400);
    expect(errOf(bad).code).toBe("unsupported_color");
    expect(transferWrite.isBlocked(s.u.id)).toBe(true);
    const before = await liveMarkdown(s.ctx, n2.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, () => "changed"));
    expect(r.statusCode).toBe(429);
    expect(await liveMarkdown(s.ctx, n2.id)).toBe(before);
  });

  it("W10d 額度用完時，本文位元組有改的檔一律 429——連只插空行（零區）的也是（判零區要先解析）；位元組相同的重送仍 200 unchanged", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const n2 = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "N2" });
    await seedMd(s.ctx.db, n2.id, "Second note para");
    const d1 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, n2.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, () => "changed"))).statusCode).toBe(200);
    const zero = await bulkPut(s.ctx.app, s.bulk.token, editBody(d1.text, b => b.replace("Para 1\n", "Para 1\n\n\n")));
    expect(zero.statusCode).toBe(429);
    const same = await bulkPut(s.ctx.app, s.bulk.token, d1.text);
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ result: "unchanged" });
  });

  it("W11 佇列被占（queueWaitMs 50）→ 503 server_busy、筆記未變", async () => {
    let release!: () => void;
    let entered!: () => void;
    const inMerge = new Promise<void>(r => (entered = r));
    const hold = new Promise<void>(r => (release = r));
    let first = true;
    const s = await scene({
      editingQueueWaitMs: 50,
      editingTestHooks: {
        beforeMerge: async () => {
          if (!first) return;
          first = false;
          entered();
          await hold;
        },
      },
    });
    const n2 = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "N2" });
    await seedMd(s.ctx.db, n2.id, "x");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const p1 = bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "first")));
    await inMerge;
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "second")));
    expect(r2.statusCode).toBe(503);
    expect(errOf(r2)).toEqual({ code: "server_busy", message: "The server is busy. Try again in a moment." });
    release();
    expect((await p1).statusCode).toBe(200);
    expect(await liveMarkdown(s.ctx, s.note.id)).not.toContain("second");
  });

  it("W12 不扣 edit／tokenWrite：兩桶 limit 0 時寫回仍 200；transferWrite limit 0 時 REST /edits 仍可寫", async () => {
    const zero = () => new FixedWindowLimiter({ limit: 0, windowMs: 60_000 });
    const s = await scene({ limiters: { edit: zero(), tokenWrite: zero() } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "x")))).statusCode).toBe(200);
    const t = await scene({ limiters: { transferWrite: zero() } });
    const res = await t.ctx.app.inject({ method: "POST", url: `/api/notes/${t.note.id}/edits`, headers: { authorization: `Bearer ${t.pat.token}`, "content-type": "application/json" }, payload: { op: "append", markdown: "appended" } });
    expect(res.statusCode).toBe(201);
  });
});

describe("W13 log 鍵集合（11 鍵——沒有 conflicts、versionId；錯誤出口 diff 鍵 null）", () => {
  it("applied／409／400 各恰一行 info、鍵恰 11 個；log 不含標題、本文、檔內標記、knbt_", async () => {
    const chunks: string[] = [];
    const s = await scene({ logger: { level: "info", stream: { write: (x: string) => void chunks.push(x) } } }, PARAS(3, "SecretBodyMarker"));
    await s.ctx.db.update(notes).set({ title: "SecretTitleMarker" }).where(eq(notes.id, s.note.id));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    chunks.length = 0;
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => "   "))).statusCode).toBe(400);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("SecretBodyMarker 1", "SecretBodyMarker changed")))).statusCode).toBe(200);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("SecretBodyMarker 2", "SecretBodyMarker other")))).statusCode).toBe(409);
    const lines = chunks.flatMap(c => c.split("\n")).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).filter(o => o.msg === "bulk transfer write");
    expect(lines).toHaveLength(3);
    const KEYS = ["userId", "tokenId", "noteId", "result", "applied", "same", "ms", "diffOverflow", "anchored", "degradedLines", "clientClosed"];
    const PINO = new Set(["level", "time", "pid", "hostname", "reqId", "msg"]);
    for (const l of lines) expect(Object.keys(l).filter(k => !PINO.has(k)).sort()).toEqual([...KEYS].sort());
    expect(lines.map(l => l.result)).toEqual(["empty_content", "applied", "base_unavailable"]);
    for (const l of [lines[0]!, lines[2]!]) for (const k of ["applied", "same", "diffOverflow", "anchored", "degradedLines"]) expect(l[k], `${l.result}.${k}`).toBeNull();
    expect(lines[1]).toMatchObject({ applied: 1, same: 0, diffOverflow: false, clientClosed: false });
    const all = chunks.join("");
    for (const m of ["SecretBodyMarker", "SecretTitleMarker", "knbt_"]) expect(all).not.toContain(m);
  });

  it("W13b 未預期的例外（紀錄交易 trigger 失敗）→ 500、`bulk transfer write` 恰一行、result internal、11 鍵且 diff 鍵 null；log 不含本文與 Failed query", async () => {
    const chunks: string[] = [];
    const s = await scene({ logger: { level: "info", stream: { write: (x: string) => void chunks.push(x) } } }, PARAS(3, "SecretBodyMarker"));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await s.ctx.db.execute(sql.raw(`create function kn_w13b() returns trigger language plpgsql as $$ begin raise exception 'W13bTriggerMarker'; end $$`));
    await s.ctx.db.execute(sql.raw(`create trigger kn_w13b before insert on note_ai_edits for each row execute function kn_w13b()`));
    chunks.length = 0;
    let status = 0;
    try {
      status = (await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("SecretBodyMarker 1", "SecretBodyMarker changed")))).statusCode;
    } finally {
      await s.ctx.db.execute(sql.raw(`drop trigger if exists kn_w13b on note_ai_edits`));
      await s.ctx.db.execute(sql.raw(`drop function if exists kn_w13b()`));
    }
    expect(status).toBe(500);
    const lines = chunks.flatMap(c => c.split("\n")).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).filter(o => o.msg === "bulk transfer write");
    expect(lines).toHaveLength(1);
    const KEYS = ["userId", "tokenId", "noteId", "result", "applied", "same", "ms", "diffOverflow", "anchored", "degradedLines", "clientClosed"];
    const PINO = new Set(["level", "time", "pid", "hostname", "reqId", "msg"]);
    expect(Object.keys(lines[0]!).filter(k => !PINO.has(k)).sort()).toEqual([...KEYS].sort());
    expect(lines[0]).toMatchObject({ result: "internal", noteId: s.note.id, clientClosed: false });
    for (const k of ["applied", "same", "diffOverflow", "anchored", "degradedLines"]) expect(lines[0]![k], k).toBeNull();
    const all = chunks.join("");
    for (const m of ["SecretBodyMarker", "Failed query", "W13bTriggerMarker"]) expect(all, m).not.toContain(m);
  });
});

describe("W14 空筆記", () => {
  it("沒有內容的筆記 → 下載本文空 → 寫兩段 → 200、內容＝agent 本文、沒有多餘空段落、紀錄形＝插入列", async () => {
    const s = await scene({}, "");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body).toBe("");
    const r = await bulkPut(s.ctx.app, s.bulk.token, `${d.text}First para\n\nSecond para`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect(norm(await liveMarkdown(s.ctx, s.note.id))).toBe("First para\n\nSecond para");
    expect(await topIdsOf(s.ctx, s.note.id)).toHaveLength(2);
    const [row] = await edits(s.ctx, s.note.id);
    expect(row).toMatchObject({ op: "file_sync", anchor: null, beforeBlocks: [] });
    expect(row!.afterBlockIds).toHaveLength(2);
  });

  it("W14b（known-limitation）只剩一顆空段落的筆記不算「空筆記」：寫兩段 → 那顆空段落留在結尾（結尾 0 行段永遠最後）", async () => {
    const s = await scene({}, "");
    await seedBlocks(s.ctx.db, s.note.id, [{ type: "paragraph" }]);
    const [emptyId] = await topIdsOf(s.ctx, s.note.id);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body.trim()).toBe("");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, () => "First para\n\nSecond para"));
    expect(r.statusCode).toBe(200);
    const blocks = await liveBlocks(s.ctx, s.note.id);
    expect(blocks.map(b => b.text)).toEqual(["First para", "Second para", ""]);
    expect(blocks[2]!.id).toBe(emptyId);
  });
});

describe("W15 帶內容的 DB 失敗不洩內容", () => {
  async function withTrigger<T>(ctx: CollabTestCtx, table: string, when: string, f: () => Promise<T>): Promise<T> {
    await ctx.db.execute(sql.raw(`create function kn_w15() returns trigger language plpgsql as $$ begin raise exception 'W15TriggerMarker'; end $$`));
    await ctx.db.execute(sql.raw(`create trigger kn_w15 ${when} on ${table} for each row execute function kn_w15()`));
    try {
      return await f();
    } finally {
      await ctx.db.execute(sql.raw(`drop trigger if exists kn_w15 on ${table}`));
      await ctx.db.execute(sql.raw(`drop function if exists kn_w15()`));
    }
  }
  const capture = () => {
    const chunks: string[] = [];
    return { chunks, logger: { level: "debug", stream: { write: (x: string) => void chunks.push(x) } } };
  };
  const assertClean = (chunks: string[], marker: string) => {
    const all = chunks.join("");
    expect(all, "前提：trigger 觸發（log 有 pgErrorSummary 的 code）").toContain('"code":"P0001"');
    for (const m of [marker, "Failed query", "params", "W15TriggerMarker"]) expect(all, m).not.toContain(m);
  };
  it("(a) 紀錄交易失敗 → 500、log 不含本文標記", async () => {
    const c = capture();
    const s = await scene({ logger: c.logger });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await withTrigger(s.ctx, "note_ai_edits", "before insert", () => bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "W15BodyMarkerA"))));
    expect(r.statusCode).toBe(500);
    assertClean(c.chunks, "W15BodyMarkerA");
  });
  it("(c) 改名失敗 → 500、標題未變、log 不含標題標記", async () => {
    const c = capture();
    const s = await scene({ logger: c.logger });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await s.ctx.db.execute(sql.raw(`create function kn_w15() returns trigger language plpgsql as $$ begin if new.id = '${s.note.id}' and new.title <> old.title then raise exception 'W15TriggerMarker'; end if; return new; end $$`));
    await s.ctx.db.execute(sql.raw(`create trigger kn_w15 before update on notes for each row execute function kn_w15()`));
    let r;
    try {
      r = await bulkPut(s.ctx.app, s.bulk.token, d.text.replace(/^title: .*$/m, `title: "W15TitleMarkerC"`));
    } finally {
      await s.ctx.db.execute(sql.raw(`drop trigger if exists kn_w15 on notes`));
      await s.ctx.db.execute(sql.raw(`drop function if exists kn_w15()`));
    }
    expect(r.statusCode).toBe(500);
    expect((await s.ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, s.note.id)))[0]!.title).toBe("Title");
    assertClean(c.chunks, "W15TitleMarkerC");
  });
  it("(d)（docs/api.md 的 internal 列）內文已寫入並記錄、之後改名失敗 → 500；同檔重送 → 409 already_sent、內文不重複", async () => {
    const c = capture();
    const s = await scene({ logger: c.logger });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await s.ctx.db.execute(sql.raw(`create function kn_w15() returns trigger language plpgsql as $$ begin if new.id = '${s.note.id}' and new.title <> old.title then raise exception 'W15TriggerMarker'; end if; return new; end $$`));
    await s.ctx.db.execute(sql.raw(`create trigger kn_w15 before update on notes for each row execute function kn_w15()`));
    const text = renameIn(editBody(d.text, b => b.replace("Para 1", "Para 1 W15D")), "W15TitleMarkerD");
    let r;
    try {
      r = await bulkPut(s.ctx.app, s.bulk.token, text);
    } finally {
      await s.ctx.db.execute(sql.raw(`drop trigger if exists kn_w15 on notes`));
      await s.ctx.db.execute(sql.raw(`drop function if exists kn_w15()`));
    }
    expect(r.statusCode).toBe(500);
    expect(await liveMarkdown(s.ctx, s.note.id)).toContain("Para 1 W15D");
    expect(await edits(s.ctx, s.note.id)).toHaveLength(1);
    const again = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(again.statusCode).toBe(409);
    expect(errOf(again).reason).toBe("already_sent");
    expect((await liveMarkdown(s.ctx, s.note.id)).split("Para 1 W15D").length - 1).toBe(1);
    expect((await s.ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, s.note.id)))[0]!.title).toBe("Title");
  });
});

describe("W16 溢位（真上限；「人改了中間那段」的形改回 409，見 transfer-write-reread）", () => {
  it("2 500 段；agent 改 0–599 與 1 900–2 499 → 中間那段沒被動到、id 不變、log diffOverflow／anchored／degradedLines", async () => {
    const chunks: string[] = [];
    const s = await scene({ logger: { level: "info", stream: { write: (x: string) => void chunks.push(x) } } }, PARAS(2500, "Unique line"));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const id1200 = (await topIdsOf(s.ctx, s.note.id))[1200]!;
    const text = editBody(d.text, b =>
      b
        .replace(/\n+$/, "")
        .split("\n\n")
        .map((p, i) => (i < 600 || i >= 1900 ? `${p} agent` : p))
        .join("\n\n"),
    );
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied" });
    expect(r.json()).not.toHaveProperty("version");
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md).toContain("Unique line 1200\n");
    expect(md).not.toContain("Unique line 1200 agent");
    expect((await topIdsOf(s.ctx, s.note.id))[1200]).toBe(id1200);
    expect(md).toContain("Unique line 0 agent");
    expect(md).toContain("Unique line 2499 agent");
    const line = chunks.flatMap(c => c.split("\n")).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).find(o => o.msg === "bulk transfer write")!;
    expect(line.diffOverflow).toBe(true);
    expect(line.anchored as number).toBeGreaterThanOrEqual(1300);
    expect(line.degradedLines).toBe(0);
  }, 180_000);
});

describe("W17 紀錄交易失敗後重送不重複（重送回 409 note_changed，不再判 same）", () => {
  it("改寫、刪除、插入兩段 → 紀錄失敗 500（內容已合併）→ 同檔重送 → 409 note_changed；內容不重複、頂層 id 唯一", async () => {
    const s = await scene({}, PARAS(5));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 0", "Para 0 rewritten").replace("Para 2\n\n", "").replace("Para 4", "Para 4\n\nInsertedOne\n\nInsertedTwo"));
    await s.ctx.db.execute(sql.raw(`create function kn_w17() returns trigger language plpgsql as $$ begin raise exception 'w17'; end $$`));
    await s.ctx.db.execute(sql.raw(`create trigger kn_w17 before insert on note_ai_edits for each row execute function kn_w17()`));
    let r1;
    try {
      r1 = await bulkPut(s.ctx.app, s.bulk.token, text);
    } finally {
      await s.ctx.db.execute(sql.raw(`drop trigger if exists kn_w17 on note_ai_edits`));
      await s.ctx.db.execute(sql.raw(`drop function if exists kn_w17()`));
    }
    expect(r1.statusCode).toBe(500);
    const idsAfterMerge = await topIdsOf(s.ctx, s.note.id);
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r2.statusCode).toBe(409);
    expect(errOf(r2).reason).toBe("note_changed");
    const ids = await topIdsOf(s.ctx, s.note.id);
    expect(ids).toEqual(idsAfterMerge);
    expect(new Set(ids).size).toBe(ids.length);
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md.split("InsertedOne").length - 1).toBe(1);
    expect(md.split("InsertedTwo").length - 1).toBe(1);
    expect((await baseRow(s.ctx, d.fm.base!)).appliedBodySha).toBeNull();
  });
});

describe("W18 寫回與新增在回覆之前已經建好全文索引（#369：known-limitations「A write … is indexed before its reply comes back」對 bulk 也成立）", () => {
  type SearchHit = { note: { id: string }; matchedOn: "title" | "body" | "both"; matches: Array<{ snippet: string }> };
  const search = async (ctx: CollabTestCtx, userId: string, q: string) => {
    const r = await ctx.app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}`, cookies: await cookieOf(userId) });
    expect(r.statusCode).toBe(200);
    return (r.json() as { hits: SearchHit[] }).hits;
  };
  const uniq = (tag: string) => `kbidx${tag}${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  it("寫回既有筆記：200 回來後立刻 GET /api/search 搜得到這篇、命中在內文（之前搜不到）", async () => {
    const s = await scene();
    const mark = uniq("w");
    expect(await search(s.ctx, s.u.id, mark)).toEqual([]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 2", `Para 2 ${mark}`)));
    expect(r.statusCode).toBe(200);
    const hits = await search(s.ctx, s.u.id, mark);
    expect(hits.map(h => h.note.id)).toEqual([s.note.id]);
    expect(hits[0]!.matchedOn).toBe("body");
    expect(hits[0]!.matches.some(m => m.snippet.includes(mark))).toBe(true);
  });

  it("新增筆記：201 回來後立刻 GET /api/search 搜得到新筆記、命中在內文", async () => {
    const s = await scene();
    const mark = uniq("c");
    const r = await bulkPut(s.ctx.app, s.bulk.token, `---\nknotebook: 1\ntitle: "Indexed new"\n---\nFirst para\n\nSecond para ${mark}\n`);
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { id: string }).id;
    const hits = await search(s.ctx, s.u.id, mark);
    expect(hits.map(h => h.note.id)).toEqual([id]);
    expect(hits[0]!.matchedOn).toBe("body");
    expect(hits[0]!.matches.some(m => m.snippet.includes(mark))).toBe(true);
  });
});

describe("Z 下載後筆記被換過 → 409 note_changed（取代 anchors_gone，動過就拒）", () => {
  /** REST `replace_section`（PAT）：把 outline[1]（第一個 heading 那段）整段換成 markdown → 所有 block 換新 id。 */
  async function replaceSection(s: Awaited<ReturnType<typeof scene>>, markdown: string) {
    const c = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json() as { outline: Array<{ sectionId: string; fingerprint: string }> };
    const sec = c.outline[1]!;
    const r = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.pat.token), payload: { op: "replace_section", section_id: sec.sectionId, markdown, if_match: sec.fingerprint } });
    expect(r.statusCode).toBe(201);
  }
  const versions = (ctx: CollabTestCtx, noteId: string) => ctx.db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId));
  const refused = async (s: Awaited<ReturnType<typeof scene>>, text: string) => {
    const md0 = await liveMarkdown(s.ctx, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual({ code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES.note_changed, reason: "note_changed" });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(md0);
  };

  it("Z1 下載 → replace_section 換掉整段 → 送舊副本（改一段＋改標題）→ 409 note_changed；內容逐字不變、沒有新版本或紀錄列、沒改名、沒扣 transferWrite、log 一行", async () => {
    const chunks: string[] = [];
    const s = await scene({ limiters: { transferWrite: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }, logger: { level: "info", stream: { write: (x: string) => void chunks.push(x) } } }, "# H\n\nFirst para\n\nSecond para");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await replaceSection(s, "# H\n\nFirst para\n\nSecond para edited by edit_note");
    const md0 = await liveMarkdown(s.ctx, s.note.id);
    const v0 = (await versions(s.ctx, s.note.id)).length;
    const e0 = (await edits(s.ctx, s.note.id)).length;
    chunks.length = 0;
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, b => b.replace("Second para", "Second para from the file")), "Renamed by file"));
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual({ code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES.note_changed, reason: "note_changed" });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(md0);
    expect(md0).not.toContain("from the file");
    expect((await versions(s.ctx, s.note.id)).length).toBe(v0);
    expect((await edits(s.ctx, s.note.id)).length).toBe(e0);
    expect((await s.ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, s.note.id)))[0]!.title).toBe("Title");
    expect((await baseRow(s.ctx, d.fm.base!)).appliedBodySha).toBeNull();
    const lines = chunks.flatMap(c => c.split("\n")).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).filter(o => o.msg === "bulk transfer write");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ result: "base_unavailable", noteId: s.note.id, applied: null });
    // transferWrite（limit 1）沒被扣：重新下載後照常寫回
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, b => b.replace("Second para edited by edit_note", "Second para redone")));
    expect(r2.statusCode).toBe(200);
  });

  it("Z2 多區檔案（A 有改、在 C 之後插 X），B、C 被換成內容相同的新 id → 整篇 409、A 也沒寫", async () => {
    const s = await scene({}, "A\n\nB\n\nC");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => {
      const [, b, c] = ed.document;
      ed.replaceBlocks([b!.id, c!.id], [{ type: "paragraph", content: "B" }, { type: "paragraph", content: "C" }]);
    });
    await refused(s, editBody(d.text, b => b.replace(/^A$/m, "A changed").replace(/\n*$/, "\n\nX\n")));
    expect(await edits(s.ctx, s.note.id)).toHaveLength(0);
  });

  it("Z3a 基底是空筆記、之後別人寫了內容 → 409（不再插在開頭）", async () => {
    const s = await scene({}, "");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.replaceBlocks(ed.document.map(b => b.id), [{ type: "paragraph", content: "Human para" }]));
    await refused(s, `${d.text}Agent para`);
  });

  it("Z3b 在基底最開頭插入（筆記沒動）→ 照舊寫入", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => `New first\n\n${b}`));
    expect(r.statusCode).toBe(200);
    expect((await liveBlocks(s.ctx, s.note.id)).map(b => b.text)).toEqual(["New first", "Para 0", "Para 1", "Para 2", "Para 3"]);
  });

  it("Z3c 現況被清成 0 顆頂層（note_states 換成空文件）→ 409", async () => {
    const s = await scene({}, PARAS(3));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await s.ctx.db.delete(noteStates).where(eq(noteStates.noteId, s.note.id));
    await seedDoc(s.ctx.db, s.note.id, new Y.Doc());
    expect(await topIdsOf(s.ctx, s.note.id)).toHaveLength(0);
    await refused(s, editBody(d.text, b => `${b.replace(/\n+$/, "")}\n\nPara 3 new`));
  });

  it("Z3d 只改標題、但筆記內文已被 replace_section 換過 → 409、標題不變", async () => {
    const s = await scene({}, "# H\n\nFirst para");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await replaceSection(s, "# H\n\nFirst para edited");
    await refused(s, renameIn(d.text, "Only title"));
    expect((await s.ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, s.note.id)))[0]!.title).toBe("Title");
  });

  it("Z4 基底 [A, B, C]；A、C 被換成新 id（內容相同）；agent 刪 B → 409、B 還在", async () => {
    const s = await scene({}, "A\n\nB\n\nC");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => {
      const [a, , c] = ed.document;
      ed.replaceBlocks([a!.id], [{ type: "paragraph", content: "A" }]);
      ed.replaceBlocks([c!.id], [{ type: "paragraph", content: "C" }]);
    });
    await refused(s, editBody(d.text, b => b.replace("B\n\n", "")));
    expect((await liveBlocks(s.ctx, s.note.id)).map(b => b.text)).toEqual(["A", "B", "C"]);
  });
});

describe("X 錯誤形 A–E（A 組回 note_changed）", () => {
  const CH = "# 第一章\n\n段落 A1\n\n## 1.1 小節\n\n段落 B1\n\n# 第二章\n\n段落 C1\n\n* 清單一\n* 清單二\n\n# 第三章\n\n段落 D1";
  const versions = (ctx: CollabTestCtx, noteId: string) => ctx.db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId));
  /** REST edit_note 的 replace_section／delete_section（PAT），以 heading 找那一段。 */
  async function sectionEdit(s: Awaited<ReturnType<typeof scene>>, heading: string, op: "replace_section" | "delete_section", markdown?: string) {
    const c = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json() as { outline: Array<{ sectionId: string; heading: string; fingerprint: string }> };
    const sec = c.outline.find(o => o.heading === heading)!;
    const payload = op === "replace_section" ? { op, section_id: sec.sectionId, markdown, if_match: sec.fingerprint } : { op, section_id: sec.sectionId, if_match: sec.fingerprint };
    const r = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.pat.token), payload });
    expect(r.statusCode).toBe(201);
  }
  /** 送檔 → 409 note_changed，內容逐字不變、不存版、不寫紀錄。 */
  async function expectRefused(s: Awaited<ReturnType<typeof scene>>, token: string, text: string) {
    const md0 = await liveMarkdown(s.ctx, s.note.id);
    const v0 = (await versions(s.ctx, s.note.id)).length;
    const e0 = (await edits(s.ctx, s.note.id)).length;
    const r = await bulkPut(s.ctx.app, token, text);
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual({ code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES.note_changed, reason: "note_changed" });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(md0);
    expect((await versions(s.ctx, s.note.id)).length).toBe(v0);
    expect((await edits(s.ctx, s.note.id)).length).toBe(e0);
  }
  const REPLACED = "# 第二章\n\n段落 C1 AI 改過\n\n* 清單一\n* 清單二";

  it("A-b replace_section 換掉第二章 → 送舊副本改同一段 C1 → 409", async () => {
    const s = await scene({}, CH);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await sectionEdit(s, "第二章", "replace_section", REPLACED);
    await expectRefused(s, s.bulk.token, editBody(d.text, b => b.replace("段落 C1", "段落 C1 檔案改")));
  });
  it("A-h replace_section 改成與檔案相同 → 409", async () => {
    const s = await scene({}, CH);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await sectionEdit(s, "第二章", "replace_section", "# 第二章\n\n段落 C1 一樣\n\n* 清單一\n* 清單二");
    await expectRefused(s, s.bulk.token, editBody(d.text, b => b.replace("段落 C1", "段落 C1 一樣")));
  });
  it("A-k replace_section 改 C1 後、檔案改同章的清單項 → 409", async () => {
    const s = await scene({}, CH);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await sectionEdit(s, "第二章", "replace_section", REPLACED);
    await expectRefused(s, s.bulk.token, editBody(d.text, b => b.replace("* 清單二", "* 清單二（檔案改）")));
  });
  it("A-m replace_section 改 C1 後、檔案改同章的標題 → 409", async () => {
    const s = await scene({}, CH);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await sectionEdit(s, "第二章", "replace_section", REPLACED);
    await expectRefused(s, s.bulk.token, editBody(d.text, b => b.replace("# 第二章", "# 第二章（檔案改名）")));
  });
  it("A-e delete_section 刪了第三章、檔案改 D1 → 409", async () => {
    const s = await scene({}, CH);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await sectionEdit(s, "第三章", "delete_section");
    await expectRefused(s, s.bulk.token, editBody(d.text, b => b.replace("段落 D1", "段落 D1 檔案改")));
  });
  it("A-兩個權杖：A 先寫回改 Z → B 從舊副本改 X（與 Z 不相鄰）→ 409；B 的修改都沒寫", async () => {
    const s = await scene({}, "段落 X\n\n段落 Y\n\n段落 Z");
    const pat2 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const b2 = await issueBulkDirect(s.ctx.db, pat2.tokenId, { access: "write" });
    const da = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const db = await downloadNote(s.ctx.app, b2.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(da.text, b => b.replace("段落 Z", "段落 Z：A 改")))).json()).toMatchObject({ result: "applied" });
    await expectRefused(s, b2.token, editBody(db.text, b => b.replace("段落 X", "段落 X：B 改")));
  });
  it("A-瀏覽器原地打字（block id 不變）後送舊副本改同一段 → 409、不存版", async () => {
    const s = await scene({}, CH);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => {
      const c1 = ed.document.find(b => JSON.stringify(b.content).includes("段落 C1"))!;
      ed.updateBlock(c1.id, { content: "段落 C1 人在瀏覽器改" });
    });
    await expectRefused(s, s.bulk.token, editBody(d.text, b => b.replace("段落 C1", "段落 C1 檔案改")));
    expect(await versions(s.ctx, s.note.id)).toHaveLength(0);
  });

  it("B front matter 開頭有 knotebook:／id:、卻沒有收尾的 --- → 400 invalid_body；新增與寫回兩條路都擋、什麼都沒建", async () => {
    const s = await scene();
    const n0 = (await s.ctx.db.select().from(notes)).length;
    const r1 = await bulkPut(s.ctx.app, s.bulk.token, "---\nknotebook: 1\ntitle: \"T\"\nbody text");
    expect(r1.statusCode).toBe(400);
    expect(errOf(r1)).toEqual({ code: "invalid_body", message: UNCLOSED_FRONT_MATTER_MESSAGE });
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, `---\nid: ${s.note.id}\nbase: 0123456789abcdef\nbody text`);
    expect(r2.statusCode).toBe(400);
    expect(errOf(r2)).toEqual({ code: "invalid_body", message: UNCLOSED_FRONT_MATTER_MESSAGE });
    expect((await s.ctx.db.select().from(notes)).length).toBe(n0);
    // 開頭不是 --- 的照舊當內文
    expect((await bulkPut(s.ctx.app, s.bulk.token, "body\n---\nknotebook: 1")).statusCode).toBe(201);
  });

  it("C 寫回 → 那列在 AI 修改紀錄撤回 → 同檔重送 → 409 reason reverted（不再回 unchanged）", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 1", "Para 1 new"));
    const w = await bulkPut(s.ctx.app, s.bulk.token, text);
    const [editId] = (w.json() as { editIds: string[] }).editIds;
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "unchanged" });
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${editId}/revert`, headers: bearer(s.pat.token) });
    expect(rv.statusCode).toBe(201);
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual({ code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES.reverted, reason: "reverted" });
    // 撤回後這份副本整份不收，連只改標題也一樣
    const rn = await bulkPut(s.ctx.app, s.bulk.token, renameIn(text, "New title"));
    expect(rn.statusCode).toBe(409);
    expect(errOf(rn).reason).toBe("reverted");
    expect((await s.ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, s.note.id)))[0]!.title).toBe("Title");
    expect(norm(await liveMarkdown(s.ctx, s.note.id))).toBe(PARAS(4));
  });

  it("C-旁觀者：別篇筆記的紀錄列撤回，不影響這份副本——同檔重送仍 unchanged", async () => {
    const s = await scene();
    const n2 = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Other" });
    await seedMd(s.ctx.db, n2.id, PARAS(3, "Q"));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, n2.id);
    const text = editBody(d.text, b => b.replace("Para 1", "Para 1 new"));
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "applied" });
    const w2 = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, b => b.replace("Q 1", "Q 1 new")));
    const [otherEdit] = (w2.json() as { editIds: string[] }).editIds;
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${n2.id}/edits/${otherEdit}/revert`, headers: bearer(s.pat.token) });
    expect(rv.statusCode).toBe(201);
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "unchanged" });
  });

  it("E 400 訊息照成因：事件屬性、<script>（整段或混在內文）、未閉合 <!--、block 上限、未閉合 ~~~", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const put = (f: (b: string) => string) => bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, f));
    const cases: Array<[string, (b: string) => string, string, string]> = [
      ["onerror", b => b.replace("Para 1", "<img src=x onerror=alert(1)>"), "unsupported_block", transferParseMessage("unsupported_block", "event_attr")],
      ["<script>", b => b.replace("Para 1", "<script>alert(1)</script>"), "unsupported_block", transferParseMessage("unsupported_block", "dropped_element")],
      ["混在內文的 <style>", b => b.replace("Para 1", "Para 1 改 <style>p{}</style>").replace("Para 3", "Para 3 改"), "unsupported_block", transferParseMessage("unsupported_block", "dropped_element")],
      ["未閉合 <!--", b => b.replace("Para 1", "<!-- open"), "empty_content", transferParseMessage("empty_content", "unclosed_comment")],
      ["2500 段", b => b.replace("Para 1", Array.from({ length: 2500 }, (_, i) => `p${i}`).join("\n\n")), "too_many_blocks", transferParseMessage("too_many_blocks")],
      ["未閉合 ~~~", b => b.replace("Para 3", "Para 3\n\n~~~\ncode"), "invalid_body", unclosedFenceMessage("~~~")],
    ];
    for (const [label, f, code, message] of cases) {
      const r = await put(f);
      expect(r.statusCode, label).toBe(400);
      expect(errOf(r), label).toEqual({ code, message });
    }
    expect(norm(await liveMarkdown(s.ctx, s.note.id))).toBe(PARAS(4));
  });

  it("script 裁示：含複雜內容（標題、巢狀清單、表格、引用、code 裡的 <script>／<iframe>、行內碼的 <style>、mermaid、並排、圖片）的筆記下載後原樣寫回 → unchanged；改一段 → applied、其餘逐字不變", async () => {
    const fence = "```";
    const md = [
      "# 標題一",
      "段落含 **粗體**、*斜體*、`<style>行內碼</style>` 與[連結](https://example.com)。",
      "## 小節",
      "* 項目一\n  * 子項目\n* 項目二",
      "1. 第一\n2. 第二",
      "> 引用",
      "| 欄一 | 欄二 |\n| --- | --- |\n| a | b |",
      `${fence}html\n<script>alert(1)</script>\n<iframe src="x"></iframe>\n<object data="y"></object>\n${fence}`,
      `${fence}mermaid\ngraph TD; A-->B;\n${fence}`,
      '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n左欄\n\n</div>\n<div data-kb-column style="flex:1">\n\n右欄\n\n</div>\n</div>',
      "![圖](https://example.com/a.png)",
      "段落 P",
    ].join("\n\n");
    const s = await scene({}, md);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    for (const tag of ["<script>", "<iframe", "<object", "<style>", "mermaid", "data-kb-columns"]) expect(d.text, tag).toContain(tag);
    expect((await bulkPut(s.ctx.app, s.bulk.token, d.text)).json()).toMatchObject({ result: "unchanged" });
    const text = editBody(d.text, b => b.replace("段落 P", "段落 P 改"));
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "applied", applied: 1 });
    expect(norm(await liveMarkdown(s.ctx, s.note.id))).toBe(norm(text.split("\n").slice(8).join("\n")));
  });

  it("script 裁示的邊界：段落文字本身是 <script>x</script>（瀏覽器打的字，匯出不跳脫）→ 原樣重送、改別段照舊；改那一段才 400 dropped_element", async () => {
    const s = await scene({}, "");
    await seedBlocks(s.ctx.db, s.note.id, [{ type: "paragraph", content: "<script>x</script>" }, { type: "paragraph", content: "Para A" }, { type: "paragraph", content: "Para B" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.text).toContain("<script>x</script>\n\nPara A");
    expect((await bulkPut(s.ctx.app, s.bulk.token, d.text)).json()).toMatchObject({ result: "unchanged" });
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para B", "Para B 改")))).json()).toMatchObject({ result: "applied" });
    expect((await liveBlocks(s.ctx, s.note.id)).map(b => b.text)).toEqual(["<script>x</script>", "Para A", "Para B 改"]);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, b => b.replace("<script>x</script>", "<script>x</script> 改")));
    expect(r.statusCode).toBe(400);
    expect(errOf(r)).toEqual({ code: "unsupported_block", message: transferParseMessage("unsupported_block", "dropped_element") });
  });
});
