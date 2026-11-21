// Knowledge info through the REST content endpoints: what a write does to the knowledge props of the headings it replaces.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { KNOWLEDGE_ID_RE, SESSION_COOKIE, YDOC_FRAGMENT, listKnowledgeInFragment } from "@knotebook/shared";
import { noteAiEdits, notes } from "../src/db/schema.js";
import { knowledgeInfoById } from "../src/notes/editing/knowledge-write.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { seedBlocks } from "./bulk-transfer-helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { buildCollabTestApp, signTestSession } from "./helpers.js";

const K1 = "k_00000001";
const K2 = "k_00000002";

const H = (id: string, text: string, props: Record<string, unknown> = {}, level = 2) => ({ id, type: "heading", props: { level, ...props }, content: text });
const KH = (id: string, text: string, knowledgeId: string, extra: Record<string, unknown> = {}) => H(id, text, { knowledgeId, knowledgeWhen: "alice reads this", ...extra });
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });
const comment = (lines: string[]) => `<!-- knotebook:knowledge\n${lines.join("\n")}\n-->`;

async function setup(blocks: unknown[]) {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedBlocks(ctx.db, note.id, blocks);
  const content = async () => (await getContent(ctx.app, note.id, pat.token)).json() as { markdown: string; fingerprint: string; outline: Array<{ sectionId: string; fingerprint: string }> };
  const section = async (id: string) => (await getContent(ctx.app, note.id, pat.token, id)).json() as { section: { markdown: string; fingerprint: string } };
  const edit = (payload: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(pat.token), payload });
  const live = async () => (await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc;
  const idsByHeading = async () => new Map(listKnowledgeInFragment((await live()).getXmlFragment(YDOC_FRAGMENT)).map(e => [e.heading, e.info.id]));
  const infos = async () => knowledgeInfoById((await live()).getXmlFragment(YDOC_FRAGMENT));
  const versionFp = async () => versionFingerprint((await live()).getXmlFragment(YDOC_FRAGMENT));
  return { ctx, u, pat, note, content, section, edit, live, infos, idsByHeading, versionFp };
}
type S = Awaited<ReturnType<typeof setup>>;

const knowledgeOf = (res: { json(): unknown }) => (res.json() as { knowledge?: { kept: Array<{ id: string; heading: string }>; created: Array<{ id: string; heading: string }>; removed: unknown[]; renewed: Array<{ id: string; heading: string; from: string }>; ignoredComments: number } }).knowledge;
const errOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; message: string } }).error;
const noteRows = async (s: S) => (await s.ctx.db.select({ id: notes.id }).from(notes)).length;

const TRICKY = ["a --> b", "x\ny", '"quoted"', "C:\\Users\\alice", " padded ", "中文 😀", "a\u2028b", "a\u0085b", "p | q", "end--!>"];

describe("reading and writing knowledge back", () => {
  it("reading a note with knowledge shows the comment, and writing the section back unchanged leaves ids, props and every fingerprint unchanged", async () => {
    const s = await setup([P("p0", "intro"), KH("hA", "A", K1, { knowledgeConclusion: "keep", knowledgeEvidence: "tested", knowledgeVerified: "2026-10-20" }), P("a1", "body"), H("hB", "B"), P("b1", "other")]);
    const before = await s.content();
    expect(before.markdown).toContain(`## A\n${comment([`id: ${K1}`, "when: alice reads this", "conclusion: keep", "evidence: tested", "verified: 2026-10-20"])}\n\nbody`);
    const infoBefore = await s.infos();
    const sec = await s.section("hA");
    const res = await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint, markdown: sec.section.markdown });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toBeUndefined();
    expect(await s.infos()).toEqual(infoBefore);
    const after = await s.content();
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.outline).toEqual(before.outline);
    await s.ctx.destroy();
  });

  it("the same holds for replace_all of the whole note, with tricky values", async () => {
    const s = await setup([
      ...TRICKY.map((v, i) => KH(`h${i}`, `Heading ${i}`, `k_0000010${i}`, { knowledgeWhen: v, knowledgeConclusion: v })),
      P("pEnd", "tail"),
    ]);
    const before = await s.content();
    const infoBefore = await s.infos();
    const res = await s.edit({ op: "replace_all", if_match: before.fingerprint, markdown: before.markdown });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toBeUndefined();
    expect(await s.infos()).toEqual(infoBefore);
    expect((await s.content()).fingerprint).toBe(before.fingerprint);
    await s.ctx.destroy();
  });
});

describe("rewrites", () => {
  it("replace_section without the comment and the same heading keeps the knowledge and its id, and lists it in knowledge.kept", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "keep" }), P("a1", "old body")]);
    const sec = await s.section("hA");
    const res = await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint, markdown: "## A\n\nnew body\n" });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toEqual({ kept: [{ id: K1, heading: "A" }], created: [], removed: [], renewed: [], ignoredComments: 0 });
    const info = (await s.infos()).get(K1)!;
    expect(info).toMatchObject({ when: "alice reads this", conclusion: "keep" });
    expect((await s.content()).markdown).toContain("new body");
    await s.ctx.destroy();
  });

  it("replace_section with the heading text changed and no comment removes the knowledge and lists it in knowledge.removed", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "old body")]);
    const sec = await s.section("hA");
    const res = await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint, markdown: "## Renamed\n\nnew body\n" });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toEqual({ kept: [], created: [], removed: [{ id: K1, heading: "A" }], renewed: [], ignoredComments: 0 });
    expect((await s.infos()).size).toBe(0);
    await s.ctx.destroy();
  });

  it("a comment changing when updates only that prop; leaving a line out empties that field", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "was", knowledgeEvidence: "docs" }), P("a1", "body")]);
    const sec = await s.section("hA");
    const res = await s.edit({
      op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint,
      markdown: `## A\n${comment([`id: ${K1}`, "when: bob reads this", "evidence: docs"])}\n\nbody\n`,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((await s.infos()).get(K1)).toMatchObject({ when: "bob reads this", conclusion: "", evidence: "docs" });
    expect(knowledgeOf(res)).toBeUndefined();
    await s.ctx.destroy();
  });

  it("a comment without id on a new heading creates knowledge with a fresh id listed in knowledge.created; on a heading that keeps its text it keeps the old id", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body"), H("hB", "B"), P("b1", "other")]);
    const whole = (await s.content()).fingerprint;
    const res = await s.edit({
      op: "replace_all", if_match: whole,
      markdown: `## A\n${comment(["when: edited"])}\n\nbody\n\n## Brand new\n${comment(["when: fresh"])}\n\nx\n`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    expect(k.created).toHaveLength(1);
    expect(k.created[0]!.heading).toBe("Brand new");
    expect(k.created[0]!.id).toMatch(KNOWLEDGE_ID_RE);
    const infos = await s.infos();
    expect(infos.get(K1)).toMatchObject({ when: "edited" });
    expect(infos.get(k.created[0]!.id)).toMatchObject({ when: "fresh" });
    expect(infos.size).toBe(2);
    await s.ctx.destroy();
  });

  it("insert_after with an id already in the note renews the inserted one and lists it in knowledge.renewed", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body"), H("hB", "B"), P("b1", "other")]);
    const sec = await s.section("hB");
    const res = await s.edit({
      op: "insert_after", section_id: "hB", if_match: sec.section.fingerprint,
      markdown: `## Copy\n${comment([`id: ${K1}`, "when: copied"])}\n\nbody\n`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    expect(k.renewed).toHaveLength(1);
    expect(k.renewed[0]).toMatchObject({ heading: "Copy", from: K1 });
    const infos = await s.infos();
    expect(infos.get(K1)).toMatchObject({ when: "alice reads this" });
    expect(infos.get(k.renewed[0]!.id)).toMatchObject({ when: "copied" });
    await s.ctx.destroy();
  });

  it("copying another knowledge's comment, id included, onto a heading placed before it renews the copy and keeps the original's id", async () => {
    const s = await setup([H("hP", "Plain"), P("p1", "plain body"), KH("hA", "A", K1, { knowledgeConclusion: "orig" }), P("a1", "body")]);
    const sec = await s.section("hP");
    const res = await s.edit({
      op: "replace_section", section_id: "hP", if_match: sec.section.fingerprint,
      markdown: `## Plain\n${comment([`id: ${K1}`, "when: copied", "conclusion: copy"])}\n\nplain body\n`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    expect(k.renewed).toHaveLength(1);
    expect(k.renewed[0]!.heading).toBe("Plain");
    const infos = await s.infos();
    expect(infos.get(K1)).toMatchObject({ conclusion: "orig" });
    expect(infos.get(k.renewed[0]!.id)).toMatchObject({ conclusion: "copy" });
    await s.ctx.destroy();
  });

  it("append without the comment makes a plain heading even with a matching heading text elsewhere", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body")]);
    const res = await s.edit({ op: "append", markdown: "## A\n\nagain\n" });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toBeUndefined();
    expect([...(await s.infos()).keys()]).toEqual([K1]);
    await s.ctx.destroy();
  });

  it("delete_section lists the knowledge it removed", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body"), H("hB", "B"), P("b1", "other")]);
    const sec = await s.section("hA");
    const res = await s.edit({ op: "delete_section", section_id: "hA", if_match: sec.section.fingerprint });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toEqual({ kept: [], created: [], removed: [{ id: K1, heading: "A" }], renewed: [], ignoredComments: 0 });
    await s.ctx.destroy();
  });

  it("reverting a write that changed knowledge brings the old knowledge back", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "keep" }), P("a1", "body")]);
    const sec = await s.section("hA");
    const res = await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint, markdown: "## Renamed\n\nbody\n" });
    expect(res.statusCode, res.body).toBe(201);
    expect((await s.infos()).size).toBe(0);
    const [row] = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${row!.id}/revert`, headers: bearer(s.pat.token) });
    expect(rv.statusCode, rv.body).toBe(201);
    expect((await s.infos()).get(K1)).toMatchObject({ conclusion: "keep" });
    await s.ctx.destroy();
  });
});

describe("what is rejected", () => {
  it("outdated without superseded_by is 400 invalid_knowledge when it changes the knowledge, and accepted when it is what the note already stores", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeStatus: "outdated" }), P("a1", "body"), H("hB", "B"), P("b1", "other")]);
    const sec = await s.section("hA");
    const same = await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint, markdown: sec.section.markdown });
    expect(same.statusCode, same.body).toBe(201);
    const secB = await s.section("hB");
    const bad = await s.edit({ op: "insert_after", section_id: "hB", if_match: secB.section.fingerprint, markdown: `## New\n${comment(["when: w", "status: outdated"])}\n\nx\n` });
    expect(bad.statusCode).toBe(400);
    expect(errOf(bad).code).toBe("invalid_knowledge");
    expect(errOf(bad).message).toBe('The knowledge comment under the heading "New" says outdated without a `superseded_by`. Nothing was written.');
    await s.ctx.destroy();
  });

  it("a malformed comment is 400 invalid_knowledge naming the heading, and nothing is written", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body")]);
    const before = await s.content();
    const res = await s.edit({ op: "replace_all", if_match: before.fingerprint, markdown: "## D1\n<!-- knotebook:knowledge\nsome line\n-->\n\nbody\n" });
    expect(res.statusCode).toBe(400);
    expect(errOf(res)).toEqual({ code: "invalid_knowledge", message: 'The knowledge comment under the heading "D1" has a line that isn\'t key: value. Nothing was written.' });
    expect((await s.content()).fingerprint).toBe(before.fingerprint);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("a value with a line break is 400 invalid_knowledge line_break; a stored one with a line break written back unchanged is accepted", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeWhen: "first\nsecond" }), P("a1", "body")]);
    const before = await s.content();
    const same = await s.edit({ op: "replace_all", if_match: before.fingerprint, markdown: before.markdown });
    expect(same.statusCode, same.body).toBe(201);
    expect((await s.infos()).get(K1)!.when).toBe("first\nsecond");
    const bad = await s.edit({ op: "append", markdown: `## Z\n${comment(['when: "a\\nb"'])}\n\nx\n` });
    expect(bad.statusCode).toBe(400);
    expect(errOf(bad).message).toBe('The knowledge comment under the heading "Z" has a line break in `when`: write it on one line. Nothing was written.');
    await s.ctx.destroy();
  });

  it("replace_all that writes an existing id on another heading and none on the original keeps the original's knowledge and renews the other", async () => {
    const s = await setup([KH("hA", "A", "k_0000000a", { knowledgeConclusion: "orig" }), P("a1", "body"), H("hX", "X"), P("x1", "other")]);
    const whole = (await s.content()).fingerprint;
    const res = await s.edit({
      op: "replace_all", if_match: whole,
      markdown: `## A

body

## X
${comment(["id: k_0000000a", "when: moved"])}

other
`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    expect(k.kept).toEqual([{ id: "k_0000000a", heading: "A" }]);
    expect(k.renewed).toHaveLength(1);
    expect(k.renewed[0]).toMatchObject({ heading: "X", from: "k_0000000a" });
    expect(k.created).toEqual([]);
    const infos = await s.infos();
    expect(infos.get("k_0000000a")).toMatchObject({ conclusion: "orig", when: "alice reads this" });
    expect(infos.get(k.renewed[0]!.id)).toMatchObject({ when: "moved" });
    await s.ctx.destroy();
  });

  it("replace_all that moves the original after a heading carrying its id leaves the id with the original, whatever the order", async () => {
    const s = await setup([KH("hA", "A", "k_0000000a", { knowledgeConclusion: "orig" }), H("hB", "B")]);
    const res = await s.edit({
      op: "replace_all", if_match: (await s.content()).fingerprint,
      markdown: `## B

## X
${comment(["id: k_0000000a", "when: moved"])}

## A
`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    const ids = await s.idsByHeading();
    expect(ids.get("A")).toBe("k_0000000a");
    expect(ids.get("X")).not.toBe("k_0000000a");
    expect(k.kept).toEqual([{ id: "k_0000000a", heading: "A" }]);
    expect(k.renewed).toEqual([{ id: ids.get("X")!, heading: "X", from: "k_0000000a" }]);
    expect(k.created).toEqual([]);
    const infos = await s.infos();
    expect(infos.get("k_0000000a")).toMatchObject({ conclusion: "orig", when: "alice reads this" });
    expect(infos.get(ids.get("X")!)).toMatchObject({ when: "moved" });
    await s.ctx.destroy();
  });

  it("replace_section that copies the section's comment onto a renamed heading above the plain original: the original keeps the id and kept names it", async () => {
    const s = await setup([KH("hA", "A", "k_0000000a", { knowledgeConclusion: "orig" }), P("a1", "body"), H("hB", "B"), P("b1", "bb")]);
    const sec = await s.section("hA");
    const res = await s.edit({
      op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint,
      markdown: `## A2
${comment(["id: k_0000000a", "when: alice reads this", "conclusion: orig"])}

body

## A

new part
`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    const ids = await s.idsByHeading();
    expect(ids.get("A")).toBe("k_0000000a");
    expect(ids.get("A2")).not.toBe("k_0000000a");
    expect(k.kept).toEqual([{ id: "k_0000000a", heading: "A" }]);
    expect(k.renewed).toEqual([{ id: ids.get("A2")!, heading: "A2", from: "k_0000000a" }]);
    expect(k.created).toEqual([]);
    expect((await s.infos()).get(ids.get("A2")!)).toMatchObject({ conclusion: "orig" });
    await s.ctx.destroy();
  });

  it("replace_section that adds a heading with the original's id keeps the original's knowledge and renews the added one", async () => {
    const s = await setup([KH("hA", "A", "k_0000000a", { knowledgeConclusion: "orig" }), P("a1", "body")]);
    const sec = await s.section("hA");
    const res = await s.edit({
      op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint,
      markdown: `## A

body

## X
${comment(["id: k_0000000a", "when: moved"])}

more
`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    expect(k.kept).toEqual([{ id: "k_0000000a", heading: "A" }]);
    expect(k.renewed.map(r => r.heading)).toEqual(["X"]);
    expect((await s.infos()).get("k_0000000a")).toMatchObject({ conclusion: "orig" });
    await s.ctx.destroy();
  });

  it("a heading renamed with its comment kept carries the id to the new name; nothing is renewed", async () => {
    const s = await setup([KH("hA", "A", "k_0000000a", { knowledgeConclusion: "orig" }), P("a1", "body")]);
    const whole = (await s.content()).fingerprint;
    const res = await s.edit({
      op: "replace_all", if_match: whole,
      markdown: `## A renamed
${comment(["id: k_0000000a", "when: alice reads this", "conclusion: orig"])}

body
`,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toBeUndefined();
    expect((await s.infos()).get("k_0000000a")).toMatchObject({ conclusion: "orig" });
    await s.ctx.destroy();
  });

  it("append of a heading with an id the note didn't have lists it in knowledge.created", async () => {
    const s = await setup([P("p1", "body")]);
    const res = await s.edit({ op: "append", markdown: `## A
${comment(["id: k_12345678", "when: w"])}

x
` });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toEqual({ kept: [], created: [{ id: "k_12345678", heading: "A" }], removed: [], renewed: [], ignoredComments: 0 });
    await s.ctx.destroy();
  });

  it("a note whose stored state already has a k_new: id still takes unrelated writes", async () => {
    const s = await setup([KH("hA", "A", "k_new:0"), P("a1", "body")]);
    const res = await s.edit({ op: "append", markdown: "tail\n" });
    expect(res.statusCode, res.body).toBe(201);
    await s.ctx.destroy();
  });

  it("duplicates the note already had stay as they were when an append writes a third heading with that id: only the added one is renewed", async () => {
    const s = await setup([KH("hA", "A", K1), KH("hB", "B", K1, { knowledgeConclusion: "second" }), P("p1", "x")]);
    const res = await s.edit({ op: "append", markdown: `## C
${comment([`id: ${K1}`, "when: c"])}

y
` });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    expect(k.renewed.map(r => r.heading)).toEqual(["C"]);
    const out = await s.content();
    expect(out.markdown).toContain(`## B
${comment([`id: ${K1}`, "when: alice reads this", "conclusion: second"])}`);
    await s.ctx.destroy();
  });

  it("a pending id written by the caller as a block id never reaches the note", async () => {
    const s = await setup([P("p1", "body")]);
    const res = await s.edit({ op: "append", markdown: `## Z\n${comment(["id: k_new:0", "when: w"])}\n\nx\n` });
    expect(res.statusCode).toBe(400);
    expect(errOf(res).code).toBe("invalid_knowledge");
    expect(errOf(res).message).toBe("The knowledge comment under the heading \"Z\" has an `id` that isn't k_ followed by 8 lowercase hex digits (leave the id line out for new knowledge). Nothing was written.");
    await s.ctx.destroy();
  });

  it("create with content whose comment says outdated without superseded_by is 400 invalid_knowledge naming the heading, and no note is created", async () => {
    const s = await setup([P("p1", "body")]);
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: s.u.id, tv: 0 })}`;
    const rowsBefore = await noteRows(s);
    const res = await s.ctx.app.inject({
      method: "POST", url: "/api/notes", headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
      payload: { title: "Fresh", content: `## D1\n${comment(["when: w", "status: outdated"])}\n\nx\n` },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(errOf(res)).toEqual({ code: "invalid_knowledge", message: 'The knowledge comment under the heading "D1" says outdated without a `superseded_by`. Nothing was written.' });
    expect(await noteRows(s)).toBe(rowsBefore);
    await s.ctx.destroy();
  });
});

describe("reply and bookkeeping", () => {
  it("ignored comments are counted in knowledge.ignoredComments", async () => {
    const s = await setup([P("p1", "body")]);
    const res = await s.edit({ op: "append", markdown: `plain paragraph\n\n${comment(["when: nowhere"])}\n\nmore\n` });
    expect(res.statusCode, res.body).toBe(201);
    expect(knowledgeOf(res)).toEqual({ kept: [], created: [], removed: [], renewed: [], ignoredComments: 1 });
    expect((await s.infos()).size).toBe(0);
    await s.ctx.destroy();
  });

  it("a reply carries no knowledge key when nothing about knowledge happened", async () => {
    const s = await setup([P("p1", "body")]);
    const res = await s.edit({ op: "append", markdown: "## Plain\n\ntext\n" });
    expect(res.statusCode, res.body).toBe(201);
    expect(Object.keys(res.json() as object).sort()).toEqual(["editId", "fingerprint", "outline", "unboundWikilinks"]);
    await s.ctx.destroy();
  });

  it("superseded_by written as <this note>#k_x is stored as k_x", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body")]);
    const res = await s.edit({
      op: "append",
      markdown: `## Old\n${comment(["when: w", "status: outdated", `superseded_by: ${s.note.id}#${K1}`])}\n\nx\n`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = knowledgeOf(res)!.created[0]!;
    expect((await s.infos()).get(created.id)!.supersededBy).toBe(K1);
    await s.ctx.destroy();
  });

  it("a write that changes knowledge changes the version fingerprint, so it goes into version history", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "body")]);
    const before = await s.versionFp();
    const sec = await s.section("hA");
    const res = await s.edit({
      op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint,
      markdown: `## A\n${comment([`id: ${K1}`, "when: changed"])}\n\nbody\n`,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await s.versionFp()).not.toBe(before);
    await s.ctx.destroy();
  });
});

describe("applying a version", () => {
  async function savedVersion(s: S) {
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: s.u.id, tv: 0 })}`;
    const headers = { cookie, "content-type": "application/json", origin: "http://localhost:3000" };
    const saved = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/versions`, headers, payload: {} });
    expect(saved.statusCode, saved.body).toBe(201);
    const apply = () => s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/versions/${saved.json().seq}/apply`, headers, payload: { versionId: saved.json().id, discardUnsaved: true } });
    return { apply };
  }

  it("applying a version brings back the knowledge it had", async () => {
    const s = await setup([KH("hA", "A", K1, { knowledgeConclusion: "then" }), P("a1", "body")]);
    const v = await savedVersion(s);
    const sec = await s.section("hA");
    const res = await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint, markdown: `## A\n${comment([`id: ${K1}`, "when: later"])}\n\nbody\n` });
    expect(res.statusCode, res.body).toBe(201);
    expect((await s.infos()).get(K1)).toMatchObject({ when: "later", conclusion: "" });
    const applied = await v.apply();
    expect(applied.statusCode, applied.body).toBeLessThan(300);
    expect((await s.infos()).get(K1)).toMatchObject({ when: "alice reads this", conclusion: "then" });
    await s.ctx.destroy();
  });

  it("applying a version saved before a heading got knowledge info leaves that heading without it", async () => {
    const s = await setup([H("hA", "A"), P("a1", "body")]);
    const v = await savedVersion(s);
    const sec = await s.section("hA");
    const res = await s.edit({ op: "replace_section", section_id: "hA", if_match: sec.section.fingerprint, markdown: `## A\n${comment(["when: now"])}\n\nbody\n` });
    expect(res.statusCode, res.body).toBe(201);
    expect((await s.infos()).size).toBe(1);
    const applied = await v.apply();
    expect(applied.statusCode, applied.body).toBeLessThan(300);
    expect((await s.infos()).size).toBe(0);
    await s.ctx.destroy();
  });
});

describe("keeping knowledge when a section is retyped", () => {
  it("two swapped knowledge headings sent without comments both keep theirs", async () => {
    const s = await setup([KH("hA", "A", K1), P("a1", "a body"), KH("hB", "B", K2), P("b1", "b body")]);
    const whole = (await s.content()).fingerprint;
    const res = await s.edit({ op: "replace_all", if_match: whole, markdown: "## B\n\nb body\n\n## A\n\na body\n" });
    expect(res.statusCode, res.body).toBe(201);
    const k = knowledgeOf(res)!;
    expect(k.kept.map(r => r.id).sort()).toEqual([K1, K2]);
    const infos = await s.infos();
    expect([...infos.keys()].sort()).toEqual([K1, K2]);
    await s.ctx.destroy();
  });
});
