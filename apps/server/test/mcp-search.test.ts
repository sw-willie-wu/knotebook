/**
 * #93 §8：MCP search_notes 的輸出（M1 MCP 層、M3、M5 端到端、M8、M9）。M6／M10 在 mcp-size.test.ts，M7 在 mcp-notes.test.ts。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedContent, seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedIndexedNote, waitIndexed } from "./search-helpers.js";
import { SEARCH_NOTES_DESCRIPTION_NO_READ, SEARCH_NOTES_DESCRIPTION_READ } from "../src/mcp/tools/search-notes.js";

const PASSWORD = "correct-horse-battery";
type Hit = { id: string; matchedOn: string; matches: Array<{ sectionId: string; heading: string; headingTruncated?: true; snippet: string }> } & Record<string, unknown>;

async function call(app: FastifyInstance, token: string, name: string, args: unknown) {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  const result = res.json().result as { isError?: true; content: { text: string }[]; structuredContent: Record<string, unknown> };
  expect(result.isError).toBeUndefined();
  expect(result.content[0]!.text).toBe(JSON.stringify(result.structuredContent));
  return result.structuredContent;
}
const hitsOf = (p: Record<string, unknown>) => p.notes as Hit[];

/** `tools/list` 裡我們會讀到的那幾層 JSON Schema（只列本檔用到的鍵）。 */
type Described = { description?: string };
type MatchSchema = { properties: { sectionId: Described } };
type HitSchema = { properties: { matchedOn: Described; matches: Described & { items: MatchSchema } } };
interface ListedTool {
  name: string;
  description: string;
  inputSchema: { properties: { query: Described } };
  outputSchema: { properties: { notes: { items: HitSchema }; matchesTruncated: Described } };
}

async function toolsList(app: FastifyInstance, token: string) {
  const res = await mcpPost(app, rpc("tools/list"), { token });
  expect(res.statusCode).toBe(200);
  return { body: res.body, tools: res.json().result.tools as ListedTool[] };
}

describe("M8 描述逐字（兩種部署形態）", () => {
  it("有 collab（讀取工具在）：description、query 與 sectionId 的說明逐字；舊句不在", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: `m8-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const { body, tools } = await toolsList(ctx.app, token);
    const t = tools.find(x => x.name === "search_notes")!;
    expect(t.description).toBe(SEARCH_NOTES_DESCRIPTION_READ);
    expect(SEARCH_NOTES_DESCRIPTION_READ).toBe(
      "Find notes among the ones you can see by text in their title or body. Matching is case-insensitive and literal. Notes whose title matches come first — exact titles, then titles that start with your text, then the rest — then notes that match only in the body. A body match lists up to 3 sections in document order, each with an excerpt near the first hit; pass a `sectionId` to read_note_section. `matches` can be empty for a body match; read the note's outline then. Saved changes are usually searchable within seconds, but right after an upgrade older notes may match by title only for a while. Attachments are not searched.",
    );
    expect(t.inputSchema.properties.query.description).toBe("Text to look for in note titles and body text. Matched literally — `%` and `_` are not wildcards.");
    const item = t.outputSchema.properties.notes.items.properties;
    expect(item.matches.items.properties.sectionId.description).toBe("Pass this to read_note_section.");
    expect(item.matchedOn.description).toBe("Whether your text was found in the title, the body, or both.");
    expect(t.outputSchema.properties.matchesTruncated.description).toBe("Present when some matches were left out to keep this reply small. Ask for fewer notes with `limit`.");
    expect(body).not.toContain("Searches note titles only");
  });

  it("無 collab：description 與 sectionId 說明是另一版，不含 read_note_section／outline／seconds", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    const { tools } = await toolsList(app, token);
    const t = tools.find(x => x.name === "search_notes")!;
    expect(t.description).toBe(SEARCH_NOTES_DESCRIPTION_NO_READ);
    expect(SEARCH_NOTES_DESCRIPTION_NO_READ).toBe(
      "Find notes among the ones you can see by text in their title or body. Matching is case-insensitive and literal. Notes whose title matches come first — exact titles, then titles that start with your text, then the rest — then notes that match only in the body. A body match lists up to 3 sections in document order, each with an excerpt near the first hit; `matches` can be empty for a body match. Attachments are not searched.",
    );
    for (const banned of ["read_note_section", "outline", "seconds"]) expect(t.description).not.toContain(banned);
    expect(t.outputSchema.properties.notes.items.properties.matches.items.properties.sectionId.description).toBe("The section's id.");
  });
});

describe("M1（MCP 層）／M9", () => {
  it("matchedOn 三值；title 時 matches 為空；頂層 key 恰為 notes、truncated，沒有 cursor／頂層 matchedOn", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    const title = await seedNote(db, { ownerId: u.id }, { title: "sigma only title" });
    const both = await seedIndexedNote(db, { ownerId: u.id }, "sigma both", [{ id: "p", text: "sigma in body" }]);
    const body = await seedIndexedNote(db, { ownerId: u.id }, "unrelated", [{ id: "p", text: "and sigma here" }]);
    const p = await call(app, token, "search_notes", { query: "sigma" });
    expect(Object.keys(p).sort()).toEqual(["notes", "truncated"]);
    const byId = new Map(hitsOf(p).map(h => [h.id, h]));
    expect(byId.get(title.id)).toMatchObject({ matchedOn: "title", matches: [] });
    expect(byId.get(both.id)!.matchedOn).toBe("both");
    expect(byId.get(both.id)!.matches).toHaveLength(1);
    expect(byId.get(body.id)!.matchedOn).toBe("body");
    expect(hitsOf(p).map(h => h.id).at(-1)).toBe(body.id);
    expect(JSON.stringify(p)).not.toMatch(/"(next)?[cC]ursor"/);
  });
});

describe("M3 matches 接 read_note_section", () => {
  it("最多 3 個、文件順序；sectionId 讀得到且含命中字；heading 與 outline 同段相同", async () => {
    const ctx = await buildCollabTestApp();
    const email = `m3-${randomUUID()}@example.com`;
    const u = await ctx.createUser({ email, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const note = await ctx.createNote(u.id, "zeta host");
    const session = await ctx.loginAs(email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, "# Alpha\n\nfoo zeta one\n\n# Beta\n\nbar\n\n# Gamma\n\nzeta two\n\n# Delta\n\nzeta three\n\n# Eps\n\nzeta four");
    client.disconnect();
    await waitIndexed(ctx.db, note.id, b => b.includes("zeta four"));
    const hit = hitsOf(await call(ctx.app, token, "search_notes", { query: "ZETA" })).find(h => h.id === note.id)!;
    expect(hit.matchedOn).toBe("both");
    expect(hit.matches.map(m => m.heading)).toEqual(["Alpha", "Gamma", "Delta"]);
    const outline = (await call(ctx.app, token, "read_note_outline", { note_id: note.id })).sections as Array<{ sectionId: string; heading: string }>;
    for (const m of hit.matches) {
      expect(outline.find(o => o.sectionId === m.sectionId)?.heading).toBe(m.heading);
      const sec = await call(ctx.app, token, "read_note_section", { note_id: note.id, section_id: m.sectionId });
      expect((sec.section as { markdown: string }).markdown.toLowerCase()).toContain("zeta");
      expect(m.snippet.toLowerCase()).toContain("zeta");
    }
  });
});

describe("M5 端到端", () => {
  it("40 個 U+0001 前文＋命中 → 摘錄含整段命中、逃脫後 ≤ 160", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    const n = await seedIndexedNote(db, { ownerId: u.id }, "c0", [{ id: "p", text: `${"\u0001".repeat(40)}zeta tail` }]);
    const m = hitsOf(await call(app, token, "search_notes", { query: "zeta" })).find(h => h.id === n.id)!.matches[0]!;
    expect(m.snippet).toContain("zeta tail");
    expect(JSON.stringify(m.snippet).length - 2).toBeLessThanOrEqual(160);
  });
});
