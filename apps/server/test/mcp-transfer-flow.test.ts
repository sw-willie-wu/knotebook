import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { IssueTransferTokenSeam } from "../src/auth/tx/issue-transfer-token.js";
import { transferTokens } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { TOO_MANY_PENDING_MESSAGE } from "../src/mcp/tools/create-transfer-token.js";
import { buildCollabTestApp, buildTestApp, freshLimiters, testConfig } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { waitForBlockedOrSettled } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { MULTIPART, PNG_BYTES, fileBody, issueDirect, ownerWithPat } from "./transfer-helpers.js";
import * as fx from "./helpers/upload-fixtures.js";

type Payload = { token: string; url: string; curl: string; method: string; noteId: string };
const callTool = (app: Parameters<typeof mcpPost>[0], token: string, name: string, args: Record<string, unknown>) =>
  mcpPost(app, rpc("tools/call", { name, arguments: args }), { token }).then(r => r.json().result as { isError?: true; structuredContent: Record<string, unknown>; content: Array<{ text: string }> });

describe("concurrent issuance from one parent credential: FOR NO KEY UPDATE serializes the pending count", () => {
  it("with 4 unconsumed tokens, the first issuance stops at afterCount (reads 4) and the second blocks; after release exactly 5 exist and the second gets too_many_requests", async () => {
    const seam: IssueTransferTokenSeam = {};
    const { app, db } = await buildTestApp({ mcpTestHooks: { issueTransferToken: seam } });
    const pool = db.$client;
    const o = await ownerWithPat(db);
    // Warm-up: touchLastUsed (UPDATE on api_tokens, throttled to 60 s) must finish before the interleaving starts;
    // otherwise it collides with the first issuance's row lock and waitForBlockedOrSettled reads that as "second blocked".
    expect((await mcpPost(app, rpc("tools/list"), { token: o.pat })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await issueDirect(db, o.patId, o.noteId, "upload");

    let calls = 0;
    let second: Promise<Awaited<ReturnType<typeof callTool>>> | undefined;
    let state: "blocked" | "settled" | undefined;
    seam.afterCount = async () => {
      if (calls++ !== 0) return;
      second = callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "upload" });
      state = await waitForBlockedOrSettled(pool, second);
    };
    const first = await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "upload" });
    const secondResult = await second!;
    expect(state).toBe("blocked");
    expect(first.isError).toBeUndefined();
    expect(secondResult.structuredContent.code).toBe("too_many_requests");
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(transferTokens)
      .where(sql`${transferTokens.parentTokenId} = ${o.patId} and ${transferTokens.purpose} = 'upload' and ${transferTokens.consumedAt} is null`);
    expect(n).toBe(5);
  });

  it("smoke: 10 concurrent upload issuances x 20 rounds (fresh parent each round) -> exactly 5 succeed per round, 5 rejected by the pending limit; another parent is unaffected", async () => {
    // 20 rounds x 10 = 200 upload issuances, all charging tokenWrite (key token:<userId>, 60 per 10 min); without a larger
    // limiter every round from the 6th on would be rate-limited, passing as pending-limit rejections. The large limiter isolates the pending limit; each rejection is asserted to be TOO_MANY_PENDING_MESSAGE.
    const tokenWrite = new FixedWindowLimiter({ limit: 10_000, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ tokenWrite }) });
    const o = await ownerWithPat(db);
    for (let round = 0; round < 20; round++) {
      const { token } = await seedTokenForUser(db, o.userId);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => callTool(app, token, "create_transfer_token", { note_id: o.noteId, purpose: "upload" })),
      );
      expect(results.filter(r => r.isError === undefined), `round ${round}`).toHaveLength(5);
      const refused = results.filter(r => r.isError === true);
      expect(refused, `round ${round}`).toHaveLength(5);
      for (const r of refused) expect(r.structuredContent, `round ${round}`).toEqual({ code: "too_many_requests", message: TOO_MANY_PENDING_MESSAGE });
    }
    expect((await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
  }, 120_000);
});

describe("transfer token plaintext never reaches the log", () => {
  it("issue -> upload 201 -> reuse 401 -> download -> wrong purpose 403 -> one runTool exception: the whole log has no plaintext and no knbt_", async () => {
    const chunks: string[] = [];
    let explode = false;
    // debug is one level more verbose than production's info, covering every log call in this project. Not trace:
    // @fastify/multipart logs `{ busboyOptions: { headers } }` at trace (raw Authorization, or the session cookie for cookie uploads),
    // which production's logger (`buildApp` defaults to info, no LOG_LEVEL) never prints.
    const { app, db } = await buildTestApp(
      { mcpTestHooks: { beforeTool: name => { if (explode && name === "create_transfer_token") throw new Error("boom"); } } },
      { logger: { level: "debug", stream: { write: (s: string) => void chunks.push(s) } } },
    );
    const o = await ownerWithPat(db);
    const up = (await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "upload" })).structuredContent as Payload;
    const post = () =>
      app.inject({ method: "POST", url: new URL(up.url).pathname, headers: { "content-type": MULTIPART, authorization: `Bearer ${up.token}` }, payload: fileBody(PNG_BYTES) });
    const created = await post();
    expect(created.statusCode).toBe(201);
    expect((await post()).statusCode).toBe(401);
    const down = (await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "download" })).structuredContent as Payload;
    const uploadId = (created.json() as { id: string }).id;
    expect((await app.inject({ method: "GET", url: `/api/uploads/${uploadId}`, headers: { authorization: `Bearer ${down.token}` } })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: new URL(up.url).pathname, headers: { "content-type": MULTIPART, authorization: `Bearer ${down.token}` }, payload: fileBody(PNG_BYTES) })).statusCode,
    ).toBe(403);
    explode = true;
    expect((await callTool(app, o.pat, "create_transfer_token", { note_id: o.noteId, purpose: "download" })).structuredContent.code).toBe("internal");
    const all = chunks.join("");
    expect(all.length).toBeGreaterThan(0);
    // The exception is thrown before the handler (beforeTool), so no new transfer token exists yet: this proves the error line
    // reached this log (the interceptor covers the error path), not that plaintext was masked; the three not.toContain below guard the plaintext.
    expect(all).toContain("MCP 工具丟出未預期的例外");
    expect(all).not.toContain(up.token);
    expect(all).not.toContain(down.token);
    expect(all).not.toContain("knbt_");
  });
});

describe("end to end (collab app): the curl the tool returns works, and its url written via edit_note reads back", () => {
  it("create_transfer_token(upload) -> replay the curl's method/header/url as a multipart POST -> 201 -> edit_note append -> read_note_section contains /api/uploads/<id>", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `t1-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    const note = await ctx.createNote(owner.id, "Images");
    const { token: pat } = await seedTokenForUser(ctx.db, owner.id);
    const p = (await callTool(ctx.app, pat, "create_transfer_token", { note_id: note.id, purpose: "upload" })).structuredContent as Payload;
    // Derived from the curl string, not other payload fields, so this proves the curl itself works.
    const m = /^curl -sS -X (POST) -H "Authorization: Bearer (knbt_[A-Za-z0-9_-]{43})" -F "file=@<path-to-file>" "([^"]+)"$/.exec(p.curl);
    expect(m).not.toBeNull();
    const [, method, bearerToken, url] = m!;
    // The curl url equals the payload `url`, and its origin comes from PUBLIC_URL (collab app uses `testConfig`); inject only takes
    // the pathname, so without pinning both a curl pointing at another host would still pass.
    expect(url).toBe(p.url);
    expect(new URL(url!).origin).toBe(testConfig.publicUrl.origin);
    const res = await ctx.app.inject({
      method: method as "POST",
      url: new URL(url!).pathname,
      headers: { "content-type": MULTIPART, authorization: `Bearer ${bearerToken}` },
      payload: fileBody(PNG_BYTES),
    });
    expect(res.statusCode).toBe(201);
    const { url: rel } = res.json() as { id: string; url: string };
    expect(rel).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}$/);
    const edit = await callTool(ctx.app, pat, "edit_note", { note_id: note.id, op: "append", markdown: `![shot](${rel})` });
    expect(edit.isError).toBeUndefined();
    const read = await callTool(ctx.app, pat, "read_note_section", { note_id: note.id, section_id: "_top" });
    expect(read.isError).toBeUndefined();
    expect((read.structuredContent.section as { markdown: string }).markdown).toContain(`![shot](${rel})`);
  });

  it("a PDF sent with the returned curl is stored as a file: the reply is {id, url, mime, kind: file}", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `t2-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    const note = await ctx.createNote(owner.id, "Files");
    const { token: pat } = await seedTokenForUser(ctx.db, owner.id);
    const p = (await callTool(ctx.app, pat, "create_transfer_token", { note_id: note.id, purpose: "upload" })).structuredContent as Payload;
    const res = await ctx.app.inject({
      method: "POST",
      url: new URL(p.url).pathname,
      headers: { "content-type": MULTIPART, authorization: `Bearer ${p.token}` },
      payload: fileBody(Buffer.from(fx.pdf()), { filename: "report.pdf", contentType: "application/pdf" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; url: string; mime: string; kind: string };
    expect(body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), url: `/api/uploads/${body.id}`, mime: "application/pdf", kind: "file" });
  });

  it("an upload written with the form UPLOAD_NEXT names for its kind reads back as that same canonical form", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `t3-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    const note = await ctx.createNote(owner.id, "Media");
    const { token: pat } = await seedTokenForUser(ctx.db, owner.id);
    const upload = async (file: Uint8Array, filename: string, contentType: string) => {
      const p = (await callTool(ctx.app, pat, "create_transfer_token", { note_id: note.id, purpose: "upload" })).structuredContent as Payload;
      const res = await ctx.app.inject({
        method: "POST",
        url: new URL(p.url).pathname,
        headers: { "content-type": MULTIPART, authorization: `Bearer ${p.token}` },
        payload: fileBody(Buffer.from(file), { filename, contentType }),
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { url: string; kind: string };
    };
    const video = await upload(fx.mp4(), "clip.mp4", "video/mp4");
    const audio = await upload(fx.mp3(), "song.mp3", "audio/mpeg");
    const file = await upload(fx.pdf(), "report.pdf", "application/pdf");
    expect([video.kind, audio.kind, file.kind]).toEqual(["video", "audio", "file"]);
    const markdown = [
      `<video src="${video.url}" data-name="clip.mp4"></video>`,
      `<audio src="${audio.url}" data-name="song.mp3"></audio>`,
      `<embed src="${file.url}" data-name="report.pdf">`,
    ].join("\n\n");
    const edit = await callTool(ctx.app, pat, "edit_note", { note_id: note.id, op: "append", markdown });
    expect(edit.isError).toBeUndefined();
    const read = await callTool(ctx.app, pat, "read_note_section", { note_id: note.id, section_id: "_top" });
    expect(read.isError).toBeUndefined();
    const out = (read.structuredContent.section as { markdown: string }).markdown;
    expect(out).toContain(`<video src="${video.url}" data-name="clip.mp4"></video>`);
    expect(out).toContain(`<audio src="${audio.url}" data-name="song.mp3"></audio>`);
    expect(out).toContain(`<embed src="${file.url}" data-name="report.pdf">`);
    expect(out).not.toContain("](/api/uploads/");
  });

  it("create_transfer_token not_found is byte-identical to read_note_outline not_found", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: `nf-${randomUUID()}@example.com`, password: "correct-horse-battery" });
    const { token } = await seedTokenForUser(ctx.db, owner.id);
    const missing = randomUUID();
    const a = await callTool(ctx.app, token, "create_transfer_token", { note_id: missing, purpose: "download" });
    const b = await callTool(ctx.app, token, "read_note_outline", { note_id: missing });
    expect(a.content[0]!.text).toBe(b.content[0]!.text);
  });
});
