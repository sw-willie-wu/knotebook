// Knowledge info over MCP: what read_note_section shows, what edit_note and create_note do with a knowledge comment, and what they say about it.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { notes } from "../src/db/schema.js";
import { knowledgeInfoById } from "../src/notes/editing/knowledge-write.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { setNoteTagsByNamesInTx } from "../src/tags/tx/note-tags.js";
import { MCP_PAGE_MAX } from "../src/mcp/limits.js";
import { seedBlocks, callTool, type ToolCallResult } from "./bulk-transfer-helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

const K1 = "k_00000001";
const H = (id: string, text: string, props: Record<string, unknown> = {}, level = 2) => ({ id, type: "heading", props: { level, ...props }, content: text });
const KH = (id: string, text: string, knowledgeId: string, extra: Record<string, unknown> = {}) => H(id, text, { knowledgeId, knowledgeWhen: "alice reads this", ...extra });
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });
const comment = (lines: string[]) => `<!-- knotebook:knowledge\n${lines.join("\n")}\n-->`;

interface KnowledgeOut { kept: Array<{ id: string; heading: string; headingTruncated?: true }>; created: Array<{ id: string; heading: string; headingTruncated?: true }>; removed: Array<{ id: string; heading: string; headingTruncated?: true }>; renewed: Array<{ id: string; heading: string; from: string }>; ignoredComments: number; truncated: boolean }
const ok = (r: ToolCallResult): Record<string, unknown> => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
  return r.structuredContent;
};
const knowledgeOf = (r: ToolCallResult): KnowledgeOut | undefined => ok(r).knowledge as KnowledgeOut | undefined;

async function setup(blocks: unknown[]) {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedBlocks(ctx.db, note.id, blocks);
  const call = (name: string, args: Record<string, unknown>) => callTool(ctx.app, pat.token, name, args);
  const section = async (id: string) => {
    const r = ok(await call("read_note_section", { note_id: note.id, section_id: id })) as { section: { markdown: string; fingerprint: string } };
    return r.section;
  };
  const wholeFingerprint = async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/content`, headers: { authorization: `Bearer ${pat.token}` } });
    return (res.json() as { fingerprint: string }).fingerprint;
  };
  const edit = (args: Record<string, unknown>) => call("edit_note", { note_id: note.id, ...args });
  const infos = async () => knowledgeInfoById((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc.getXmlFragment(YDOC_FRAGMENT));
  return { ctx, u, pat, note, call, section, wholeFingerprint, edit, infos };
}
type S = Awaited<ReturnType<typeof setup>>;

describe("tool schemas", () => {
  it("tools/list shows knowledge in edit_note's and create_note's output schema and tags in read_note_outline's note", async () => {
    const s = await setup([P("p1", "x")]);
    const res = await mcpPost(s.ctx.app, rpc("tools/list"), { token: s.pat.token });
    type Schema = { properties: Record<string, { properties?: Record<string, unknown>; description?: string }> };
    const tools = res.json().result.tools as Array<{ name: string; outputSchema: Schema }>;
    const out = (n: string) => tools.find(t => t.name === n)!.outputSchema;
    expect(Object.keys(out("edit_note").properties)).toContain("knowledge");
    expect(Object.keys(out("edit_note").properties.knowledge!.properties ?? {}).sort()).toEqual(["created", "ignoredComments", "kept", "removed", "renewed", "truncated"]);
    expect(Object.keys(out("create_note").properties)).toContain("knowledge");
    expect(Object.keys(out("read_note_outline").properties.note!.properties ?? {})).toContain("tags");
    await s.ctx.destroy();
  });
});

describe("reading", () => {
  it("read_note_outline's note.tags lists the tags in the order added, [] without tags, and the owner's tags to a share viewer", async () => {
    const s = await setup([P("p1", "x")]);
    const before = ok(await s.call("read_note_outline", { note_id: s.note.id })).note as { tags: string[] };
    expect(before.tags).toEqual([]);
    await s.ctx.db.transaction(tx => setNoteTagsByNamesInTx(tx, { noteId: s.note.id, expected: { ownerId: s.u.id, groupId: null }, names: ["zulu", "alpha", "Mike"], createdBy: s.u.id }));
    const after = ok(await s.call("read_note_outline", { note_id: s.note.id })).note as { tags: string[] };
    expect(after.tags).toEqual(["zulu", "alpha", "Mike"]);
    const viewer = await seedUser(s.ctx.db);
    await seedShare(s.ctx.db, s.note.id, viewer.id, "viewer");
    const viewerToken = await seedTokenForUser(s.ctx.db, viewer.id, "notes:read");
    const seen = ok(await callTool(s.ctx.app, viewerToken.token, "read_note_outline", { note_id: s.note.id })).note as { tags: string[] };
    expect(seen.tags).toEqual(["zulu", "alpha", "Mike"]);
    await s.ctx.destroy();
  });

  it("read_note_section returns the comment under a knowledge heading", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "keep" }), P("a1", "body")]);
    const sec = await s.section("hA");
    expect(sec.markdown).toBe(`## A\n${comment([`id: ${K1}`, "when: alice reads this", "conclusion: keep"])}\n\nbody\n`);
    await s.ctx.destroy();
  });
});

describe("edit_note", () => {
  it("replace_section without the comment keeps the knowledge; the reply's knowledge.kept names it", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "old")]);
    const sec = await s.section("hA");
    const k = knowledgeOf(await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.fingerprint, markdown: "## A\n\nnew\n" }));
    expect(k).toEqual({ kept: [{ id: K1, heading: "A" }], created: [], removed: [], renewed: [], ignoredComments: 0, truncated: false });
    expect((await s.infos()).get(K1)).toMatchObject({ when: "alice reads this" });
    await s.ctx.destroy();
  });

  it("knowledge lists are cut at 100 with truncated true, headings at 200 characters with headingTruncated", async () => {
    const blocks = [P("p0", "intro"), ...Array.from({ length: 120 }, (_, i) => KH(`h${i}`, `Heading ${i}`, `k_${String(i + 1).padStart(8, "0")}`)), KH("hLong", "L".repeat(300), "k_00000999")];
    const s = await setup(blocks);
    const k = knowledgeOf(await s.edit({ op: "replace_all", if_match: await s.wholeFingerprint(), markdown: "just text" }))!;
    expect(k.removed).toHaveLength(MCP_PAGE_MAX);
    expect(k.truncated).toBe(true);
    await s.ctx.destroy();
    const t = await setup([KH("hLong", "L".repeat(300), K1), P("p1", "x")]);
    const long = knowledgeOf(await t.edit({ op: "replace_all", if_match: await t.wholeFingerprint(), markdown: "just text" }))!;
    expect(long.removed[0]!.heading).toHaveLength(200);
    expect(long.removed[0]!.headingTruncated).toBe(true);
    expect(long.truncated).toBe(false);
    await t.ctx.destroy();
  });

  it("an invalid comment is the invalid_knowledge tool error with the heading in the message", async () => {
    const s = await setup([P("p1", "x")]);
    const r = await s.edit({ op: "append", markdown: "## Z\n<!-- knotebook:knowledge\nsome line\n-->\n\nbody\n" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "invalid_knowledge", message: 'The knowledge comment under the heading "Z" has a line that isn\'t key: value. Nothing was written.' });
    await s.ctx.destroy();
  });

  it("markdown starting with #todo #urgent written by edit_note replace_all is a paragraph with that text, the note gets no tags, and it reads back as #todo #urgent", async () => {
    const s = await setup([P("p1", "x")]);
    ok(await s.edit({ op: "replace_all", if_match: await s.wholeFingerprint(), markdown: "#todo #urgent\n\nbody\n" }));
    const sec = await s.section("_top");
    expect(sec.markdown.startsWith("#todo #urgent\n")).toBe(true);
    const outline = ok(await s.call("read_note_outline", { note_id: s.note.id })).note as { tags: string[] };
    expect(outline.tags).toEqual([]);
    await s.ctx.destroy();
  });
});

describe("create_note", () => {
  it("with content holding a comment after a paragraph reports ignoredComments 1; one under a heading is listed in created", async () => {
    const s = await setup([P("p1", "x")]);
    const ignored = knowledgeOf(await s.call("create_note", { title: "A", content: `text\n\n${comment(["when: nowhere"])}\n\nmore\n` }))!;
    expect(ignored).toEqual({ kept: [], created: [], removed: [], renewed: [], ignoredComments: 1, truncated: false });
    const created = knowledgeOf(await s.call("create_note", { title: "B", content: `## D1\n${comment(["when: w"])}\n\nbody\n` }))!;
    expect(created.created).toHaveLength(1);
    expect(created.created[0]!.heading).toBe("D1");
    expect(created.created[0]!.id).toMatch(/^k_[0-9a-f]{8}$/);
    expect(created.ignoredComments).toBe(0);
    await s.ctx.destroy();
  });

  it("with content that writes a new id in full lists it in created, so the reply says what was stored", async () => {
    const s = await setup([P("p1", "x")]);
    const k = knowledgeOf(await s.call("create_note", { title: "C", content: `## A
${comment(["id: k_12345678", "when: w"])}

body
` }))!;
    expect(k).toEqual({ kept: [], created: [{ id: "k_12345678", heading: "A" }], removed: [], renewed: [], ignoredComments: 0, truncated: false });
    await s.ctx.destroy();
  });

  it("whose content says outdated without superseded_by is the invalid_knowledge tool error naming the heading, not internal, and no note is left", async () => {
    const s = await setup([P("p1", "x")]);
    const before = (await s.ctx.db.select({ id: notes.id }).from(notes)).length;
    const r = await s.call("create_note", { title: "Bad", content: `## D1\n${comment(["when: w", "status: outdated"])}\n\nx\n` });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ code: "invalid_knowledge", message: 'The knowledge comment under the heading "D1" says outdated without a `superseded_by`. Nothing was written.' });
    expect((await s.ctx.db.select({ id: notes.id }).from(notes)).length).toBe(before);
    expect(await s.ctx.db.select().from(notes).where(eq(notes.title, "Bad"))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("content starting with #todo #urgent is a paragraph with that text and the note gets no tags", async () => {
    const s = await setup([P("p1", "x")]);
    const created = ok(await s.call("create_note", { title: "Tagless", content: "#todo #urgent\n\nbody\n" })).note as { id: string };
    const sec = ok(await s.call("read_note_section", { note_id: created.id, section_id: "_top" })) as { section: { markdown: string } };
    expect(sec.section.markdown.startsWith("#todo #urgent\n")).toBe(true);
    expect((ok(await s.call("read_note_outline", { note_id: created.id })).note as { tags: string[] }).tags).toEqual([]);
    await s.ctx.destroy();
  });
});

describe("each claim in the new describe text holds", () => {
  async function written(s: S, markdown: string, op: "append" | "replace_all" = "append"): Promise<KnowledgeOut | undefined> {
    const args = op === "append" ? { op, markdown } : { op, markdown, if_match: await s.wholeFingerprint() };
    return knowledgeOf(await s.edit(args));
  }

  it("a comment under a heading in a list, a quote or columns is ignored and counted", async () => {
    const s = await setup([P("p1", "x")]);
    const k = await written(
      s,
      `> ## In quote\n> ${comment(["when: q"]).replace(/\n/g, "\n> ")}\n>\n> text\n\n- ## In list\n  ${comment(["when: l"]).replace(/\n/g, "\n  ")}\n\n  text\n`,
    );
    expect(k?.created ?? []).toEqual([]);
    expect(k?.ignoredComments).toBeGreaterThanOrEqual(1);
    expect((await s.infos()).size).toBe(0);
    await s.ctx.destroy();
  });

  it("leaving out a line other than id empties that field", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "was", knowledgeEvidence: "tested" }), P("a1", "body")]);
    const sec = await s.section("hA");
    ok(await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.fingerprint, markdown: `## A\n${comment([`id: ${K1}`, "when: still"])}\n\nbody\n` }));
    expect((await s.infos()).get(K1)).toMatchObject({ when: "still", conclusion: "", evidence: "" });
    await s.ctx.destroy();
  });

  it("insert_after and append without a comment make plain headings", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body")]);
    const sec = await s.section("hA");
    expect(await written(s, "## A\n\ntext\n")).toBeUndefined();
    ok(await s.edit({ op: "insert_after", section_id: "hA", if_match: sec.fingerprint, markdown: "## B\n\ntext\n" }));
    expect([...(await s.infos()).keys()]).toEqual([K1]);
    await s.ctx.destroy();
  });

  it("evidence unconfirmed is stored as empty", async () => {
    const s = await setup([P("p1", "x")]);
    const k = (await written(s, `## U\n${comment(["when: w", "evidence: unconfirmed"])}\n\nx\n`))!;
    expect((await s.infos()).get(k.created[0]!.id)).toMatchObject({ evidence: "" });
    await s.ctx.destroy();
  });

  it("a value in double quotes is read as a JSON string", async () => {
    const s = await setup([P("p1", "x")]);
    const k = (await written(s, `## Q\n${comment([`when: "say \\"hi\\" \\u003e done"`])}\n\nx\n`))!;
    expect((await s.infos()).get(k.created[0]!.id)).toMatchObject({ when: 'say "hi" > done' });
    await s.ctx.destroy();
  });

  it("status current is refused and only unverified or outdated are accepted", async () => {
    const s = await setup([P("p1", "x")]);
    const bad = await s.edit({ op: "append", markdown: `## S\n${comment(["when: w", "status: current"])}\n\nx\n` });
    expect(bad.structuredContent.code).toBe("invalid_knowledge");
    const good = knowledgeOf(await s.edit({ op: "append", markdown: `## S\n${comment(["when: w", "status: unverified"])}\n\nx\n` }))!;
    expect((await s.infos()).get(good.created[0]!.id)).toMatchObject({ status: "unverified" });
    await s.ctx.destroy();
  });

  it("outdated needs superseded_by, which may be a knowledge id or <note id>#<knowledge id> in another note", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "x")]);
    const other = "22222222-2222-4222-8222-222222222222";
    const k = (await written(s, `## Old\n${comment(["when: w", "status: outdated", `superseded_by: ${other}#k_00000002`])}\n\nx\n`))!;
    expect((await s.infos()).get(k.created[0]!.id)).toMatchObject({ status: "outdated", supersededBy: `${other}#k_00000002` });
    await s.ctx.destroy();
  });

  it("a comment without a blank line after the --> is refused", async () => {
    const s = await setup([P("p1", "x")]);
    const r = await s.edit({ op: "append", markdown: `## B\n${comment(["when: w"])}\ntext right below\n` });
    expect(r.structuredContent).toEqual({ code: "invalid_knowledge", message: 'The knowledge comment under the heading "B" needs a blank line after its -->. Nothing was written.' });
    await s.ctx.destroy();
  });

  it("a heading whose level you changed gets nothing from the heading it replaced, and is listed in removed for the old one", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body")]);
    const sec = await s.section("hA");
    const k = knowledgeOf(await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.fingerprint, markdown: "### A\n\nbody\n" }))!;
    expect(k.kept).toEqual([]);
    expect(k.removed).toEqual([{ id: K1, heading: "A" }]);
    await s.ctx.destroy();
  });
});
