// A file sent back goes through the same knowledge checks as every other write: a bad value is a 400 and nothing is written, and an id left out is never stored as a placeholder.
import { describe, expect, it } from "vitest";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { knowledgeInfoById } from "../src/notes/editing/knowledge-write.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, issueBulkDirect, seedMd } from "./bulk-transfer-helpers.js";
import { buildCollabTestApp } from "./helpers.js";

const comment = (lines: string[]) => `<!-- knotebook:knowledge\n${lines.join("\n")}\n-->`;

async function setup(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedMd(ctx.db, note.id, "intro paragraph\n\n## Existing\n\nbody text\n");
  const infos = async () => knowledgeInfoById((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc.getXmlFragment(YDOC_FRAGMENT));
  return { ctx, bulk, note, infos };
}

describe("a new-note file with a bad knowledge value", () => {
  it("is refused before any note row is created: the step right before the insert is never reached", async () => {
    let reached = 0;
    const s = await setup({ editingTestHooks: { beforeCreateFromFile: async () => { reached += 1; } } });
    const bad = await bulkPut(s.ctx.app, s.bulk.token, `---
knotebook: 1
title: "Fresh"
---
## D1
${comment(["when: w", "status: outdated"])}

x
`);
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe("invalid_knowledge");
    expect(reached).toBe(0);
    const good = await bulkPut(s.ctx.app, s.bulk.token, `---
knotebook: 1
title: "Fresh"
---
## D1
${comment(["when: w"])}

x
`);
    expect(good.statusCode, good.body).toBe(201);
    expect(reached).toBe(1);
    await s.ctx.destroy();
  });
});

describe("file write-back and knowledge comments", () => {
  it("a comment that says outdated without superseded_by is 400 invalid_knowledge naming the heading, and nothing is written", async () => {
    const s = await setup();
    const dl = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const put = await bulkPut(s.ctx.app, s.bulk.token, editBody(dl.text, b => `${b}\n\n## Old way\n${comment(["when: w", "status: outdated"])}\n\nx\n`));
    expect(put.statusCode, put.body).toBe(400);
    expect(put.json().error).toEqual({
      code: "invalid_knowledge",
      message: 'The knowledge comment under the heading "Old way" says outdated without a `superseded_by`. Nothing was written.',
    });
    expect((await s.infos()).size).toBe(0);
    await s.ctx.destroy();
  });

  it("a comment without an id gets a real id, never the placeholder", async () => {
    const s = await setup();
    const dl = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const put = await bulkPut(s.ctx.app, s.bulk.token, editBody(dl.text, b => `${b}\n\n## Fresh\n${comment(["when: w"])}\n\nx\n`));
    expect(put.statusCode, put.body).toBe(200);
    const infos = await s.infos();
    expect(infos.size).toBe(1);
    const [id] = [...infos.keys()];
    expect(id).toMatch(/^k_[0-9a-f]{8}$/);
    await s.ctx.destroy();
  });

  it("an id that another heading already has is renewed on the new one", async () => {
    const s = await setup();
    const dl = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const first = await bulkPut(s.ctx.app, s.bulk.token, editBody(dl.text, b => `${b}\n\n## Fresh\n${comment(["id: k_00000001", "when: w"])}\n\nx\n`));
    expect(first.statusCode, first.body).toBe(200);
    const dl2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const second = await bulkPut(s.ctx.app, s.bulk.token, editBody(dl2.text, b => `${b}\n\n## Copy\n${comment(["id: k_00000001", "when: copy"])}\n\nx\n`));
    expect(second.statusCode, second.body).toBe(200);
    const infos = await s.infos();
    expect(infos.size).toBe(2);
    expect(infos.get("k_00000001")).toMatchObject({ when: "w" });
    await s.ctx.destroy();
  });
});
