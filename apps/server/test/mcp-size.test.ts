/**
 * Two response-size thresholds, which are **two different things** - don't mix them:
 * - {@link N_LIST_MAX} governs the **context cost of `tools/list`** (every tool's input/output schema goes into the model's context; something must stop schemas from slowly bloating).
 *   It is a **test threshold**, not a production constant, so it doesn't live in `src/`.
 * - {@link MCP_MAX_WIRE} is `N`, governing **one `tools/call` response**. It is a **sentinel, not a target**: breaking it means a row of the table in `mcp/limits.ts` was missed;
 *   the right response is to go back and check that row, **not to raise N**.
 *
 * Everything measured is the **wire response** (`res.body.length`, UTF-16 code units), not the payload: the mirror makes the same payload appear twice in the response (the second time JSON-escaped),
 * `wire ~ 2.1 x payload`. The `tools/list` call also includes the SDK's own `"execution":{"taskSupport":"forbidden"}` and each schema's `"$schema"` line - only the whole body gives the cost that really enters the context.
 *
 * The image block is the only exemption from N, governed by `MCP_IMAGE_MAX_BYTES` (case (vi)).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import { groups, noteSearchSections, noteStates, notes, uploads, users } from "../src/db/schema.js";
import {
  MCP_DELETE_FOLDER_IDS_MAX,
  MCP_FOLDER_PAGE_MAX,
  MCP_IMAGE_MAX_BYTES,
  MCP_LIST_WIRE_BUDGET,
  MCP_PAGE_MAX,
} from "../src/mcp/limits.js";
import { fingerprintOf } from "../src/notes/editing/fingerprint.js";
import { writeSearchIndex } from "../src/notes/search-index.js";
import { SEARCH_EXTRACTOR_VERSION } from "../src/notes/search-text.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { getContent, seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedUpload } from "./copy-helpers.js";
import { cookieOf, seedGroup } from "./group-helpers.js";
import { seedFolder, seedFolderChain, seedManyNotesInFolder, setNoteFolder } from "./folder-helpers.js";
import { wireCost } from "../src/mcp/wire-budget.js";
import { knowledgeForModel } from "../src/mcp/knowledge-output.js";
import { markTrashed } from "./trash-helpers.js";
import type { Db } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

/**
 * `N`: upper bound of one `tools/call` wire response (UTF-16 code units). The same number as the `bodyLimit` of `POST /api/notes/:id/edits`:
 * however large a request may be, the response shouldn't be larger.
 */
export const MCP_MAX_WIRE = 262_144;

/**
 * Upper bound of the `tools/list` wire response (UTF-16 code units).
 *
 * **How it was set**: take W = the `tools/list` wire of the worst-case credential (the read-write-move-delete credential, with the most tools registered), round up to a multiple of 1024,
 * multiply by 1.3 (room for normal schema and `.describe()` growth), round up to the hundreds. The shape follows `MAX_ENTRY_BYTES` in `scripts/check-bundle-size.mjs`.
 * The rule is to re-derive only when it breaks: the threshold stays until a tool or schema really pushes some credential's wire over the line. When re-deriving, find out first **why it grew**
 * and update this derivation with it; don't just raise it. W has grown since the recipe was first applied; re-running it today gives a higher number - expected, don't "correct" it.
 * The `tools/list` test logs the current value on every run, so no baseline figures are copied elsewhere.
 *
 * **What regression hits the wall**: making any one tool's description or schema longer by `N_LIST_MAX - W + 100` characters (appended to a sentence end) goes red. The `tools/list` schema enters the
 * context only once, so the wire grows by exactly what is added, not x2.1 as with the mirror. When it hits the wall **first ask "must this text be in the schema at all?"**: every byte of `tools/list`
 * enters the model's context on every connection, while `instructions` and `docs/mcp.md` are cheaper homes.
 */
export const N_LIST_MAX = 78_600;

/**
 * Lower-bound sentinel for the first call of case (vii) (the worst shape of `list_trash`; group name of 80 `"`, the second call's 67+13 form is larger). Falling below 230 000 means the fixture isn't full
 * (the deleter or group missing, titles not cut to 200 after escaping) or `truncateText` cuts harder than "200 after escaping": check the fixture, don't change this number to suit it (same intent as MIN_WORST_GROUP_WIRE).
 * Since folders were added, `list_trash` pages by budget and every item carries `folderPath` (every note placed in the worst five-level path), so a single page can no longer exceed the budget; what is measured is
 * "the sum of every item's `wireCost` over all pages": 101 items of about 3 761 each is about 380 000, far above 230 000; below it means the fixture isn't full (as above).
 */
const MIN_WORST_TRASH_WIRE = 230_000;

/**
 * Lower-bound sentinel for the first call of case (iv) (the worst group shape since #177). Falling below 240 000 means the fixture isn't full, or `truncateText` cuts harder than "200 after escaping"
 * (e.g. the budget counted as two escapes): check, don't change this number to suit it.
 * Since folders were added, `list_notes` pages by wire budget (`MCP_LIST_WIRE_BUDGET` 240 000), so a single page can no longer exceed it; what is measured is
 * "`wireCost({ notes, nextCursor: null })` after merging all pages' `notes`" (mirror twice, excluding the JSON-RPC envelope): 100 notes with `folder: null` come to about 250 000.
 * It is still the proof that "the fixture is bad enough": below 240 000 means it fits without paging, and (iv) couldn't observe paging.
 */
const MIN_WORST_GROUP_WIRE = 240_000;

interface Measured {
  label: string;
  wire: number;
}

const measured: Measured[] = [];

async function callWire(
  app: FastifyInstance,
  token: string,
  label: string,
  name: string,
  args: unknown
): Promise<number> {
  return (await callWireResult(app, token, label, name, args)).wire;
}

async function callWireResult<T = Record<string, unknown>>(
  app: FastifyInstance,
  token: string,
  label: string,
  name: string,
  args: unknown
): Promise<{ wire: number; sc: T }> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  const result = res.json().result as { isError?: true; structuredContent: T };
  // Error results are tiny and would make the threshold falsely green: what is under test must be the success path.
  expect(result.isError).toBeUndefined();
  const wire = res.body.length;
  measured.push({ label, wire });
  console.log(`[案 11c] ${label.padEnd(46)} wire=${String(wire).padStart(7)}  餘裕 ×${(MCP_MAX_WIRE / wire).toFixed(1)}`);
  expect(wire).toBeLessThanOrEqual(MCP_MAX_WIRE);
  return { wire, sc: result.structuredContent };
}

/** Wire cost of one item in a list (mirror twice + two commas). */
const itemWire = (v: unknown): number => wireCost(v) + 2;

type ListNotesPage = { notes: Array<Record<string, unknown> & { id: string; updatedAt: string }>; nextCursor: string | null; pageCutShort?: true };

async function pageAllNotes(app: FastifyInstance, token: string, label: string, limit: number): Promise<ListNotesPage[]> {
  const pages: ListNotesPage[] = [];
  let cursor: string | undefined;
  for (let i = 1; i <= 20; i += 1) {
    const args = cursor === undefined ? { limit } : { limit, cursor };
    const res = await mcpPost(app, rpc("tools/call", { name: "list_notes", arguments: args }), { token });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { isError?: true; structuredContent: ListNotesPage };
    expect(result.isError).toBeUndefined();
    const wire = res.body.length;
    const pageLabel = `${label} 第 ${i} 頁`;
    measured.push({ label: pageLabel, wire });
    console.log(`[案 11c] ${pageLabel.padEnd(46)} wire=${String(wire).padStart(7)}  餘裕 ×${(MCP_MAX_WIRE / wire).toFixed(1)}`);
    expect(wire).toBeLessThanOrEqual(MCP_MAX_WIRE);
    // Production invariant: each page's payload (mirror twice) stays within the budget; stricter than the sentinel, it catches regressions like the budget constant being mis-wired or paging not happening.
    expect(wireCost(result.structuredContent)).toBeLessThanOrEqual(MCP_LIST_WIRE_BUDGET);
    pages.push(result.structuredContent);
    if (result.structuredContent.nextCursor === null) return pages;
    cursor = result.structuredContent.nextCursor;
  }
  throw new Error("list_notes 翻了 20 頁還沒到底");
}

type ListTrashPage = {
  items: Array<Record<string, unknown> & { id: string; folderPathTruncated?: true }>;
  truncated: boolean;
  nextCursor: string | null;
  pageCutShort?: true;
};

async function pageAllTrash(app: FastifyInstance, token: string, label: string): Promise<{ pages: ListTrashPage[]; wires: number[] }> {
  const pages: ListTrashPage[] = [];
  const wires: number[] = [];
  let cursor: string | undefined;
  for (let i = 1; i <= 20; i += 1) {
    const res = await mcpPost(app, rpc("tools/call", { name: "list_trash", arguments: cursor === undefined ? {} : { cursor } }), { token });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { isError?: true; structuredContent: ListTrashPage };
    expect(result.isError).toBeUndefined();
    const wire = res.body.length;
    const pageLabel = `${label} 第 ${i} 頁`;
    measured.push({ label: pageLabel, wire });
    console.log(`[案 11c] ${pageLabel.padEnd(46)} wire=${String(wire).padStart(7)}  餘裕 ×${(MCP_MAX_WIRE / wire).toFixed(1)}`);
    expect(wire).toBeLessThanOrEqual(MCP_MAX_WIRE);
    expect(wireCost(result.structuredContent)).toBeLessThanOrEqual(MCP_LIST_WIRE_BUDGET);
    const page = result.structuredContent;
    expect(page.truncated).toBe(page.nextCursor !== null);
    pages.push(page);
    wires.push(wire);
    if (page.nextCursor === null) return { pages, wires };
    cursor = page.nextCursor;
  }
  throw new Error("list_trash 翻了 20 頁還沒到底");
}

async function restNoteIds(app: FastifyInstance, userId: string): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(userId) });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as Array<{ id: string }>).map(n => n.id);
}

/**
 * After paging: ids without duplicates, the set equals REST, `total` notes; the sequence follows (`updatedAt` ms DESC, `id` DESC) - MCP's keyset key.
 * REST sorts by microseconds, so the order within one millisecond may differ; the sequence isn't compared against it.
 */
function expectPagedSameAsRest(pages: ListNotesPage[], restIds: string[], total: number): ListNotesPage["notes"] {
  const all = pages.flatMap(p => p.notes);
  const ids = all.map(n => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(total);
  expect([...ids].sort()).toEqual([...restIds].sort());
  for (let i = 1; i < all.length; i += 1) {
    const a = all[i - 1]!;
    const b = all[i]!;
    expect(a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id), `${i - 1}→${i}`).toBe(true);
  }
  return all;
}

async function owner(ctx: CollabTestCtx): Promise<{ id: string; email: string; token: string }> {
  const email = `o-${randomUUID()}@example.com`;
  const user = await ctx.createUser({ email, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, user.id, "notes:read");
  return { id: user.id, email, token };
}

/** (iv)'s `count` (default 100) worst-case group notes (see the long comment above (iv)); shared by (iv), (iv-b) and the millisecond-boundary test. */
async function seedWorstGroupNotes(
  ctx: CollabTestCtx,
  count: number = MCP_PAGE_MAX,
): Promise<{ o: { id: string; email: string; token: string }; g: { id: string } }> {
  const o = await owner(ctx);
  const handle = `h${"a".repeat(31)}`; // 32 characters: so lastEdited.byHandle is full length too, like (iii)
  await ctx.db.update(users).set({ handle }).where(eq(users.id, o.id));
  const name = `${'"'.repeat(67)}${"\u0001".repeat(13)}`;
  expect([...name]).toHaveLength(80); // upper bound of `groups_name_chk`
  const g = await seedGroup(ctx.db, name, [{ userId: o.id, role: "member" }]);
  const agentLabel = "g".repeat(32);
  for (let i = 0; i < count; i += 1) {
    const n = String(i).padStart(4, "0");
    await seedMaxNote(ctx.db, { groupId: g.id }, o.id, { title: '"'.repeat(200), slug: `${n}-${"s".repeat(95)}`, agentLabel });
  }
  return { o, g };
}

async function firstSectionId(app: FastifyInstance, token: string, noteId: string, offset = 0): Promise<string> {
  const res = await mcpPost(
    app,
    rpc("tools/call", { name: "read_note_outline", arguments: { note_id: noteId, section_offset: offset } }),
    { token }
  );
  const payload = res.json().result.structuredContent as { sections: { sectionId: string; chars: number }[] };
  // Take the longest segment: read_note_section's worst case is "there is something to cut".
  return payload.sections.reduce((a, b) => (a.chars >= b.chars ? a : b)).sectionId;
}

/**
 * `edit_note`'s `if_match` can only come from a **fingerprint**, and `read_note_outline` deliberately carries none (header of `outline-page.ts`), so measurement goes through REST `GET /content`,
 * for the same reason as `restOutline()` in `mcp-edit-note.test.ts`: an independent truth, no detour to guess it.
 */
async function sectionAt(
  app: FastifyInstance,
  token: string,
  noteId: string,
  index: number
): Promise<{ sectionId: string; fingerprint: string }> {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  const body = res.json() as { outline: Array<{ sectionId: string; fingerprint: string }> };
  return body.outline[index]!;
}

describe("#108 tools/list context cost", () => {
  // Measured with the worst-case credential: the read-write-move-delete credential (`delete_note`/`restore_note` only register with notes:delete, `move_note_to_group` only with notes:move,
  // `copy_note`'s description is the long version, and the input/output schemas of `edit_note`/`create_note` all enter the context). Read-write-delete, read-write-move, read-write and read-only are
  // printed alongside for comparison; the threshold is pinned only to the read-write-move-delete number (tool counts are in the assertions below).
  it("read-write-move-delete credential's tools/list full wire response <= N_LIST_MAX (RWD, RWM, RW, R as comparison)", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const { token: rwmToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move");
    const { token: rwdToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:delete");
    const { token: rwmdToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move notes:delete");

    const roRes = await mcpPost(ctx.app, rpc("tools/list"), { token: o.token });
    expect(roRes.statusCode).toBe(200);
    expect((roRes.json().result.tools as unknown[]).length).toBe(9);
    const roWire = roRes.body.length;

    const rwRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwToken });
    expect(rwRes.statusCode).toBe(200);
    expect((rwRes.json().result.tools as unknown[]).length).toBe(16);
    const rwWire = rwRes.body.length;

    const rwmRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwmToken });
    expect(rwmRes.statusCode).toBe(200);
    expect((rwmRes.json().result.tools as unknown[]).length).toBe(17);
    const rwmWire = rwmRes.body.length;

    const rwdRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwdToken });
    expect(rwdRes.statusCode).toBe(200);
    expect((rwdRes.json().result.tools as unknown[]).length).toBe(19);
    const rwdWire = rwdRes.body.length;

    const rwmdRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwmdToken });
    expect(rwmdRes.statusCode).toBe(200);
    expect((rwmdRes.json().result.tools as unknown[]).length).toBe(20);
    const rwmdWire = rwmdRes.body.length;

    console.log(
      `[案 11b] tools/list  唯讀憑證（九支，對照）wire=${roWire}  讀寫憑證（十六支，對照）wire=${rwWire}  ` +
        `讀寫搬移憑證（十七支，對照）wire=${rwmWire}  讀寫刪除憑證（十九支，對照）wire=${rwdWire}  ` +
        `讀寫搬移刪除憑證（二十支，被測）wire=${rwmdWire}  門檻=${N_LIST_MAX}  用掉 ${((rwmdWire / N_LIST_MAX) * 100).toFixed(1)}%`
    );
    expect(rwmdWire).toBeLessThanOrEqual(N_LIST_MAX);
  });
});

describe("#108 single response size", () => {
  // Case (i): a note whose heading is 260 000 characters and whose title is also 260 000 characters.
  // What it kills (each by loosening the matching `outputSchema` limit, otherwise the SDK's `validateToolOutput` blocks it before this size threshold): `title` not cut in `dto.ts`; `note.title` not cut in
  // `read-note-outline.ts` (**a different call site from the previous one**); `heading` not cut in `outline-page.ts`; `markdown` not cut in `read-note-section.ts`.
  // **This case is not the only guard for those four, don't claim it is**: not cutting `heading`/`markdown` also turns `mcp-content.test.ts` red, and `title` is guarded directly by the 200-character assertion in `mcp-notes.test.ts`.
  // **What is unique to (i) is the layer "under a pathological note, wire <= N"**: per-field assertions look at field values and can't see whether the whole response blows up, which is what the last row needs.
  // `create_note`'s worst case is **the response's `title` cut to 200 + the extra `titleTruncated:true`** (`toNoteSummary`, `dto.ts`) - the same pathological shape as this case's `hugeTitle`, so it sits here:
  // one `create_note` with a read-write credential and a title of the same 260 000 characters.
  // `create_note` doesn't write the live doc (no `content`), so it **doesn't pollute** this case's other measurements.
  // `create_transfer_token` is also measured here (every tool must be): one upload and one download call. Its response carries no title or content (only id, token, URL, curl, a fixed `next`),
  // so a pathological note isn't its worst shape; what is measured is "it is within N too".
  // `edit_note` is measured in (ii) (its worst shape is a whole page of per-section fingerprints).
  it("(i) a note with a 260 000-character heading and title -> edit_note's rename and the other tools (including create_transfer_token for both purposes) are all <= N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const hugeTitle = `T${"i".repeat(259_999)}`;
    const note = await ctx.createNote(o.id, hugeTitle);
    const session = await ctx.loginAs(o.email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, `# ${"H".repeat(260_000)}\n\n${"B".repeat(20_000)} tail`);

    await callWire(ctx.app, o.token, "(i) read_note_outline", "read_note_outline", { note_id: note.id });
    const sectionId = await firstSectionId(ctx.app, o.token, note.id);
    await callWire(ctx.app, o.token, "(i) read_note_section", "read_note_section", {
      note_id: note.id,
      section_id: sectionId,
    });
    await callWire(ctx.app, o.token, "(i) list_notes", "list_notes", { limit: MCP_PAGE_MAX });
    await callWire(ctx.app, o.token, "(i) search_notes", "search_notes", { query: "Tiii", limit: 50 });
    await callWire(ctx.app, rwToken, "(i) create_note", "create_note", { title: hugeTitle });
    await callWire(ctx.app, rwToken, "(i) create_transfer_token upload", "create_transfer_token", { note_id: note.id, purpose: "upload" });
    await callWire(ctx.app, rwToken, "(i) create_transfer_token download", "create_transfer_token", { note_id: note.id, purpose: "download" });
    // bulk transfer: the response carries no title or content (token, three curl groups, a fixed `next`); what is measured is "it is within N too".
    await callWire(ctx.app, rwToken, "(i) open_notes_as_files", "open_notes_as_files", {});
    // copy_note's worst case = the copy's title truncated + titleTruncated (like create_note); the source is this note with the 260 000-character title.
    await callWire(ctx.app, rwToken, "(i) copy_note", "copy_note", { note_id: note.id });
    // move_note_to_group's worst case = after the move the title truncated + the group owner. Create a group first and move this pathological note into it.
    // move_note_to_group registers only with notes:move: this call uses a read-write-move credential (callWire asserts isError is undefined).
    const mg = await seedGroup(ctx.db, "Move target", [{ userId: o.id, role: "admin" }]);
    const { token: rwmToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move");
    await callWire(ctx.app, rwmToken, "(i) move_note_to_group", "move_note_to_group", { note_id: note.id, group_id: mg.id });
    // rename's worst case = the response `title` cut to 200 after escaping + titleTruncated (mirror twice), with the same 260 000-character title.
    // Placed last in (i) because it really changes the title (add any new measurement before it; copy/move already are).
    // rename needs `if_match` = the fingerprint of the current title (hugeTitle; copy/move don't change the source title).
    await callWire(ctx.app, rwToken, "(i) edit_note rename", "edit_note", {
      note_id: note.id,
      op: "rename",
      title: `R${"i".repeat(259_999)}`,
      if_match: fingerprintOf(hugeTitle),
    });
    client.disconnect();
  });

  // Case (ii): 500 sections with 1000-character headings. **It only kills one thing: an unpaged outline** (removing `slice(offset, offset + MCP_PAGE_MAX)` in `buildOutlinePage` -> first page far over N, red).
  // **It can't kill "`heading` not cut"**: 100 sections x 1000-character headings stay within 262 144; that one relies on (i) (one 260 000-character heading).
  // The last-page call shows "the paging boundary is also within the threshold", not a guard for another way of writing it.
  it("(ii) 500 sections with 1000-character headings -> the first and the last page of the outline are both <= N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const note = await ctx.createNote(o.id, "five hundred sections");
    const md = Array.from({ length: 500 }, (_, i) => `# ${String(i).padStart(4, "0")}${"h".repeat(994)}`).join("\n\n");
    const session = await ctx.loginAs(o.email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, md);

    await callWire(ctx.app, o.token, "(ii) read_note_outline 第一頁", "read_note_outline", { note_id: note.id });
    await callWire(ctx.app, o.token, "(ii) read_note_outline 第五頁", "read_note_outline", {
      note_id: note.id,
      section_offset: 4 * MCP_PAGE_MAX,
    });
    const sectionId = await firstSectionId(ctx.app, o.token, note.id);
    await callWire(ctx.app, o.token, "(ii) read_note_section", "read_note_section", {
      note_id: note.id,
      section_id: sectionId,
    });

    // `edit_note`'s worst case is a **success response carrying a whole page (100 entries) of per-section fingerprints** (`withFingerprints: true` in `outline-page.ts`; `read_note_outline` has no such burden).
    // The write landing point is deliberately in the **later part** (section 250, far from the first page): the page rule of the `replace_section` family counts from the landing point (`afterSectionIndex`),
    // so hitting the first section would measure the same shape as `read_note_outline`'s first page and miss "the page rule yields a whole page for any landing point".
    // This call is **last** in the `it` because it really writes and must not pollute the earlier measurements.
    const target = await sectionAt(ctx.app, o.token, note.id, 250);
    const editWire = await callWire(ctx.app, rwToken, "(ii) edit_note replace_section@250", "edit_note", {
      note_id: note.id,
      op: "replace_section",
      section_id: target.sectionId,
      markdown: `# 0250-edited${"h".repeat(986)}`,
      if_match: target.fingerprint,
    });
    // The same full outline page next to the worst `knowledge`: all four lists cut by their budget, every id and heading made of `"` (the most expensive character once mirrored).
    // Ids come from collab state, so their length has no limit of its own.
    const worst = (n: number) => Array.from({ length: MCP_PAGE_MAX }, (_, i) => ({ id: `k_${String(i).padStart(8, "0")}${'"'.repeat(n)}`, heading: '"'.repeat(200) }));
    for (const idLength of [0, 300, 3000]) {
      const knowledge = knowledgeForModel({ kept: worst(idLength), created: worst(idLength), removed: worst(idLength), renewed: worst(idLength).map(r => ({ ...r, from: `k_00000000${'"'.repeat(idLength)}` })), ignoredComments: 1 });
      expect(knowledge.truncated).toBe(true);
      const total = editWire + wireCost(knowledge);
      console.log(`[knowledge] idLength=${idLength} knowledge wire=${wireCost(knowledge)} total=${total}`);
      expect(total).toBeLessThanOrEqual(MCP_LIST_WIRE_BUDGET);
    }
    client.disconnect();
  });

  /**
   * Case (iii): 100 notes in which "every field is compliant but full length". **The largest response of all tools is this one** - the first two cases can't measure it (they only have one or two rows).
   *
   * **Don't create them casually with `ctx.createNote`**: the rows would have a NULL `last_edited_at`, `lastEdited` would always be `null`, the 32-character `agentLabel`/`byHandle` x 100 rows wouldn't be in the response at all,
   * and the measured value would be clearly below the real worst case. Fill all four fields together: `lastEditedAt`/`lastEditedBy`/`lastEditedAgentLabel` (`lastEditedTokenId` doesn't enter the DTO).
   * **A measured value clearly below 160 000 means the fixture isn't full: check the fixture, don't change N.**
   *
   * Measures about 155 600, about 4 800 below the 160 360 estimate: the `title` here is **exactly 200 and has no `titleTruncated`**, while the true worst case is `title > 200` cut to 200 **plus an extra `"titleTruncated":true`** (mirror twice, about 48 wire per row, about 4 800 over 100 rows);
   * 200 is deliberate because this case measures "the compliant worst case". State this when quoting the number, otherwise people ask whether the fixture is still not full.
   *
   * **Honest note: this case kills no way of "missing a cut"**: every cell is exactly at its limit, so removing truncation has zero effect on it (those four are guarded as described under (i): `heading`/`markdown` by `mcp-content` together with (i),
   * `title` directly by `mcp-notes`). What it guards is another thing: **whether "one response <= N" really holds in the compliant worst case**. If `MCP_PAGE_MAX` is raised or a field is added to `NoteSummary`, this is what goes red.
   */
  it("(iii) 100 full-length notes (handle 32 / title 200 / slug 100 / agentLabel 32) + limit 100 -> <= N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const handle = `h${"a".repeat(31)}`; // 32 characters, the limit of `handles_handle_chk`
    expect(handle).toHaveLength(32);
    await ctx.db.update(users).set({ handle }).where(eq(users.id, o.id));

    const agentLabel = "g".repeat(32);
    for (let i = 0; i < MCP_PAGE_MAX; i += 1) {
      const n = String(i).padStart(4, "0");
      await seedMaxNote(ctx.db, { ownerId: o.id }, o.id, {
        title: `${n}${"t".repeat(196)}`,
        slug: `${n}-${"s".repeat(95)}`,
        agentLabel,
      });
    }

    const wire = await callWire(ctx.app, o.token, "(iii) list_notes limit=100", "list_notes", { limit: MCP_PAGE_MAX });
    // Sentinel for "the fixture isn't full" (criterion above: should land around 160 000). Its resolution only goes down to "the whole `lastEdited` group is missing" (created with `ctx.createNote` ->
    // `last_edited_at` NULL -> all four fields absent from the response): that drops the value to ~130 000 (red), while only `lastEditedAgentLabel` null gives ~149 000 (green), so it does not catch
    // "one of the four fields isn't full"; 140 000 sits between the two.
    expect(wire).toBeGreaterThan(140_000);
    // `search_notes`' `limit` caps at 50, so its worst case is about half of this call.
    await callWire(ctx.app, o.token, "(iii) search_notes limit=50", "search_notes", { query: "ttt", limit: 50 });

    // `create_note`'s other half of the worst case: `owner.handle` (called `ownerHandle` before #175) at the 32-character limit just set here ((i)'s owner has a short random-email handle and can't measure this cell).
    // The title is again long enough to truncate; both together form the real worst case of a `create_note` response.
    await callWire(ctx.app, rwToken, "(iii) create_note", "create_note", { title: "c".repeat(300) });
  });

  /**
   * Case (iv) (#175; made the true worst shape in #177): the group variant of (iii). Each group-note row's `owner` is `{"kind":"group","id":"<36>","name":"<80 code points>"}` and its `url` is `/g/<36>/...`, both longer than the personal
   * `{"kind":"user","handle":"<32>"}`/`/n/<32>/...` - (iii)'s fixture has no group notes and can't measure this shape.
   *
   * **How the worst shape after #177 was derived**: `title`/`owner.name` go through `truncateText` with a budget of "200 after JSON escaping". A character's wire cost is two escapes (structuredContent + the mirror text's re-escape):
   * ASCII 2, `"`/`\` 6 (`\"` + `\\\"`), `\n` 5, U+0001 13 (`\u0001` + `\u0001`); the budget they use is 1, 2, 2, 6. So wire/budget is largest for `"`/`\` (x3), and C0 only x2.17:
   * - `title` (unbounded in the DB): any title starting with 101 or more `"` is cut to 100 `"` (wire 600) + `titleTruncated` (about 48) = **648 per row**, 248 more than 200 ASCII (400). 200 `"` are used here.
   * - `owner.name` (DB limit 80 code points): 80 `"` use only 160 of the budget and aren't cut (wire 480); the best uncut mix is 70 `"` + 10 C0 (budget exactly 200, wire 550). A cut adds `nameTruncated` (about 46), so the worst is a **cut one**:
   *   **67 `"` + 13 U+0001** -> keeps 67+11 (budget exactly 200, wire 545) + the flag = about 591 per row. All C0 (80) leaves only 33 + the flag = about 475.
   *   This mix was enumerated by computing the two-layer `JSON.stringify` length with the real `ownerForModel`/`toNoteSummary` over combinations of any three of `"`/U+0001/`\n`/ASCII/emoji/CJK; 69+11 is one less than 67+13.
   *
   * The last two calls are **two shapes that would have broken N before #177**: group name as 80 U+0001, and title as 200 U+0001. Since folders were added, list_notes pages by budget, so they only assert <= N
   * and no longer guard those two mutations (see the comments inside the `it`).
   */
  it("(iv) #175/#177 group shape: 100 worst-case group notes (title of 200 `\"`, group name of 67 `\"` + 13 U+0001) + limit 100 -> paged by size, every page <= N, continuing matches REST's set", async () => {
    const ctx = await buildCollabTestApp();
    const { o, g } = await seedWorstGroupNotes(ctx);
    // Folders: the first page is cut short by the wire budget; continue to null, every page <= N (built into pageAllNotes), the total equals REST's set.
    const pages = await pageAllNotes(ctx.app, o.token, "(iv) list_notes limit=100（群組形最壞）", MCP_PAGE_MAX);
    expect(pages[0]!.pageCutShort).toBe(true);
    expect(pages[0]!.notes.length).toBeLessThan(MCP_PAGE_MAX);
    expect(pages[0]!.nextCursor).not.toBeNull();
    const all = expectPagedSameAsRest(pages, await restNoteIds(ctx.app, o.id), MCP_PAGE_MAX);
    // Sentinel for "fixture not full / cut too much", see the constant's comment: the 100 notes merged from all pages don't fit on one page.
    expect(wireCost({ notes: all, nextCursor: null })).toBeGreaterThan(MIN_WORST_GROUP_WIRE);
    const search = await callWire(ctx.app, o.token, "(iv) search_notes limit=50（群組形最壞）", "search_notes", { query: '""""', limit: 50 });
    expect(search).toBeGreaterThan(MIN_WORST_GROUP_WIRE / 2); // make sure all 50 match, not a false green from an empty result

    // The next two calls are the shapes that would have broken N before #177 and only assert <= N. list_notes pages by budget, so they **no longer guard** the "ownerForModel doesn't truncate the group name" and
    // "truncateText falls back to the original length" mutations (written that way the pages would just be cut shorter and still <= N); the real guards are the group-name and title cases of `test/unit/mcp-limits.test.ts`.
    await ctx.db.update(groups).set({ name: "\u0001".repeat(80) }).where(eq(groups.id, g.id));
    await callWire(ctx.app, o.token, "(iv) list_notes 群組名 80 個 U+0001", "list_notes", { limit: MCP_PAGE_MAX });
    await ctx.db.update(notes).set({ title: "\u0001".repeat(200) }).where(eq(notes.groupId, g.id));
    await callWire(ctx.app, o.token, "(iv) list_notes 標題 200 個 U+0001", "list_notes", { limit: MCP_PAGE_MAX });

    // #175: `create_note`'s group shape (`groupId`): the response's `owner` is the group name changed above. The title is 1000 `"` (it gets cut): 260 000 `"` would exceed the request bodyLimit after escaping (413),
    // and the cut shape doesn't depend on the length. Relies only on `callWire`'s built-in `<= N` and non-error; no lower-bound sentinel (the `create_note` response is small anyway).
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    await callWire(ctx.app, rwToken, "(iv) create_note（群組形）", "create_note", { title: '"'.repeat(1000), group_id: g.id });
  });

  // One more note, so the `limit + 1` row exists (hasMore = true) and the paging path is also exercised when there really is a next page.
  it("(iv-b) 101 worst-case group notes, limit 100 (the extra row fetched by the query exists) -> the first page is still cut by size and has a nextCursor; continuing to the end matches REST's set of 101", async () => {
    const ctx = await buildCollabTestApp();
    const { o } = await seedWorstGroupNotes(ctx, MCP_PAGE_MAX + 1);
    const pages = await pageAllNotes(ctx.app, o.token, "(iv-b) list_notes 101 篇 limit=100", MCP_PAGE_MAX);
    expect(pages[0]!.pageCutShort).toBe(true);
    expect(pages[0]!.notes.length).toBeLessThan(MCP_PAGE_MAX);
    expect(pages[0]!.nextCursor).not.toBeNull();
    expectPagedSameAsRest(pages, await restNoteIds(ctx.app, o.id), MCP_PAGE_MAX + 1);
  });

  /**
   * Paging cursor landing on a pair within the same millisecond: first spread (iv)'s 100 notes 2 ms apart in their original order (content unchanged) and page once to find the first page's cut point k; then set notes k and k+1
   * to the same millisecond and 1 microsecond apart with **microsecond order opposite to id order** (the larger microsecond goes to the smaller id): REST (microseconds) and MCP (milliseconds + id) order this pair oppositely,
   * and a cursor using microseconds or a non-sort key would drop one of them.
   */
  it("millisecond boundary: the last note of the first page and the first of the second are in the same millisecond with microsecond order opposite to id order -> paging neither skips nor repeats", async () => {
    const ctx = await buildCollabTestApp();
    const { o, g } = await seedWorstGroupNotes(ctx);
    const pool = ctx.db.$client;
    const base = Date.UTC(2026, 9, 1);
    await pool.query(
      `with r as (select id, row_number() over (order by updated_at desc, id desc) as rn from notes where group_id = $1)
       update notes n set updated_at = $2::timestamptz - r.rn * interval '2 milliseconds' from r where n.id = r.id`,
      [g.id, new Date(base).toISOString()],
    );
    const before = await pageAllNotes(ctx.app, o.token, "LN4 拉開後", MCP_PAGE_MAX);
    const k = before[0]!.notes.length;
    expect(k).toBeLessThan(MCP_PAGE_MAX);
    const order = before.flatMap(p => p.notes).map(n => n.id);
    const [small, large] = [order[k - 1]!, order[k]!].sort() as [string, string];
    const ms = new Date(base - (2 * k + 1)).toISOString(); // between notes k-1 and k+2
    await pool.query(`update notes set updated_at = $2::timestamptz + interval '501 microseconds' where id = $1`, [small, ms]);
    await pool.query(`update notes set updated_at = $2::timestamptz + interval '500 microseconds' where id = $1`, [large, ms]);

    // Precondition: exactly two notes in this millisecond; microsecond order is opposite to id order (REST gives the small one first, MCP the large one).
    const same = await pool.query(`select count(*)::int as n from notes where date_trunc('milliseconds', updated_at) = $1::timestamptz`, [ms]);
    expect(same.rows[0].n).toBe(2);
    const rest = await restNoteIds(ctx.app, o.id);
    expect(rest.indexOf(small)).toBe(rest.indexOf(large) - 1);

    const pages = await pageAllNotes(ctx.app, o.token, "LN4", MCP_PAGE_MAX);
    expect(pages[0]!.notes).toHaveLength(k);
    expect(pages[0]!.notes.at(-1)!.id).toBe(large);
    expect(pages[1]!.notes[0]!.id).toBe(small);
    expectPagedSameAsRest(pages, rest, MCP_PAGE_MAX);
  });

  /**
   * Case (v) (#93): 50 group notes of (iv)'s shape, each with 5 sections, 200-`"` headings and a body mostly `"` containing the query word. Without the wire budget it would be about 328 000 > N (estimate);
   * with the budget -> <= N and `matchesTruncated: true`. Control: the same batch with normal headings and body -> 3 matches per note, no matchesTruncated.
   */
  it("(v) #93 search_notes: 50 worst-case group notes x 5 worst-case heading/body sections -> <= N, matchesTruncated; normal content -> 3 per note", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const handle = `h${"a".repeat(31)}`;
    await ctx.db.update(users).set({ handle }).where(eq(users.id, o.id));
    const g = await seedGroup(ctx.db, `${'"'.repeat(67)}${"\u0001".repeat(13)}`, [{ userId: o.id, role: "member" }]);
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const n = String(i).padStart(4, "0");
      const id = await seedMaxNote(ctx.db, { groupId: g.id }, o.id, { title: '"'.repeat(200), slug: `${n}-${"s".repeat(95)}`, agentLabel: "g".repeat(32) });
      ids.push(id);
      await ctx.db.insert(noteStates).values({ noteId: id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
      const rows = Array.from({ length: 5 }, (_, k) => ({
        sectionId: `${"s".repeat(62)}${String(k).padStart(2, "0")}`,
        ord: k + 1,
        heading: '"'.repeat(200),
        body: `${'"'.repeat(150)}""""${'"'.repeat(150)}`,
      }));
      await writeSearchIndex(ctx.db, id, 1, { rows, contentHash: `m6-${i}`, indexedUnits: rows.reduce((s, r) => s + r.body.length, 0), capped: false, extractorVersion: SEARCH_EXTRACTOR_VERSION });
    }
    const worst = await mcpPost(ctx.app, rpc("tools/call", { name: "search_notes", arguments: { query: '""""', limit: 50 } }), { token: o.token });
    console.log(`[案 11c] (v) search_notes 50×5 最壞 wire=${worst.body.length}`);
    expect(worst.body.length).toBeLessThanOrEqual(MCP_MAX_WIRE);
    const wp = worst.json().result.structuredContent as { notes: Array<{ matches: unknown[] }>; matchesTruncated?: true };
    expect(wp.notes).toHaveLength(50);
    expect(wp.matchesTruncated).toBe(true);

    await ctx.db.update(noteSearchSections).set({ heading: "Heading", body: 'plain text """" here' }).where(inArray(noteSearchSections.noteId, ids));
    const normal = await mcpPost(ctx.app, rpc("tools/call", { name: "search_notes", arguments: { query: '""""', limit: 50 } }), { token: o.token });
    const np = normal.json().result.structuredContent as { notes: Array<{ matches: unknown[] }>; matchesTruncated?: true };
    expect(np.notes).toHaveLength(50); // so the `every` on the next line isn't vacuously true over an empty array
    expect(np.notes.every(n => n.matches.length === 3)).toBe(true);
    expect("matchesTruncated" in np).toBe(false);
  });

  /**
   * Case (vi) (#200): the image block is the **only exemption** from N, its limit governed alone by `MCP_IMAGE_MAX_BYTES`. An image exactly at the limit: wire - image.data.length <= N (the rest is still under the sentinel),
   * data.length <= 4*ceil(MAX/3) (the exact upper bound of base64 inflation); limit + 1 -> file_too_large (file not read).
   */
  it("(vi) #200 read_note_image: an image exactly at the limit meets both bounds; limit + 1 -> file_too_large", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const note = await ctx.createNote(o.id, "image cap");
    const atCap = await seedUpload(ctx.db, ctx.uploadsDir, note.id, o.id, Buffer.alloc(MCP_IMAGE_MAX_BYTES, 7));
    const res = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_image", arguments: { note_id: note.id, upload_id: atCap } }), { token: o.token });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { isError?: true; content: Array<{ type: string; data?: string }> };
    expect(result.isError).toBeUndefined();
    const data = result.content[1]!.data!;
    console.log(`[案 11c] (vi) read_note_image 上限 wire=${res.body.length}  非圖部分=${res.body.length - data.length}  data=${data.length}`);
    expect(res.body.length - data.length).toBeLessThanOrEqual(MCP_MAX_WIRE);
    expect(data.length).toBeLessThanOrEqual(4 * Math.ceil(MCP_IMAGE_MAX_BYTES / 3));
    const [over] = await ctx.db.insert(uploads).values({ noteId: note.id, uploaderId: o.id, mime: "image/png", size: MCP_IMAGE_MAX_BYTES + 1 }).returning({ id: uploads.id });
    const r2 = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_image", arguments: { note_id: note.id, upload_id: over!.id } }), { token: o.token });
    expect(r2.json().result.structuredContent.code).toBe("file_too_large");
  });

  /**
   * Case (vii) (#181): the worst shape of `list_trash`. One page of 100 items (101 notes -> `truncated: true`), each item's `title` (unbounded in the DB) and the deleter's `displayName` (unbounded in the DB) are 300 `"` cut to 100 `"` + `*Truncated`
   * (same reason as (iv): `"` has the largest wire/budget ratio), `handle` 32, group shape (a `group` object), `retentionDays` 3650 (`purgeAt` non-null).
   * The first call uses a group name of 80 `"` (not cut); the second switches to (iv)'s 67 `"` + 13 U+0001 (cut + `nameTruncated`, the group name's true worst shape).
   * Folders: every note sits at the deepest point of a five-level group folder chain of `[33,40,40,40,41]` `"` (the strictly worst path), and every item also carries `folderPath`;
   * `list_trash` pages by budget, so all three calls page to the end: every page <= N and payload <= budget, `truncated` is equivalent to `nextCursor !== null`, and the first page's cut point is close to the budget (wire > budget - 4 000 = the fixture is bad enough).
   * The third call restores 31 notes to live notes, leaving 70: cut by the budget but the query has no next row (hasMore false), and the first page must still be `truncated: true` with a `nextCursor` (kills "`truncated` changed back to hasMore").
   * `delete_note`/`restore_note` are measured once each (the same note, the worst title; `restore_note` returns the noteSummary shape, with the group name of the second call).
   */
  it("(vii) #181 list_trash: 101 worst-case trashed group notes (title and deleter name of 300 `\"` each, handle 32, retention 3650 days, worst five-level path) -> paged by size, every page <= N; delete_note / restore_note with the worst title -> <= N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const handle = `h${"a".repeat(31)}`;
    await ctx.db.update(users).set({ handle, displayName: '"'.repeat(300) }).where(eq(users.id, o.id));
    await ctx.db.$client.query(`update site_settings set trash_retention_days = 3650`);
    const g = await seedGroup(ctx.db, '"'.repeat(80), [{ userId: o.id, role: "admin" }]);
    const chain = await seedFolderChain(ctx.db, { group: g.id }, [33, 40, 40, 40, 41].map(n => '"'.repeat(n)));
    const ids: string[] = [];
    for (let i = 0; i < MCP_PAGE_MAX + 1; i += 1) {
      const n = String(i).padStart(4, "0");
      const id = await seedMaxNote(ctx.db, { groupId: g.id }, o.id, { title: '"'.repeat(300), slug: `${n}-${"s".repeat(95)}`, agentLabel: "g".repeat(32) });
      await setNoteFolder(ctx.db.$client, id, chain.at(-1)!);
      await markTrashed(ctx.db.$client, id, o.id);
      ids.push(id);
    }
    const shot = async (label: string, total: number) => {
      const { pages, wires } = await pageAllTrash(ctx.app, o.token, label);
      expect(pages[0]!.pageCutShort).toBe(true);
      expect(wires[0]!).toBeGreaterThan(MCP_LIST_WIRE_BUDGET - 4_000); // the cut point is close to the budget = the fixture is bad enough
      const items = pages.flatMap(p => p.items);
      expect(new Set(items.map(i => i.id)).size).toBe(total);
      expect(items[0]!.folderPathTruncated).toBe(true); // precondition: the worst path is really carried
      const noPath: Record<string, unknown> = { ...items[0]! };
      delete noPath.folderPath;
      delete noPath.folderPathTruncated;
      // Printed so the derivation in `limits.ts` can be checked against real values.
      console.log(
        `[案 11c 每項] ${label} list_trash 每項最壞 ${Math.max(...items.map(itemWire))}  ` +
          `folderPath 增量 ${wireCost(items[0]!) - wireCost(noPath)}  第一頁 ${pages[0]!.items.length} 項`
      );
      return { pages, sum: items.reduce((s, i) => s + wireCost(i), 0) };
    };
    const first = await shot("(vii) list_trash 101 篇（群組名 80 個 \"）", MCP_PAGE_MAX + 1);
    expect(first.sum).toBeGreaterThan(MIN_WORST_TRASH_WIRE); // sentinel for "fixture not full / cut too much", see the constant's comment

    await ctx.db.update(groups).set({ name: `${'"'.repeat(67)}${"\u0001".repeat(13)}` }).where(eq(groups.id, g.id));
    const second = await shot("(vii) list_trash 101 篇（群組名 67+13）", MCP_PAGE_MAX + 1);
    // The group name really switches to the cut shape (if it didn't, this would repeat the first call). Paged single-page wires all hug the budget and can't show a difference, so compare the total cost of all items.
    expect(second.sum).toBeGreaterThan(first.sum);

    // Restoring 31 leaves 70 (more than fits on one page, at most 100): cut by the budget but the query has no next row; the first page is still truncated + nextCursor, and truncated is false when paging to the end.
    await ctx.db.$client.query(`update notes set deleted_at = null, deleted_by = null where id = any($1::uuid[])`, [ids.slice(70)]);
    const pc = await shot("(vii) LT-PC list_trash 70 篇", 70);
    expect([pc.pages[0]!.truncated, pc.pages[0]!.nextCursor !== null]).toEqual([true, true]);
    expect(pc.pages.at(-1)!.truncated).toBe(false);

    const { token: rwmdToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move notes:delete");
    await callWire(ctx.app, rwmdToken, "(vii) restore_note（最壞標題）", "restore_note", { note_id: ids[0] });
    await callWire(ctx.app, rwmdToken, "(vii) delete_note（最壞標題）", "delete_note", { note_id: ids[0] });
  });

  /**
   * Case (viii): everything built in one app.
   * - Group name 67 `"` + 13 U+0001, owner handle 32; a five-level group folder chain of `[33, 40, 40, 40, 41]` `"` (the strictly worst path, exactly 400 after truncation); the deepest level also has 50 sibling folders
   *   named 78 `"` + a two-digit serial (158 after escaping -> cut to 40 `"` + `nameTruncated`, path again exactly 400). The serial is at the end: the kept prefix after truncation is all `"` (the most expensive character on the wire); at the front it would keep two cheap digits.
   * - 100 group notes of (iv)'s shape at the deepest level; another user has a same-shaped personal folder chain and 100 personal notes (personal shape, `owner` is the handle).
   * Calls: list_notes (both shapes), search_notes, list_folders, list_trash (= case (vii), the same deepest-path shape, not rebuilt), read_note_outline ((ii)'s shape placed at the deepest level), and last delete_folder (300-note subtree; it deletes things).
   * This case does not guard the three mutations below (budget paging or too-small fixtures hide them): folder name not cut -> `unit/mcp-folder-fields`, `mcp-folder-fields`; path cut by segment only without dropping segments -> `unit/mcp-folder-fields`,
   * the eight-level case of `mcp-trash-tools`, `mcp-folders`; list_folders page changed to 100 -> `mcp-folders`. Breaking the sentinel = a row missing from the limits table in `limits.ts`; the response is to add the row, never to raise `MCP_MAX_WIRE`.
   */
  it("(viii) worst folder shape: list_notes / search_notes / list_folders / read_note_outline / delete_folder all <= N (list_trash is in (vii))", async () => {
    const ctx = await buildCollabTestApp();
    const pool = ctx.db.$client;
    const q = (n: number): string => '"'.repeat(n);
    const shape = [33, 40, 40, 40, 41].map(q);
    const agentLabel = "g".repeat(32);

    const o = await owner(ctx);
    await ctx.db.update(users).set({ handle: `h${"a".repeat(31)}` }).where(eq(users.id, o.id));
    const g = await seedGroup(ctx.db, `${q(67)}${"\u0001".repeat(13)}`, [{ userId: o.id, role: "admin" }]);
    const chain = await seedFolderChain(ctx.db, { group: g.id }, shape);
    const deepest = chain[4]!;
    for (let i = 0; i < MCP_FOLDER_PAGE_MAX; i += 1) {
      await seedFolder(ctx.db, { group: g.id }, { parentId: chain[3]!, name: `${q(78)}${String(i).padStart(2, "0")}` });
    }
    const groupNoteIds: string[] = [];
    for (let i = 0; i < MCP_PAGE_MAX; i += 1) {
      const n = String(i).padStart(4, "0");
      const id = await seedMaxNote(ctx.db, { groupId: g.id }, o.id, { title: q(200), slug: `${n}-${"s".repeat(95)}`, agentLabel });
      await setNoteFolder(pool, id, deepest);
      groupNoteIds.push(id);
    }

    const p = await owner(ctx);
    await ctx.db.update(users).set({ handle: `p${"b".repeat(31)}` }).where(eq(users.id, p.id));
    const pChain = await seedFolderChain(ctx.db, { personal: p.id }, shape);
    for (let i = 0; i < MCP_PAGE_MAX; i += 1) {
      const n = String(i).padStart(4, "0");
      const id = await seedMaxNote(ctx.db, { ownerId: p.id }, p.id, { title: q(200), slug: `${n}-${"s".repeat(95)}`, agentLabel });
      await setNoteFolder(pool, id, pChain[4]!);
    }

    // list_notes: notes at the deepest level with a cut folder.name (40 `"` + nameTruncated) -> paged by budget, the first page close to the budget, and continuing totals 100.
    const firstWire = (label: string): number => measured.find(m => m.label === `${label} 第 1 頁`)!.wire;
    const gLabel = "(viii)① list_notes 群組形（最深層）";
    const gPages = await pageAllNotes(ctx.app, o.token, gLabel, MCP_PAGE_MAX);
    expect(gPages[0]!.pageCutShort).toBe(true);
    expect(firstWire(gLabel)).toBeGreaterThan(MCP_LIST_WIRE_BUDGET - 4_000); // the cut point is close to the budget = the fixture is bad enough
    const gAll = expectPagedSameAsRest(gPages, await restNoteIds(ctx.app, o.id), MCP_PAGE_MAX);
    expect(gAll.every(n => (n.folder as { id: string } | null)?.id === deepest)).toBe(true);
    expect(gAll[0]!.folder).toMatchObject({ name: q(40), nameTruncated: true });
    const pLabel = "(viii)① list_notes 個人形（最深層）";
    const pPages = await pageAllNotes(ctx.app, p.token, pLabel, MCP_PAGE_MAX);
    const pAll = expectPagedSameAsRest(pPages, await restNoteIds(ctx.app, p.id), MCP_PAGE_MAX);
    expect(pAll[0]!.folder).toMatchObject({ id: pChain[4], nameTruncated: true });
    console.log(
      `[案 11c 每項] (viii)① list_notes 每項最壞 群組形 ${Math.max(...gAll.map(itemWire))}  個人形 ${Math.max(...pAll.map(itemWire))}  ` +
        `第一頁 群組形 ${gPages[0]!.notes.length} 篇  個人形 ${pPages[0]!.notes.length} 篇${pPages[0]!.pageCutShort ? "（pageCutShort）" : ""}`
    );

    // search_notes: (v)'s shape (each note has 5 worst heading/body sections), all 100 notes indexed, notes carry the worst folder -> <= N, matchesTruncated.
    for (const [i, id] of groupNoteIds.entries()) {
      await ctx.db.insert(noteStates).values({ noteId: id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
      const rows = Array.from({ length: 5 }, (_, k) => ({
        sectionId: `${"s".repeat(62)}${String(k).padStart(2, "0")}`,
        ord: k + 1,
        heading: q(200),
        body: `${q(150)}""""${q(150)}`,
      }));
      await writeSearchIndex(ctx.db, id, 1, { rows, contentHash: `f9-${i}`, indexedUnits: rows.reduce((s, r) => s + r.body.length, 0), capped: false, extractorVersion: SEARCH_EXTRACTOR_VERSION });
    }
    const search = await callWireResult<{ notes: Array<{ folder: unknown }>; matchesTruncated?: true }>(
      ctx.app, o.token, "(viii)② search_notes 50×5 最壞＋folder", "search_notes", { query: '""""', limit: 50 }
    );
    expect(search.sc.notes).toHaveLength(50);
    expect(search.sc.matchesTruncated).toBe(true);
    expect(search.sc.notes[0]!.folder).toMatchObject({ id: deepest, nameTruncated: true });

    // list_folders one full page: of 55 group folders take the first 50; the budget doesn't cut it -> pageCutShort is absent (if it turns red later, some field limit was loosened).
    const lf = await callWireResult<{ folders: Array<Record<string, unknown>>; nextCursor: string | null; pageCutShort?: true }>(
      ctx.app, o.token, "(viii)③ list_folders 一整頁", "list_folders", {}
    );
    expect(lf.sc.pageCutShort).toBeUndefined();
    expect(lf.sc.folders).toHaveLength(MCP_FOLDER_PAGE_MAX);
    expect(lf.sc.nextCursor).not.toBeNull();
    // The first four levels of the chain aren't cut; the rest (the deepest level and the 50 siblings) are cut in both name and path: at least 46 of a page's 50 items carry pathTruncated.
    expect(lf.sc.folders.filter(f => f.pathTruncated === true && f.nameTruncated === true).length).toBeGreaterThanOrEqual(MCP_FOLDER_PAGE_MAX - 4);
    console.log(`[案 11c 每項] (viii)③ list_folders 每項最壞 ${Math.max(...lf.sc.folders.map(itemWire))}`);

    // list_trash: see (vii) (the same five-level deepest path, each item also carries folderPath).

    // read_note_outline: (ii)'s shape (500 sections, 1000-character titles) is measured at the top level (folder null) first, then at the deepest level -> more than 1 000 larger (the folder field is really there).
    const outlineNote = await ctx.createNote(p.id, "five hundred sections");
    const session = await ctx.loginAs(p.email, PASSWORD);
    const client = await seedContent(ctx, session, outlineNote.id, Array.from({ length: 500 }, (_, i) => `# ${String(i).padStart(4, "0")}${"h".repeat(994)}`).join("\n\n"));
    const top = await callWireResult<{ folder: unknown }>(ctx.app, p.token, "(viii)⑥ read_note_outline 第一頁（頂層）", "read_note_outline", { note_id: outlineNote.id });
    expect(top.sc.folder).toBeNull();
    await setNoteFolder(pool, outlineNote.id, pChain[4]!);
    const deep = await callWireResult<{ folder: { id: string; path: string[]; pathTruncated?: true } }>(
      ctx.app, p.token, "(viii)⑥ read_note_outline 第一頁（最深層）", "read_note_outline", { note_id: outlineNote.id }
    );
    expect(deep.sc.folder).toMatchObject({ id: pChain[4], pathTruncated: true });
    expect(deep.sc.folder.path).toHaveLength(5);
    expect(deep.wire - top.wire).toBeGreaterThan(1_000);
    const noFolder: Record<string, unknown> = { ...deep.sc };
    delete noFolder.folder;
    console.log(
      `[案 11c 每項] (viii)⑥ read_note_outline folder 增量 對 null ${deep.wire - top.wire}  對無此鍵 ${wireCost(deep.sc) - wireCost(noFolder)}`
    );
    client.disconnect();

    // delete_folder large subtree: add 200 more notes at the deepest level (300 total) -> delete the whole chain; response <= N, exactly 100 ids + the flag.
    await seedManyNotesInFolder(pool, { groupId: g.id }, deepest, 200);
    const { token: rwmdToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move notes:delete");
    const df = await callWireResult<{ trashedNoteCount: number; trashedNoteIds: string[]; trashedNoteIdsTruncated?: true; deletedFolderCount: number }>(
      ctx.app, rwmdToken, "(viii)⑤ delete_folder 300 篇子樹", "delete_folder", { folder_id: chain[0] }
    );
    expect(df.sc).toMatchObject({ trashedNoteCount: 300, trashedNoteIdsTruncated: true, deletedFolderCount: 5 + MCP_FOLDER_PAGE_MAX });
    expect(df.sc.trashedNoteIds).toHaveLength(MCP_DELETE_FOLDER_IDS_MAX);
    console.log(`[案 11c 每項] (viii)⑤ delete_folder payload（鏡像兩份）${wireCost(df.sc)}`);
  });

  // Print the whole table once. **A hook, deliberately not an `it`**: it only aggregates values earlier cases already asserted, and an `it` would make running just one of those cases a false red.
  afterAll(() => {
    console.log(
      `\n[案 11c 量測表] N=${MCP_MAX_WIRE}\n` +
        measured.map(m => `  ${m.label.padEnd(46)} ${String(m.wire).padStart(7)}  ×${(MCP_MAX_WIRE / m.wire).toFixed(1)}`).join("\n")
    );
  });
});

/**
 * A row of an "every cell compliant but full length" note; fills all four `lastEdited` fields (see the warning above). Personal notes pass `{ ownerId }`, group notes `{ groupId }` (XOR, #175); `editorId` is `last_edited_by`.
 */
async function seedMaxNote(
  db: Db,
  owner: { ownerId: string } | { groupId: string },
  editorId: string,
  opts: { title: string; slug: string; agentLabel: string }
): Promise<string> {
  const [row] = await db
    .insert(notes)
    .values({
      ...("groupId" in owner ? { groupId: owner.groupId } : { ownerId: owner.ownerId }),
      title: opts.title,
      slug: opts.slug,
      lastEditedAt: new Date(),
      lastEditedBy: editorId,
      lastEditedAgentLabel: opts.agentLabel,
    })
    .returning({ id: notes.id });
  return row!.id;
}
