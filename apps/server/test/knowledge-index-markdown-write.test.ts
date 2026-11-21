// A knowledge comment written as Markdown through edit_note reaches the knowledge index; a heading rewritten as a paragraph takes its row out again.
import { describe, expect, it } from "vitest";
import type { KnowledgeIndexDto } from "@knotebook/shared";
import { seedBlocks, callTool } from "./bulk-transfer-helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";

const comment = (lines: string[]) => `<!-- knotebook:knowledge\n${lines.join("\n")}\n-->`;
const K1 = "k_00000001";

describe("edit_note and the knowledge index", () => {
  it("a heading written with a knowledge comment is in the index after the reply; a rewrite that turns the heading into a paragraph removes it", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
    await seedBlocks(ctx.db, note.id, [{ id: "p1", type: "paragraph", content: "intro" }]);
    const index = async () => {
      const res = await ctx.app.inject({ method: "GET", url: "/api/knowledge/index/me", cookies: await cookieOf(u.id) });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as KnowledgeIndexDto;
    };
    const fingerprint = async () => {
      const res = await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/content`, headers: { authorization: `Bearer ${pat.token}` } });
      return (res.json() as { fingerprint: string }).fingerprint;
    };

    const added = await callTool(ctx.app, pat.token, "edit_note", {
      note_id: note.id, op: "append", markdown: `## Rule\n${comment([`id: ${K1}`, "when: reading the rule"])}\n\nbody\n`,
    });
    expect(added.isError, JSON.stringify(added.structuredContent)).toBeUndefined();
    const before = await index();
    expect(before.entries.map(e => e.knowledgeId)).toEqual([K1]);

    const removed = await callTool(ctx.app, pat.token, "edit_note", {
      note_id: note.id, op: "replace_all", if_match: await fingerprint(), markdown: "intro\n\nRule\n\nbody\n",
    });
    expect(removed.isError, JSON.stringify(removed.structuredContent)).toBeUndefined();
    expect((await index()).entries).toEqual([]);
  });
});
