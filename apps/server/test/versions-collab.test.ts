// 版本歷史 × 真 Hocuspocus（spec 2026-10-09 §11.2 三切點 (a)(b)、D9 的 WS 形、Review Focus RF3）。
// 斷言一律寫明「增量」還是「總數」：seedContent 走 WS，斷線就會觸發 unload 切版（spec §11.2 開頭）。
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { docText, seedContent, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, testEditingRuntime } from "./helpers.js";
import { seedOldNote, versionsOf, waitForVersionCount } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";

async function setup(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  return { ctx, u, note, session, unloaded };
}
/** 在 client.doc 第一顆段落的文字上做一次編輯（模擬瀏覽器打字），等 server 收到。 */
async function typeInFirst(ctx: Awaited<ReturnType<typeof setup>>["ctx"], noteId: string, doc: Y.Doc, fn: (t: Y.XmlText) => void, sentinel: (s: string) => boolean): Promise<void> {
  const p = topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))[0]!.get(0) as Y.XmlElement;
  doc.transact(() => fn(p.get(0) as Y.XmlText));
  await waitFor("server 收到編輯", 5_000, () => sentinel(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
}

describe("三切點 (a)(b)", () => {
  it("(a) WS 編輯 → idle 到期 → 增 1 版、editors 是那位使用者", async () => {
    const s = await setup({ versionIdleMs: 50 });
    const client = await seedContent(s.ctx, s.session, s.note.id, "第一段種子文字");
    await waitForVersionCount(s.ctx.db, s.note.id, 1); // 種子本身被 idle 切成 v1（落盤 debounce 2 s ＋ 50 ms）
    await typeInFirst(s.ctx, s.note.id, client.doc, t => t.insert(0, "再改"), x => x.includes("再改"));
    await waitForVersionCount(s.ctx.db, s.note.id, 2); // 增 1
    expect((await versionsOf(s.ctx.db, s.note.id))[1]!.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2); // 已切過、unload 不多切
  });

  it("(b) 全部斷線 → beforeUnloadDocument 增 1 版（不等 idle）", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "不等五分鐘的內容");
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    client.disconnect();
    await s.unloaded();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[1, "auto"]]);
    expect(rows[0]!.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
  });
});

describe("D9：沒有憑空出現的版本（WS 形）", () => {
  it("viewer 打開舊筆記再關 → 總數 0", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const v = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, v.id, "viewer");
    const viewer = await s.ctx.loginAs("v@example.com", PASSWORD);
    const c = await viewer.connect(s.note.id);
    c.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("editor 打開舊筆記、改一字、關 → 總數 1，內容是改後", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const c = await s.session.connect(s.note.id);
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.insert(0, "新"), x => x.includes("新舊筆記內容"));
    const after = versionFingerprint(s.ctx.collab.hocuspocus.documents.get(s.note.id)!.getXmlFragment(YDOC_FRAGMENT));
    c.disconnect();
    await s.unloaded();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, rows[0]!.ydoc);
    expect(versionFingerprint(v1.getXmlFragment(YDOC_FRAGMENT))).toBe(after);
  });

  it("editor 打開舊筆記、打一字再刪掉、關 → 總數 0", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const c = await s.session.connect(s.note.id);
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.insert(0, "Ω"), x => x.includes("Ω"));
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.delete(0, 1), x => !x.includes("Ω"));
    c.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("WS client 打開真空筆記、回寫一顆空段落（瀏覽器 mount 正規化的形）、斷線 → 總數 0", async () => {
    const s = await setup();
    const c = await s.session.connect(s.note.id);
    // ⚠ server 端 headless EditorSession 只 mount 不會回寫（Task 6 實跑：mount 後 client fragment 仍是空字串），
    // 所以這裡明寫「一顆預設屬性的空段落」——即瀏覽器打開真空筆記時正規化回寫的那個形。
    const ed = await EditorSession.open(testEditingRuntime, c.doc);
    try {
      ed.editor.replaceBlocks(ed.editor.document, [{ type: "paragraph" }]);
    } finally {
      ed.close();
    }
    await waitFor("server 收到正規化段落", 5_000, () => topLevelContainers(s.ctx.collab.hocuspocus.documents.get(s.note.id)!.getXmlFragment(YDOC_FRAGMENT)).length === 1);
    c.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("打開真空筆記、打一字再刪掉、斷線 → 總數 0", async () => {
    const s = await setup();
    const c = await seedContent(s.ctx, s.session, s.note.id, "Ω");
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.delete(0, t.length), x => !x.includes("Ω"));
    c.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});

describe("RF3：筆記被刪時計時器還在跑", () => {
  it("到期安靜跳過：沒有 error 級 log、零列（CASCADE）、文件照常卸載", async () => {
    // 總管裁定（預檢 I-2）：idle 壓到 500 ms，刪除排在「計時器已掛」之後、到期之前（以 debugState().hasTimer 為屏障），
    // 再等到期跑完——不賭 50 ms 的窗口。
    const s = await setup({ versionIdleMs: 500 });
    const client = await seedContent(s.ctx, s.session, s.note.id, "會被刪掉的筆記內容");
    await waitFor("idle 計時器已掛", 5_000, () => s.ctx.collab.versions.debugState(s.note.id)?.hasTimer === true);
    await s.ctx.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(s.ctx.collab.versions.debugState(s.note.id)?.hasTimer).toBe(true); // 刪除時計時器仍在跑（尚未到期）
    await waitFor("idle 計時器到期", 5_000, () => s.ctx.collab.versions.debugState(s.note.id)?.hasTimer === false);
    await new Promise(r => setTimeout(r, 300)); // 讓到期回呼裡的切版（若有）跑完
    client.disconnect();
    await s.unloaded();
    expect(s.ctx.collabLogs.filter(l => l.level === "error")).toEqual([]);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});
