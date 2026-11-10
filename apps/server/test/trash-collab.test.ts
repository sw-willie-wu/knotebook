/**
 * #181：共編與垃圾桶。
 * 一律接真 hooks（`createCollabHooks`）：預設 noop hooks 的 DELETE 不開閘門、不踢線，還原也不收門。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_NOTE_DELETED, YDOC_FRAGMENT, type NoteDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { COLLAB_REJECT_FORBIDDEN, COLLAB_REJECT_NOTE_DELETING } from "../src/collab/server.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { getContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, testEditingRuntime, type CollabTestCtx } from "./helpers.js";
import { trashCols } from "./trash-helpers.js";

const PASSWORD = "correct-horse-battery";

function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

async function noteStateHas(ctx: CollabTestCtx, noteId: string, text: string): Promise<boolean> {
  const { rows } = await ctx.db.$client.query<{ ydoc: Buffer }>(`select ydoc from note_states where note_id = $1`, [noteId]);
  if (!rows[0]) return false;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, rows[0].ydoc);
  return doc.getXmlFragment(YDOC_FRAGMENT).toString().includes(text);
}

describe("#181 共編與垃圾桶", () => {
  it("CL1：移入踢線（CLOSE note-deleted）；TTL 內新連線以 note-deleting 拒；閘門過期後以 forbidden 拒", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cl1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-cl1@example.com", PASSWORD);
    const client = await session.connect(note.id);

    const del = await session.fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    await waitFor("在線者收到 CLOSE(note-deleted)", 10_000, () => client.closes.some(c => c.reason === COLLAB_CLOSE_NOTE_DELETED));
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(0);
    expect((await trashCols(ctx.db.$client, note.id))?.deleted_at).not.toBeNull();

    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
    ctx.collab.unmarkDeleting(note.id); // 模擬 TTL 到期
    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);
  });

  it("CL2：移入 → 還原 → 立刻連得上並能同步（閘門被 onNotesRestored 收掉，不等 TTL）", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cl2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-cl2@example.com", PASSWORD);

    expect((await session.fetch(`/api/notes/${note.id}`, { method: "DELETE" })).status).toBe(204);
    expect(ctx.collab.isDeleting(note.id)).toBe(true);
    const res = await session.fetch("/api/trash/restore", { method: "POST", body: JSON.stringify({ ids: [note.id] }) });
    expect(res.status).toBe(200);
    expect(ctx.collab.isDeleting(note.id)).toBe(false);

    const a = await session.connect(note.id);
    const b = await session.connect(note.id);
    insertParagraph(a.doc, "CL2 還原後的字");
    await waitFor("另一端收到", 10_000, () => b.doc.getXmlFragment(YDOC_FRAGMENT).toString().includes("CL2 還原後的字"));
  });

  it("CL3：移入後直開直連寫入並落盤 → 不 throw、note_states 有那段字、仍在垃圾桶、清單不含它；還原後 /content 讀得到", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-cl3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-cl3@example.com", PASSWORD);
    expect((await session.fetch(`/api/notes/${note.id}`, { method: "DELETE" })).status).toBe(204);

    const TEXT = "CL3 落盤進垃圾桶筆記的字";
    const src = new Y.Doc();
    const s = await EditorSession.open(testEditingRuntime, src);
    try {
      s.editor.replaceBlocks(s.editor.document, [{ type: "paragraph", content: TEXT }]);
    } finally {
      s.close();
    }
    // 測試直開（繞過 withDirectConnection 的重確認）：模擬閘門後零星抵達的 store。
    const direct = await ctx.collab.hocuspocus.openDirectConnection(note.id, { userId: owner.id });
    await direct.transact(doc => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
    });
    await expect(direct.disconnect()).resolves.toBeUndefined();

    expect(await noteStateHas(ctx, note.id, TEXT)).toBe(true);
    expect((await trashCols(ctx.db.$client, note.id))?.deleted_at).not.toBeNull();
    const list = (await (await session.fetch("/api/notes")).json()) as NoteDto[];
    expect(list.map(n => n.id)).not.toContain(note.id);

    const res = await session.fetch("/api/trash/restore", { method: "POST", body: JSON.stringify({ ids: [note.id] }) });
    expect(res.status).toBe(200);
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");
    const content = await getContent(ctx.app, note.id, token);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.body).toContain(TEXT);
  });
});
