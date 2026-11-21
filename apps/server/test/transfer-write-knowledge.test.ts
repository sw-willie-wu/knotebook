// Knowledge info through the file path: what a download shows, what a file sends back, and what the reply says about it.
import { describe, expect, it } from "vitest";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { knowledgeInfoById } from "../src/notes/editing/knowledge-write.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, issueBulkDirect, seedBlocks, topIdsOf } from "./bulk-transfer-helpers.js";
import { buildCollabTestApp } from "./helpers.js";

const comment = (lines: string[]) => `<!-- knotebook:knowledge\n${lines.join("\n")}\n-->`;
const K1 = "k_00000001";
const K2 = "k_00000002";

async function setup(md: string) {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const create = await bulkPut(ctx.app, bulk.token, `---\nknotebook: 1\ntitle: "Notes"\n---\n${md}`);
  expect(create.statusCode, create.body).toBe(201);
  const noteId = create.json().id as string;
  const infos = async () => knowledgeInfoById((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, noteId)).doc.getXmlFragment(YDOC_FRAGMENT));
  const download = () => downloadNote(ctx.app, bulk.token, noteId);
  const put = (text: string) => bulkPut(ctx.app, bulk.token, text);
  return { ctx, u, bulk, noteId, infos, download, put };
}

const TWO = `## First\n${comment([`id: ${K1}`, "when: when A", "conclusion: use A"])}\n\nfirst body\n\n## Second\n${comment([`id: ${K2}`, "when: when B", "conclusion: use B"])}\n\nsecond body\n\n## Third\n\nthird body\n`;

describe("a file with knowledge comments", () => {
  it("sent back unchanged is unchanged; with one paragraph changed only that paragraph's block changes and the knowledge heading keeps its id, props and block id", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    expect(d.body).toContain(`id: ${K1}`);
    const infoBefore = await s.infos();
    const idsBefore = await topIdsOf(s.ctx, s.noteId);
    const same = await s.put(d.text);
    expect(same.json()).toMatchObject({ result: "unchanged", applied: 0 });
    expect(same.json()).not.toHaveProperty("knowledge");
    const r = await s.put(editBody(d.text, b => b.replace("second body", "second body changed")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect(r.json()).not.toHaveProperty("knowledge");
    expect(await s.infos()).toEqual(infoBefore);
    const idsAfter = await topIdsOf(s.ctx, s.noteId);
    expect(idsAfter).toEqual(idsBefore);
    await s.ctx.destroy();
  });

  it("changing a value in a comment rewrites only that heading and the reply has no knowledge key", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const before = await s.infos();
    const r = await s.put(editBody(d.text, b => b.replace("when: when A", "when: when A changed")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect(r.json()).not.toHaveProperty("knowledge");
    const after = await s.infos();
    expect(after.get(K1)?.when).toBe("when A changed");
    expect(after.get(K2)).toEqual(before.get(K2));
    await s.ctx.destroy();
  });

  it("taking a comment out removes the knowledge and lists it in knowledge.removed", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const r = await s.put(editBody(d.text, b => b.replace(`\n${comment([`id: ${K1}`, "when: when A", "conclusion: use A"])}\n`, "\n")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().knowledge).toEqual({ kept: [], created: [], removed: [{ id: K1, heading: "First" }], renewed: [], ignoredComments: 0 });
    const after = await s.infos();
    expect([...after.keys()]).toEqual([K2]);
    await s.ctx.destroy();
  });

  it("copying a knowledge heading with its comment elsewhere in the file renews the copy's id and reports it", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const copy = `\n\n## First copy\n${comment([`id: ${K1}`, "when: when A", "conclusion: use A"])}\n\ncopied body\n`;
    const r = await s.put(editBody(d.text, b => `${b.replace(/\n+$/, "")}${copy}`));
    expect(r.statusCode, r.body).toBe(200);
    const k = r.json().knowledge as { created: unknown[]; renewed: Array<{ id: string; heading: string; from: string }>; removed: unknown[] };
    expect(k.created).toEqual([]);
    expect(k.removed).toEqual([]);
    expect(k.renewed).toHaveLength(1);
    expect(k.renewed[0]).toMatchObject({ heading: "First copy", from: K1 });
    expect(k.renewed[0]!.id).toMatch(/^k_[0-9a-f]{8}$/);
    const after = await s.infos();
    expect(after.get(K1)?.when).toBe("when A");
    expect(after.get(k.renewed[0]!.id)?.when).toBe("when A");
    await s.ctx.destroy();
  });

  it("a rewritten region that holds the original heading but carries another heading's id renews that id; the other heading keeps its own", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const r = await s.put(editBody(d.text, b => b.replace(`id: ${K1}`, `id: ${K2}`)));
    expect(r.statusCode, r.body).toBe(200);
    const k = r.json().knowledge as { created: unknown[]; renewed: Array<{ id: string; heading: string; from: string }>; removed: Array<{ id: string; heading: string }> };
    expect(k.renewed).toHaveLength(1);
    expect(k.renewed[0]).toMatchObject({ heading: "First", from: K2 });
    expect(k.removed).toEqual([{ id: K1, heading: "First" }]);
    expect(k.created).toEqual([]);
    const after = await s.infos();
    expect(after.get(K2)?.when).toBe("when B");
    expect(after.has(K1)).toBe(false);
    expect(after.get(k.renewed[0]!.id)?.when).toBe("when A");
    await s.ctx.destroy();
  });

  it("an id written in full that is new to the note is created; an id left out gets a generated one, also created", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const add = `\n\n## Fourth\n${comment(["id: k_0000000f", "when: w4"])}\n\nfourth\n\n## Fifth\n${comment(["when: w5"])}\n\nfifth\n`;
    const r = await s.put(editBody(d.text, b => `${b.replace(/\n+$/, "")}${add}`));
    expect(r.statusCode, r.body).toBe(200);
    const k = r.json().knowledge as { created: Array<{ id: string; heading: string }>; renewed: unknown[] };
    expect(k.created.map(c => c.heading).sort()).toEqual(["Fifth", "Fourth"]);
    expect(k.created.map(c => c.id)).toContain("k_0000000f");
    expect(k.renewed).toEqual([]);
    await s.ctx.destroy();
  });

  it("a malformed comment is 400 invalid_knowledge naming the heading, and nothing is written", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const idsBefore = await topIdsOf(s.ctx, s.noteId);
    const r = await s.put(editBody(d.text, b => b.replace("when: when A", "this line has no colon")));
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("invalid_knowledge");
    expect(r.json().error.message).toContain('"First"');
    expect(await topIdsOf(s.ctx, s.noteId)).toEqual(idsBefore);
    await s.ctx.destroy();
  });

  it("a comment with no blank line after it is 400 invalid_knowledge blank_line_missing", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const r = await s.put(editBody(d.text, b => b.replace("-->\n\nfirst body", "-->\nfirst body")));
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("invalid_knowledge");
    expect(r.json().error.message).toContain("blank line");
    await s.ctx.destroy();
  });

  it("a comment whose id line was taken out keeps the knowledge's id when its heading is unchanged", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const r = await s.put(editBody(d.text, b => b.replace(`id: ${K1}\n`, "").replace("when A", "when A edited")));
    expect(r.statusCode, r.body).toBe(200);
    const after = await s.infos();
    expect(after.get(K1)?.when).toBe("when A edited");
    expect(after.size).toBe(2);
    expect(r.json()).not.toHaveProperty("knowledge");
    await s.ctx.destroy();
  });

  it("taking out the blank line after --> while also changing a paragraph two sections below fails like replace_all of the whole file", async () => {
    const s = await setup(TWO);
    const d = await s.download();
    const broken = editBody(d.text, b => b.replace("-->\n\nfirst body", "-->\nfirst body").replace("third body", "third body changed"));
    const viaFile = await s.put(broken);
    const pat = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const whole = (await getContent(s.ctx.app, s.noteId, pat.token)).json() as { fingerprint: string };
    const viaEdit = await s.ctx.app.inject({
      method: "POST",
      url: `/api/notes/${s.noteId}/edits`,
      headers: bearer(pat.token),
      payload: { op: "replace_all", if_match: whole.fingerprint, markdown: parseBody(broken) },
    });
    expect(viaFile.statusCode).toBe(400);
    expect(viaEdit.statusCode).toBe(400);
    expect(viaEdit.json().error, "edit path").toEqual(viaFile.json().error);
    await s.ctx.destroy();
  });
});

const parseBody = (text: string): string => text.slice(text.indexOf("\n---\n", 4) + 5);

describe("values that need quoting round-trip through a download and a write-back", () => {
  const TRICKY: Array<[string, string]> = [
    ["an arrow", "a --> b"],
    ["a bang arrow", "a --!> b"],
    ["a leading quote", '"quoted" start'],
    ["surrounding spaces", "  padded  "],
    ["a windows path", "C:\\Users\\alice"],
    ["a line separator", "one\u2028two"],
    ["a next-line character", "one\u0085two"],
    ["a newline", "one\ntwo"],
    ["cjk and emoji", "中文 😀"],
  ];
  it.each(TRICKY)("%s", async (_name, value) => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "T" });
    await seedBlocks(ctx.db, note.id, [
      { type: "heading", props: { level: 2, knowledgeId: K1, knowledgeWhen: value, knowledgeConclusion: value }, content: "Heading" },
      { type: "paragraph", content: "body" },
    ]);
    const infos = async () => knowledgeInfoById((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc.getXmlFragment(YDOC_FRAGMENT));
    const before = await infos();
    expect(before.get(K1)?.when).toBe(value);
    const d = await downloadNote(ctx.app, bulk.token, note.id);
    expect(d.text).not.toMatch(/[\u0085\u2028]/);
    const same = await bulkPut(ctx.app, bulk.token, d.text);
    expect(same.json()).toMatchObject({ result: "unchanged" });
    const r = await bulkPut(ctx.app, bulk.token, editBody(d.text, b => b.replace("body", "body changed")));
    expect(r.statusCode, r.body).toBe(200);
    expect(await infos()).toEqual(before);
    await ctx.destroy();
  });
});

describe("a section's region includes its comment lines", () => {
  it("a note with many knowledge headings downloads mergeable, and a change in one comment line is one rewritten place", async () => {
    const md = Array.from({ length: 30 }, (_, i) => {
      const id = `k_${String(i + 1).padStart(8, "0")}`;
      return `## Heading ${i}\n${comment([`id: ${id}`, `when: w${i}`, `conclusion: c${i}`])}\n\nbody ${i}\n`;
    }).join("\n");
    const s = await setup(md);
    const d = await s.download();
    const r = await s.put(editBody(d.text, b => b.replace("conclusion: c7\n", "conclusion: c7 changed\n")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    expect((await s.infos()).get("k_00000008")?.conclusion).toBe("c7 changed");
    await s.ctx.destroy();
  });
});

describe("a new-note file", () => {
  it("keeps its knowledge comments and reports the created ids", async () => {
    const s = await setup("plain\n");
    const r = await s.put(`---\nknotebook: 1\ntitle: "Second"\n---\n## D\n${comment(["id: k_0000000a", "when: w"])}\n\nx\n`);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().knowledge).toMatchObject({ created: [{ id: "k_0000000a", heading: "D" }] });
    await s.ctx.destroy();
  });
});

async function seeded(blocks: unknown[]) {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Seeded" });
  await seedBlocks(ctx.db, note.id, blocks);
  const infos = async () => knowledgeInfoById((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc.getXmlFragment(YDOC_FRAGMENT));
  return { ctx, bulk, note, infos, download: () => downloadNote(ctx.app, bulk.token, note.id), put: (text: string) => bulkPut(ctx.app, bulk.token, text) };
}

describe("a heading whose markdown can't carry the comment back", () => {
  it("a coloured toggle heading rewritten by a file loses its knowledge, and knowledge.removed lists it", async () => {
    const s = await seeded([
      { type: "heading", props: { level: 2, textColor: "red", isToggleable: true, knowledgeId: K1, knowledgeWhen: "w" }, content: "Coloured", children: [{ type: "paragraph", content: "inside" }] },
      { type: "paragraph", content: "tail" },
    ]);
    const d = await s.download();
    const same = await s.put(d.text);
    expect(same.json()).toMatchObject({ result: "unchanged" });
    const r = await s.put(editBody(d.text, b => b.replace("Coloured", "Coloured again")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().knowledge.removed).toEqual([{ id: K1, heading: "Coloured" }]);
    expect((await s.infos()).size).toBe(0);
    await s.ctx.destroy();
  });

  it("an empty heading rewritten by a file loses its knowledge: it is listed under removed and its comment under ignoredComments", async () => {
    const s = await seeded([
      { type: "heading", props: { level: 2, knowledgeId: K1, knowledgeWhen: "w" }, content: "" },
      { type: "paragraph", content: "tail" },
    ]);
    const d = await s.download();
    const same = await s.put(d.text);
    expect(same.json()).toMatchObject({ result: "unchanged" });
    const r = await s.put(editBody(d.text, b => b.replace("when: w", "when: w2")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().knowledge).toMatchObject({ removed: [{ id: K1, heading: "" }], ignoredComments: 1 });
    expect((await s.infos()).size).toBe(0);
    await s.ctx.destroy();
  });
});

describe("ids a note already repeated", () => {
  it("are left as they were: a file that changes a paragraph, or the second heading's comment, renews nothing", async () => {
    const s = await seeded([
      { type: "heading", props: { level: 2, knowledgeId: K1, knowledgeWhen: "first" }, content: "One" },
      { type: "paragraph", content: "one body" },
      { type: "heading", props: { level: 2, knowledgeId: K1, knowledgeWhen: "second" }, content: "Two" },
      { type: "paragraph", content: "two body" },
    ]);
    const idsOf = async () => {
      const { knowledgeIdsByBlock } = await import("../src/notes/editing/knowledge-write.js");
      return [...knowledgeIdsByBlock((await loadNoteDoc({ db: s.ctx.db, collab: s.ctx.collab }, s.note.id)).doc.getXmlFragment(YDOC_FRAGMENT)).values()];
    };
    expect(await idsOf()).toEqual([K1, K1]);
    const d = await s.download();
    const p = await s.put(editBody(d.text, b => b.replace("two body", "two body changed")));
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).not.toHaveProperty("knowledge");
    const d2 = await s.download();
    const c = await s.put(editBody(d2.text, b => b.replace("when: second", "when: second changed")));
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).not.toHaveProperty("knowledge");
    expect(await idsOf()).toEqual([K1, K1]);
    await s.ctx.destroy();
  });
});
