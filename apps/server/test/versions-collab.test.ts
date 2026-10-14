// 版本歷史 × 真 Hocuspocus（#272 spec 2026-10-13 §4.1、§4.2、§12.1 案 19（WS 形）；前 spec 2026-10-09 D9 的 WS 形）。
// #272 起只有一條自動規則：落盤寫待切、停手 X 後掃描器切；離開（unload）不切。本檔把 X 壓成 0，掃描一律手動呼叫 `scanDue()`。
// 斷言一律寫明「增量」還是「總數」。
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { docText, seedContent, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, testEditingRuntime } from "./helpers.js";
import { NO_PENDING, pendingOf, seedOldNote, versionsOf, waitForPending } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";

async function setup(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp({ versionAutoWaitMs: 0, ...opts });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  const scan = () => ctx.collab.versions.scanDue();
  return { ctx, u, note, session, unloaded, scan };
}
/** 在 client.doc 第一顆段落的文字上做一次編輯（模擬瀏覽器打字），等 server 收到。 */
async function typeInFirst(ctx: Awaited<ReturnType<typeof setup>>["ctx"], noteId: string, doc: Y.Doc, fn: (t: Y.XmlText) => void, sentinel: (s: string) => boolean): Promise<void> {
  const p = topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))[0]!.get(0) as Y.XmlElement;
  doc.transact(() => fn(p.get(0) as Y.XmlText));
  await waitFor("server 收到編輯", 5_000, () => sentinel(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
}

describe("#272：停手才切（§4.1）、離開不切（§4.2）", () => {
  it("(a) WS 編輯 → 落盤後待切、當下 0 版；掃描 → 增 1 版、editors 是那位使用者；再改再掃 → 再增 1；離開後掃描不多切", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "第一段種子文字");
    await waitForPending(s.ctx.db, s.note.id);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await typeInFirst(s.ctx, s.note.id, client.doc, t => t.insert(0, "再改"), x => x.includes("再改"));
    await waitForPending(s.ctx.db, s.note.id);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(2); // 增 1
    expect(rows[1]!.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
    client.disconnect();
    await s.unloaded();
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2);
  });

  it("(b) 全部斷線 → 不切（M9）、留下待切；掃描之後才 1 版", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "不等五分鐘的內容");
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    const p = await pendingOf(s.ctx.db, s.note.id);
    expect(p.at).not.toBeNull();
    expect(p.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[1, "auto"]]);
    expect(rows[0]!.editors).toEqual([{ user_id: s.u.id, agent_label: null }]);
  });
});

describe("D9：沒有憑空出現的版本（WS 形；離開後掃描）", () => {
  it("viewer 打開舊筆記再關 → 總數 0、沒有待切", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const v = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, v.id, "viewer");
    const viewer = await s.ctx.loginAs("v@example.com", PASSWORD);
    const c = await viewer.connect(s.note.id);
    c.disconnect();
    await s.unloaded();
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("editor 打開舊筆記、改一字、關 → 掃描後總數 1，內容是改後", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const c = await s.session.connect(s.note.id);
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.insert(0, "新"), x => x.includes("新舊筆記內容"));
    const after = versionFingerprint(s.ctx.collab.hocuspocus.documents.get(s.note.id)!.getXmlFragment(YDOC_FRAGMENT));
    c.disconnect();
    await s.unloaded();
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, rows[0]!.ydoc);
    expect(versionFingerprint(v1.getXmlFragment(YDOC_FRAGMENT))).toBe(after);
  });

  it("案 19：editor 打開舊筆記、打一字再刪掉、關 → 掃描後總數 0、待切清掉", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "舊筆記內容");
    const c = await s.session.connect(s.note.id);
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.insert(0, "Ω"), x => x.includes("Ω"));
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.delete(0, 1), x => !x.includes("Ω"));
    c.disconnect();
    await s.unloaded();
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("WS client 打開真空筆記、回寫一顆空段落（瀏覽器 mount 正規化的形）、斷線 → 沒有待切、掃描後總數 0", async () => {
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
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("打開真空筆記、打一字再刪掉、斷線 → 掃描後總數 0", async () => {
    const s = await setup();
    const c = await seedContent(s.ctx, s.session, s.note.id, "Ω");
    await typeInFirst(s.ctx, s.note.id, c.doc, t => t.delete(0, t.length), x => !x.includes("Ω"));
    c.disconnect();
    await s.unloaded();
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});

describe("筆記被刪時有待切", () => {
  it("掃描安靜跳過：沒有 error 級 log、零列（CASCADE）、文件照常卸載", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "會被刪掉的筆記內容");
    await waitForPending(s.ctx.db, s.note.id);
    await s.ctx.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(await s.scan()).toBe(0); // 列已刪：選不到
    client.disconnect();
    await s.unloaded();
    expect(s.ctx.collabLogs.filter(l => l.level === "error")).toEqual([]);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});
