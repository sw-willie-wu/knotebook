/**
 * The whole family uses `buildCollabTestApp` (the production shape): by the deployment gate (`mcp/register.ts`: tools that read the live doc register only when both `collab`
 * and `editing` exist) these two tools are **only registered when both are present**, so an app without collab doesn't advertise them at all (the shape assertion for that side is in the MCP write tests).
 *
 * callTool/payloadOf are copies of the same helpers in several other MCP test files, deliberately not moved into mcp-helpers.ts (a few lines each).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { noteStateBackups, notes, noteStates } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { fingerprintOf } from "../src/notes/editing/fingerprint.js";
import { PRESENCE_COLOR, presenceClientId } from "../src/notes/editing/presence.js";
import { MCP_PAGE_MAX, MCP_SECTION_CHARS, MCP_TEXT_MAX } from "../src/mcp/limits.js";
import { buildCollabTestApp, type CollabTestCtx, signTestSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, tick, waitFor } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { loadDoc, xmlOf } from "./copy-helpers.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";
const NUL = String.fromCharCode(0);
/** An unpaired high/low surrogate (`String.prototype.isWellFormed` needs the ES2024 lib; this repo targets ES2023). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string };
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
  /** The whole wire body as a string, for scans that a fingerprint must not appear anywhere. */
  raw: string;
}

interface OutlineEntry extends Record<string, unknown> {
  sectionId: string;
  level: number;
  heading: string;
  chars: number;
  headingTruncated?: true;
}

interface OutlinePayload extends Record<string, unknown> {
  note: Record<string, unknown> & {
    id: string;
    title: string;
    owner: { kind: string; handle?: string; id?: string; name?: string };
    role: string;
  };
  totalChars: number;
  sections: OutlineEntry[];
  truncated: boolean;
  nextSectionOffset: number | null;
  lastEdited: unknown;
}

interface SectionPayload extends Record<string, unknown> {
  section: Record<string, unknown> & { id: string; level: number; chars: number; markdown: string; fingerprint?: string };
  truncated: boolean;
  nextOffset: number | null;
  lastEdited: unknown;
  note?: string;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result, raw: res.body };
}

/** `structuredContent` of a successful call; also guards the mirror equality. */
function payloadOf<T>(call: ToolCall): T {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBeUndefined();
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent as unknown as T;
}

const outlineOf = async (app: FastifyInstance, token: string, noteId: string, sectionOffset?: number) =>
  payloadOf<OutlinePayload>(
    await callTool(app, token, "read_note_outline", {
      note_id: noteId,
      ...(sectionOffset === undefined ? {} : { section_offset: sectionOffset }),
    })
  );

const sectionOf = async (app: FastifyInstance, token: string, noteId: string, sectionId: string, offset?: number) =>
  payloadOf<SectionPayload>(
    await callTool(app, token, "read_note_section", {
      note_id: noteId,
      section_id: sectionId,
      ...(offset === undefined ? {} : { offset }),
    })
  );

/** The same outline from REST: the **independent** truth for `sectionId`/`fingerprint` (MCP must not compute its own). */
async function restOutline(app: FastifyInstance, noteId: string, token: string) {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  return res.json().outline as Array<{ sectionId: string; level: number; heading: string; chars: number; fingerprint: string }>;
}

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  ownerHandle: string;
  token: string;
  tokenId: string;
  noteId: string;
  email: string;
}

/** owner + one PAT (token name fixed to "Claude Code" => agent label "claude") + one note. */
async function scene(
  markdown: string | null,
  opts: Parameters<typeof buildCollabTestApp>[0] = {},
  title?: string
): Promise<Scene & { disconnect: () => void }> {
  const ctx = await buildCollabTestApp(opts);
  const email = `o-${randomUUID()}@example.com`;
  const owner = await ctx.createUser({ email, password: PASSWORD });
  const note = await ctx.createNote(owner.id, title);
  const { token, tokenId } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  let disconnect = (): void => {};
  if (markdown !== null) {
    const session = await ctx.loginAs(email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, markdown);
    disconnect = () => client.disconnect();
  }
  const ownerHandle = (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}`, headers: bearer(token) })).json()
    .ownerHandle as string;
  return { ctx, ownerId: owner.id, ownerHandle, token, tokenId, noteId: note.id, email, disconnect };
}

/** Headings must all be the same level: `## B` is merged into section A by sectionize. */
const TWO_SECTIONS = "# A\n\n第一段內容\n\n# B\n\n第二段內容";

describe("#108 read_note_outline", () => {
  it("note that starts with a heading: _top exists with chars 0, every other section's sectionId = that heading block's id", async () => {
    const s = await scene(TWO_SECTIONS);
    const out = await outlineOf(s.ctx.app, s.token, s.noteId);
    expect(out.sections).toHaveLength(3);
    expect(out.sections[0]!.sectionId).toBe("_top");
    expect(out.sections[0]!.chars).toBe(0);
    expect(out.sections.map(x => x.heading)).toEqual(["", "A", "B"]);
    expect(out.sections.map(x => x.level)).toEqual([0, 1, 1]);
    // The truth for sectionId is REST (= that heading block's id); MCP must not invent its own.
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    expect(out.sections.map(x => x.sectionId)).toEqual(rest.map(x => x.sectionId));
    expect(out.note.role).toBe("owner");
    expect(out.note.owner).toEqual({ kind: "user", handle: s.ownerHandle });
    expect(out.truncated).toBe(false);
    expect(out.nextSectionOffset).toBeNull();
    s.disconnect();
  });

  it("a note never opened: sections only _top, totalChars 0, no error", async () => {
    const s = await scene(null);
    const out = await outlineOf(s.ctx.app, s.token, s.noteId);
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0]!.sectionId).toBe("_top");
    expect(out.totalChars).toBe(0);
    expect(out.lastEdited).toBeNull();
  });

  // Compare the **key set of each field**, not a heuristic like "contains no 16 hex chars" (a heading called `deadbeefdeadbeef` would turn the heuristic red).
  // What it kills: copying `outlineOf`'s return value (which carries `fingerprint` and `blockIds`).
  //
  // The guard for the `headingTruncated` family is not the key-set assertion below: writing `headingTruncated: false` is caught by `outputSchema`'s
  // `z.literal(true)` (ten tests in this file go red, as `isError`); writing `undefined` turns **nothing** in this file red - that half is guarded by
  // `test/unit/mcp-outline-page.test.ts` on the object's key set.
  it("outline's top-level / note / every entry key set match exactly, with no fingerprint at all", async () => {
    const s = await scene(TWO_SECTIONS);
    const call = await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: s.noteId });
    const out = payloadOf<OutlinePayload>(call);
    // #381: the only fingerprint is the title's `titleFingerprint` (rename's if_match); no whole-note or per-section body fingerprint appears (the two checks below).
    expect(Object.keys(out).sort()).toEqual(
      ["folder", "lastEdited", "nextSectionOffset", "note", "sections", "titleFingerprint", "totalChars", "truncated"].sort()
    );
    expect(out.titleFingerprint).toBe(fingerprintOf(out.note.title));
    expect(Object.keys(out.note).sort()).toEqual(["id", "owner", "role", "tags", "title"].sort());
    for (const entry of out.sections) {
      expect(Object.keys(entry).sort()).toEqual(["chars", "heading", "level", "sectionId"].sort());
    }
    // When not truncated the `headingTruncated` key is **absent** (not `undefined`).
    expect(out.sections.every(e => !("headingTruncated" in e))).toBe(true);
    // Second, non-heuristic guard: scan the wire body for the **real values** computed by REST. Neither the whole-note fingerprint nor any section fingerprint may appear
    // anywhere in the `read_note_outline` response (including inside a heading).
    const content = (await getContent(s.ctx.app, s.noteId, s.token)).json() as {
      fingerprint: string;
      outline: Array<{ fingerprint: string }>;
    };
    for (const fp of [content.fingerprint, ...content.outline.map(o => o.fingerprint)]) {
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      expect(call.raw).not.toContain(fp);
    }
    s.disconnect();
  });

  it("more than 100 sections: first page 100 entries + truncated + nextSectionOffset 100, section_offset continues it", async () => {
    const many = Array.from({ length: 105 }, (_, i) => `# S${i}\n\nbody ${i}`).join("\n\n");
    const s = await scene(many);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    expect(rest).toHaveLength(106); // _top + 105 sections

    const p1 = await outlineOf(s.ctx.app, s.token, s.noteId);
    expect(p1.sections).toHaveLength(MCP_PAGE_MAX);
    expect(p1.truncated).toBe(true);
    expect(p1.nextSectionOffset).toBe(MCP_PAGE_MAX);

    const p2 = await outlineOf(s.ctx.app, s.token, s.noteId, p1.nextSectionOffset!);
    expect(p2.sections).toHaveLength(6);
    expect(p2.truncated).toBe(false);
    expect(p2.nextSectionOffset).toBeNull();
    const seen = [...p1.sections, ...p2.sections].map(x => x.sectionId);
    expect(seen).toEqual(rest.map(x => x.sectionId));
    expect(new Set(seen).size).toBe(106);
    s.disconnect();
  });

  it("section_offset beyond the section count -> sections empty, truncated false, nextSectionOffset null (not an error)", async () => {
    const s = await scene(TWO_SECTIONS);
    const out = await outlineOf(s.ctx.app, s.token, s.noteId, 500);
    expect(out.sections).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.nextSectionOffset).toBeNull();
    // Overflow is still a successful call, and `totalChars` is still the whole note's.
    expect(out.totalChars).toBeGreaterThan(0);
    s.disconnect();
  });

  it("heading and note.title are cut to 200 after escaping and carry *Truncated", async () => {
    const huge = "H".repeat(260_000);
    const s = await scene(`# ${huge}\n\ntail line`, {}, "T".repeat(260_000));
    const out = await outlineOf(s.ctx.app, s.token, s.noteId);
    expect(out.note.title.length).toBe(MCP_TEXT_MAX);
    expect(out.note.title).toBe("T".repeat(MCP_TEXT_MAX));
    expect(out.note.titleTruncated).toBe(true);
    const heading = out.sections[1]!;
    expect(heading.heading.length).toBe(MCP_TEXT_MAX);
    expect(heading.heading).toBe("H".repeat(MCP_TEXT_MAX));
    expect(heading.headingTruncated).toBe(true);
    // `chars` is the **untruncated** real length; the model decides how many reads to make from it.
    expect(heading.chars).toBeGreaterThan(260_000);
    s.disconnect();
  });

  it("totalChars is the whole note's count, not this page's (same before and after paging)", async () => {
    const many = Array.from({ length: 105 }, (_, i) => `# S${i}\n\nbody ${i}`).join("\n\n");
    const s = await scene(many);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const whole = rest.reduce((n, o) => n + o.chars, 0);
    const p1 = await outlineOf(s.ctx.app, s.token, s.noteId);
    const p2 = await outlineOf(s.ctx.app, s.token, s.noteId, MCP_PAGE_MAX);
    expect(p1.totalChars).toBe(whole);
    expect(p2.totalChars).toBe(whole);
    // Control: this page's own sum is **not** equal to totalChars, otherwise the two lines above would also pass for an implementation that sums only this page.
    expect(p2.sections.reduce((n, o) => n + o.chars, 0)).toBeLessThan(whole);
    s.disconnect();
  });
});

describe("#108 read_note_section", () => {
  const LONG = "L".repeat(9_000);

  it("section over 4000 chars: sliced, nextOffset, the next call continues it", async () => {
    const s = await scene(`# Long\n\n${LONG}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const target = rest[1]!;
    const full = (await getContent(s.ctx.app, s.noteId, s.token, target.sectionId)).json().section.markdown as string;
    expect(full.length).toBeGreaterThan(2 * MCP_SECTION_CHARS);

    const p1 = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId);
    expect(p1.section.markdown.length).toBe(MCP_SECTION_CHARS);
    expect(p1.truncated).toBe(true);
    expect(p1.nextOffset).toBe(MCP_SECTION_CHARS);
    expect(p1.section.id).toBe(target.sectionId);
    expect(p1.section.level).toBe(target.level);
    expect(p1.section.chars).toBe(target.chars);

    let acc = p1.section.markdown;
    let next = p1.nextOffset;
    let last = p1;
    while (next !== null) {
      last = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId, next);
      acc += last.section.markdown;
      next = last.nextOffset;
    }
    expect(acc).toBe(full);
    expect(last.truncated).toBe(false);
    s.disconnect();
  });

  // When the cut lands in the middle of a surrogate pair, `truncateCodeUnits` steps back one to 3999 code units. **`nextOffset` must step back with it**: hard-coding
  // `offset + 4000` would start the next page at the low surrogate, so the stitched content is one code unit short and each page carries a lone surrogate (JSON
  // serialization doesn't complain, it silently sends bad characters). This test is the only guard for `nextOffset === actual returned length`.
  it("when the cut lands in the middle of a surrogate pair nextOffset steps back one, and stitching the pages back is still byte-identical to the whole section", async () => {
    const s = await scene(`# E\n\n${"\u{1F600}".repeat(5_000)}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const target = rest[1]!;
    const full = (await getContent(s.ctx.app, s.noteId, s.token, target.sectionId)).json().section.markdown as string;
    // Non-vacuity guard: a naive `slice(0, 4000)` **really** cuts a lone surrogate on this input. If this line goes red, the fixture's prefix length changed and the cut no longer
    // lands inside a surrogate pair, which makes the two assertions below meaningless.
    expect(LONE_SURROGATE.test(full.slice(0, MCP_SECTION_CHARS))).toBe(true);

    const p1 = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId);
    expect(p1.truncated).toBe(true);
    expect(p1.section.markdown.length).toBe(MCP_SECTION_CHARS - 1);
    expect(p1.nextOffset).toBe(p1.section.markdown.length);
    expect(LONE_SURROGATE.test(p1.section.markdown)).toBe(false);

    let acc = p1.section.markdown;
    let next = p1.nextOffset;
    while (next !== null) {
      const page = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId, next);
      expect(LONE_SURROGATE.test(page.section.markdown)).toBe(false);
      acc += page.section.markdown;
      next = page.nextOffset;
    }
    expect(acc).toBe(full);
    s.disconnect();
  });

  it("the truncated call carries no fingerprint but does carry the explanatory note text", async () => {
    const s = await scene(`# Long\n\n${LONG}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const call = await callTool(s.ctx.app, s.token, "read_note_section", {
      note_id: s.noteId,
      section_id: rest[1]!.sectionId,
    });
    const p1 = payloadOf<SectionPayload>(call);
    expect(p1.truncated).toBe(true);
    expect("fingerprint" in p1.section).toBe(false);
    expect(typeof p1.note).toBe("string");
    // Non-heuristic: the **real value** of that section must not appear on the wire at all.
    expect(call.raw).not.toContain(rest[1]!.fingerprint);
    s.disconnect();
  });

  // What it kills: overcorrecting to "never return a fingerprint", which would make `replace_section` unusable on long sections. (The second half, "that value
  // sent to edit_note is accepted", is in the write tests.)
  //
  // The reason for withholding is **correctness**: don't let someone edit what they haven't fully read (`replace_section` after reading the first 4000 characters
  // would eat the unread tail and the model wouldn't know what it deleted). **It is not a security boundary**: a call with a large `offset` also counts as the page that ends the section
  // and still gets the fingerprint (see the header of `src/mcp/tools/read-note-section.ts`), so it only protects models that read sequentially.
  it("reading the whole section (last call truncated false) includes the fingerprint, identical to REST's section fingerprint", async () => {
    const s = await scene(`# Long\n\n${LONG}`);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const target = rest[1]!;
    const full = (await getContent(s.ctx.app, s.noteId, s.token, target.sectionId)).json().section.markdown as string;

    const tail = await sectionOf(s.ctx.app, s.token, s.noteId, target.sectionId, full.length - 10);
    expect(tail.truncated).toBe(false);
    expect(tail.nextOffset).toBeNull();
    expect(tail.section.fingerprint).toBe(target.fingerprint);
    expect("note" in tail).toBe(false);
    // A short section (read in one call) gets the fingerprint too.
    const top = await sectionOf(s.ctx.app, s.token, s.noteId, "_top");
    expect(top.truncated).toBe(false);
    expect(top.section.fingerprint).toBe(rest[0]!.fingerprint);
    s.disconnect();
  });

  it("response doesn't include the heading (it's already on the markdown's first line), key set matches exactly", async () => {
    const s = await scene(TWO_SECTIONS);
    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    const done = await sectionOf(s.ctx.app, s.token, s.noteId, rest[1]!.sectionId);
    expect(Object.keys(done).sort()).toEqual(["lastEdited", "nextOffset", "section", "truncated"].sort());
    expect(Object.keys(done.section).sort()).toEqual(["chars", "fingerprint", "id", "level", "markdown"].sort());
    expect("heading" in done.section).toBe(false);
    expect(done.section.markdown.startsWith("# A")).toBe(true);
    s.disconnect();
  });

  it("nonexistent section_id -> section_not_found (not not_found)", async () => {
    const s = await scene(TWO_SECTIONS);
    const call = await callTool(s.ctx.app, s.token, "read_note_section", {
      note_id: s.noteId,
      section_id: "no-such-section",
    });
    expect(call.status).toBe(200);
    expect(call.result.isError).toBe(true);
    expect(call.result.structuredContent!.code).toBe("section_not_found");
    s.disconnect();
  });

  // A `section_id` that doesn't match `SECTION_ID_RE` is blocked at the **schema layer** (format guard + NUL check), i.e. **outside the handler**.
  // Deliberately **no** "no SQL was sent" assertion: `section_id` never reaches SQL (`readNoteContent` -> `outlineOf` -> in-memory `find`), so it would always be true;
  //   likewise no "no document load": `documents.size` never grows on the read path, same category error.
  // **The positive control is mandatory**: without it, the negative assertion is vacuously true both for correct code and for code where `read_note_section`
  //   was never wrapped in `runTool()`, and the guard silently stops working.
  it("malformed section_id / note_id (including the one with NUL) are blocked outside the handler", async () => {
    const seen: string[] = [];
    const s = await scene(TWO_SECTIONS, { mcpTestHooks: { beforeTool: name => void seen.push(name) } });
    const count = (): number => seen.filter(n => n === "read_note_section").length;

    // Positive control: one valid call proves this tool **really** goes through `runTool()`.
    const ok = await sectionOf(s.ctx.app, s.token, s.noteId, "_top");
    expect(ok.section.id).toBe("_top");
    expect(count()).toBe(1);

    for (const bad of ["not a section id!", `a${NUL}b`, "x".repeat(65)]) {
      const call = await callTool(s.ctx.app, s.token, "read_note_section", { note_id: s.noteId, section_id: bad });
      expect(call.status).toBe(200);
      expect(call.result.isError).toBe(true);
      // `.refine(noNul)` is invisible in the JSON Schema, but the SDK's `validateToolInput` really runs it.
      expect(call.result.content[0]!.text).toContain("Input validation error");
      expect(count()).toBe(1); // count unchanged = zod blocked it outside the handler
    }

    // Format guard for `note_id` (`UUID_RE` in `NOTE_ID`): without it an illegal uuid falls through to `resolveRole` and is folded into `not_found` - a similar symptom
    // but a **different code**, and that format check would then rest on a private choice of another module.
    for (const bad of ["not-a-uuid", `x${NUL}y`]) {
      const call = await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: bad });
      expect(call.result.isError).toBe(true);
      expect(call.result.content[0]!.text).toContain("Input validation error");
      expect("structuredContent" in call.result).toBe(false); // so it carries no `code` from us
    }
    s.disconnect();
  });
});

describe("#108 shared wiring of the two content tools", () => {
  it("an id with role === none and an id that doesn't exist -> not_found, with byte-identical results", async () => {
    const s = await scene(TWO_SECTIONS);
    const stranger = await s.ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
    const secret = await s.ctx.createNote(stranger.id, "Secret");
    const ghost = randomUUID();

    for (const tool of ["read_note_outline", "read_note_section"] as const) {
      const args = tool === "read_note_outline" ? {} : { section_id: "_top" };
      const hidden = await callTool(s.ctx.app, s.token, tool, { note_id: secret.id, ...args });
      const missing = await callTool(s.ctx.app, s.token, tool, { note_id: ghost, ...args });
      expect(hidden.result.isError).toBe(true);
      expect(hidden.result.structuredContent!.code).toBe("not_found");
      // "Exists but you have no permission" and "doesn't exist" must be indistinguishable, down to the message string.
      expect(hidden.result.structuredContent).toEqual(missing.result.structuredContent);
      expect(hidden.result.content[0]!.text).toBe(missing.result.content[0]!.text);
    }
    s.disconnect();
  });

  // The boundary between "not-found doesn't leak" and "the rejection path doesn't touch presence": `touch` only checks whether the document is loaded and **doesn't look at the role**.
  // If presence ran before the `role === "none"` early return, anyone holding a PAT who can guess a note id could make `handle (claude)` appear on the screen of the **real collaborators** -
  // both an existence leak and a side effect of the rejection path.
  // The premise: that note is **really in `hocuspocus.documents`** (so a stranger connects and seeds some content); with a never-opened note `touch` is a no-op and the assertion is vacuous.
  it("the role === none rejection path doesn't touch presence - even while someone else is editing that note", async () => {
    const s = await scene(TWO_SECTIONS);
    const strangerEmail = `x-${randomUUID()}@example.com`;
    const stranger = await s.ctx.createUser({ email: strangerEmail, password: PASSWORD });
    const secret = await s.ctx.createNote(stranger.id, "Secret");
    const strangerSession = await s.ctx.loginAs(strangerEmail, PASSWORD);
    const strangerClient = await seedContent(s.ctx, strangerSession, secret.id, "# S\n\n協作者正在看的內容");
    const secretDoc = s.ctx.collab.hocuspocus.documents.get(secret.id)!;

    for (const tool of ["read_note_outline", "read_note_section"] as const) {
      const args = tool === "read_note_outline" ? {} : { section_id: "_top" };
      const call = await callTool(s.ctx.app, s.token, tool, { note_id: secret.id, ...args });
      expect(call.result.structuredContent!.code).toBe("not_found");
    }
    await tick();
    expect(secretDoc.awareness.getStates().get(presenceClientId(secret.id, s.tokenId))).toBeUndefined();

    // Control: the same token on a note it **can** see does show up, so the assertion above isn't vacuous because presence is simply not wired.
    await outlineOf(s.ctx.app, s.token, s.noteId);
    await tick();
    const ownDoc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    await waitFor("自己的筆記上有現身", 2_000, () =>
      ownDoc.awareness.getStates().get(presenceClientId(s.noteId, s.tokenId)) !== undefined
    );
    strangerClient.disconnect();
    s.disconnect();
  });

  it("read path has zero side effects: after 10 calls of each of the two tools, note_states / backup / documents.size / last_edited are all unchanged", async () => {
    const s = await scene(TWO_SECTIONS);
    await waitFor("server 收到編輯", 5_000, () =>
      docText(s.ctx.collab.hocuspocus.documents.get(s.noteId)!).includes("第二段內容")
    );
    s.disconnect();
    await waitFor("落盤並卸載", 10_000, () => s.ctx.collab.hocuspocus.documents.size === 0);

    const before = (await s.ctx.db.select().from(noteStates).where(eq(noteStates.noteId, s.noteId)))[0]!;
    const backups = (await s.ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, s.noteId))).length;
    const rowBefore = (await s.ctx.db.select().from(notes).where(eq(notes.id, s.noteId)))[0]!;

    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    for (let i = 0; i < 10; i += 1) {
      expect((await outlineOf(s.ctx.app, s.token, s.noteId)).sections).toHaveLength(3);
      expect((await sectionOf(s.ctx.app, s.token, s.noteId, rest[1]!.sectionId)).section.id).toBe(rest[1]!.sectionId);
    }

    const after = (await s.ctx.db.select().from(noteStates).where(eq(noteStates.noteId, s.noteId)))[0]!;
    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await s.ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, s.noteId))).length).toBe(backups);
    // This line measures **after the fact**: it catches "the document stays in memory after reading" but not "loaded and unloaded during the call" (the traces left on that path are
    // `note_states.version` and backup rows, guarded by the two lines above). The vacuously true half is marked here; don't treat it as a complete guard for "never opens a direct connection".
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0);
    const rowAfter = (await s.ctx.db.select().from(notes).where(eq(notes.id, s.noteId)))[0]!;
    expect({
      at: rowAfter.lastEditedAt?.getTime() ?? null,
      by: rowAfter.lastEditedBy,
      tokenId: rowAfter.lastEditedTokenId,
      label: rowAfter.lastEditedAgentLabel,
      updatedAt: rowAfter.updatedAt.getTime(),
    }).toEqual({
      at: rowBefore.lastEditedAt?.getTime() ?? null,
      by: rowBefore.lastEditedBy,
      tokenId: rowBefore.lastEditedTokenId,
      label: rowBefore.lastEditedAgentLabel,
      updatedAt: rowBefore.updatedAt.getTime(),
    });
  });

  it("consumes the contentRead limiter; failures with role === none don't eat it", async () => {
    const s = await scene(TWO_SECTIONS, { limiters: { contentRead: new FixedWindowLimiter({ limit: 2, windowMs: 600_000 }) } });
    const ghost = randomUUID();
    // Five calls on notes it can't reach: all not_found, **consuming none of the limiter** (`consume` comes after `resolveRole`).
    for (let i = 0; i < 5; i += 1) {
      const call = await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: ghost });
      expect(call.result.structuredContent!.code).toBe("not_found");
    }
    expect((await outlineOf(s.ctx.app, s.token, s.noteId)).sections).toHaveLength(3);
    expect((await sectionOf(s.ctx.app, s.token, s.noteId, "_top")).section.id).toBe("_top");
    // The call blocked by 429 must **leave no trace**: presence is ordered after the limiter, so awareness's clock doesn't advance. This is the only guard for
    // "presence is not before the limiter" - without it, moving touch before the limiter consumption turns no test red.
    const doc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const clientId = presenceClientId(s.noteId, s.tokenId);
    await tick();
    const clockBefore = doc.awareness.meta.get(clientId)?.clock;
    expect(clockBefore).toBeGreaterThan(0); // control: the first two successful calls **did** show up
    const third = await callTool(s.ctx.app, s.token, "read_note_outline", { note_id: s.noteId });
    expect(third.result.isError).toBe(true);
    expect(third.result.structuredContent!.code).toBe("too_many_requests");
    await tick();
    expect(doc.awareness.meta.get(clientId)?.clock).toBe(clockBefore);
    s.disconnect();
  });

  // presence: shape follows `note-presence.test.ts`.
  // Asserting the full display name, not just the target, catches a change to the name presenceIdentity composes (handle, space, left paren, agent label, right paren), which the UI relies on.
  it("token readers show up (display name / color verbatim), outline lands at the document start, section lands on the section's first block; cookie readers don't touch", async () => {
    const s = await scene(TWO_SECTIONS);
    const id = presenceClientId(s.noteId, s.tokenId);
    const doc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const remote = () => doc.awareness.getStates().get(id) as { user?: { name: string; color: string }; cursor?: { anchor: unknown } } | undefined;
    const cursorText = (): string | null => {
      const r = remote();
      if (!r?.cursor) return null;
      const abs = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(r.cursor.anchor as never),
        doc
      );
      return abs ? (abs.type as Y.XmlText).toString() : null;
    };
    const expectedName = `${s.ownerHandle} (claude)`;

    // The cookie reader runs first: MCP's session path has `tokenId` null and must not touch.
    // `mcpPost`'s `cookie` takes the **value** (the helper builds `SESSION_COOKIE=` itself), not the whole header.
    const cookie = await signTestSession({ userId: s.ownerId, tv: 0 });
    const viaCookie = await mcpPost(
      s.ctx.app,
      rpc("tools/call", { name: "read_note_outline", arguments: { note_id: s.noteId } }),
      { cookie }
    );
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().result.isError).toBeUndefined();

    await outlineOf(s.ctx.app, s.token, s.noteId);
    await tick();
    await waitFor("名字到達", 2_000, () => remote()?.user?.name === expectedName);
    expect(remote()!.user!.color).toBe(PRESENCE_COLOR);
    // First touch of this (noteId, tokenId) in this file: clock is 1 => the cookie call above didn't touch.
    expect(doc.awareness.meta.get(id)?.clock).toBe(1);
    expect(cursorText()).toContain("A");

    const rest = await restOutline(s.ctx.app, s.noteId, s.token);
    await sectionOf(s.ctx.app, s.token, s.noteId, rest[2]!.sectionId);
    await tick();
    await waitFor("游標到 B", 2_000, () => (cursorText() ?? "").includes("B"));
    expect(cursorText()).not.toContain("A");
    s.disconnect();
  });

  // Mitigation for "pagination is not a snapshot": the sentence is written verbatim into the tool description the model sees. Without this test, deleting that sentence turns nothing red.
  // It asserts the `tools/list` **sent on the wire**, not the source constant, so a corrected constant that isn't wired into `registerTool` is also caught.
  it("tools/list verbatim text appears on the wire (pagination warning, fingerprint only after a full read)", async () => {
    const s = await scene(null);
    const res = await mcpPost(s.ctx.app, rpc("tools/list"), { token: s.token });
    expect(res.statusCode).toBe(200);
    const tools = res.json().result.tools as { name: string; description: string }[];
    const byName = (name: string): string => tools.find(t => t.name === name)!.description;
    expect(byName("read_note_outline")).toContain(
      "finish listing all pages before you start editing; editing while you page will skip sections."
    );
    expect(byName("read_note_section")).toContain(
      "arrives with the page that finishes it, so read to the end before you rewrite it."
    );
  });

  it("runTool() coverage: the names beforeTool sees are exactly the four read-only tools", async () => {
    const seen: string[] = [];
    const s = await scene(TWO_SECTIONS, { mcpTestHooks: { beforeTool: name => void seen.push(name) } });
    payloadOf<Record<string, unknown>>(await callTool(s.ctx.app, s.token, "list_notes"));
    payloadOf<Record<string, unknown>>(await callTool(s.ctx.app, s.token, "search_notes", { query: "a" }));
    await outlineOf(s.ctx.app, s.token, s.noteId);
    await sectionOf(s.ctx.app, s.token, s.noteId, "_top");
    // Forgetting to wrap one tool in `runTool()` causes no compile error: an uncaught exception would be sent into the model's context as is.
    expect([...new Set(seen)].sort()).toEqual(
      ["list_notes", "read_note_outline", "read_note_section", "search_notes"].sort()
    );
    s.disconnect();
  });
});

describe("#240 uppercase note_id (MCP read)", () => {
  /** Seed only after all preconditions are done: when it returns, the debounce window has just started. */
  async function liveScene(markdown: string) {
    const ctx = await buildCollabTestApp();
    const email = `l1-${randomUUID()}@example.com`;
    const owner = await ctx.createUser({ email, password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const { token, tokenId } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
    const session = await ctx.loginAs(email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, markdown);
    const seededAt = Date.now();
    return { ctx, token, tokenId, noteId: note.id, client, seededAt };
  }
  const stateHas = async (ctx: CollabTestCtx, noteId: string, text: string) => {
    const d = await loadDoc(ctx.db, noteId);
    return d !== null && xmlOf(d).includes(text);
  };

  it("live doc newer than note_states: outline with an uppercase note_id reads the live paragraph, note.id comes back lowercase", async () => {
    const s = await liveScene("# Head\n\n第一段內容");
    const outline = await outlineOf(s.ctx.app, s.token, s.noteId.toUpperCase());
    // Ordered first: with the lowercasing removed the outline would read from note_states, which doesn't have Head yet.
    expect(outline.sections.map(e => e.heading)).toContain("Head");
    expect(await stateHas(s.ctx, s.noteId, "Head")).toBe(false); // the read happens inside the debounce window; if this turns true the test loses its discriminating power
    console.log(`[outline] seed→斷言 ${Date.now() - s.seededAt} ms（store debounce 2000 ms）`);
    expect(outline.note.id).toBe(s.noteId);
    s.client.disconnect();
  });

  it("live doc newer than note_states: read_note_section(_top) with an uppercase note_id reads the live content", async () => {
    const MARK = `MARK-${randomUUID()}`;
    const s = await liveScene(`${MARK}\n\n# 尾段`); // MARK precedes the first heading = the _top section, so no outline read is needed to get a section id
    const section = await sectionOf(s.ctx.app, s.token, s.noteId.toUpperCase(), "_top");
    expect(section.section.markdown).toContain(MARK);
    expect(await stateHas(s.ctx, s.noteId, MARK)).toBe(false);
    console.log(`[section] seed→斷言 ${Date.now() - s.seededAt} ms（store debounce 2000 ms）`);
    s.client.disconnect();
  });

  it("reading with an uppercase note_id -> presence appears with the lowercase id", async () => {
    const s = await scene("# A\n\n第一段內容");
    const doc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    await outlineOf(s.ctx.app, s.token, s.noteId.toUpperCase());
    await tick();
    await waitFor("大寫 id 的讀取讓 presence 出現在小寫 doc 上", 2_000, () =>
      doc.awareness.getStates().get(presenceClientId(s.noteId, s.tokenId)) !== undefined
    );
    s.disconnect();
  });
});
