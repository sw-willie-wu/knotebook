import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { buildCollabTestApp, testConfig } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { loadDoc } from "./copy-helpers.js";
import { seedGroup, seedNote } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import type { FastifyInstance } from "fastify";

// spec 2026-10-13 site-links §9、§15.2 I1；Review Focus RF1。
const PASSWORD = "correct-horse-battery";

async function call(app: FastifyInstance, token: string, name: string, args: unknown) {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  const result = res.json().result as { isError?: true; structuredContent: Record<string, unknown> };
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
  return result.structuredContent;
}
async function topMarkdown(app: FastifyInstance, token: string, noteId: string): Promise<string> {
  const r = (await call(app, token, "read_note_section", { note_id: noteId, section_id: "_top" })) as { section: { markdown: string } };
  return r.section.markdown;
}
function wikilinkAttrs(doc: Y.Doc): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const n of doc.getXmlFragment(YDOC_FRAGMENT).createTreeWalker(x => x instanceof Y.XmlElement && x.nodeName === "wikilink")) {
    out.push((n as Y.XmlElement).getAttributes());
  }
  return out;
}

describe("#269 I1：MCP 站內連結往返", () => {
  it("寫 [x](/g/<gid>/<slug>#b-<bid>) → 讀回 [x](/notes/<id>#b-<bid>)；label 空時改目標標題後讀回新標題；表格同；REST /content 同形", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const group = await seedGroup(ctx.db, "G", [{ userId: owner.id, role: "admin" }]);
    const gnote = await seedNote(ctx.db, { groupId: group.id }, { title: "Group Doc", slug: "group-doc" });
    const target = await ctx.createNote(owner.id, "Target");
    const host = await ctx.createNote(owner.id, "Host");

    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `[x](/g/${group.id}/group-doc#b-abc123)` });
    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `[Target](${testConfig.publicUrl.origin}/notes/${target.id})` });
    // 表格兩格：label 非空（cell）與 label 空（文字＝標題）——審查 r0 m2：表格裡的「改名後讀回新標題」也要有整合層觀測。
    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `| a | b |\n| --- | --- |\n| [cell](/notes/${target.id}) | [Target](/notes/${target.id}) |` });
    const count = (s: string, sub: string) => s.split(sub).length - 1;

    let md = await topMarkdown(ctx.app, token, host.id);
    expect(md).toContain(`[x](/notes/${gnote.id}#b-abc123)`);
    expect(count(md, `[Target](/notes/${target.id})`)).toBe(2); // 段落＋表格
    expect(md).toContain(`[cell](/notes/${target.id})`);

    await ctx.db.update(notes).set({ title: "Renamed" }).where(eq(notes.id, target.id));
    md = await topMarkdown(ctx.app, token, host.id);
    expect(count(md, `[Renamed](/notes/${target.id})`)).toBe(2); // label 空 ⇒ 現行標題（段落與表格 cell 都是）
    expect(md).not.toContain(`[Target](/notes/${target.id})`);
    expect(md).toContain(`[cell](/notes/${target.id})`); // label 非空 ⇒ 不變

    const rest = await getContent(ctx.app, host.id, token);
    expect(rest.statusCode).toBe(200);
    expect((rest.json() as { markdown: string }).markdown).toContain(`[Renamed](/notes/${target.id})`);
  });

  it("讀者看不到目標：讀回 snapshotTitle、不露現行標題；寫回後變一般連結（§17-8）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const reader = await ctx.createUser({ email: `r-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const { token: readerToken } = await seedTokenForUser(ctx.db, reader.id, "notes:read notes:write");
    const secret = await ctx.createNote(owner.id, "Secret Title");
    const host = await ctx.createNote(owner.id, "Host");
    await ctx.share(host.id, reader.id, "editor");
    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `[Secret Title](/notes/${secret.id})` });
    // 審查 r0 m2：表格 cell 裡讀者看不到的目標同樣讀回存下來的文字。
    await call(ctx.app, token, "edit_note", { note_id: host.id, op: "append", markdown: `| s |\n| --- |\n| [Secret Title](/notes/${secret.id}) |` });
    await ctx.db.update(notes).set({ title: "Renamed Secret" }).where(eq(notes.id, secret.id));
    const count = (s: string, sub: string) => s.split(sub).length - 1;

    const md = await topMarkdown(ctx.app, readerToken, host.id);
    expect(count(md, `[Secret Title](/notes/${secret.id})`)).toBe(2); // 段落＋表格 cell
    expect(md).not.toContain("Renamed Secret");
    // 對照：owner 看得到 ⇒ 同一份文件讀回現行標題（證明上面兩行不是因為什麼都沒換）。
    expect(count(await topMarkdown(ctx.app, token, host.id), `[Renamed Secret](/notes/${secret.id})`)).toBe(2);

    // 審查 r0 m1：REST 讀出同樣以**讀者**的可見性取標題——`/content` 與 `/edits` 409 的 `current`。
    const rest = await getContent(ctx.app, host.id, readerToken);
    expect(rest.statusCode).toBe(200);
    const restMd = (rest.json() as { markdown: string }).markdown;
    expect(count(restMd, `[Secret Title](/notes/${secret.id})`)).toBe(2);
    expect(restMd).not.toContain("Renamed Secret");
    const stale = await ctx.app.inject({
      method: "POST",
      url: `/api/notes/${host.id}/edits`,
      headers: bearer(readerToken),
      payload: { op: "replace_all", markdown: "x", if_match: "0000000000000000" },
    });
    expect(stale.statusCode).toBe(409);
    const currentMd = (stale.json() as { current: { markdown: string } }).current.markdown;
    expect(count(currentMd, `[Secret Title](/notes/${secret.id})`)).toBe(2);
    expect(currentMd).not.toContain("Renamed Secret");

    await call(ctx.app, readerToken, "edit_note", { note_id: host.id, op: "append", markdown: `[again](/notes/${secret.id})` });
    const doc = (await loadDoc(ctx.db, host.id))!;
    expect(wikilinkAttrs(doc)).toHaveLength(2); // owner 寫的段落＋表格兩個；reader 寫的那一個看不到 ⇒ 一般連結
  });

  it("RF1：標題與 label 含 markdown 特殊字元——讀出跳脫正確、寫回 label 逐字相同（或文字＝標題時為空）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const tricky = await ctx.createNote(owner.id, "[Draft] Plan *v2*");
    const src = await ctx.createNote(owner.id, "Src");
    const dst = await ctx.createNote(owner.id, "Dst");
    // label 空（文字＝標題）與 label 含 ] 與反斜線兩種
    await call(ctx.app, token, "edit_note", { note_id: src.id, op: "append", markdown: `[\\[Draft\\] Plan \\*v2\\*](/notes/${tricky.id}) [a\\]b\\\\](/notes/${tricky.id})` });
    const before = wikilinkAttrs((await loadDoc(ctx.db, src.id))!);
    expect(before.map(a => a.label ?? "")).toEqual(["", "a]b\\"]);

    const md = await topMarkdown(ctx.app, token, src.id);
    await call(ctx.app, token, "edit_note", { note_id: dst.id, op: "append", markdown: md });
    const after = wikilinkAttrs((await loadDoc(ctx.db, dst.id))!);
    expect(after.map(a => a.label ?? "")).toEqual(["", "a]b\\"]);
    expect(after.map(a => a.targetNoteId)).toEqual([tricky.id, tricky.id]);
  });

  // Task 5 審查 m1：`createWithContent` 的寫入轉換（可見清單＋siteOrigin）原本沒有整合層觀測。
  it("create_note 的 content 裡的站內連結 → 存成 wikilink（同 edit_note 的規則）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const target = await ctx.createNote(owner.id, "Target");
    const r = (await call(ctx.app, token, "create_note", { title: "Made", content: `see [Target](${testConfig.publicUrl.origin}/notes/${target.id}#b-h1)` })) as { note: { id: string } };
    const attrs = wikilinkAttrs((await loadDoc(ctx.db, r.note.id))!);
    expect(attrs.map(a => [a.targetNoteId, a.label ?? "", a.anchorBlockId ?? ""])).toEqual([[target.id, "", "h1"]]);
  });
});
