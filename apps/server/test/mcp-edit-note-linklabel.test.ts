/**
 * #387：沒有自訂文字的 wikilink（顯示目標的現行標題）——agent 讀到之後目標改名，agent 照讀到的文字用 `edit_note`（或 `create_note`）
 * 寫回，連結不得被凍結成自訂文字（`notes/editing/shown-link-texts.ts`）。批次寫回的同一件事是 #385（`transfer-write-linklabel.test.ts`）。
 *
 * N1 是 issue 的情境；N2 是「agent 真的改了文字」；N3 其他會寫連結的 op（insert_after／append／replace_all，含寫進另一篇）；
 * N4 記憶是每個人自己的，REST `GET /content` 讀到的也算；N5 讀到同一段文字的自訂文字連結 → 不當成沒有自訂文字；N6 `create_note`；
 * N7 agent 自己寫的連結（沒讀過）、目標改名後用回覆的指紋原樣寫回（審查 I1）；N8／N9 REST `/edits` 與撤回 409 的 `current` 也算讀到（審查 I2）；
 * N11 自己寫的自訂文字連結原樣寫回仍是自訂文字（第二輪 I-a）；N12 合併失敗的寫入不記（m-a）；N13 被清掉的原文字隨寫入延長期限（m-b）。
 *
 * ⚠ scene 用 `seedBlocks` 直接種連結（不經寫入）：寫入也會記在寫入者名下（I1），用 `edit_note` 種的話 N1／N3／N6 不讀也會過，
 * 就守不到「讀出會記」了。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { ShownLinkTexts } from "../src/notes/editing/shown-link-texts.js";
import { buildCollabTestApp } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { loadDoc } from "./copy-helpers.js";
import { seedBlocks } from "./bulk-transfer-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

async function call(app: FastifyInstance, token: string, name: string, args: unknown) {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  const result = res.json().result as { isError?: true; structuredContent: Record<string, unknown> };
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
  return result.structuredContent;
}
async function readTop(app: FastifyInstance, token: string, noteId: string): Promise<{ markdown: string; fingerprint: string }> {
  const r = (await call(app, token, "read_note_section", { note_id: noteId, section_id: "_top" })) as { section: { markdown: string; fingerprint: string } };
  return r.section;
}
type Wl = { targetNoteId: string; label: string; snapshotTitle: string };
async function links(ctx: Awaited<ReturnType<typeof buildCollabTestApp>>, noteId: string): Promise<Wl[]> {
  const doc = await loadDoc(ctx.db, noteId);
  const out: Wl[] = [];
  if (doc === null) return out; // 從未寫進過內容的筆記沒有 note_states 列
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlElement && x.nodeName === "wikilink")) {
    const a = (n as Y.XmlElement).getAttributes() as Partial<Wl>;
    out.push({ targetNoteId: a.targetNoteId ?? "", label: a.label ?? "", snapshotTitle: a.snapshotTitle ?? "" });
  }
  return out;
}

async function scene(extra: unknown[] = [], opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
  const target = await ctx.createNote(owner.id, "Target v1");
  const host = await ctx.createNote(owner.id, "Host");
  const href = `/notes/${target.id}`;
  // 直接種（不經寫入、不經讀出）：這之後 owner 沒有讀到過、也沒有寫過任何連結。
  await seedBlocks(ctx.db, host.id, [
    { type: "paragraph", content: [{ type: "text", text: "Para links ", styles: {} }, { type: "wikilink", props: { targetNoteId: target.id, snapshotTitle: "Target v1", label: "" } }, { type: "text", text: " here.", styles: {} }] },
    ...extra,
  ]);
  const rename = (title: string) => ctx.db.update(notes).set({ title }).where(eq(notes.id, target.id));
  return { ctx, owner, token, target, host, href, rename };
}

describe("#387 edit_note 寫回時保住「沒有自訂文字」的 wikilink", () => {
  it("N1 讀到 → 目標改名 → 舊指紋 replace_section、連結文字沒動 → label 仍空、snapshotTitle 是現行標題；之後再改名仍跟著變", async () => {
    const s = await scene();
    expect((await links(s.ctx, s.host.id)).map(l => l.label)).toEqual([""]);
    const read = await readTop(s.ctx.app, s.token, s.host.id);
    expect(read.markdown).toContain(`[Target v1](${s.href})`);
    await s.rename("Target v2");
    // 目標改名不動這篇的指紋，所以舊指紋照樣通過（issue 的第 3 步）。
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_section", section_id: "_top", if_match: read.fingerprint, markdown: read.markdown.replace("Para links", "Para edited links") });
    expect(await links(s.ctx, s.host.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
    expect((await readTop(s.ctx.app, s.token, s.host.id)).markdown).toContain(`Para edited links [Target v2](${s.href}) here.`);
    await s.rename("Target v3");
    expect((await readTop(s.ctx.app, s.token, s.host.id)).markdown).toContain(`Para edited links [Target v3](${s.href}) here.`);
  });

  it("N2 agent 把連結文字改成別的字（目標讀後也改了名）→ 存成自訂文字；改成讀出沒出現過的舊名也算自訂", async () => {
    for (const text of ["My own words", "Target v0"]) {
      const s = await scene();
      const read = await readTop(s.ctx.app, s.token, s.host.id);
      await s.rename("Target v2");
      await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_section", section_id: "_top", if_match: read.fingerprint, markdown: read.markdown.replace("[Target v1]", `[${text}]`) });
      expect((await links(s.ctx, s.host.id)).map(l => l.label)).toEqual([text]);
      await s.rename("Target v3");
      expect((await readTop(s.ctx.app, s.token, s.host.id)).markdown).toContain(`Para links [${text}](${s.href}) here.`);
    }
  });

  it("N3 insert_after、append（寫進另一篇）、replace_all 照讀到的文字寫連結 → 全都沒有自訂文字", async () => {
    const s = await scene();
    const other = await s.ctx.createNote(s.owner.id, "Other");
    const read = await readTop(s.ctx.app, s.token, s.host.id);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "insert_after", section_id: "_top", if_match: read.fingerprint, markdown: `# Copied\n\nCopy [Target v1](${s.href})` });
    const appended = (await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Again [Target v1](${s.href})` })) as { fingerprint: string };
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual([""]);
    await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "replace_all", if_match: appended.fingerprint, markdown: `All [Target v1](${s.href}) and [Target v1](${s.href})` });
    expect((await links(s.ctx, s.host.id)).map(l => [l.label, l.snapshotTitle])).toEqual([["", "Target v1"], ["", "Target v2"]]);
    expect((await links(s.ctx, other.id)).map(l => [l.label, l.snapshotTitle])).toEqual([["", "Target v2"], ["", "Target v2"]]);
  });

  it("N4 記下的是每個人自己讀到的：別人沒讀過 → 照舊存成自訂文字；經 REST GET /content 讀到的也算", async () => {
    const s = await scene();
    const restReader = await s.ctx.createUser({ email: `r-${randomUUID()}@example.com`, password: PASSWORD });
    const stranger = await s.ctx.createUser({ email: `s-${randomUUID()}@example.com`, password: PASSWORD });
    await s.ctx.share(s.target.id, restReader.id, "viewer");
    await s.ctx.share(s.target.id, stranger.id, "viewer");
    await s.ctx.share(s.host.id, restReader.id, "editor");
    await s.ctx.share(s.host.id, stranger.id, "editor");
    const { token: restToken } = await seedTokenForUser(s.ctx.db, restReader.id, "notes:read notes:write");
    const { token: strangerToken } = await seedTokenForUser(s.ctx.db, stranger.id, "notes:read notes:write");
    await readTop(s.ctx.app, s.token, s.host.id); // owner 讀過——不算到別人頭上
    const rest = await getContent(s.ctx.app, s.host.id, restToken);
    expect(rest.statusCode).toBe(200);
    expect((rest.json() as { markdown: string }).markdown).toContain(`[Target v1](${s.href})`);
    await s.rename("Target v2");
    await call(s.ctx.app, strangerToken, "edit_note", { note_id: s.host.id, op: "append", markdown: `Stranger [Target v1](${s.href})` });
    await call(s.ctx.app, restToken, "edit_note", { note_id: s.host.id, op: "append", markdown: `Rest [Target v1](${s.href})` });
    expect((await links(s.ctx, s.host.id)).map(l => l.label)).toEqual(["", "Target v1", ""]);
  });

  it("N5 讀到同一個目標、同一段文字的自訂文字連結 → 寫回時照舊是那個自訂文字（最後讀到的算數）", async () => {
    const s = await scene();
    await readTop(s.ctx.app, s.token, s.host.id); // 記下 (目標, "Target v1") 沒有自訂文字
    await s.rename("Target v2");
    const custom = await s.ctx.createNote(s.owner.id, "Custom");
    await seedBlocks(s.ctx.db, custom.id, [
      { type: "paragraph", content: [{ type: "text", text: "Old name ", styles: {} }, { type: "wikilink", props: { targetNoteId: s.target.id, snapshotTitle: "Target v1", label: "Target v1" } }] },
    ]);
    const read = await readTop(s.ctx.app, s.token, custom.id);
    expect(read.markdown).toContain(`[Target v1](${s.href})`);
    await call(s.ctx.app, s.token, "edit_note", { note_id: custom.id, op: "replace_section", section_id: "_top", if_match: read.fingerprint, markdown: read.markdown.replace("Old name", "Old name kept") });
    expect((await links(s.ctx, custom.id)).map(l => l.label)).toEqual(["Target v1"]);
  });

  it("N6 create_note 的 content 照讀到的文字寫連結 → 沒有自訂文字", async () => {
    const s = await scene();
    await readTop(s.ctx.app, s.token, s.host.id);
    await s.rename("Target v2");
    const r = (await call(s.ctx.app, s.token, "create_note", { title: "Made", content: `see [Target v1](${s.href})` })) as { note: { id: string } };
    expect(await links(s.ctx, r.note.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
  });

  it("N7 agent 自己 append 的連結（沒讀過）→ 目標改名 → 用回覆的指紋 replace_all 原樣寫回 → 仍沒有自訂文字（審查 I1）", async () => {
    const s = await scene();
    const other = await s.ctx.createNote(s.owner.id, "Other");
    const a = (await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Mine [Target v1](${s.href})` })) as { fingerprint: string };
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual([""]);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "replace_all", if_match: a.fingerprint, markdown: `Mine edited [Target v1](${s.href})` });
    expect(await links(s.ctx, other.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
  });

  it("N10 create_note 寫下的連結（沒讀過）→ 目標改名 → 同樣的文字 append 進另一篇 → 沒有自訂文字（審查 I1，create 那條）", async () => {
    const s = await scene();
    await call(s.ctx.app, s.token, "create_note", { title: "Made", content: `see [Target v1](${s.href})` });
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "append", markdown: `Again [Target v1](${s.href})` });
    expect((await links(s.ctx, s.host.id)).map(l => [l.label, l.snapshotTitle])).toEqual([["", "Target v1"], ["", "Target v2"]]);
  });

  it("N8 REST `POST /edits` 舊指紋 409 → 目標改名 → 照 `current` 寫回 → 仍沒有自訂文字（審查 I2）", async () => {
    const s = await scene();
    const stale = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.host.id}/edits`, headers: bearer(s.token), payload: { op: "replace_all", markdown: "x", if_match: "0000000000000000" } });
    expect(stale.statusCode).toBe(409);
    const current = (stale.json() as { current: { markdown: string; fingerprint: string } }).current;
    expect(current.markdown).toContain(`[Target v1](${s.href})`);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_all", if_match: current.fingerprint, markdown: current.markdown.replace("Para links", "Para edited links") });
    expect(await links(s.ctx, s.host.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
  });

  it("N9 REST 撤回 409 stale 的 `current` → 目標改名 → 照 `current` 寫回 → 仍沒有自訂文字（審查 I2）", async () => {
    const s = await scene([{ type: "heading", props: { level: 2 }, content: "Tail" }]);
    // 另一位編輯者做出一筆之後被改掉的修改（他的讀寫記在他自己名下，不算到 owner 頭上）。
    const writer = await s.ctx.createUser({ email: `w-${randomUUID()}@example.com`, password: PASSWORD });
    await s.ctx.share(s.host.id, writer.id, "editor");
    const { token: wt } = await seedTokenForUser(s.ctx.db, writer.id, "notes:read notes:write");
    const added = (await call(s.ctx.app, wt, "edit_note", { note_id: s.host.id, op: "append", markdown: "Extra" })) as { editId: string; outline: { sections: Array<{ sectionId: string; heading: string; fingerprint: string }> } };
    const tail = added.outline.sections.find(x => x.heading === "Tail")!;
    await call(s.ctx.app, wt, "edit_note", { note_id: s.host.id, op: "replace_section", section_id: tail.sectionId, if_match: tail.fingerprint, markdown: "## Tail\n\nExtra changed" });
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.host.id}/edits/${added.editId}/revert`, headers: bearer(s.token) });
    expect(rv.statusCode).toBe(409);
    expect((rv.json() as { error: { code: string } }).error.code).toBe("stale");
    const current = (rv.json() as { current: { markdown: string; fingerprint: string } }).current;
    expect(current.markdown).toContain(`[Target v1](${s.href})`);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_all", if_match: current.fingerprint, markdown: current.markdown.replace("Para links", "Para edited links") });
    expect(await links(s.ctx, s.host.id)).toEqual([{ targetNoteId: s.target.id, label: "", snapshotTitle: "Target v2" }]);
  });

  it("N11 agent 自己寫的自訂文字連結 → 用回覆的指紋 replace_all 原樣寫回 → 仍是那個自訂文字（第二輪 I-a）", async () => {
    const s = await scene();
    const other = await s.ctx.createNote(s.owner.id, "Other");
    const a = (await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Mine [My own words](${s.href})` })) as { fingerprint: string };
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual(["My own words"]);
    await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "replace_all", if_match: a.fingerprint, markdown: `Mine edited [My own words](${s.href})` });
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual(["My own words"]);
  });

  it("N12 合併前失敗的寫入不記：edit_note append 失敗 → 目標改名 → 再寫同樣文字 → 照舊存成自訂文字（第二輪 m-a）", async () => {
    let failNext = true;
    const s = await scene([], { editingTestHooks: { beforeMerge: async () => { if (failNext) { failNext = false; throw new Error("probe: merge refused"); } } } });
    const other = await s.ctx.createNote(s.owner.id, "Other");
    const res = await mcpPost(s.ctx.app, rpc("tools/call", { name: "edit_note", arguments: { note_id: other.id, op: "append", markdown: `Mine [Target v1](${s.href})` } }), { token: s.token });
    expect((res.json().result as { isError?: true }).isError).toBe(true);
    expect(await links(s.ctx, other.id)).toEqual([]);
    await s.rename("Target v2");
    await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Again [Target v1](${s.href})` });
    expect((await links(s.ctx, other.id)).map(l => l.label)).toEqual(["Target v1"]);
  });

  it("N13 寫回時被清掉的原文字也隨這次寫入延長期限（edit_note 與 create_note；第二輪 m-b）", async () => {
    for (const via of ["edit_note", "create_note"] as const) {
      let now = 0;
      const shownLinks = new ShownLinkTexts({ ttlMs: 1000, now: () => now });
      const s = await scene([], { shownLinks });
      const read = await readTop(s.ctx.app, s.token, s.host.id); // 記下 (目標, "Target v1")，到期 1000
      await s.rename("Target v2");
      now = 900; // 照讀到的文字寫回（被清成沒有自訂文字）——原文字的期限要延長到 1900
      if (via === "edit_note") {
        await call(s.ctx.app, s.token, "edit_note", { note_id: s.host.id, op: "replace_section", section_id: "_top", if_match: read.fingerprint, markdown: read.markdown.replace("Para links", "Para edited links") });
        expect((await links(s.ctx, s.host.id)).map(l => l.label)).toEqual([""]);
      } else {
        const made = (await call(s.ctx.app, s.token, "create_note", { title: "Made", content: `see [Target v1](${s.href})` })) as { note: { id: string } };
        expect((await links(s.ctx, made.note.id)).map(l => l.label)).toEqual([""]);
      }
      now = 1500; // 讀出那筆已過期；只剩寫入那次記下的
      const other = await s.ctx.createNote(s.owner.id, "Other");
      await call(s.ctx.app, s.token, "edit_note", { note_id: other.id, op: "append", markdown: `Again [Target v1](${s.href})` });
      expect((await links(s.ctx, other.id)).map(l => l.label), via).toEqual([""]);
    }
  });
});
