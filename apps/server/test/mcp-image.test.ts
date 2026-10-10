/**
 * #200 §9.3：MCP `read_note_image`（M1 讀圖半、M5、M6）＋ Review Focus RF4（大寫 note_id）。
 * 模型面字串寫字面值（#200 §7.2、§7.3 逐字；<MAX> = 5242880）。
 */
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
const NOT_READABLE = "No readable image with that id. It may not exist, or it may belong to a note you can't read.";
const DESC_TOKEN =
  "Look at an image in a note. Pass the id from `/api/uploads/<id>` in read_note_section's markdown. Images up to 5242880 bytes come back as an image; larger ones are refused — download those with create_transfer_token instead.";
const DESC_SESSION =
  "Look at an image in a note. Pass the id from `/api/uploads/<id>` in read_note_section's markdown. Images up to 5242880 bytes come back as an image; larger ones are refused.";
const SECTION_SENTENCE =
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
  it("M1 讀寫／唯讀 token、session、無 collab 都有；token 與 session 描述二選一", async () => {
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

  it("M5 正路：content[1] 是 image、data 解回原位元組、mimeType 取 DB、鏡像等式；/api/uploads/<id> 形亦可", async () => {
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

  it("M5 not_found：不存在與看不到的筆記逐位元組相同；查無上傳、檔案不在磁碟逐位元組相同", async () => {
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

  it("M5 上限邊界：size＝上限 → 成功；上限＋1 → file_too_large（token 版含 noteId、session 版指向瀏覽器）；實檔比 DB size 大 → 同 file_too_large", async () => {
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

  it("M5 扣 contentRead：limit 1 → 第二發 too_many_requests", async () => {
    const contentRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ contentRead }) });
    const me = await seedUser(db);
    const n = await seedNote(db, { ownerId: me.id });
    const id = await seedUpload(db, uploadsDir, n.id, me.id, PNG);
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    expect((await read(app, token, n.id, id)).isError).toBeUndefined();
    expect((await read(app, token, n.id, id)).structuredContent!.code).toBe("too_many_requests");
  });

  it("M5 Q3 放寬：別篇的上傳、讀得到那一篇 → 成功且 noteId 是上傳所屬；讀不到那一篇 → 與查無逐位元組相同", async () => {
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
    // #200 §7.3-4：超過上限時回的 noteId 是**上傳所屬**的那一篇（download token 綁在那一篇），不是傳進來的 note_id。
    const [bigInB] = await db.insert(uploads).values({ noteId: b.id, uploaderId: other.id, mime: "image/png", size: MAX + 1 }).returning({ id: uploads.id });
    const over = await read(app, token, a.id, bigInB!.id);
    expect(over.structuredContent).toMatchObject({ code: "file_too_large", noteId: b.id, bytes: MAX + 1 });
    expect(String(over.structuredContent!.message)).toContain(`for note ${b.id}.`);
    // 先判讀不讀得到、再判大小：屬於讀不到的 C 篇、size＝上限＋1 的上傳，仍是與查無逐位元組相同的 not_found（不洩漏 noteId 與大小）。
    const [bigInC] = await db.insert(uploads).values({ noteId: c.id, uploaderId: other.id, mime: "image/png", size: MAX + 1 }).returning({ id: uploads.id });
    expect((await read(app, token, a.id, bigInC!.id)).structuredContent).toEqual({ code: "not_found", message: NOT_READABLE });
  });

  it("RF4 大寫 note_id：上傳屬於該篇 → 成功、noteId 是小寫", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const me = await seedUser(db);
    const n = await seedNote(db, { ownerId: me.id });
    const id = await seedUpload(db, uploadsDir, n.id, me.id, PNG);
    const { token } = await seedTokenForUser(db, me.id, "notes:read");
    const r = await read(app, token, n.id.toUpperCase(), id);
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ noteId: n.id });
  });

  it("M6 read_note_section 讀回兩種形：無 caption → ![name](/api/uploads/<id>)；有 caption → <figure><img …src=…><figcaption>；§7.6 句在 wire 上", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const [p, q] = [randomUUID(), randomUUID()];
    const doc = new Y.Doc();
    const s = await EditorSession.open(testEditingRuntime, doc);
    try {
      s.editor.replaceBlocks(s.editor.document, [
        { type: "image", props: { url: `/api/uploads/${p}`, name: "plain" } },
        { type: "image", props: { url: `/api/uploads/${q}`, name: "cap", caption: "A caption" } },
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
    expect(md).toContain("<figure><img");
    expect(md).toContain(`src="/api/uploads/${q}"`);
    expect(md).toContain("<figcaption>");
    const res = await mcpPost(ctx.app, rpc("tools/list"), { token });
    const desc = (res.json().result.tools as Array<{ name: string; description: string }>).find(t => t.name === "read_note_section")!.description;
    expect(desc.endsWith(SECTION_SENTENCE)).toBe(true);
    expect(res.body).toContain(JSON.stringify(SECTION_SENTENCE).slice(1, -1));
  });
});
