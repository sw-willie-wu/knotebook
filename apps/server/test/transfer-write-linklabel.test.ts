/**
 * 8000 第三輪探索測試 F1：沒有自訂文字的 wikilink（顯示目標的現行標題）——下載後目標改名，在舊副本裡改含那個連結的段落再寫回，
 * 連結文字不得被凍結成自訂文字（`transfer/link-texts.ts`）。L1–L4 是總管指定的四案；L5 是這版之前下載的副本（基底沒有 `links`）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notes, transferBases } from "../src/db/schema.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testEditingRuntime } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, issueBulkDirect, seedBlocks } from "./bulk-transfer-helpers.js";

async function scene(label = "") {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "E" });
  const target = await seedNote(ctx.db, { ownerId: u.id }, { title: "Target v1" });
  await seedBlocks(ctx.db, note.id, [
    { type: "paragraph", content: [{ type: "text", text: "Para E1 links ", styles: {} }, { type: "wikilink", props: { targetNoteId: target.id, snapshotTitle: "Old snapshot", label } }, { type: "text", text: " here.", styles: {} }] },
    { type: "paragraph", content: "Para E2" },
  ]);
  const renameTarget = (title: string) => ctx.db.update(notes).set({ title }).where(eq(notes.id, target.id));
  /** 現況每個 wikilink 的 label 與 snapshotTitle（fork 上開一次 session 讀；不寫回）。 */
  const links = async () => {
    const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id);
    const s = await EditorSession.open(testEditingRuntime, doc);
    try {
      type Wl = { type: string; props?: { label: string; snapshotTitle: string } };
      return s.editor.document.flatMap(b => (Array.isArray(b.content) ? (b.content as Wl[]) : []).filter(c => c.type === "wikilink").map(c => ({ label: c.props!.label, snapshotTitle: c.props!.snapshotTitle })));
    } finally {
      s.close();
    }
  };
  /** 讀者看到的第一段（下載＝MCP 讀出：沒有自訂文字的連結顯示目標的現行標題）。 */
  const firstPara = async () => (await downloadNote(ctx.app, bulk.token, note.id)).body.split("\n").find(l => l.startsWith("Para E1"))!;
  return { ctx, u, pat, bulk, note, target, renameTarget, links, firstPara };
}
const href = (id: string) => `/notes/${id}`;

describe("F1 寫回時保住「沒有自訂文字」的 wikilink", () => {
  it("L1 下載 → 目標改名 → 舊副本改含連結的段落（連結文字沒動）→ 200 applied、label 仍空、顯示現行標題；之後再改名仍跟著變", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body).toContain(`[Target v1](${href(s.target.id)})`);
    await s.renameTarget("Target v2");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para E1 links", "Para E1 edited links")));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect(await s.links()).toEqual([{ label: "", snapshotTitle: "Target v2" }]);
    expect(await s.firstPara()).toBe(`Para E1 edited links [Target v2](${href(s.target.id)}) here.`);
    await s.renameTarget("Target v3");
    expect(await s.firstPara()).toBe(`Para E1 edited links [Target v3](${href(s.target.id)}) here.`);
  });

  it("L2 agent 把連結文字改成自訂字（目標下載後也改了名）→ 存成自訂 label；改成基底的 snapshotTitle 也算自訂", async () => {
    for (const text of ["My own words", "Old snapshot"]) {
      const s = await scene();
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      await s.renameTarget("Target v2");
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("[Target v1]", `[${text}]`)));
      expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
      expect((await s.links()).map(l => l.label)).toEqual([text]);
      await s.renameTarget("Target v3");
      expect(await s.firstPara()).toBe(`Para E1 links [${text}](${href(s.target.id)}) here.`);
    }
  });

  it("L3 目標沒改名、agent 改了同段其他字 → label 仍空；之後改名跟著變", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace(" here.", " over here.")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect((await s.links()).map(l => l.label)).toEqual([""]);
    await s.renameTarget("Target v2");
    expect(await s.firstPara()).toBe(`Para E1 links [Target v2](${href(s.target.id)}) over here.`);
  });

  it("L4 連結原本就有自訂文字 → 目標改名、改同段其他字寫回 → 保持那個自訂文字", async () => {
    const s = await scene("Custom words");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body).toContain(`[Custom words](${href(s.target.id)})`);
    await s.renameTarget("Target v2");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para E1 links", "Para E1 edited links")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect((await s.links()).map(l => l.label)).toEqual(["Custom words"]);
    expect(await s.firstPara()).toBe(`Para E1 edited links [Custom words](${href(s.target.id)}) here.`);
  });

  it("L5 基底段表沒有 links（這版之前下載的副本）→ 照舊規則：下載時的標題存成自訂文字", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const [row] = await s.ctx.db.select().from(transferBases).where(eq(transferBases.key, d.fm.base!));
    expect(row!.segments!.some(sg => (sg.links?.length ?? 0) > 0)).toBe(true);
    await s.ctx.db.update(transferBases).set({ segments: row!.segments!.map(({ links: _l, ...sg }) => sg) }).where(eq(transferBases.key, d.fm.base!));
    await s.renameTarget("Target v2");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para E1 links", "Para E1 edited links")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect((await s.links()).map(l => l.label)).toEqual(["Target v1"]);
  });
});
