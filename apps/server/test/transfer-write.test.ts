/**
 * bulk transfer spec 2026-11-02 §9（寫回既有筆記）；plan PR-2 T8（W1–W17）。流程：`downloadNote` → `editBody` → `bulkPut`。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { noteAiEdits, notes, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildCollabTestApp, testConfig, type CollabTestCtx } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { seedNote, seedShare, seedUser } from "./group-helpers.js";
import { basesOf, bulkPut, downloadNote, editBody, humanEdit, issueBulkDirect, liveMarkdown, seedMd, topIdsOf } from "./bulk-transfer-helpers.js";

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
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string } }).error;
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
    expect(body).toMatchObject({ result: "applied", applied: 1, same: 0, conflicts: 0, renamed: false, base: null, created: false });
    expect(body).not.toHaveProperty("version");
    expect((body.editIds as string[]).length).toBe(1);
    expect(norm(await liveMarkdown(s.ctx, s.note.id))).toBe(norm(editBody(d.text, b => b.replace("Para 1", "Para 1 new")).split("\n").slice(8).join("\n")));
    const ids1 = await topIdsOf(s.ctx, s.note.id);
    expect([ids1[0], ids1[2], ids1[3]]).toEqual([ids0[0], ids0[2], ids0[3]]);
    expect(ids1[1]).not.toBe(ids0[1]);
    const rows = await edits(s.ctx, s.note.id);
    expect(rows.map(x => x.op)).toEqual(["file_sync"]);
    expect((await baseRow(s.ctx, d.fm.base!)).appliedBodySha).not.toBeNull();
  });

  // isBlocked 預檢在佇列之前（§9.2-4）：桶滿時連同檔重送都 429，所以這裡用 limit 2——寫一次、重送、再寫一篇仍成功＝重送沒扣。
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
    expect(errOf(w4).code).toBe("base_unavailable");
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(after);
    // 重送與 409 都沒扣 → limit 2 還剩 1：再寫一篇仍 200
    const n2 = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "N2" });
    await seedMd(s.ctx.db, n2.id, "Only para");
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, n2.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, () => "Changed para"))).statusCode).toBe(200);
  });

  it("W5 409 三形：別人的 base、別篇的 base、不存在的 16 hex", async () => {
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
    for (const [label, base] of [["別人的", vd.fm.base!], ["別篇的", od.fm.base!], ["不存在", "ffffffffffffffff"]] as const) {
      const r = await bulkPut(s.ctx.app, s.bulk.token, changed(base));
      expect(r.statusCode, label).toBe(409);
      expect(errOf(r).code, label).toBe("base_unavailable");
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
    expect(errOf(r).code).toBe("base_unavailable");
    expect(await liveMarkdown(ctx2, s.note.id)).toBe(before);
    expect(await edits(ctx2, s.note.id)).toHaveLength(0);
  });

  it("W6 not_mergeable：改內容 → 409；原樣重送 → unchanged", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "x")));
    expect(r.statusCode).toBe(409);
    expect(errOf(r).code).toBe("not_mergeable");
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, d.text);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ result: "unchanged" });
  });

  it("W7 只插空行 → unchanged、applied_body_sha 已寫、不扣 transferWrite", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1\n", "Para 1\n\n\n")));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "unchanged" });
    expect((await baseRow(s.ctx, d.fm.base!)).appliedBodySha).not.toBeNull();
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
      ["unsupported_color", editBody(d.text, b => b.replace("B", 'x <span style="color:#ff6600">o</span>')), "unsupported_color"],
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
    expect(errOf(r).code).toBe("invalid_body");
    expect(errOf(r).message).toContain("```");
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
    expect(errOf(viewer).message).toBe("沒有編輯權限");
    // 範圍外：folder 範圍的權杖、筆記不在那個資料夾
    const f = (await seedFolder(s.ctx.db, { personal: s.u.id }, { name: "F" })).id;
    const fbulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write", range: { kind: "folder", folderId: f } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const out = await bulkPut(s.ctx.app, fbulk.token, editBody(d.text, b => b.replace("Para 1", "x")));
    expect(out.statusCode).toBe(403);
    expect(errOf(out).message).toBe("這篇筆記不在此 transfer token 的範圍內");
    // 範圍物件看不到：刪掉資料夾
    await s.ctx.db.execute(sql`delete from folders where id = ${f}`);
    const gone = await bulkPut(s.ctx.app, fbulk.token, editBody(d.text, b => b.replace("Para 1", "x")));
    expect(gone.statusCode).toBe(403);
    expect(errOf(gone).message).toBe("此 transfer token 的範圍已看不到");
    // access=read
    const rbulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "read" });
    expect((await bulkPut(s.ctx.app, rbulk.token, editBody(d.text, b => b.replace("Para 1", "x")))).statusCode).toBe(403);
    // 垃圾桶
    await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, s.note.id));
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "x")))).statusCode).toBe(404);
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
    expect(String(r.headers["retry-after"])).toMatch(/^[1-9]\d*$/);
    expect(await liveMarkdown(s.ctx, n2.id)).toBe(before);
  });

  it("W10b（T8-M8）isBlocked 預檢在佇列之前（§9.2-4）：桶滿時連「同檔重送」也 429（不進佇列、不規劃），沒有預檢會回 200 unchanged", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 1", "x"));
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).statusCode).toBe(200);
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).statusCode).toBe(429);
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
    expect(errOf(r2).code).toBe("server_busy");
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

describe("W13 log 鍵集合（§13＋plan §0.1-10：13 鍵；錯誤出口 diff 鍵 null）", () => {
  it("applied／409／400 各恰一行 info、鍵恰 13 個；log 不含標題、本文、檔內標記、knbt_", async () => {
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
    const KEYS = ["userId", "tokenId", "noteId", "result", "applied", "same", "conflicts", "versionId", "ms", "diffOverflow", "anchored", "degradedLines", "clientClosed"];
    const PINO = new Set(["level", "time", "pid", "hostname", "reqId", "msg"]);
    for (const l of lines) expect(Object.keys(l).filter(k => !PINO.has(k)).sort()).toEqual([...KEYS].sort());
    expect(lines.map(l => l.result)).toEqual(["empty_content", "applied", "base_unavailable"]);
    for (const l of [lines[0]!, lines[2]!]) for (const k of ["applied", "same", "conflicts", "versionId", "diffOverflow", "anchored", "degradedLines"]) expect(l[k], `${l.result}.${k}`).toBeNull();
    expect(lines[1]).toMatchObject({ applied: 1, same: 0, conflicts: 0, diffOverflow: false, clientClosed: false });
    const all = chunks.join("");
    for (const m of ["SecretBodyMarker", "SecretTitleMarker", "knbt_"]) expect(all).not.toContain(m);
  });

  it("W13b（審查 m1）未預期的例外（紀錄交易 trigger 失敗）→ 500、`bulk transfer write` 恰一行、result internal、13 鍵且 diff 鍵 null；log 不含本文與 Failed query", async () => {
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
    const KEYS = ["userId", "tokenId", "noteId", "result", "applied", "same", "conflicts", "versionId", "ms", "diffOverflow", "anchored", "degradedLines", "clientClosed"];
    const PINO = new Set(["level", "time", "pid", "hostname", "reqId", "msg"]);
    expect(Object.keys(lines[0]!).filter(k => !PINO.has(k)).sort()).toEqual([...KEYS].sort());
    expect(lines[0]).toMatchObject({ result: "internal", noteId: s.note.id, clientClosed: false });
    for (const k of ["applied", "same", "conflicts", "versionId", "diffOverflow", "anchored", "degradedLines"]) expect(lines[0]![k], k).toBeNull();
    const all = chunks.join("");
    for (const m of ["SecretBodyMarker", "Failed query", "W13bTriggerMarker"]) expect(all, m).not.toContain(m);
  });
});

describe("W14 空筆記（gate r1 I5）", () => {
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
});

describe("W15 帶內容的 DB 失敗不洩內容（gate r1 I4、r2 I-3）", () => {
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
  it("(b) 存版失敗（衝突 → cutIfDirty）→ 500、筆記未變、log 不含本文標記", async () => {
    const c = capture();
    const s = await scene({ logger: c.logger });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[1]!.id, { content: "W15HumanMarkerB" }));
    const before = await liveMarkdown(s.ctx, s.note.id);
    const r = await withTrigger(s.ctx, "note_versions", "before insert", () => bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "W15BodyMarkerB"))));
    expect(r.statusCode).toBe(500);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    assertClean(c.chunks, "W15HumanMarkerB");
    expect(c.chunks.join("")).not.toContain("W15BodyMarkerB");
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
});

describe("W16 溢位不改回別人的修改（gate r1 I6，真上限）", () => {
  it("2 500 段；人改第 1 200 段；agent 改 0–599 與 1 900–2 499 → 第 1 200 段仍是人的、沒存版、log diffOverflow／anchored／degradedLines", async () => {
    const chunks: string[] = [];
    const s = await scene({ logger: { level: "info", stream: { write: (x: string) => void chunks.push(x) } } }, PARAS(2500, "Unique line"));
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[1200]!.id, { content: "Human changed 1200" }));
    const text = editBody(d.text, b =>
      b
        .replace(/\n+$/, "")
        .split("\n\n")
        .map((p, i) => (i < 600 || i >= 1900 ? `${p} agent` : p))
        .join("\n\n"),
    );
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", conflicts: 0 });
    expect(r.json()).not.toHaveProperty("version");
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md).toContain("Human changed 1200");
    expect(md).toContain("Unique line 0 agent");
    expect(md).toContain("Unique line 2499 agent");
    const line = chunks.flatMap(c => c.split("\n")).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).find(o => o.msg === "bulk transfer write")!;
    expect(line.diffOverflow).toBe(true);
    expect(line.anchored as number).toBeGreaterThanOrEqual(1300);
    expect(line.degradedLines).toBe(0);
  }, 180_000);
});

describe("W17 紀錄交易失敗後重送不重複（gate r1 m11）", () => {
  it("改寫、刪除、插入兩段 → 紀錄失敗 500 → 同檔重送 → unchanged；內容不重複、頂層 id 唯一、沒有新版本", async () => {
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
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ result: "unchanged" });
    expect(r2.json()).not.toHaveProperty("version");
    const ids = await topIdsOf(s.ctx, s.note.id);
    expect(ids).toHaveLength(idsAfterMerge.length);
    expect(new Set(ids).size).toBe(ids.length);
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md.split("InsertedOne").length - 1).toBe(1);
    expect(md.split("InsertedTwo").length - 1).toBe(1);
    expect((await baseRow(s.ctx, d.fm.base!)).appliedBodySha).not.toBeNull();
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "unchanged" });
  });
});
