/** Model-facing strings are written as literals (<MAX> = 5242880). */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { uploads } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, buildTestApp, freshLimiters, testEditingRuntime } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { cookieOf, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { PNG, seedDoc, seedUpload } from "./copy-helpers.js";

const MAX = 5_242_880;
const NOT_READABLE = "No readable image with that id. It may not exist, may not be a PNG, JPEG, GIF or WebP image, or may belong to a note you can't read.";
const DESC_TOKEN =
  "Look at an image in a note. Pass the id from `/api/uploads/<id>` in read_note_section's markdown. Images up to 5242880 bytes come back as an image; larger ones are refused — download those with create_transfer_token instead.";
const DESC_SESSION =
  "Look at an image in a note. Pass the id from `/api/uploads/<id>` in read_note_section's markdown. Images up to 5242880 bytes come back as an image; larger ones are refused.";
/** Columns: images with a width are also read as `<figure>`; table cells aren't mentioned; the address is given as an example (old absolute URLs also contain the id). */
const SECTION_SENTENCE =
  "An uploaded file's address contains its upload id, for example `/api/uploads/<id>` in `![name](/api/uploads/<id>)`, in `[name](/api/uploads/<id>)` or, for an image with a caption or shown at a set width, in `<figure><img … src=\"/api/uploads/<id>\" …>…</figure>`; read an image with read_note_image.";
/** Sentence from before the columns feature: it only covers figures with captions, which is incomplete once images with widths ship. */
const OLD_SECTION_SENTENCE =
  "Uploaded images appear as `![name](/api/uploads/<id>)`, or inside `<figure><img src=\"/api/uploads/<id>\">…</figure>` when captioned; see them with read_note_image.";

type Result = { isError?: true; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: Record<string, unknown> & { code?: string; message?: string } };
async function call(app: FastifyInstance, auth: { token?: string; cookie?: string }, name: string, args: unknown): Promise<Result> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), auth);
  expect(res.statusCode).toBe(200);
  return res.json().result as Result;
}
const read = (app: FastifyInstance, token: string, noteId: string, uploadId: string) => call(app, { token }, "read_note_image", { note_id: noteId, upload_id: uploadId });
async function toolsOf(app: FastifyInstance, auth: { token?: string; cookie?: string }) {
  return (await mcpPost(app, rpc("tools/list"), auth)).json().result.tools as Array<{ name: string; description: string }>;
}

describe("#200 read_note_image", () => {
  it("read-write / read-only token, session and no-collab all have it; the token and session descriptions are either-or", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    for (const scope of ["notes:read", "notes:read notes:write"] as const) {
      const t = (await toolsOf(ctx.app, { token: (await seedTokenForUser(ctx.db, me.id, scope)).token })).find(x => x.name === "read_note_image");
      expect(t?.description).toBe(DESC_TOKEN);
    }
    const s = (await toolsOf(ctx.app, { cookie: Object.values(await cookieOf(me.id))[0]! })).find(x => x.name === "read_note_image");
    expect(s?.description).toBe(DESC_SESSION);
    const plain = await buildTestApp();
    const u = await seedUser(plain.db);
    expect((await toolsOf(plain.app, { token: (await seedTokenForUser(plain.db, u.id, "notes:read")).token })).map(t => t.name)).toContain("read_note_image");
  });

  it("happy path: content[1] is an image, data decodes to the original bytes, mimeType comes from the DB, mirror equality; the /api/uploads/<id> form also works", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const me = await seedUser(db);
    const n = await seedNote(db, { ownerId: me.id });
    const id = await seedUpload(db, uploadsDir, n.id, me.id, PNG);
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    for (const uploadId of [id, `/api/uploads/${id}`]) {
      const r = await read(app, token, n.id, uploadId);
      expect(r.isError).toBeUndefined();
      expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(Buffer.from(r.content[1]!.data!, "base64").equals(PNG)).toBe(true);
      expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
      expect(r.structuredContent).toEqual({ noteId: n.id, uploadId: id, mimeType: "image/png", bytes: PNG.length });
    }
  });

  it("not_found: a nonexistent note and an invisible note are byte-identical; a missing upload and a file absent from disk are byte-identical", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [me, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const mine = await seedNote(db, { ownerId: me.id });
    const theirs = await seedNote(db, { ownerId: other.id });
    const tid = await seedUpload(db, uploadsDir, theirs.id, other.id, PNG);
    const gone = await seedUpload(db, uploadsDir, mine.id, me.id, PNG, { noFile: true });
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    const a = JSON.stringify((await read(app, token, randomUUID(), tid)).structuredContent);
    const b = JSON.stringify((await read(app, token, theirs.id, tid)).structuredContent);
    expect(a).toBe(b);
    expect(JSON.parse(a).code).toBe("not_found");
    const c = (await read(app, token, mine.id, randomUUID())).structuredContent;
    const d = (await read(app, token, mine.id, gone)).structuredContent;
    expect(c).toEqual({ code: "not_found", message: NOT_READABLE });
    expect(JSON.stringify(d)).toBe(JSON.stringify(c));
  });

  it("size limit boundary: size = limit -> success; limit + 1 -> file_too_large (token version includes noteId, session version points to the browser); a real file larger than the DB size -> the same file_too_large", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const me = await seedUser(db);
    const n = await seedNote(db, { ownerId: me.id });
    const atCap = await seedUpload(db, uploadsDir, n.id, me.id, Buffer.alloc(MAX, 1));
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    expect((await read(app, token, n.id, atCap)).isError).toBeUndefined();
    const [over] = await db.insert(uploads).values({ noteId: n.id, uploaderId: me.id, mime: "image/png", size: MAX + 1 }).returning({ id: uploads.id });
    expect((await read(app, token, n.id, over!.id)).structuredContent).toEqual({
      code: "file_too_large",
      message: `This image is ${MAX + 1} bytes; read_note_image returns images up to ${MAX} bytes. Download it with create_transfer_token (purpose "download") for note ${n.id}.`,
      noteId: n.id,
      bytes: MAX + 1,
    });
    const s = await call(app, { cookie: Object.values(await cookieOf(me.id))[0]! }, "read_note_image", { note_id: n.id, upload_id: over!.id });
    expect(s.structuredContent).toEqual({
      code: "file_too_large",
      message: `This image is ${MAX + 1} bytes; read_note_image returns images up to ${MAX} bytes. Open it in the browser instead.`,
      noteId: n.id,
      bytes: MAX + 1,
    });
    const lying = await seedUpload(db, uploadsDir, n.id, me.id, Buffer.alloc(MAX + 1, 2));
    await db.update(uploads).set({ size: 10 }).where(eq(uploads.id, lying));
    expect((await read(app, token, n.id, lying)).structuredContent!.code).toBe("file_too_large");
  });

  it("charges contentRead: limit 1 -> the second call is too_many_requests", async () => {
    const contentRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ contentRead }) });
    const me = await seedUser(db);
    const n = await seedNote(db, { ownerId: me.id });
    const id = await seedUpload(db, uploadsDir, n.id, me.id, PNG);
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    expect((await read(app, token, n.id, id)).isError).toBeUndefined();
    expect((await read(app, token, n.id, id)).structuredContent!.code).toBe("too_many_requests");
  });

  it("relaxed: an upload of another note that I can read -> success and noteId is the note the upload belongs to; one I can't read -> byte-identical to a missing upload", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const [me, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const a = await seedNote(db, { ownerId: me.id });
    const b = await seedNote(db, { ownerId: other.id });
    const c = await seedNote(db, { ownerId: other.id });
    await seedShare(db, b.id, me.id, "viewer");
    const inB = await seedUpload(db, uploadsDir, b.id, other.id, PNG);
    const inC = await seedUpload(db, uploadsDir, c.id, other.id, PNG);
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    const ok = await read(app, token, a.id, inB);
    expect(ok.structuredContent).toMatchObject({ noteId: b.id, uploadId: inB });
    const denied = await read(app, token, a.id, inC);
    expect(denied.structuredContent).toEqual({ code: "not_found", message: NOT_READABLE });
    // #200: the noteId returned when over the limit is the note the **upload belongs to** (the download token is bound to that note), not the passed-in note_id.
    const [bigInB] = await db.insert(uploads).values({ noteId: b.id, uploaderId: other.id, mime: "image/png", size: MAX + 1 }).returning({ id: uploads.id });
    const over = await read(app, token, a.id, bigInB!.id);
    expect(over.structuredContent).toMatchObject({ code: "file_too_large", noteId: b.id, bytes: MAX + 1 });
    expect(String(over.structuredContent!.message)).toContain(`for note ${b.id}.`);
    // Readability is judged before size: an upload of an unreadable note C with size = limit + 1 is still the same not_found as a missing one (no noteId or size leak).
    const [bigInC] = await db.insert(uploads).values({ noteId: c.id, uploaderId: other.id, mime: "image/png", size: MAX + 1 }).returning({ id: uploads.id });
    expect((await read(app, token, a.id, bigInC!.id)).structuredContent).toEqual({ code: "not_found", message: NOT_READABLE });
  });

  it("uppercase note_id: the upload belongs to that note -> success, noteId is lowercase", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const me = await seedUser(db);
    const n = await seedNote(db, { ownerId: me.id });
    const id = await seedUpload(db, uploadsDir, n.id, me.id, PNG);
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    const r = await read(app, token, n.id.toUpperCase(), id);
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ noteId: n.id });
  });

  it("read_note_section reads back three shapes: no caption -> ![name](/api/uploads/<id>); caption -> <figure><img ... src=...><figcaption>; width -> <figure><img ... width>; the sentence is on the wire", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const [p, q, r, f] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const doc = new Y.Doc();
    const s = await EditorSession.open(testEditingRuntime, doc);
    try {
      s.editor.replaceBlocks(s.editor.document, [
        { type: "image", props: { url: `/api/uploads/${p}`, name: "plain" } },
        { type: "image", props: { url: `/api/uploads/${q}`, name: "cap", caption: "A caption" } },
        { type: "image", props: { url: `/api/uploads/${r}`, name: "sized", previewWidth: 300 } },
        { type: "file", props: { url: `/api/uploads/${f}`, name: "report.pdf" } },
        { type: "paragraph", content: "tail" },
      ]);
    } finally {
      s.close();
    }
    await seedDoc(ctx.db, n.id, doc);
    const { token } = await seedTokenForUser(ctx.db, me.id, "notes:read");
    const outline = await call(ctx.app, { token }, "read_note_outline", { note_id: n.id });
    const sectionId = (outline.structuredContent!.sections as Array<{ sectionId: string }>)[0]!.sectionId;
    const sec = await call(ctx.app, { token }, "read_note_section", { note_id: n.id, section_id: sectionId });
    const md = (sec.structuredContent!.section as { markdown: string }).markdown;
    expect(md).toContain(`![plain](/api/uploads/${p})`);
    expect(md).toContain(`[report.pdf](/api/uploads/${f})`);
    expect(md).toContain("<figure><img");
    expect(md).toContain(`src="/api/uploads/${q}"`);
    expect(md).toContain("<figcaption>");
    expect(md).toContain(`<figure><img alt="sized" src="/api/uploads/${r}" width="300"></figure>`);
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    const desc = (res.json().result.tools as Array<{ name: string; description: string }>).find(t => t.name === "read_note_section")!.description;
    expect(desc).toContain(` ${SECTION_SENTENCE} `);
    expect(res.body).toContain(JSON.stringify(SECTION_SENTENCE).slice(1, -1));
  });

  it("a PDF upload is refused with the same not_found as a missing upload, before the size check", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const me = await seedUser(db);
    const n = await seedNote(db, { ownerId: me.id });
    const pdf = await seedUpload(db, uploadsDir, n.id, me.id, Buffer.from("%PDF-1.4\n%%EOF\n"), { mime: "application/pdf" });
    const [big] = await db.insert(uploads).values({ noteId: n.id, uploaderId: me.id, mime: "application/pdf", size: MAX + 1 }).returning({ id: uploads.id });
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    const missing = (await read(app, token, n.id, randomUUID())).structuredContent;
    expect(missing).toEqual({ code: "not_found", message: NOT_READABLE });
    for (const id of [pdf, big!.id]) {
      const r = await read(app, token, n.id, id);
      expect(r.isError).toBe(true);
      expect(r.content).toHaveLength(1);
      expect(r.structuredContent).toEqual(missing);
    }
  });

  it("the pre-columns image sentence isn't on the wire (read-write and read-only tokens and session are all checked)", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auths = [
      { token: (await seedTokenForUser(ctx.db, me.id, "notes:read")).token },
      { token: (await seedTokenForUser(ctx.db, me.id, "notes:read notes:write")).token },
      { cookie: Object.values(await cookieOf(me.id))[0]! },
    ];
    for (const auth of auths) {
      const res = await mcpPost(ctx.app, rpc("tools/list"), auth);
      expect(res.body).toContain(JSON.stringify(SECTION_SENTENCE).slice(1, -1)); // false-green guard: read_note_section is on the list
      expect(res.body).not.toContain(JSON.stringify(OLD_SECTION_SENTENCE).slice(1, -1));
      expect(res.body).not.toContain("Uploaded images appear as");
    }
  });
});
