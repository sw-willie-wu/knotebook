// 套用版本與手動儲存（spec 2026-10-09 §7、§11.2「套用」「手動儲存」「沒有 WS 連線時 REST 套用」「指紋」的空版本案）。
// 直接驅動 NoteWriteService（另建一個實例、自己的佇列）：REST 的映射在 Task 9。
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { noteAiEdits, noteLinks, noteStates, noteVersions, notes } from "../src/db/schema.js";
import type { EditingTestHooks } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { NoteWriteService } from "../src/notes/editing/write-service.js";
import { seedDoc } from "./copy-helpers.js";
import { docText, seedContent, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, testEditingRuntime, type TestClient } from "./helpers.js";
import { noteBase, seedOldNote, versionsOf } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";

async function setup() {
  let onMerge: (() => Promise<void>) | null = null;
  let onBase: (() => Promise<void>) | null = null;
  const hooks: EditingTestHooks = {
    beforeMerge: async () => { if (onMerge) await onMerge(); },
    beforeVersionBase: async () => { if (onBase) await onBase(); },
  };
  const ctx = await buildCollabTestApp();
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const writes = new NoteWriteService({ db: ctx.db, collab: ctx.collab, editing: testEditingRuntime, versions: ctx.collab.versions, testHooks: hooks });
  const log = ctx.app.log;
  const apply = (seq: number, versionId: string, discardUnsaved = false) =>
    writes.applyVersion(log, { noteId: note.id, seq, versionId, userId: u.id, discardUnsaved });
  const save = (name: string | null = null) => writes.saveVersion(log, { noteId: note.id, userId: u.id, name });
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  const live = () => ctx.collab.hocuspocus.documents.get(note.id)!;
  const setHooks = (h: { merge?: (() => Promise<void>) | null; base?: (() => Promise<void>) | null }) => {
    if (h.merge !== undefined) onMerge = h.merge;
    if (h.base !== undefined) onBase = h.base;
  };
  return { ctx, u, note, session, writes, apply, save, unloaded, live, setHooks };
}
type S = Awaited<ReturnType<typeof setup>>;

/** 以 provider 側編輯器整篇換成 blocks（模擬瀏覽器），等 server 收到哨兵字串。 */
async function setBlocks(s: S, client: TestClient, blocks: unknown[], sentinel: string): Promise<void> {
  const ed = await EditorSession.open(testEditingRuntime, client.doc);
  try {
    ed.editor.replaceBlocks(ed.editor.document, blocks as never);
  } finally {
    ed.close();
  }
  await waitFor(`server 收到（${sentinel}）`, 5_000, () => docText(s.live()).includes(sentinel));
}
const ids = (d: Y.Doc) => topLevelContainers(d.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id"));

/** v1＝「第一版」＋連到 other 的 wikilink；v2＝「第二版」沒有連結。回 v1、v2 的列與 other。 */
async function twoVersions(s: S) {
  const other = await s.ctx.createNote(s.u.id, "Other");
  const client = await s.session.connect(s.note.id);
  await setBlocks(s, client, [
    { type: "paragraph", content: [{ type: "text", text: "第一版 ", styles: {} }, { type: "wikilink", props: { targetNoteId: other.id, snapshotTitle: "Other" } }] },
  ], "第一版");
  const r1 = await s.save("一");
  await setBlocks(s, client, [{ type: "paragraph", content: "第二版內容" }], "第二版內容");
  const r2 = await s.save("二");
  if (!r1.ok || !r2.ok) throw new Error("前置 save 失敗");
  return { client, other, v1: r1.row, v2: r2.row };
}

/** 沒有任何 WS 連線、文件也沒載入時，把 note_states 整份換成 markdown 寫出來的內容（server 端 EditorSession，不經 Hocuspocus）。 */
async function overwriteState(s: S, markdown: string): Promise<void> {
  const doc = new Y.Doc();
  const ed = await EditorSession.open(testEditingRuntime, doc);
  try {
    ed.editor.replaceBlocks(ed.editor.document, ed.editor.tryParseMarkdownToBlocks(markdown));
  } finally {
    ed.close();
  }
  await s.ctx.db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)) }).where(eq(noteStates.noteId, s.note.id));
}

async function storedText(s: S): Promise<string> {
  const [row] = await s.ctx.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, s.note.id));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row!.ydoc);
  return docText(doc);
}

describe("套用（§7、§11.2）", () => {
  it("正常：內容＝快照（另一條連線看得到）、區塊 id 保留、基底更新、dirty=false、不增版本、不寫 note_ai_edits、落款是人、note_links 更新", async () => {
    const s = await setup();
    const { client, other, v1 } = await twoVersions(s);
    const v1doc = new Y.Doc();
    Y.applyUpdate(v1doc, v1.ydoc);
    const out = await s.apply(1, v1.id);
    expect(out).toEqual({ ok: true, result: { applied: true }, agentLabel: null });
    const second = await s.session.connect(s.note.id);
    await waitFor("第二條連線同步", 5_000, () => docText(second.doc).includes("第一版"));
    expect(docText(second.doc)).not.toContain("第二版內容");
    expect(ids(second.doc)).toEqual(ids(v1doc));
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(1);
    expect(await s.ctx.collab.versions.currentOf(s.note.id)).toMatchObject({ baseSeq: 1, dirty: false, nextSeq: 3 });
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toEqual([]);
    const [stamp] = await s.ctx.db.select({ by: notes.lastEditedBy, label: notes.lastEditedAgentLabel, tokenId: notes.lastEditedTokenId }).from(notes).where(eq(notes.id, s.note.id));
    expect(stamp).toEqual({ by: s.u.id, label: null, tokenId: null });
    expect((await s.ctx.db.select({ t: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, s.note.id))).map(r => r.t)).toEqual([other.id]);
    client.disconnect();
    second.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2); // unload 不多切（fp === 基底）
  });

  it("套用再改再切 → 新版 base_seq＝被套用的版號（「從 v1 接著改」）", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    await s.apply(1, v1.id);
    await setBlocks(s, client, [{ type: "paragraph", content: "從一接著改" }], "從一接著改");
    const r = await s.save();
    expect(r).toMatchObject({ ok: true, upgraded: false, row: { seq: 3, baseSeq: 1 } });
    client.disconnect();
  });

  it("dirty 且 discardUnsaved=false → version_unsaved_changes、內容不變；discardUnsaved=true → 套用", async () => {
    const s = await setup();
    const { client, v1, v2 } = await twoVersions(s);
    await setBlocks(s, client, [{ type: "paragraph", content: "未存的修改" }], "未存的修改");
    // §6.4 優先序：dirty 文件上 versionId 對不上 → 仍是 version_mismatch（讀列在 isDirty 之前），不是 version_unsaved_changes。
    expect(await s.apply(1, v2.id)).toEqual({ ok: false, kind: "apply", code: "version_mismatch" });
    expect(await s.apply(1, v1.id)).toEqual({ ok: false, kind: "apply", code: "version_unsaved_changes" });
    expect(docText(s.live())).toContain("未存的修改");
    expect(await s.apply(1, v1.id, true)).toMatchObject({ ok: true });
    await waitFor("provider 收到套用", 5_000, () => docText(client.doc).includes("第一版"));
    client.disconnect();
  });

  it("fork 與 merge 之間有人改字：discardUnsaved=true → 第一次重試成功；連續兩次不符 → 409 且內容不變", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    let n = 0;
    s.setHooks({ merge: async () => {
      n += 1;
      if (n === 1) await setBlocks(s, client, [{ type: "paragraph", content: "插隊一" }], "插隊一");
    } });
    expect(await s.apply(1, v1.id, true)).toMatchObject({ ok: true });
    expect(n).toBe(2);
    expect(docText(s.live())).not.toContain("插隊一");
    expect(docText(s.live())).toContain("第一版");
    // 重試那一輪的 out 寫回基底：指向 v1、套用後不 dirty。
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(1);
    expect(await s.ctx.collab.versions.currentOf(s.note.id)).toMatchObject({ baseSeq: 1, dirty: false });

    s.setHooks({ merge: async () => {
      n += 1;
      await setBlocks(s, client, [{ type: "paragraph", content: `每次都插隊${n}` }], `每次都插隊${n}`);
    } });
    const before = n;
    expect(await s.apply(2, (await versionsOf(s.ctx.db, s.note.id))[1]!.id, true)).toEqual({ ok: false, kind: "apply", code: "version_unsaved_changes" });
    expect(n - before).toBe(2);
    expect(docText(s.live())).toContain(`每次都插隊${n}`);
    client.disconnect();
  });

  it("discardUnsaved=false 且 fork 之後有人改字 → 第一次重試的 isDirty 就 409（只 merge 一次）", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    const baseBefore = await noteBase(s.ctx.db, s.note.id);
    let n = 0;
    s.setHooks({ merge: async () => {
      n += 1;
      await setBlocks(s, client, [{ type: "paragraph", content: "插隊" }], "插隊");
    } });
    expect(await s.apply(1, v1.id)).toEqual({ ok: false, kind: "apply", code: "version_unsaved_changes" });
    expect(n).toBe(1);
    // 內容沒被套（仍是插隊的那份）、基底不動（仍指向 v2）。
    expect(docText(s.live())).toContain("插隊");
    expect(docText(s.live())).not.toContain("第一版");
    expect(baseBefore.baseSeq).toBe(2);
    expect(await noteBase(s.ctx.db, s.note.id)).toEqual(baseBefore);
    client.disconnect();
  });

  it("versionId 對不上 → version_mismatch；seq 不存在 → not_found", async () => {
    const s = await setup();
    const { client, v2 } = await twoVersions(s);
    expect(await s.apply(1, v2.id)).toEqual({ ok: false, kind: "apply", code: "version_mismatch" });
    expect(await s.apply(99, v2.id)).toEqual({ ok: false, kind: "apply", code: "not_found" });
    client.disconnect();
  });

  it("beforeDisconnect 失敗 → 內容已套、基底未更新、該次 unload 不切版、applying 已清", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    client.disconnect();
    await s.unloaded(); // 沒有 WS：套用的直連會在 disconnect 時 unload
    s.setHooks({ base: async () => { throw new Error("基底寫回失敗（測試）"); } });
    expect(await s.apply(1, v1.id)).toMatchObject({ ok: true });
    await s.unloaded();
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(2);
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2);
    const again = await s.session.connect(s.note.id);
    expect(docText(again.doc)).toContain("第一版");
    expect(s.ctx.collab.versions.debugState(s.note.id)?.applying).toBe(false);
    again.disconnect();
  });

  it("排隊期間該版被刪 → 基底 NULL（0 列分支）、內容照套", async () => {
    const s = await setup();
    const { client, v1 } = await twoVersions(s);
    s.setHooks({ merge: async () => {
      await s.ctx.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`);
    } });
    expect(await s.apply(1, v1.id)).toMatchObject({ ok: true });
    expect(await noteBase(s.ctx.db, s.note.id)).toMatchObject({ baseSeq: null, baseFingerprint: null });
    expect((await s.ctx.collab.versions.currentOf(s.note.id))!.baseSeq).toBeNull();
    client.disconnect();
  });

  it("沒有人開著的筆記（舊筆記、從未有 WS）套用 → version_base_seq＝套用的版號、版本數不變、unload 不多切、內容落盤", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記第一版");
    const r1 = await s.save("一");
    await overwriteState(s, "舊筆記第二版");
    const r2 = await s.save("二");
    if (!r1.ok || !r2.ok) throw new Error("前置 save 失敗");
    expect([r1.row.seq, r2.row.seq, (await noteBase(s.ctx.db, s.note.id)).baseSeq]).toEqual([1, 2, 2]);
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0);
    expect(await s.apply(1, r1.row.id)).toMatchObject({ ok: true });
    await s.unloaded();
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(1);
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2);
    const text = await storedText(s);
    expect(text).toContain("舊筆記第一版");
    expect(text).not.toContain("舊筆記第二版");
  });

  it("沒有人開著的筆記、排隊期間該版被刪 → reset 發生在 disconnect 之前，該次 unload 依「沒有基底」規則切出新版並成為基底", async () => {
    // 守「基底寫回在 disconnect 之前」：卸載跑在 disconnect 裡，若寫回（含 reset）搬到 disconnect 之後，卸載時 applying 仍為 true
    // → 自動切版略過，最後只剩 seq 2 一版（Task 8 突變 M8 實跑）。上一案（1 列分支）對同一突變是等價的（M7 實跑全綠）。
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記第一版");
    const r1 = await s.save("一");
    await overwriteState(s, "舊筆記第二版");
    const r2 = await s.save("二");
    if (!r1.ok || !r2.ok) throw new Error("前置 save 失敗");
    s.setHooks({ merge: async () => {
      await s.ctx.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`);
    } });
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0);
    expect(await s.apply(1, r1.row.id)).toMatchObject({ ok: true });
    await s.unloaded();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[2, "manual"], [3, "auto"]]);
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(3);
    const v3 = new Y.Doc();
    Y.applyUpdate(v3, rows[1]!.ydoc);
    expect(docText(v3)).toContain("舊筆記第一版");
  });

  it("空版本套用後 dirty=false（§7-4：留一顆空段落，fpAfter＝真空指紋）", async () => {
    const s = await setup();
    const empty = await s.save("空"); // 新筆記、沒有基底、真空：手動照建（§6.3 作者補）
    const client = await s.session.connect(s.note.id);
    await setBlocks(s, client, [{ type: "paragraph", content: "後來的內容" }], "後來的內容");
    await s.save();
    if (!empty.ok) throw new Error("前置失敗");
    expect(await s.apply(1, empty.row.id)).toMatchObject({ ok: true });
    expect(topLevelContainers(s.live().getXmlFragment(YDOC_FRAGMENT))).toHaveLength(1);
    expect(await s.ctx.collab.versions.currentOf(s.note.id)).toMatchObject({ baseSeq: 1, dirty: false });
    client.disconnect();
  });
});

describe("手動儲存（§6.3 的 service 半段）", () => {
  it("乾淨且有基底 → upgraded、總數不變；dirty → 新版；沒有基底的舊筆記（沒載入）→ 建一版；筆記已刪 → note-deleted", async () => {
    const s = await setup();
    const old = new Y.Doc();
    const ed = await EditorSession.open(testEditingRuntime, old);
    try {
      ed.editor.replaceBlocks(ed.editor.document, ed.editor.tryParseMarkdownToBlocks("舊筆記"));
    } finally {
      ed.close();
    }
    await seedDoc(s.ctx.db, s.note.id, old);
    expect(await s.save("首存")).toMatchObject({ ok: true, upgraded: false, row: { seq: 1, kind: "manual", name: "首存" } });
    expect(await s.save("改名")).toMatchObject({ ok: true, upgraded: true, row: { seq: 1, name: "改名" } });
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    const client = await seedContent(s.ctx, s.session, s.note.id, "新增的一段文字");
    expect(await s.save()).toMatchObject({ ok: true, upgraded: false, row: { seq: 2 } });
    client.disconnect();
    await s.unloaded();
    await s.ctx.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(await s.save()).toEqual({ ok: false, kind: "note-deleted" });
  });
});
