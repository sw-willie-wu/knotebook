/**
 * #181 PR-2a T11：既有 MCP 工具與垃圾桶（spec 2026-10-21 §6.8.1、A2-5 MCP 面、A2-13 的 PR-2a 部分、AG6）。
 * 憑證一律讀寫搬移（`notes:read notes:write notes:move`）；讀 live doc 的工具要 collab，所以全檔用 `buildCollabTestApp`。
 * 造垃圾桶狀態打 `DELETE /api/notes/:id`、還原打 `POST /api/trash/restore`（cookie）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { EditorSession } from "../src/notes/editing/session.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { loadDoc, seedDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, testEditingRuntime } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedAttachment } from "./storage-helpers.js";
import { inject } from "./trash-helpers.js";

const SCOPE = "notes:read notes:write notes:move";
type Result = { isError?: true; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> & { code?: string } };

async function call(app: FastifyInstance, token: string, name: string, args: unknown): Promise<Result> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().result as Result;
}
const listIds = async (app: FastifyInstance, token: string) =>
  ((await call(app, token, "list_notes", {})).structuredContent!.notes as Array<{ id: string }>).map(n => n.id);
const searchIds = async (app: FastifyInstance, token: string, query: string) =>
  ((await call(app, token, "search_notes", { query })).structuredContent!.notes as Array<{ id: string }>).map(n => n.id);

async function trash(app: FastifyInstance, noteId: string, userId: string): Promise<void> {
  const res = await inject(app, "DELETE", `/api/notes/${noteId}`, userId);
  expect(res.statusCode, res.body).toBe(204);
}
async function restore(app: FastifyInstance, noteId: string, userId: string): Promise<void> {
  const res = await inject(app, "POST", "/api/trash/restore", userId, { ids: [noteId] });
  expect(res.statusCode, res.body).toBe(200);
  expect((res.json() as { restored: Array<{ id: string }> }).restored.map(n => n.id)).toEqual([noteId]);
}

/** 一段文字＋一張指向 `/api/uploads/<uploadId>` 的圖（同 `mcp-image.test.ts` M6 的造法）。 */
async function imageNoteDoc(uploadId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(testEditingRuntime, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, [
      { type: "paragraph", content: "cross-note image" },
      { type: "image", props: { url: `/api/uploads/${uploadId}`, name: "pic" } },
    ]);
  } finally {
    s.close();
  }
  return doc;
}

/** 對 `noteId` 呼叫各支「單篇」工具的引數（`read_note_image` 的上傳固定為 `uploadId`）。 */
function perNoteCalls(noteId: string, uploadId: string, groupId: string): Array<[string, Record<string, unknown>]> {
  return [
    ["read_note_outline", { note_id: noteId }],
    ["read_note_section", { note_id: noteId, section_id: "_top" }],
    ["read_note_image", { note_id: noteId, upload_id: uploadId }],
    ["edit_note", { note_id: noteId, op: "append", markdown: "MC1 append" }],
    ["edit_note:rename", { note_id: noteId, op: "rename", title: "MC1 rename" }], // rename 支另有一處單篇授權
    ["move_note_to_group", { note_id: noteId, group_id: groupId }],
    ["copy_note", { note_id: noteId }],
    ["create_transfer_token", { note_id: noteId, purpose: "download" }],
  ];
}

describe("MC1 既有工具看不到垃圾桶筆記（§6.8.1）", () => {
  it("list／search 不列；七支單篇工具（edit_note 含 append 與 rename）回 not_found，text 與隨機 uuid 相同；還原後又列得到、讀得到", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "MC1", [{ userId: u.id, role: "admin" }]);
    const t = await seedNote(ctx.db, { ownerId: u.id }, { title: "mcone-trash" });
    const l = await seedNote(ctx.db, { ownerId: u.id }, { title: "mcone-live" });
    const ut = await seedAttachment(ctx.db, ctx.uploadsDir, t.id, u.id, 12);
    const { token } = await seedTokenForUser(ctx.db, u.id, SCOPE);

    // 前提：移入前讀得到（不是別的原因讓下面得 not_found）。
    expect((await listIds(ctx.app, token)).sort()).toEqual([t.id, l.id].sort());
    expect((await searchIds(ctx.app, token, "mcone")).sort()).toEqual([t.id, l.id].sort());
    for (const name of ["read_note_outline", "read_note_section", "read_note_image", "create_transfer_token"]) {
      const args = perNoteCalls(t.id, ut, g.id).find(([n]) => n === name)![1];
      expect((await call(ctx.app, token, name, args)).isError, `移入前 ${name}`).toBeUndefined();
    }

    await trash(ctx.app, t.id, u.id);

    expect(await listIds(ctx.app, token)).toEqual([l.id]);
    expect(await searchIds(ctx.app, token, "mcone")).toEqual([l.id]);
    const got: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    const ghost = randomUUID();
    const ghostCalls = perNoteCalls(ghost, ut, g.id);
    for (const [i, [name, args]] of perNoteCalls(t.id, ut, g.id).entries()) {
      const tool = name.split(":")[0]!;
      const r = await call(ctx.app, token, tool, args);
      const miss = await call(ctx.app, token, tool, ghostCalls[i]![1]);
      got[name] = { isError: r.isError, code: r.structuredContent?.code, text: r.content[0]?.text };
      want[name] = { isError: true, code: "not_found", text: miss.content[0]?.text };
      expect(miss.structuredContent?.code, `隨機 uuid ${name}`).toBe("not_found");
    }
    expect(got).toEqual(want);
    // 上面的 move／copy 都沒成功：t 仍是個人筆記、沒有多出副本。
    const { rows } = await ctx.db.$client.query<{ n: number }>(`select count(*)::int n from notes`);
    expect(rows[0]!.n).toBe(2);
    expect((await ctx.db.$client.query<{ title: string }>(`select title from notes where id = $1`, [t.id])).rows[0]!.title).toBe("mcone-trash");

    await restore(ctx.app, t.id, u.id);
    expect((await listIds(ctx.app, token)).sort()).toEqual([t.id, l.id].sort());
    expect((await call(ctx.app, token, "read_note_outline", { note_id: t.id })).isError).toBeUndefined();
  });
});

describe("MC1b 跨篇附件（read-note-image 的第二次授權）", () => {
  it("活筆記 l 引用垃圾桶筆記 t 的附件：移入前讀得到；移入後 not_found 且 text 與查無上傳相同；還原後又讀得到", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const t = await seedNote(ctx.db, { ownerId: u.id });
    const l = await seedNote(ctx.db, { ownerId: u.id });
    const ut = await seedAttachment(ctx.db, ctx.uploadsDir, t.id, u.id, 12);
    await seedDoc(ctx.db, l.id, await imageNoteDoc(ut));
    const { token } = await seedTokenForUser(ctx.db, u.id, SCOPE);
    const read = (uploadId: string) => call(ctx.app, token, "read_note_image", { note_id: l.id, upload_id: uploadId });

    const before = await read(ut);
    expect(before.isError).toBeUndefined();
    expect(before.structuredContent).toMatchObject({ noteId: t.id, uploadId: ut });

    await trash(ctx.app, t.id, u.id);
    const after = await read(ut);
    const miss = await read(randomUUID());
    expect(miss.structuredContent?.code).toBe("not_found");
    expect({ isError: after.isError, code: after.structuredContent?.code, text: after.content[0]?.text }).toEqual({
      isError: true, code: "not_found", text: miss.content[0]?.text,
    });

    await restore(ctx.app, t.id, u.id);
    const again = await read(ut);
    expect(again.isError).toBeUndefined();
    expect(again.structuredContent).toMatchObject({ noteId: t.id, uploadId: ut });
  });
});

describe("MC2 AG6：既有工具不會把筆記移進垃圾桶", () => {
  it("讀寫搬移憑證：tools/list 沒有 delete_note／restore_note；edit_note（含 replace_all 清空）、copy_note（個人、群組）、create_note（群組）、move_note_to_group 之後垃圾桶筆記數不變", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "MC2", [{ userId: u.id, role: "admin" }]);
    const t = await seedNote(ctx.db, { ownerId: u.id });
    const l = await seedNote(ctx.db, { ownerId: u.id }, { title: "MC2 live" });
    await trash(ctx.app, t.id, u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id, SCOPE);
    const trashedIds = async () =>
      (await ctx.db.$client.query<{ id: string }>(`select id from notes where deleted_at is not null order by id`)).rows.map(r => r.id);

    const names = ((await mcpPost(ctx.app, rpc("tools/list"), { token })).json().result.tools as Array<{ name: string }>).map(x => x.name);
    expect(names).toEqual(expect.arrayContaining(["edit_note", "copy_note", "create_note", "move_note_to_group"]));
    expect(names).not.toContain("delete_note");
    expect(names).not.toContain("restore_note");
    expect(names).not.toContain("delete_folder"); // 資料夾 PR-3d T8：同樣只在 notes:delete 時註冊
    expect(names).toContain("list_trash"); // #181 PR-2d：讀取類，任何憑證都有
    expect(await trashedIds()).toEqual([t.id]);

    const ok = async (name: string, args: Record<string, unknown>): Promise<Result> => {
      const r = await call(ctx.app, token, name, args);
      expect(await trashedIds(), `${name} 之後`).toEqual([t.id]); // 先於成功與否：工具回錯也不能已經移入
      expect(r.isError, `${name} ${JSON.stringify(r.structuredContent)}`).toBeUndefined();
      return r;
    };
    const appended = await ok("edit_note", { note_id: l.id, op: "append", markdown: "MC2 一段" });
    // 清空：空內容被拒成 empty_content（不是移入）；換成只剩一個字的整篇取代則成功。
    const emptied = await call(ctx.app, token, "edit_note", { note_id: l.id, op: "replace_all", markdown: "", if_match: appended.structuredContent!.fingerprint });
    expect([emptied.isError, emptied.structuredContent?.code]).toEqual([true, "empty_content"]);
    await ok("edit_note", { note_id: l.id, op: "replace_all", markdown: "x", if_match: appended.structuredContent!.fingerprint });
    await ok("copy_note", { note_id: l.id });
    await ok("copy_note", { note_id: l.id, group_id: g.id });
    await ok("create_note", { title: "MC2 group", group_id: g.id });
    await ok("move_note_to_group", { note_id: l.id, group_id: g.id });

    const { rows } = await ctx.db.$client.query<{ n: number }>(`select count(*)::int n from notes`);
    expect(rows[0]!.n).toBe(5); // t、l、兩份副本、新建那篇
    expect(await trashedIds()).toEqual([t.id]);
  });
});

/** 文件裡所有 wikilink 節點的 `targetNoteId`（文件順序）。 */
function wikilinkTargets(doc: Y.Doc): string[] {
  const out: string[] = [];
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlElement && x.nodeName === "wikilink")) {
    out.push(String((n as Y.XmlElement).getAttribute("targetNoteId")));
  }
  return out;
}

describe("MC3 §6.4 的例外（rev 4.2，known-limitations）：垃圾桶期間讀出再寫回，指向它的 wikilink 變一般連結", () => {
  it("A 連到 B、C；B 在垃圾桶時以 read_note_section 讀 A、replace_section 原樣寫回 → 只剩 C 是 wikilink；還原 B 後不會變回", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const a = await seedNote(ctx.db, { ownerId: u.id }, { title: "MC3 A" });
    const b = await seedNote(ctx.db, { ownerId: u.id }, { title: "MC3 B" });
    const c = await seedNote(ctx.db, { ownerId: u.id }, { title: "MC3 C" });
    const { token } = await seedTokenForUser(ctx.db, u.id, SCOPE);
    const ok = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await call(ctx.app, token, name, args);
      expect(r.isError, `${name} ${JSON.stringify(r.structuredContent)}`).toBeUndefined();
      return r.structuredContent!;
    };
    await ok("edit_note", { note_id: a.id, op: "append", markdown: `# Sec\n\nsee [MC3 B](/notes/${b.id}) and [MC3 C](/notes/${c.id})` });
    expect(wikilinkTargets((await loadDoc(ctx.db, a.id))!)).toEqual([b.id, c.id]);

    await trash(ctx.app, b.id, u.id);
    const outline = await ok("read_note_outline", { note_id: a.id });
    const sec = (outline.sections as Array<{ sectionId: string; heading: string }>).find(s => s.heading === "Sec")!;
    const read = (await ok("read_note_section", { note_id: a.id, section_id: sec.sectionId })).section as { markdown: string; fingerprint: string };
    expect(read.markdown).toContain(`(/notes/${b.id})`);
    await ok("edit_note", { note_id: a.id, op: "replace_section", section_id: sec.sectionId, markdown: read.markdown, if_match: read.fingerprint });
    const after = (await loadDoc(ctx.db, a.id))!;
    expect(wikilinkTargets(after)).toEqual([c.id]);
    const sec2 = ((await ok("read_note_outline", { note_id: a.id })).sections as Array<{ sectionId: string; heading: string }>).find(s => s.heading === "Sec")!;
    const md = ((await ok("read_note_section", { note_id: a.id, section_id: sec2.sectionId })).section as { markdown: string }).markdown;
    expect(md).toContain(`(/notes/${b.id})`); // 連結本身還在，只是不再是 wikilink

    await restore(ctx.app, b.id, u.id);
    expect(wikilinkTargets((await loadDoc(ctx.db, a.id))!)).toEqual([c.id]);
  });
});
