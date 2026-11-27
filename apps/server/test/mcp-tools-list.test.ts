/**
 * Two harnesses, each with its own subject, **not interchangeable** (division of labour of the deployment gate):
 * - `buildCollabTestApp` = the production shape (collab + editing both present): which tools each credential sees is asserted by the tests below.
 *   `move_note_to_group` registers only with `notes:move`; `delete_note`/`restore_note` and `delete_folder` only with `notes:delete` (and write); the folder write tools and `move_note_to_folder` with notes:write;
 *   `list_folders` for any credential in any deployment shape.
 * - `buildTestApp` = no collab -> only tools that query the DB (read-write credentials also get `create_note`, which is outside the deployment gate; the token path also has `create_transfer_token`).
 *
 * **The scope-filtering test needs write tools to be a guard**: with read tools only, the two `not.toContain` lines for `edit_note`/`create_note` are tautologies and can't claim to guard scope filtering.
 * The read-write credential's full tool list, the hard-coded ordered name list, calling `edit_note` directly while skipping the list, and the `runTool()` coverage also live in this file.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { noteAiEdits, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { SESSION_COOKIE, type TokenScope } from "@knotebook/shared";
import { CREATE_KNOWLEDGE_SENTENCE, EDIT_TAG_SENTENCE, READ_SECTION_KNOWLEDGE_SENTENCE, WRITE_KNOWLEDGE_SENTENCE } from "../src/mcp/knowledge-strings.js";
import { COPY_GROUP_ID_DESCRIBE, COPY_GROUP_ID_DESCRIBE_NO_MOVE, COPY_NOTE_DESCRIPTION, COPY_NOTE_DESCRIPTION_NO_MOVE } from "../src/mcp/tools/copy-note.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf } from "./group-helpers.js";
import { INITIALIZE, mcpPost, rpc } from "./mcp-helpers.js";
import type { Db } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";
/** #239: read-write-move credentials: only their list has move_note_to_group. */
const RWM = "notes:read notes:write notes:move" as const;
/** #181: the two forms that include notes:delete: only their lists have delete_note/restore_note. */
const RWD = "notes:read notes:write notes:delete" as const;
const RWMD = "notes:read notes:write notes:move notes:delete" as const;
/** Tools registered only with notes:delete. */
const DELETE_TOOLS = ["delete_note", "restore_note", "delete_folder"];
const sessionCookie = async (userId: string) => (await cookieOf(userId))[SESSION_COOKIE]!;

/** The six tools that only query the DB (read_note_image also reads disk): present in any deployment shape, for any credential. */
const DB_ONLY_TOOLS = ["list_folders", "list_notes", "list_notifications", "list_trash", "read_note_image", "search_notes"];
/** The three read tools that read the live doc (read_comments for an anchor's section): advertised only when `collab && editing` both exist. */
const LIVE_DOC_TOOLS = ["read_comments", "read_note_outline", "read_note_section"];
/** #200: registered only on the token path (sessions don't have it), outside the deployment gate. */
const TOKEN_ONLY_TOOLS = ["create_transfer_token"];
/** Bulk transfer: also token-only but **inside** the deployment gate (the signed token is used to export, which needs a mount; same criterion as LIVE_DOC_TOOLS). */
const BULK_TOOLS = ["open_notes_as_files"];
/** The three folder write tools and move_note_to_folder: registered with notes:write, outside the collab gate. */
const FOLDER_WRITE_TOOLS = ["create_folder", "rename_folder", "move_folder", "move_note_to_folder"];
/**
 * The **registration order** in `register.ts`: list_notes, search_notes, the two read tools, edit_note, (outside the gate) create_note, move_note_to_group, copy_note, (outside the gate, token only) create_transfer_token,
 * (inside the gate, token only) open_notes_as_files, (outside the gate, all credentials) list_trash, (outside the gate, notes:delete) delete_note, restore_note, (outside the gate, all credentials) list_folders,
 * (outside the gate, notes:write) create_folder, rename_folder, move_folder, move_note_to_folder, (outside the gate, notes:delete) delete_folder, read_note_image, (inside the gate) read_comments, (inside the gate, notes:write) post_comment,
 * (outside the gate, all credentials) list_notifications. The hard-coded-order test pins this order verbatim, unsorted.
 * `move_note_to_group` registers only with `notes:move` (read-write-move credentials and sessions); the two trash write tools only with `notes:delete`; the relative order of the rest is unchanged.
 */
const RWMD_TOOLS_IN_ORDER = [
  "list_notes",
  "search_notes",
  "read_note_outline",
  "read_note_section",
  "edit_note",
  "create_note",
  "move_note_to_group",
  "copy_note",
  "create_transfer_token",
  "open_notes_as_files",
  "list_trash",
  "delete_note",
  "restore_note",
  "list_folders",
  "create_folder",
  "rename_folder",
  "move_folder",
  "move_note_to_folder",
  "delete_folder",
  "read_note_image",
  "read_comments",
  "post_comment",
  "list_notifications",
];
const RWM_TOOLS_IN_ORDER = RWMD_TOOLS_IN_ORDER.filter(n => !DELETE_TOOLS.includes(n));

/** `{ sort: false }` takes an unsorted name path - **existing callers all omit it, behaviour unchanged** (default true). A `.sort()` version can never observe order: the hard-coded-order test must use `{ sort: false }`. */
async function toolNames(app: FastifyInstance, token: string, opts: { sort?: boolean } = {}): Promise<string[]> {
  const res = await mcpPost(app, rpc("tools/list"), { token });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.error).toBeUndefined();
  const names = (body.result.tools as { name: string }[]).map(t => t.name);
  return opts.sort === false ? names : names.sort();
}

/** An app without collab needs no password login: insert a user row directly (skips argon2; same as `mcp-endpoint.test.ts`). */
async function seedUser(db: Db): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `mcp-${randomUUID()}@example.com`, displayName: "M" })
    .returning();
  return user!.id;
}

describe("#108 tools/list", () => {
  // The two `not.toContain` lines only mean something because the write tools exist: with read tools alone they would pass for any implementation.
  // With both write tools registered, this test catches "a read-only credential lists the write tools because scope filtering is missing".
  // Swapping `canWrite = canWriteNotes(ctx)` for `canWrite = true` in `register.ts` reddens this test (the read-only credential's set) and the direct-call test below (a read-only credential skipping the list):
  // the read-only credential then gets `edit_note`/`create_note`, the `insufficient_scope` dead code disappears, and the direct-call test degrades from "Tool edit_note not found" to `insufficient_scope`.
  // This test uses a read-only credential on purpose: a read-write credential already sees every tool, so it would not notice scope filtering being removed.
  // What discriminates today besides scope filtering itself is the `toEqual` line (**exactly these names in the production shape**, none more, none less, a rename also goes red) - a shape assertion.
  // **Don't merge this with the deployment-gate test below to look less repetitive**: they test **two deployment shapes** and merging loses one side - removing the gate reddens only the gate test and leaves this one green, which shows they don't cover each other.
  it("read-only credential's tools/list = exactly eleven (nine read tools + create_transfer_token + open_notes_as_files), without edit_note / create_note / post_comment", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");

    const names = await toolNames(ctx.app, token);
    expect(names).toEqual([...DB_ONLY_TOOLS, ...LIVE_DOC_TOOLS, ...TOKEN_ONLY_TOOLS, ...BULK_TOOLS].sort());
    expect(names).not.toContain("edit_note");
    expect(names).not.toContain("create_note");
    expect(names).not.toContain("post_comment");
  });

  // Deployment-gate shape assertion: **this is the only guard for that gate**. Removing the gate (`if (ctx.collab && ctx.editing)` -> `if (true)` in `register.ts`) reddens only this test (the app without collab would also list
  // `edit_note`/`read_note_outline`/`read_note_section`); every other tool-list test uses `buildCollabTestApp`, which has collab anyway, so that mutation leaves them green. Conversely, moving `list_notes`/`search_notes` behind the gate
  // also reddens this test (no tool registered, `tools/list` degrades to `-32601`) and `mcp-notes.test.ts`'s sentinel test (also an app without collab).
  // **Uses a read-write credential**: a read-only credential can't reach `edit_note` (filtered by scope at registration), so it can't tell "not advertised because there's no collab" from "not advertised because there's no scope"; only a read-write credential can.
  // `create_note` is outside this gate, so it (with `copy_note` and `create_transfer_token`) must be in the set and `edit_note` must not.
  // A read-write credential without notes:move doesn't see `move_note_to_group` (it registers only with `notes:move`), so it has one fewer than read-write-move; the credential deliberately stays read-write:
  // switching to read-write-move would make this test change both "move permission" and "deployment shape".
  it("app without collab + read-write credential: only the six DB-querying tools (including read_note_image, list_trash, list_folders, list_notifications), create_note, copy_note, the four folder write tools (including move_note_to_folder) and create_transfer_token are advertised (create_note is outside the deployment gate)", async () => {
    const { app, db } = await buildTestApp();
    const userId = await seedUser(db);
    const { token } = await seedTokenForUser(db, userId, "notes:read notes:write");

    expect(await toolNames(app, token)).toEqual(["copy_note", "create_note", ...FOLDER_WRITE_TOOLS, ...DB_ONLY_TOOLS, ...TOKEN_ONLY_TOOLS].sort());
  });

  // Read-write-move-delete credential's `tools/list` (production shape). Differs from the ordered-list test: this one uses `.sort()` and guards the **set**, not overlapping the order assertion.
  // Read-write and read-write-delete are covered by separate tests below.
  it("read-write-move-delete credential's tools/list has twenty-three tools; read-write-move twenty (each has open_notes_as_files)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, RWMD);
    const { token: rwm } = await seedTokenForUser(ctx.db, owner.id, RWM);

    const rwmSet = [...DB_ONLY_TOOLS, ...LIVE_DOC_TOOLS, "edit_note", "post_comment", "create_note", "move_note_to_group", "copy_note", ...TOKEN_ONLY_TOOLS, ...BULK_TOOLS, ...FOLDER_WRITE_TOOLS];
    expect(await toolNames(ctx.app, token)).toEqual([...rwmSet, ...DELETE_TOOLS].sort());
    expect(await toolNames(ctx.app, rwm)).toEqual(rwmSet.sort());
  });

  // The name array is **verbatim** the hard-coded list, **including order** - only `toolNames()` with `{ sort: false }` can see it; the `.sort()` version (the previous test) has zero discrimination on order.
  // **This test has zero discrimination on "scope filtering removed"** (it uses the read-write credential, whose full list is unchanged by that mutation); what it kills is **order**: swapping the registration order of
  // `list_notes`/`search_notes` in `register.ts` reddens only this test, while the previous (sorted) test stays green - one guards the set, the other the order.
  it("read-write-move-delete credential's tools/list name array is verbatim the hard-coded twenty-three-name list, including order", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, RWMD);

    const names = await toolNames(ctx.app, token, { sort: false });
    expect(names).toEqual(RWMD_TOOLS_IN_ORDER);
  });

  // #175: `create_note`'s model-facing strings are verbatim on the wire and the withdrawn old claims are absent (each rewritten sentence is checked both ways: the right one present, the withdrawn one gone).
  // The literals are hard-coded here, for comparison with the final sentences in `docs/mcp.md` (the docs are outside this file; this file doesn't compare against docs).
  // Compares the JSON.parse'd strings (what the model sees) and also checks the raw body against `JSON.stringify(s).slice(1, -1)` to confirm the escaped form on the wire matches (whether the em dash, backtick and `'` are escaped in JSON).
  it("#175: create_note's description / group_id / title strings are verbatim on the wire, the old claims are absent", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    const tools = res.json().result.tools as { name: string; description: string; inputSchema: { properties: Record<string, { type?: string; format?: string; description?: string }> } }[];
    const entry = tools.find(t => t.name === "create_note")!;

    const G1 = "Create a new note — yours, or in one of your groups when you pass `group_id`.";
    const D2 = "or leave it out for an empty note, which edit_note can fill in later if the reply's `role` is `owner` or `editor`.";
    const D3 = "pass it to read_note_outline, or to edit_note when its `role` allows writing";
    const G2 =
      "The id of one of your groups where your role lets you create notes. The note then belongs to the group, not to you. " +
      "Leave it out for a personal note. If your role there can create notes but not edit them, the note is read-only for you: " +
      "the reply's `role` is `viewer`.";
    const T1 = "de-duplicated against the other notes in the same place — your personal notes, or that group's notes — with a numeric suffix";

    expect(entry.description).toContain(G1);
    expect(entry.description).toContain(D2);
    expect(entry.description).toContain(D3);
    const groupId = entry.inputSchema.properties.group_id!;
    expect(groupId.type).toBe("string");
    expect(groupId.format).toBe("uuid");
    expect(groupId.description).toBe(G2);
    expect(entry.inputSchema.properties.title!.description).toContain(T1);
    expect(Object.keys(entry.inputSchema.properties)).not.toContain("groupId");

    // Withdrawn old claims: none may remain anywhere (description, the describe of the two fields).
    const everywhere = [entry.description, ...Object.values(entry.inputSchema.properties).map(p => p.description ?? "")].join("\n");
    for (const gone of [
      "Create a new note owned by you.",
      "an empty note you can write to later with edit_note",
      "pass it to edit_note or read_note_outline",
      "de-duplicated against your other notes",
      "when you pass `groupId`",
    ]) {
      expect(everywhere, gone).not.toContain(gone);
    }

    // Wire form: the raw body contains `JSON.stringify(s).slice(1, -1)`. JSON.stringify doesn't escape non-ASCII, so passing means the em dash (U+2014), backticks and `'` on the wire are unescaped original characters (no need to compare the escaped form).
    for (const s of [G1, D2, D3, G2, T1]) expect(res.body).toContain(JSON.stringify(s).slice(1, -1));
  });

  // #180: the new strings of edit_note / create_note / instructions are verbatim on the wire; none of the old sentences remain.
  it("#180: rename-related strings are verbatim on the wire, the old sentences are absent", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    const tools = res.json().result.tools as { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> }; outputSchema: { properties: Record<string, { description?: string }> } }[];
    const edit = tools.find(t => t.name === "edit_note")!;
    const create = tools.find(t => t.name === "create_note")!;
    const DESC =
      "Change one note. Six operations: `replace_all` rewrites the whole note, `replace_section` and `delete_section` act on one section, " +
      "`insert_after` puts new markdown after a section, `append` adds to the end, and `rename` changes its title. Every operation except " +
      "`append` needs `if_match`, the fingerprint of what you are replacing — a section's from read_note_section (once you have " +
      "read to its end) or from a previous edit_note reply; the whole note's from a previous edit_note reply; the title's (`titleFingerprint`) " +
      "from read_note_outline or a previous rename's reply. A change to the content is " +
      "recorded in the note's history, where anyone who can edit the note can usually undo it. A rename is not recorded: " +
      "to undo it, rename the note back. Unless the note has a custom URL, its URL follows the new title and the old URL " +
      "usually stops working. A rename's reply has `title`, `titleFingerprint` and `url` instead of `editId`, `fingerprint`, `outline` and `unboundWikilinks`.";
    const OP = "What to do. `replace_section`, `insert_after` and `delete_section` need `section_id`; `append` may omit `if_match`; `rename` takes `title` and `if_match` and nothing else.";
    const MD_HEAD = "The new markdown. Required for every operation except delete_section and rename. Colors are HTML, as read_note_section returns them:";
    const IF_MATCH =
      "The fingerprint of what you are replacing. Required for every operation except append; the write fails if what you are replacing " +
      "changed since you got that fingerprint. For rename it is the title's `titleFingerprint`, from read_note_outline or a previous " +
      "rename's reply. A title change does not change the content's fingerprints, and a content change does not change `titleFingerprint`.";
    const TITLE_IN = "The note's new title. Only rename takes it.";
    const TITLE_OUT = "After a rename, the note's new title.";
    const TITLE_FP_OUT = "After a rename, the fingerprint of the new title. Pass it as `if_match` to a following rename.";
    const URL_OUT = "After a rename, the note's page as a site-relative path, as in list_notes.";
    const CREATE_TITLE_TAIL = "Pass a title if you know it; edit_note's `rename` can change it later when the reply's `role` is `owner` or `editor`.";
    // #381: read_note_outline's title fingerprint (doesn't name edit_note - a read-only credential sees this tool too).
    const OUTLINE_TITLE_FP = "The fingerprint of the note's whole title, even when `note.title` is cut. Renaming the note needs it as `if_match`.";
    const outline = tools.find(t => t.name === "read_note_outline")!;

    expect(edit.description).toBe(DESC);
    expect(edit.inputSchema.properties.op!.description).toBe(OP);
    expect(edit.inputSchema.properties.markdown!.description!.startsWith(MD_HEAD)).toBe(true);
    expect(edit.inputSchema.properties.if_match!.description).toBe(IF_MATCH);
    expect(edit.inputSchema.properties.title!.description).toBe(TITLE_IN);
    expect(edit.outputSchema.properties.title!.description).toBe(TITLE_OUT);
    expect(edit.outputSchema.properties.titleFingerprint!.description).toBe(TITLE_FP_OUT);
    expect(edit.outputSchema.properties.url!.description).toBe(URL_OUT);
    expect(outline.outputSchema.properties.titleFingerprint!.description).toBe(OUTLINE_TITLE_FP);
    expect(create.inputSchema.properties.title!.description!.endsWith(CREATE_TITLE_TAIL)).toBe(true);
    for (const s of [DESC, OP, MD_HEAD, IF_MATCH, TITLE_IN, TITLE_OUT, TITLE_FP_OUT, URL_OUT, CREATE_TITLE_TAIL, OUTLINE_TITLE_FP]) {
      expect(res.body).toContain(JSON.stringify(s).slice(1, -1));
    }
    for (const gone of [
      "Five operations",
      "only `append` may omit `if_match`",
      "Required for every operation except delete_section.",
      // Pins the second half of the old sentence ("the write fails if the note changed since you read it"), because the new sentence starts with the same prefix as the old one (rename is no longer exempt).
      "No tool here renames a note afterwards",
      // rename no longer exempts if_match and no longer says "last title written wins".
      "except `append` and `rename` needs `if_match`",
      "Required for every operation except append and rename",
      "`rename` takes `title` and nothing else",
      "the last title written wins",
      "the write fails if the note changed since you read it",
      // The response field is camelCase `titleFingerprint`; the snake_case form must not appear anywhere.
      "title_fingerprint",
    ]) {
      expect(res.body, gone).not.toContain(JSON.stringify(gone).slice(1, -1));
    }
  });

  // #269: the model-facing strings for internal links are verbatim on the wire (verbatim `toBe`, not a prefix match), each with one extra sentence pinned.
  it("#269: sectionId / read_note_section markdown / edit_note markdown / create_note content strings are verbatim on the wire", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    type Tool = { name: string; inputSchema: { properties: Record<string, { description?: string }> }; outputSchema?: { properties: Record<string, unknown> } };
    const tools = res.json().result.tools as Tool[];
    const byName = (n: string) => tools.find(t => t.name === n)!;
    const SECTION_ID =
      "Pass this to read_note_section. `_top` is the text before the first heading. Any other sectionId is also the id of that heading's block, so `/notes/<note id>#b-<sectionId>` links to that heading.";
    const READ_LINK =
      'A link saved as a link to a note comes back as `[text](/notes/<id>)` (inside a block that comes back as HTML, as `<a href="/notes/<id>">`), ending in `#b-<block id>` when it points at a place in that note.';
    const WRITE_LINK =
      "A Markdown link whose URL is a note on this site — `/notes/<id>` or the `url` list_notes gives, relative or this site's full URL, optionally ending in `#b-<block id>` — is saved as a link to that note if you can see it; any other link to this site is kept as an ordinary link.";
    const outline = byName("read_note_outline").outputSchema as { properties: { sections: { items: { properties: { sectionId: { description: string } } } } } };
    expect(outline.properties.sections.items.properties.sectionId.description).toBe(SECTION_ID);
    const section = byName("read_note_section").outputSchema as { properties: { section: { properties: { markdown: { description: string } } } } };
    expect(section.properties.section.properties.markdown.description.endsWith(` ${READ_LINK}`)).toBe(true);
    expect(byName("edit_note").inputSchema.properties.markdown!.description!).toContain(` ${WRITE_LINK} `);
    expect(byName("create_note").inputSchema.properties.content!.description!).toContain(` ${WRITE_LINK} `);
    for (const s of [SECTION_ID, READ_LINK, WRITE_LINK]) expect(res.body).toContain(JSON.stringify(s).slice(1, -1));
    // Two extra sentences pinned: the anchor form and "kept as an ordinary link": goes red if someone shortens a sentence or reverts it to the draft form.
    expect(res.body).toContain("#b-<block id>");
    expect(res.body).toContain("kept as an ordinary link");
    expect(res.body).not.toContain("A link to another note comes back as");
  });

  // Columns: the model-facing strings for columns and sizes are verbatim (whole-sentence `toBe`) on the wire; the old sentences are absent. The size sentence doesn't mention images inside table cells (not accepted yet).
  it("columns: the columns and size sentences of edit_note markdown / create_note content / read_note_section are verbatim on the wire, the old sentences are absent", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> }; outputSchema?: unknown };
    const tools = res.json().result.tools as Tool[];
    const byName = (n: string) => tools.find(t => t.name === n)!;
    const WRITE_LINK =
      "A Markdown link whose URL is a note on this site — `/notes/<id>` or the `url` list_notes gives, relative or this site's full URL, optionally ending in `#b-<block id>` — is saved as a link to that note if you can see it; any other link to this site is kept as an ordinary link.";
    const READ_LINK =
      'A link saved as a link to a note comes back as `[text](/notes/<id>)` (inside a block that comes back as HTML, as `<a href="/notes/<id>">`), ending in `#b-<block id>` when it points at a place in that note.';
    const COLUMNS =
      'Side-by-side columns are HTML, exactly as read_note_section returns them: <div data-kb-columns style="display:flex;gap:16px"> holding ' +
      '<div data-kb-column style="flex:N"> columns (N is the relative width, 0.1 to 10, at most two decimals), each of these tags and its </div> ' +
      "on a line of its own, each column with markdown inside, a blank line after its opening tag and another before its </div>. " +
      "Writes take 2 to 4 columns. Rewriting a section that holds columns means sending the whole <div> block back.";
    const SIZES =
      'Sizes are HTML too: an image shown at a set width reads as <figure><img … width="W">…</figure>, and a table with set column widths ' +
      "reads as an HTML table with colwidth on its first row's cells. Widths are whole pixels from 32 to 4000; write them back the same way to keep them.";
    const EDIT_MD =
      "The new markdown. Required for every operation except delete_section and rename. Colors are HTML, as read_note_section returns them: " +
      'colored text is <span style="color:red">…</span> inside the markdown; a block\'s own color is e.g. <p data-background-color="yellow">…</p>. ' +
      `For a color, use one of these names: default, gray, brown, red, orange, yellow, green, blue, purple, pink, or a hex color such as #ff6600 (written #rgb or #rrggbb). ${COLUMNS} ${SIZES} ` +
      "HTML in the markdown is read as HTML; to keep a `<` that would start a tag or comment as text, write `\\<` (as read_note_section returns it), except inside code or a block written as HTML. " +
      `${WRITE_LINK} ${WRITE_KNOWLEDGE_SENTENCE} ${EDIT_TAG_SENTENCE}`;
    const CREATE_CONTENT =
      "Markdown for the new note. Leave it out to create an empty note. Some deployments cannot store content this way and answer `invalid_body`; " +
      `create the note without it and the note still exists. Colors, side-by-side columns and sizes work as in edit_note. ${WRITE_LINK} ${CREATE_KNOWLEDGE_SENTENCE}`;
    const SECTION_MD =
      "This page of the section, as markdown. The first page starts with the section's heading line — except `_top`, which has no heading; " +
      "a later page resumes where the last one stopped. Colored text and blocks come back as HTML, as do images shown at a set width, tables " +
      "with set column widths, and the <div> tags around side-by-side columns; write it back unchanged to keep them (edit_note takes rows of 2 to 4 columns). " +
      "Outside code and blocks that come back as HTML, a `<` that could start an HTML tag or comment comes back as `\\<`; write it back unchanged to keep it as text. " +
      READ_LINK;
    const SECTION_IMAGES =
      'An uploaded file\'s address contains its upload id, for example `/api/uploads/<id>` in `![name](/api/uploads/<id>)`, in `[name](/api/uploads/<id>)` or, for an image with a caption or shown at a set width, in `<figure><img … src="/api/uploads/<id>" …>…</figure>`; read an image with read_note_image.';

    expect(byName("edit_note").inputSchema.properties.markdown!.description).toBe(EDIT_MD);
    expect(byName("create_note").inputSchema.properties.content!.description).toBe(CREATE_CONTENT);
    const section = byName("read_note_section");
    expect((section.outputSchema as { properties: { section: { properties: { markdown: { description: string } } } } }).properties.section.properties.markdown.description).toBe(SECTION_MD);
    expect(section.description.endsWith(` ${SECTION_IMAGES} ${READ_SECTION_KNOWLEDGE_SENTENCE}`)).toBe(true);
    for (const s of [COLUMNS, SIZES, EDIT_MD, CREATE_CONTENT, SECTION_MD, SECTION_IMAGES]) expect(res.body).toContain(JSON.stringify(s).slice(1, -1));
    for (const gone of [
      "Colors work as in edit_note.",
      "write it back unchanged to keep the colors.",
      "(in a table cell",
      "Uploaded images appear as",
      "An uploaded image's address is `/api/uploads/<id>`",
      "An uploaded image's address contains its upload id",
    ]) {
      expect(res.body, gone).not.toContain(JSON.stringify(gone).slice(1, -1));
    }
  });

  // #177: truncation counts the JSON-escaped length. Two things the model reads on the outputSchema change with it: the heading description (both directions: the new sentence present, the old one absent)
  // and the group `owner`'s `name` having a limit and `nameTruncated` (every tool that returns `owner` must have it).
  it("#177: the heading description says 200 after escaping; the group owner carries the name limit and nameTruncated", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    const tools = res.json().result.tools as { name: string; outputSchema?: unknown }[];
    const outputs = new Map(tools.map(t => [t.name, JSON.stringify(t.outputSchema ?? null)]));

    for (const name of ["read_note_outline", "edit_note"]) {
      expect(outputs.get(name), name).toContain("The section's heading text, cut at 200 characters as written in JSON.");
    }
    expect(res.body).not.toContain("cut at 200 characters.");

    const groupOwner = '"name":{"type":"string","maxLength":200},"nameTruncated":{"type":"boolean","const":true}';
    // Folders: only match the owner union - it has both the group discriminator and `handle`; list_folders' `space` also has `"const":"group"` but no handle.
    const withOwner = [...outputs]
      .filter(([, schema]) => schema.includes('"const":"group"') && schema.includes('"handle"'))
      .map(([name]) => name)
      .sort();
    // #239: a read-write credential's list has no move_note_to_group, so this test no longer checks its owner shape: it shares `noteSummarySchema` (`mcp/dto.ts`) with copy_note, an accepted trade-off.
    // move_note_to_folder returns noteSummarySchema (registered with notes:write), so it also carries the group owner shape.
    expect(withOwner).toEqual(["copy_note", "create_note", "list_notes", "move_note_to_folder", "read_note_outline", "search_notes"]);
    for (const name of withOwner) expect(outputs.get(name), name).toContain(groupOwner);
    // The group shape of the folder tools' `space`: the group name likewise has a limit and `groupNameTruncated`.
    const groupSpace = '"groupName":{"type":"string","maxLength":200},"groupNameTruncated":{"type":"boolean","const":true}';
    for (const name of ["list_folders", "create_folder", "rename_folder", "move_folder"]) expect(outputs.get(name), name).toContain(groupSpace);
  });

  // A read-only credential **skips** `tools/list` and calls `edit_note` directly: scope filtering only happens at registration, with no second guard against "a client remembering an old list / guessing tool names".
  // **Not `insufficient_scope`**: `register.ts` didn't register this name, so the SDK judges "unknown tool" - `isError`, `content[0].text` containing "Tool edit_note not found", **no** `structuredContent`.
  // What this test still discriminates is the zero-side-effect half: that call never reached our handler, so `note_ai_edits` necessarily gets no new row.
  it("read-only credential skipping tools/list and calling edit_note directly -> the SDK's not-found form, and no new note_ai_edits row", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");

    const before = await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
    expect(before).toHaveLength(0);

    const call = await mcpPost(
      ctx.app,
      rpc("tools/call", { name: "edit_note", arguments: { note_id: note.id, op: "append", markdown: "不該寫進去" } }),
      { token }
    );
    expect(call.statusCode).toBe(200);
    const result = call.json().result as { isError?: true; content: { text: string }[]; structuredContent?: unknown };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Tool edit_note not found");
    expect(result.structuredContent).toBeUndefined();

    const after = await ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
    expect(after).toHaveLength(0);
  });

  // The `runTool()` coverage guard is spread over three files (named in the header of `register.ts`): this one guards `edit_note`/`create_note`/`create_transfer_token`/`read_note_image`/`copy_note`/`move_note_to_group`
  // and the rest of that half. `mcp-notes.test.ts` only hits `list_notes`/`search_notes` and `mcp-content.test.ts` only the two read tools, so both are **always green** for these write/transfer/image tools (not in their name sets);
  // without this test, the later-added tools would have no try/catch guard. Uses a read-write-move-delete credential (`delete_note`/`restore_note` are on the list only then).
  it("runTool() coverage: the names beforeTool sees are exactly {copy_note, create_folder, create_note, create_transfer_token, delete_folder, delete_note, edit_note, list_folders, list_notifications, list_trash, move_folder, move_note_to_folder, move_note_to_group, open_notes_as_files, post_comment, read_comments, read_note_image, rename_folder, restore_note}", async () => {
    const seen: string[] = [];
    const ctx = await buildCollabTestApp({ mcpTestHooks: { beforeTool: name => void seen.push(name) } });
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, RWMD);
    const note = await ctx.createNote(owner.id);

    await mcpPost(ctx.app, rpc("tools/call", { name: "edit_note", arguments: { note_id: note.id, op: "append", markdown: "x" } }), {
      token,
    });
    await mcpPost(ctx.app, rpc("tools/call", { name: "create_note", arguments: {} }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "copy_note", arguments: { note_id: randomUUID() } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "create_transfer_token", arguments: { note_id: note.id, purpose: "download" } }), {
      token,
    });
    await mcpPost(ctx.app, rpc("tools/call", { name: "open_notes_as_files", arguments: {} }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "move_note_to_group", arguments: { note_id: randomUUID(), group_id: randomUUID() } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_image", arguments: { note_id: note.id, upload_id: randomUUID() } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "list_trash", arguments: {} }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "delete_note", arguments: { note_id: randomUUID() } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "restore_note", arguments: { note_id: randomUUID() } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "list_folders", arguments: {} }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "create_folder", arguments: { name: "p13" } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "rename_folder", arguments: { folder_id: randomUUID(), name: "x" } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "move_folder", arguments: { folder_id: randomUUID(), parent_id: null } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "move_note_to_folder", arguments: { note_id: randomUUID(), folder_id: null } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "delete_folder", arguments: { folder_id: randomUUID() } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "read_comments", arguments: { note_id: note.id } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "post_comment", arguments: { note_id: note.id, body: "x" } }), { token });
    await mcpPost(ctx.app, rpc("tools/call", { name: "list_notifications", arguments: {} }), { token });

    expect([...new Set(seen)].sort()).toEqual([
      "copy_note",
      "create_folder",
      "create_note",
      "create_transfer_token",
      "delete_folder",
      "delete_note",
      "edit_note",
      "list_folders",
      "list_notifications",
      "list_trash",
      "move_folder",
      "move_note_to_folder",
      "move_note_to_group",
      "open_notes_as_files",
      "post_comment",
      "read_comments",
      "read_note_image",
      "rename_folder",
      "restore_note",
    ]);
  });

  // delete_note, restore_note and delete_folder don't declare idempotentHint (a second call returns not_found).
  it("annotations: move_note_to_group is verbatim {destructiveHint:true, idempotentHint:false}; copy_note {destructiveHint:false}; delete_note {destructiveHint:true}, restore_note {destructiveHint:false}; list_folders {readOnlyHint:true}; create_folder {destructiveHint:false}, rename_folder / move_folder / move_note_to_folder {destructiveHint:false, idempotentHint:true}; delete_folder {destructiveHint:true}; post_comment {destructiveHint:false}; no other tool has an annotations key", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, RWMD); // only this credential's list has move_note_to_group and the two trash write tools
    const tools = (await mcpPost(ctx.app, rpc("tools/list"), { token })).json().result.tools as { name: string; annotations?: unknown }[];
    expect(tools.find(t => t.name === "move_note_to_group")!.annotations).toEqual({ destructiveHint: true, idempotentHint: false });
    expect(tools.find(t => t.name === "copy_note")!.annotations).toEqual({ destructiveHint: false });
    expect(tools.find(t => t.name === "delete_note")!.annotations).toEqual({ destructiveHint: true });
    expect(tools.find(t => t.name === "restore_note")!.annotations).toEqual({ destructiveHint: false });
    expect(tools.find(t => t.name === "list_folders")!.annotations).toEqual({ readOnlyHint: true }); // folders: the designated exception
    expect(tools.find(t => t.name === "create_folder")!.annotations).toEqual({ destructiveHint: false });
    expect(tools.find(t => t.name === "rename_folder")!.annotations).toEqual({ destructiveHint: false, idempotentHint: true });
    expect(tools.find(t => t.name === "move_folder")!.annotations).toEqual({ destructiveHint: false, idempotentHint: true });
    expect(tools.find(t => t.name === "move_note_to_folder")!.annotations).toEqual({ destructiveHint: false, idempotentHint: true });
    expect(tools.find(t => t.name === "delete_folder")!.annotations).toEqual({ destructiveHint: true }); // no idempotentHint written (the second call returns not_found)
    expect(tools.find(t => t.name === "post_comment")!.annotations).toEqual({ destructiveHint: false });
    const annotated = ["copy_note", "move_note_to_group", ...DELETE_TOOLS, "list_folders", ...FOLDER_WRITE_TOOLS, "post_comment"];
    expect(tools.filter(t => !annotated.includes(t.name) && "annotations" in t).map(t => t.name)).toEqual([]);
  });

  // `move_note_to_group` registers by `canMove`: changing `if (canMove)` back to `if (canWrite)` in `register.ts` reddens this test.
  it("#239: a read-write credential without move -> nineteen tools, no move_note_to_group (registration order unchanged; open_notes_as_files included)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    expect(await toolNames(ctx.app, token, { sort: false })).toEqual(RWM_TOOLS_IN_ORDER.filter(n => n !== "move_note_to_group"));
  });

  // Independent of move: read-write-delete has the two trash write tools and no move_note_to_group.
  it("#181: read-write-delete credential -> twenty-two tools, no move_note_to_group, with delete_note / restore_note (delete_folder included; registration order unchanged)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, RWD);
    expect(await toolNames(ctx.app, token, { sort: false })).toEqual(RWMD_TOOLS_IN_ORDER.filter(n => n !== "move_note_to_group"));
  });

  it("#239: session -> twenty-one tools (no create_transfer_token / open_notes_as_files; has move_note_to_group, delete_note / restore_note, list_folders, the four folder write tools and delete_folder)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const res = await mcpPost(ctx.app, rpc("tools/list"), { cookie: await sessionCookie(owner.id) });
    const names = (res.json().result.tools as { name: string }[]).map(t => t.name);
    expect(names).toEqual(RWMD_TOOLS_IN_ORDER.filter(n => n !== "create_transfer_token" && n !== "open_notes_as_files"));
  });

  it("#239: copy_note's description and group_id description are either-or by canMove", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    // The credential is a scope string (token) or "session" (cookie); read-write-move and session both get the canMove version.
    const copyOf = async (cred: TokenScope | "session") => {
      const auth = cred === "session" ? { cookie: await sessionCookie(owner.id) } : { token: (await seedTokenForUser(ctx.db, owner.id, cred)).token };
      const res = await mcpPost(ctx.app, rpc("tools/list"), auth);
      const tool = (res.json().result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }>)
        .find(t => t.name === "copy_note")!;
      return { description: tool.description, groupId: tool.inputSchema.properties.group_id!.description };
    };
    expect(await copyOf("notes:read notes:write")).toEqual({ description: COPY_NOTE_DESCRIPTION_NO_MOVE, groupId: COPY_GROUP_ID_DESCRIBE_NO_MOVE });
    expect(await copyOf("notes:read notes:write notes:move")).toEqual({ description: COPY_NOTE_DESCRIPTION, groupId: COPY_GROUP_ID_DESCRIBE });
    expect(await copyOf("session")).toEqual({ description: COPY_NOTE_DESCRIPTION, groupId: COPY_GROUP_ID_DESCRIBE });
  });

  // The `listChanged` half of the initialize test (moved here from the transport-layer family). **Order is the contract**: `registerTool` unconditionally sets `listChanged` back to `true`, so
  // `registerCapabilities({tools:{listChanged:false}})` must come **after** all tools are registered. Before any tool is registered this test has zero discrimination (nothing flips the flag back).
  // **It is today's only guard for that ordering contract.**
  it("initialize declares capabilities.tools.listChanged === false (the ordering contract)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");

    const res = await mcpPost(ctx.app, INITIALIZE, { token });
    expect(res.statusCode).toBe(200);
    const caps = res.json().result.capabilities;
    // We are stateless and GET returns 405, so there is no server-to-client push channel; declaring false is honest.
    expect(caps.tools.listChanged).toBe(false);
  });
});

describe("#108 JSON-RPC batch", () => {
  // One POST with two `tools/call`: one a visible note, one a note that merely "exists but you have no permission" (**not** a random UUID: authorization is under test, not just existence).
  // Two things must hold at once: (1) authorization is independent per call (one succeeds, one `not_found`); (2) the limiter is charged independently per call, and the `role === "none"` call **doesn't eat the limiter**
  // (the same discipline as the content-tool limiter test). The limiter has 2 slots: the batch uses 1, then one more call can succeed, and the third gets 429.
  // This test is **the only one that posts a batch**: each of the two calls in one POST runs its own authorization and its own accounting. The "failures don't eat the limiter" half is also guarded by `mcp-content.test.ts`.
  it("one POST with two tools/call: each authorized and charged independently, the failing one doesn't eat the limiter", async () => {
    const ctx = await buildCollabTestApp({
      limiters: { contentRead: new FixedWindowLimiter({ limit: 2, windowMs: 600_000 }) },
    });
    const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
    const stranger = await ctx.createUser({ email: `x-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");
    const mine = await ctx.createNote(owner.id, "Mine");
    const theirs = await ctx.createNote(stranger.id, "Theirs");

    const call = (id: number, noteId: string) =>
      rpc("tools/call", { name: "read_note_outline", arguments: { note_id: noteId } }, id);
    const res = await mcpPost(ctx.app, [call(1, mine.id), call(2, theirs.id)], { token });
    expect(res.statusCode).toBe(200);

    const bodies = res.json() as { id: number; result: { isError?: true; structuredContent?: { code?: string } } }[];
    expect(Array.isArray(bodies)).toBe(true);
    expect(bodies).toHaveLength(2);
    const byId = new Map(bodies.map(b => [b.id, b.result]));
    // Each authorized independently: the owner's call gets the outline, the stranger's is `not_found` (**must not** reveal "exists but you have no permission").
    expect(byId.get(1)!.isError).toBeUndefined();
    expect(byId.get(2)!.isError).toBe(true);
    expect(byId.get(2)!.structuredContent!.code).toBe("not_found");

    // The batch used only 1 slot: 1 remains.
    const second = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_outline", arguments: { note_id: mine.id } }), { token });
    expect(second.json().result.isError).toBeUndefined();
    // The third call (the third successfully authorized one in the limiter) is the one blocked.
    const third = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_outline", arguments: { note_id: mine.id } }), { token });
    expect(third.json().result.structuredContent.code).toBe("too_many_requests");
  });
});

describe("#241: every tool rejects unknown keys (wire level; the structure side is guarded by unit/mcp-register.test.ts)", () => {
  // #239: a read-write credential no longer lists move_note_to_group and its copy_note has no group_id: adding a read-write-move credential lets the other version go through the wire level too.
  // #181: adds the two forms containing notes:delete (delete_note/restore_note are only on their lists).
  for (const scope of [RWMD, RWD, RWM, "notes:read notes:write", "notes:read"] as const) {
    it(`${scope}: every name in tools/list given { zz_unknown: 1 } -> isError, no structuredContent, message contains zz_unknown`, async () => {
      const ctx = await buildCollabTestApp();
      const owner = await ctx.createUser({ email: `x241-${randomUUID()}@example.com`, password: PASSWORD });
      const { token } = await seedTokenForUser(ctx.db, owner.id, scope);
      const names = await toolNames(ctx.app, token, { sort: false });
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const res = await mcpPost(ctx.app, rpc("tools/call", { name, arguments: { zz_unknown: 1 } }), { token });
        const result = res.json().result as { isError?: true; structuredContent?: unknown; content: { text: string }[] };
        expect({ name, text: result.content[0]!.text.includes("zz_unknown") }).toEqual({ name, text: true });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
      }
    });
  }

  it("strict doesn't hurt: list_notes with {} succeeds; no arguments is still the SDK's Required (same as with the raw shape)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `x241b-${randomUUID()}@example.com`, password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, owner.id, "notes:read");
    const ok = (await mcpPost(ctx.app, rpc("tools/call", { name: "list_notes", arguments: {} }), { token })).json().result;
    expect(ok.isError).toBeUndefined();
    const bare = (await mcpPost(ctx.app, rpc("tools/call", { name: "list_notes" }), { token })).json().result;
    expect(bare.isError).toBe(true);
    expect(bare.content[0].text).toContain("Required");
  });
});
