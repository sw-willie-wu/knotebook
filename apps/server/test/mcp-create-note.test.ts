/**
 * The test without collab uses `buildTestApp`, the rest use `buildCollabTestApp`: `create_note` is not behind the deployment gate. Without `content` it
 * only inserts one row and never touches the live doc, and REST `POST /api/notes` is registered unconditionally and answers 400 for content without collab (`routes/notes.ts`:
 * "This deployment cannot create a note with content. ..."); MCP mirroring that is parity with REST (same opening sentence on both sides since #372).
 *
 * **Every test uses a read-write token**: a read-only token has `create_note` filtered out at registration, so using one would give a green unrelated to the subject
 * (the read-only side is asserted in mcp-tools-list.test.ts).
 *
 * callTool/payloadOf/errorOf are copies of the same helpers in several other MCP test files, deliberately not moved into mcp-helpers.ts (a few lines each).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { canonicalNotePath } from "@knotebook/shared";
import { noteAiEdits, notes, users } from "../src/db/schema.js";
import { EDIT_LIMIT, FixedWindowLimiter } from "../src/http/rate-limit.js";
import { QueueBusyError } from "../src/notes/editing/queue.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { UserGate } from "../src/auth/session.js";
import { buildCollabTestApp, buildTestApp, freshDb, freshLimiters, type CollabTestCtx } from "./helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedGroup, seedUser } from "./group-helpers.js";
import type { Db } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

interface ToolResultBody {
  isError?: true;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
}

interface ToolCall {
  status: number;
  result: ToolResultBody;
}

interface NoteSummary {
  id: string;
  title: string;
  titleTruncated?: true;
  owner: { kind: string; handle?: string; id?: string; name?: string };
  slug: string;
  url: string;
  role: string;
  updatedAt: string;
  lastEdited: { at: string; byHandle: string; agentLabel: string | null } | null;
}

async function callTool(app: FastifyInstance, token: string, name: string, args: unknown = {}): Promise<ToolCall> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  return { status: res.statusCode, result: res.json().result };
}

/** `structuredContent` of a successful call; also guards the mirror equality. */
function payloadOf(call: ToolCall): { note: NoteSummary } {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBeUndefined();
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent as unknown as { note: NoteSummary };
}

function errorOf(call: ToolCall): Record<string, unknown> & { code?: string; message?: string } {
  expect(call.status).toBe(200);
  expect(call.result.isError).toBe(true);
  expect(call.result.content[0]!.text).toBe(JSON.stringify(call.result.structuredContent));
  return call.result.structuredContent!;
}

const createNote = (app: FastifyInstance, token: string, args: Record<string, unknown> = {}) =>
  callTool(app, token, "create_note", args);

const countNotes = async (db: Db, ownerId: string): Promise<number> =>
  (await db.select().from(notes).where(eq(notes.ownerId, ownerId))).length;

interface Scene {
  ctx: CollabTestCtx;
  ownerId: string;
  ownerHandle: string;
  token: string;
  tokenId: string;
}

/** owner + one read-write PAT (token name fixed to "Claude Code" => agent label "claude"). **No pre-created note**: the subject is the note being created, an extra one would add a base count to the `countNotes` assertions. */
async function scene(opts: Parameters<typeof buildCollabTestApp>[0] = {}): Promise<Scene> {
  const ctx = await buildCollabTestApp(opts);
  const owner = await ctx.createUser({ email: `o-${randomUUID()}@example.com`, password: PASSWORD });
  const { token, tokenId } = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write", "Claude Code");
  const [row] = await ctx.db.select().from(users).where(eq(users.id, owner.id));
  return { ctx, ownerId: owner.id, ownerHandle: row!.handle, token, tokenId };
}

describe("#108 create_note", () => {
  // Parsing happens **before** the row is created (a contract written verbatim in `write-service.ts`'s docstring), so bad content creates no row.
  // The originally planned input ("contains an unsupported block" -> `unsupported_block`) can't reach the whitelist branch at the integration layer: the headless schema is the full
  // `defaultBlockSpecs` plus mermaid/codeBlock, so every type BlockNote's markdown parser produces is in the whitelist. The `unsupported_block` code is reachable from markdown,
  // but through other branches (core parse throws, see mcp-write-guards; HTML with event-handler attributes, caught by the syntax check); the whitelist branch is covered with a narrowed fake schema in
  // `test/unit/editing-markdown.test.ts`. This test uses `empty_content`, reachable on the same pipeline (same input as the second case of REST's `note-create-content.test.ts`);
  // the contract under test (parse first, create the row after) is unchanged.
  // This test is not the only guard for that contract: moving the insert in `createWithContent` before the parse also turns `note-create-content.test.ts`'s "bad content -> 400, no new row"
  // red (both share the service's implementation). What is unique here is that it also holds on the MCP call path.
  it("bad content -> the matching parse error code, and zero new rows in the notes table", async () => {
    const s = await scene();
    const call = await createNote(s.ctx.app, s.token, { title: "T", content: "   \n" });
    const err = errorOf(call);
    expect(err.code).toBe("empty_content");
    expect(err.message).toBeTruthy();
    expect(await countNotes(s.ctx.db, s.ownerId)).toBe(0);
  });
  it("content mixing <style>/<script> -> unsupported_block rejects the whole write, zero new rows in notes", async () => {
    const s = await scene();
    for (const content of ["# 標題\n\n<style>p{color:red}</style>\n\n內文", "內文 <script>alert(1)</script> 後文"]) {
      const err = errorOf(await createNote(s.ctx.app, s.token, { title: "T", content }));
      expect(err.code, content).toBe("unsupported_block");
    }
    expect(await countNotes(s.ctx.db, s.ownerId)).toBe(0);
  });

  // Without `content` = the equivalent of REST's 201 (the DB's default title, `lastEdited` always null). When `title` is absent the key is **left out of values entirely**
  // (`insertNoteWithAutoSlug` in `notes/create.ts`) so the DB default `"Untitled"`/`untitled-<uuid8>` applies: the application layer doesn't hard-code a second copy of the literal.
  it("no content -> succeeds, title from the DB default, url exactly canonicalNotePath, lastEdited null", async () => {
    const s = await scene();
    const { note } = payloadOf(await createNote(s.ctx.app, s.token));

    expect(note.title).toBe("Untitled");
    expect(note.role).toBe("owner");
    expect(note.owner).toEqual({ kind: "user", handle: s.ownerHandle });
    expect(note.url).toBe(canonicalNotePath({ ownerHandle: s.ownerHandle, groupId: null, slug: note.slug }));
    expect(note.titleTruncated).toBeUndefined();

    const [row] = await s.ctx.db.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.ownerId).toBe(s.ownerId);
    expect(row!.title).toBe("Untitled");
    expect(await countNotes(s.ctx.db, s.ownerId)).toBe(1);

    // This path is a bare insert: **no `note_ai_edits` row** => no editId, **nothing to undo**. The last sentence of `CREATE_NOTE_DESCRIPTION` is therefore limited to the path
    // with `content`: claiming "recorded and can be undone" here would mislead the model into judging "create an empty note, then edit_note" as safe.
    // **This line guards that fact** (the verbatim check of the text itself belongs to the enumeration test).
    // **It must come before the `lastEdited` line below**: the same regression (making this path also go through `createWithContent`) turns both red, and vitest aborts the whole `it`
    // at the first failure - if the other came first the message would be "`lastEdited` is not null", not pointing at the actual cause, an extra undoable record.
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id))).toHaveLength(0);
    expect(note.lastEdited).toBeNull();
  });

  // #145: a note created via `create_note` with a title used to get the URL `untitled-<8hex>`. The slug is derived in the same statement that inserts the row,
  // so the **same response's** `slug`/`url` are final and no second write is needed.
  it("#145: with a title, the same response's slug and url are the derived form (not untitled-<8hex>)", async () => {
    const s = await scene();
    const { note } = payloadOf(await createNote(s.ctx.app, s.token, { title: "MCP Title 145" }));

    // The first assertion is `slug`, the issue's symptom itself, so a regression that misses the MCP path fails at the cause.
    expect(note.slug).toBe("mcp-title-145");
    expect(note.url).toBe(canonicalNotePath({ ownerHandle: s.ownerHandle, groupId: null, slug: "mcp-title-145" }));
    expect(note.url).not.toMatch(/untitled-[0-9a-f]{8}$/);

    // Read back from the DB: `url` comes from `canonicalNotePath` and `slug` from the insert's returning.
    const [row] = await s.ctx.db.select().from(notes).where(eq(notes.id, note.id));
    expect(row!.slug).toBe("mcp-title-145");
    expect(row!.slugIsCustom).toBe(false);
  });

  // With `content` this goes through the **same pipeline** as REST `POST /api/notes` (`createWithContent`), so the persisted content must be identical field by field.
  // The two notes' `sectionId` (a block id) necessarily differ; `fingerprint` doesn't include ids (`canonicalizeNode` filters `id` out), so it is the comparable field.
  // `lastEdited` non-null guards **the re-read step**: the row from the insert's `returning()` is taken before the merge, so its four fields are still null and without a re-read `lastEdited` would always be null.
  it("valid content -> persisted content equals POST /api/notes field by field, and lastEdited is non-null", async () => {
    const s = await scene();
    const CONTENT = "# 標題一\n\n第一段內容\n\n# 標題二\n\n第二段內容";

    const { note } = payloadOf(await createNote(s.ctx.app, s.token, { title: "MCP", content: CONTENT }));
    const rest = await s.ctx.app.inject({
      method: "POST",
      url: "/api/notes",
      headers: bearer(s.token),
      payload: { title: "REST", content: CONTENT },
    });
    expect(rest.statusCode).toBe(201);

    const mine = (await getContent(s.ctx.app, note.id, s.token)).json();
    const theirs = (await getContent(s.ctx.app, rest.json().id as string, s.token)).json();
    expect(mine.markdown).toBe(theirs.markdown);
    expect(mine.fingerprint).toBe(theirs.fingerprint);
    const shape = (o: { outline: Array<{ level: number; heading: string; chars: number; fingerprint: string }> }) =>
      o.outline.map(e => ({ level: e.level, heading: e.heading, chars: e.chars, fingerprint: e.fingerprint }));
    expect(shape(mine)).toEqual(shape(theirs));

    // Guards the re-read step (without it -> always null). The attribution is the caller, the agent name comes from the token name.
    expect(note.lastEdited).not.toBeNull();
    expect(note.lastEdited!.byHandle).toBe(s.ownerHandle);
    expect(note.lastEdited!.agentLabel).toBe("claude");
    expect(note.title).toBe("MCP");
  });

  // This tests the mapping "catch doesn't distinguish the exception type -> delete the row -> `internal`", **not** a real queue timeout. `QueueBusyError` is **structurally
  // unreachable** on the create path: `NoteWriteQueue` is per-note and this path uses the **freshly inserted id**, so `chains.get(newId)` is always empty and the gate resolves
  // `"ok"` immediately; no concurrent caller can get it. So the exception is thrown from `beforeMerge` (our own injection seam) and goes through the same catch.
  it("beforeMerge throws QueueBusyError with content -> internal, not server_busy, and the just-created row is deleted", async () => {
    const s = await scene({ editingTestHooks: { beforeMerge: async () => { throw new QueueBusyError(); } } });
    const err = errorOf(await createNote(s.ctx.app, s.token, { title: "T", content: "內容" }));
    expect(err.code).toBe("internal");
    expect(await countNotes(s.ctx.db, s.ownerId)).toBe(0);
  });

  // The criterion is whether the tool needs the live doc, not which tool it resembles.
  // Uses a **read-write** token (a read-only token can't see `create_note`, which would make this test always green and unrelated).
  // **The `edit` limiter is held by the test** (`freshLimiters({ edit })`): this app is the only deployment shape that reaches the "`available` is false" branch, and the `edit`
  // limiter has **no second consumer** there - but it is still observable: the limiter is in the test's hand, so counting its remaining slots is the criterion (see the last two lines of this test).
  it("app without collab: tools/list includes create_note (#175: three fields); without content it works, with content -> invalid_body with zero new rows and no edit limiter slot consumed (create_note is outside the gate)", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit }) });
    const [user] = await db.insert(users).values({ email: `p-${randomUUID()}@example.com`, displayName: "P" }).returning();
    const userId = user!.id;
    // A read-write-move token: the set includes move_note_to_group, which only registers with notes:move. list_trash only queries the DB and is also outside the gate (any token).
    const { token } = await seedTokenForUser(db, userId, "notes:read notes:write notes:move");

    const list = await mcpPost(app, rpc("tools/list"), { token });
    const tools = list.json().result.tools as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    const names = tools.map(t => t.name).sort();
    expect(names).toContain("create_note");
    // The tools that read the live doc aren't advertised at all in this deployment shape; `create_note` is their counterexample, so this line also pins that it really is outside the gate.
    // Also outside the gate: create_transfer_token (token-specific), read_note_image (any token), copy_note and move_note_to_group, list_folders (DB only, any token),
    // the three folder write tools and move_note_to_folder (notes:write), and list_notifications (DB only, any credential).
    expect(names).toEqual(["copy_note", "create_folder", "create_note", "create_transfer_token", "list_folders", "list_notes", "list_notifications", "list_trash", "move_folder", "move_note_to_folder", "move_note_to_group", "read_note_image", "rename_folder", "search_notes"]);

    // `inputSchema` **may only be a raw shape or a bare `ZodObject` (`.strict()` is fine)**: passing `ZodEffects`/a union makes the advertised JSON Schema silently
    // `{"type":"object","properties":{}}` (the model sees no fields), while the file's other tests (all sending correct params) stay green. This line is the only guard for that symptom
    // on `create_note` (`edit_note`'s is in `mcp-edit-note.test.ts`).
    // Which "wrong" shapes break this tool was measured, not copied from elsewhere: a plain `z.object(createNoteInput)` advertises a schema **byte-identical to the raw shape**, so it is not
    // caught here; `z.object(createNoteInput).refine(...)` (`ZodEffects`) **really empties `properties`**, and **only this line** goes red (`expected [] to deeply equal ['content', 'title']`).
    // So this line guards the `ZodEffects`/union family, not every non-raw-shape form.
    const entry = tools.find(t => t.name === "create_note")!;
    // MCP input keys are snake_case (`group_id`); folders add `folder_id`.
    expect(Object.keys(entry.inputSchema.properties ?? {}).sort()).toEqual(["content", "folder_id", "group_id", "title"]);

    const { note } = payloadOf(await createNote(app, token));
    expect(note.title).toBe("Untitled");
    expect(await countNotes(db, userId)).toBe(1);

    const err = errorOf(await createNote(app, token, { title: "T", content: "x" }));
    expect(err.code).toBe("invalid_body");
    expect(await countNotes(db, userId)).toBe(1);

    // Rejection has zero side effects, and the **order** of two lines in `create-note.ts`: the `available` gate comes **before** charging the `edit` limiter, so the two calls above
    // (a successful create without content, and `invalid_body` with content) must not consume **any** slot. The limiter is created by this test, so the remaining count can be read directly.
    let left = 0;
    while (edit.consume(userId)) left += 1;
    expect(left, "帶 content 的 invalid_body 與不帶 content 的成功建立都不得消耗 edit 桶").toBe(EDIT_LIMIT.limit);
  });

  // #175: the group check comes **before** `available` (same order as REST `POST /api/notes`). On an app without collab, `create_note` with content normally returns `invalid_body`;
  // with a non-member `groupId` added the answer must be `group_not_found` (whether the group exists must not be masked by "this deployment doesn't support content"),
  // with zero new rows and no `edit` limiter slot consumed.
  it("app without collab: content + non-member groupId -> group_not_found (group check before available), zero new rows, no edit limiter slot consumed (#175)", async () => {
    const edit = new FixedWindowLimiter(EDIT_LIMIT);
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ edit }) });
    const [me, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: other.id, role: "admin" }]);
    const { token } = await seedTokenForUser(db, me.id, "notes:read notes:write");

    const err = errorOf(await createNote(app, token, { title: "T", content: "# x", group_id: foreign.id }));
    expect(err.code).toBe("group_not_found");
    expect(err.message).toBe("No group with that id among the groups you belong to.");
    expect((await db.select().from(notes)).length).toBe(0);
    let left = 0;
    while (edit.consume(me.id)) left += 1;
    expect(left).toBe(EDIT_LIMIT.limit);
  });

  // #145: `insertNoteWithAutoSlug` issues probe queries, so it **must not** sit before the `ctx.writes.available` gate (a pure values object that issues no query may).
  // Moving it back would make the "this deployment doesn't support content" rejection path start hitting the DB.
  //
  // What this test guards: moving the **whole call** before the gate is already caught by the existing row-count assertions (the no-collab test's `countNotes` and the zero-new-rows
  // in the bad-content and QueueBusy tests) **and** this test's `probes()`; moving **only the probe** before the gate while leaving the INSERT in place goes red **only here**,
  // in `probes()` - row counts don't move, so the `probes()` half is the only guard for that shape, which is this test's value.
  it("#145: the rejection path with content (no collab) issues zero probes and creates zero rows", async () => {
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    // The gate must be swapped along with it (same as the statement-shape test in `notes-slug.test.ts`): swapping only db would make authentication query another database.
    const { app } = await buildTestApp({ db: loggedDb, gate: new UserGate(loggedDb), limiters: freshLimiters() });
    const [user] = await db.insert(users).values({ email: `q-${randomUUID()}@example.com`, displayName: "Q" }).returning();
    const { token } = await seedTokenForUser(db, user!.id, "notes:read notes:write");

    const probes = () => queries.filter(q => /^select/i.test(q.trim()) && /"slug"\s*=/.test(q));
    const noteInserts = () => queries.filter(q => /^insert into "notes"/i.test(q.trim()));

    queries.length = 0;
    const err = errorOf(await createNote(app, token, { title: "X", content: "x" }));
    expect(err.code).toBe("invalid_body");
    expect(probes()).toHaveLength(0);
    expect(noteInserts()).toHaveLength(0);

    // The self-check deliberately comes last (the opposite of the statement-shape test in `notes-slug.test.ts`), for the reason "who goes red first when the regex stops matching":
    // there the two halves send separate requests and count their own queries; on a regex mismatch the "exactly 0" half passes vacuously and the "exactly 1" half goes red, so
    // "exactly 1" must be first.
    // Here the "exactly 0" half is the **rejection path** (which shouldn't query anyway), so on a mismatch it also passes vacuously rather than failing => vitest doesn't abort early,
    // and the later half still runs and goes red. The different order in the two tests is deliberate.
    queries.length = 0;
    const { note } = payloadOf(await createNote(app, token, { title: "X" }));
    expect(note.slug).toBe("x");
    expect(probes()).toHaveLength(1);
    expect(noteInserts()).toHaveLength(1);
  });

  // `create_note` does **not touch presence**: the comment moved from `routes/notes.ts` into the service says the other three write paths touch and this one deliberately
  // doesn't ("don't add it back as an oversight").
  //
  // **This test cannot catch someone adding the touch back**: adding `presence?.touch(...)` after `applyEdit` succeeds in `createWithContent` keeps the whole file green.
  // `PresenceRegistry.touch` first needs `documents.get(noteId)`, and this note was just created and its direct connection is `disconnect()`ed when `applyEdit` ends,
  // so the document is necessarily not loaded then => touch is necessarily a no-op.
  // No counterexample can be built: (a) nobody can connect to a note that doesn't exist yet; (b) connecting afterwards doesn't help, awareness isn't persisted;
  // (c) `buildCollabTestApp` has no injectable fake `PresenceRegistry` (only `presenceOptions`).
  // So "no touch" on this path is guaranteed by construction, not by a test; this test guards the **outcome**: after creation hocuspocus holds no loaded document, which catches
  // "the direct connection wasn't closed" but not "a touch line was added".
  // This test has **no awareness/presence assertions** (hence the title doesn't mention name tags): the note's document isn't even loaded, `documents.get(id)` is `undefined`,
  // so there is no awareness object to compare.
  it("after create_note hocuspocus holds no loaded document", async () => {
    const s = await scene();
    const docsBefore = s.ctx.collab.hocuspocus.documents.size;
    const { note } = payloadOf(await createNote(s.ctx.app, s.token, { title: "T", content: "# H\n\n內容" }));

    expect(s.ctx.collab.hocuspocus.documents.size).toBe(docsBefore);
    expect(s.ctx.collab.hocuspocus.documents.get(note.id)).toBeUndefined();
  });
});
