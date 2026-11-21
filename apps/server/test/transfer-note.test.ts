import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { canonicalNotePath } from "@knotebook/shared";
import { folders, notes, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { TOO_MANY_BULK_TOKENS_MESSAGE } from "../src/mcp/tools/open-notes-as-files.js";
import { readNoteContent } from "../src/notes/editing/read.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { NOT_IN_RANGE_MESSAGE, RANGE_GONE_MESSAGE, TRANSFER_NOTE_NOT_FOUND_MESSAGE } from "../src/routes/transfer.js";
import { deriveTransferKey, transferKeyId } from "../src/transfer/base-hash.js";
import { sanitizeTitle } from "../src/transfer/paths.js";
import { buildCollabTestApp, testConfig, testEditingRuntime } from "./helpers.js";
import { seedContent, seedTokenForUser } from "./editing-helpers.js";
import { seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { seedFolder, seedPlacement, setNoteFolder } from "./folder-helpers.js";
import { seedDoc, wikilinkDoc } from "./copy-helpers.js";
import { basesOf, bulkDelete, bulkGet, callTool, issueBulkDirect, parseNoteFile, seedMd } from "./bulk-transfer-helpers.js";

const PASSWORD = "correct horse battery staple";
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string } }).error;
const mcpMarkdown = async (ctx: Awaited<ReturnType<typeof buildCollabTestApp>>, noteId: string, viewerId: string) => {
  const r = await readNoteContent({ db: ctx.db, collab: ctx.collab }, testEditingRuntime, noteId, viewerId);
  if (typeof r === "string" || !("markdown" in r)) throw new Error("unexpected read shape");
  return r.markdown;
};

describe("single-note download", () => {
  it("200: content-type, 9-line frontmatter + body = what MCP reads; base maps to one base row (user, note, key_id, salt, line_hashes, segments, applied_* NULL)", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const n = await seedNote(ctx.db, { ownerId: u.id }, { title: "會議紀錄" });
    await seedMd(ctx.db, n.id, "# 標題\n\n第一段\n\n1. a\n2. b\n\n第二段");
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    const r = await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, b.token);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    const f = parseNoteFile(r.body);
    expect(f.keys).toEqual(["knotebook", "id", "title", "tags", "role", "base", "url"]);
    expect(f.fm).toMatchObject({ knotebook: "1", id: n.id, title: JSON.stringify("會議紀錄"), role: "owner" });
    expect(f.fm.url).toBe(canonicalNotePath({ ownerHandle: u.handle, groupId: null, slug: n.slug }));
    expect(f.body).toBe(await mcpMarkdown(ctx, n.id, u.id));
    const [base] = await ctx.db.select().from(transferBases).where(eq(transferBases.key, f.fm.base!));
    expect(base).toBeDefined();
    expect(base!.userId).toBe(u.id);
    expect(base!.noteId).toBe(n.id);
    expect(base!.keyId).toBe(transferKeyId(deriveTransferKey(testConfig.appSecret)));
    expect(base!.salt.length).toBe(16);
    const nLines = f.body.replace(/\n+$/, "").split("\n").length;
    expect(base!.lineHashes.length).toBe(8 * nLines);
    expect(base!.lineKinds.length).toBe(nLines);
    expect(base!.segments).not.toBeNull();
    expect(base!.appliedBodySha).toBeNull();
    expect(base!.appliedTitleSha).toBeNull();
  });

  it("404 with the same text (TRANSFER_NOTE_NOT_FOUND_MESSAGE): nonexistent uuid, invisible, trash, non-uuid, %00", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    const hidden = await seedNote(ctx.db, { ownerId: other.id });
    const trashed = await seedNote(ctx.db, { ownerId: u.id });
    await ctx.db.update(notes).set({ deletedAt: sql`now()` }).where(eq(notes.id, trashed.id));
    const bodies: string[] = [];
    for (const id of [randomUUID(), hidden.id, trashed.id, "abc", "%00"]) {
      const r = await bulkGet(ctx.app, `/api/transfer/notes/${id}`, b.token);
      expect(r.statusCode, id).toBe(404);
      bodies.push(r.body);
    }
    for (const x of bodies) expect(x).toBe(bodies[0]);
    expect(errOf({ json: () => JSON.parse(bodies[0]!) })).toEqual({ code: "not_found", message: TRANSFER_NOTE_NOT_FOUND_MESSAGE });
  });

  it("403 out of scope: personal token reading a group note; folder token reading outside the folder; group token reading another group", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const g1 = await seedGroup(ctx.db, "G1", [{ userId: u.id, role: "member" }]);
    const g2 = await seedGroup(ctx.db, "G2", [{ userId: u.id, role: "member" }]);
    const gNote = await seedNote(ctx.db, { groupId: g2.id });
    const f = await seedFolder(ctx.db, { personal: u.id });
    const outside = await seedNote(ctx.db, { ownerId: u.id });
    const inside = await seedNote(ctx.db, { ownerId: u.id });
    await setNoteFolder(ctx.db.$client, inside.id, f.id);
    const personal = await issueBulkDirect(ctx.db, pat.tokenId, { range: { kind: "personal" } });
    const folder = await issueBulkDirect(ctx.db, pat.tokenId, { range: { kind: "folder", folderId: f.id } });
    const group = await issueBulkDirect(ctx.db, pat.tokenId, { range: { kind: "group", groupId: g1.id } });
    for (const [t, id] of [[personal.token, gNote.id], [folder.token, outside.id], [group.token, gNote.id]] as const) {
      const r = await bulkGet(ctx.app, `/api/transfer/notes/${id}`, t);
      expect(r.statusCode).toBe(403);
      expect(errOf(r)).toEqual({ code: "forbidden", message: NOT_IN_RANGE_MESSAGE });
    }
    expect((await bulkGet(ctx.app, `/api/transfer/notes/${inside.id}`, folder.token)).statusCode).toBe(200);
  });

  it("contentRead limit 1: 404 first does not charge, then 200, one more request 429 + Retry-After", async () => {
    const ctx = await buildCollabTestApp({ limiters: { contentRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const n = await seedNote(ctx.db, { ownerId: u.id });
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    expect((await bulkGet(ctx.app, `/api/transfer/notes/${randomUUID()}`, b.token)).statusCode).toBe(404);
    expect((await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, b.token)).statusCode).toBe(200);
    const r = await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, b.token);
    expect(r.statusCode).toBe(429);
    expect(String(r.headers["retry-after"])).toMatch(/^[1-9]\d*$/);
  });

  it("HEAD /api/transfer/notes/:id -> 404, does not charge contentRead (exposeHeadRoute: false)", async () => {
    const ctx = await buildCollabTestApp({ limiters: { contentRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const nn = await seedNote(ctx.db, { ownerId: u.id });
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    const h = await ctx.app.inject({ method: "HEAD", url: `/api/transfer/notes/${nn.id}`, headers: { authorization: `Bearer ${b.token}` } });
    expect(h.statusCode).toBe(404);
    expect((await bulkGet(ctx.app, `/api/transfer/notes/${nn.id}`, b.token)).statusCode).toBe(200);
  });

  it("content-disposition: a title with CJK + emoji + / -> filename* decodes to sanitizeTitle(title).md", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const title = "週報 \u{1F680} a/b (draft)*";
    const n = await seedNote(ctx.db, { ownerId: u.id }, { title });
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    const r = await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, b.token);
    const cd = String(r.headers["content-disposition"]);
    const m = /^attachment; filename\*=UTF-8''(.+)$/.exec(cd);
    expect(m, cd).not.toBeNull();
    expect(m![1]).not.toMatch(/['()*]/);
    expect(decodeURIComponent(m![1]!)).toBe(sanitizeTitle(title) + ".md");
  });

  it("live: another client edits the content -> the download is the live content; does not touch presence (awareness has no entry for this token)", async () => {
    const ctx = await buildCollabTestApp();
    const email = `o-${randomUUID()}@example.com`;
    const owner = await ctx.createUser({ email, password: PASSWORD });
    const n = await ctx.createNote(owner.id);
    const session = await ctx.loginAs(email, PASSWORD);
    const client = await seedContent(ctx, session, n.id, "live 內容 sentinel-7f3a");
    const pat = await seedTokenForUser(ctx.db, owner.id, "notes:read");
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    const before = [...ctx.collab.hocuspocus.documents.get(n.id)!.awareness.getStates().keys()].sort();
    const r = await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, b.token);
    expect(r.statusCode).toBe(200);
    expect(parseNoteFile(r.body).body).toContain("sentinel-7f3a");
    const live = ctx.collab.hocuspocus.documents.get(n.id)!;
    expect(live.awareness.getStates().get(presenceClientId(n.id, pat.tokenId))).toBeUndefined();
    expect([...live.awareness.getStates().keys()].sort()).toEqual(before);
    client.disconnect();
  });

  it("wikilink target the reader cannot see -> link text falls back to snapshotTitle (same as MCP reads, does not reveal the current title)", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const secret = await seedNote(ctx.db, { ownerId: other.id }, { title: "SECRET-現行標題" });
    const n = await seedNote(ctx.db, { ownerId: u.id });
    await seedDoc(ctx.db, n.id, wikilinkDoc([secret.id]));
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    const r = await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, b.token);
    const body = parseNoteFile(r.body).body;
    expect(body).toBe(await mcpMarkdown(ctx, n.id, u.id));
    expect(body).not.toContain("SECRET-現行標題");
  });

  it("retention: fetching the same note 11 times -> at most 10 rows for this reader and note; another reader's rows for the same note are unaffected", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const v = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: u.id });
    await seedShare(ctx.db, n.id, v.id, "viewer");
    const pu = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const pv = await seedTokenForUser(ctx.db, v.id, "notes:read");
    const bu = await issueBulkDirect(ctx.db, pu.tokenId);
    const bv = await issueBulkDirect(ctx.db, pv.tokenId);
    for (let i = 0; i < 3; i++) expect((await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, bv.token)).statusCode).toBe(200);
    for (let i = 0; i < 11; i++) expect((await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, bu.token)).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await basesOf(ctx.db, { userId: u.id, noteId: n.id })).length).toBe(10), { timeout: 5_000 });
    expect((await basesOf(ctx.db, { userId: v.id, noteId: n.id })).length).toBe(3);
  });

  it("revoke: DELETE -> 204, row gone, later GET -> 401; with 3 already full -> revoke one -> a 4th can be issued", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const n = await seedNote(ctx.db, { ownerId: u.id });
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    expect((await bulkDelete(ctx.app, b.token)).statusCode).toBe(204);
    expect((await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, b.token)).statusCode).toBe(401);
    const p2 = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const ts = [];
    for (let i = 0; i < 3; i++) ts.push(await issueBulkDirect(ctx.db, p2.tokenId));
    expect((await callTool(ctx.app, p2.token, "open_notes_as_files", {})).structuredContent).toEqual({ code: "too_many_requests", message: TOO_MANY_BULK_TOKENS_MESSAGE });
    expect((await bulkDelete(ctx.app, ts[0]!.token)).statusCode).toBe(204);
    expect((await callTool(ctx.app, p2.token, "open_notes_as_files", {})).isError).toBeUndefined();
  });

  it("two readers fetch the same note -> two rows with different salt and different line_hashes", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const v = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: u.id });
    await seedMd(ctx.db, n.id, "same text\n\nsame text");
    await seedShare(ctx.db, n.id, v.id, "viewer");
    for (const id of [u.id, v.id]) {
      const p = await seedTokenForUser(ctx.db, id, "notes:read");
      const b = await issueBulkDirect(ctx.db, p.tokenId);
      expect((await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, b.token)).statusCode).toBe(200);
    }
    const [a, c] = await basesOf(ctx.db, { noteId: n.id });
    expect(a!.salt.equals(c!.salt)).toBe(false);
    expect(a!.lineHashes.equals(c!.lineHashes)).toBe(false);
  });

  it("write-back route exists: PUT /api/transfer/notes without a body -> not 404 (400), with text/markdown -> not 415; base unchanged", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const b = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const before = (await basesOf(ctx.db)).length;
    const r1 = await ctx.app.inject({ method: "PUT", url: "/api/transfer/notes", headers: { authorization: `Bearer ${b.token}` } });
    expect(r1.statusCode).not.toBe(404);
    expect(r1.statusCode).toBe(400);
    const r2 = await ctx.app.inject({ method: "PUT", url: "/api/transfer/notes", headers: { authorization: `Bearer ${b.token}`, "content-type": "text/markdown; charset=utf-8" }, payload: "---\nid: x\n---\nhi" });
    expect(r2.statusCode).not.toBe(415);
    expect((await basesOf(ctx.db)).length).toBe(before);
  });

  it("range object no longer visible: shared-space folder F deleted (only the placement, the note is still visible) -> that note 403 RANGE_GONE", async () => {
    const ctx = await buildCollabTestApp();
    const a = await seedUser(ctx.db);
    const bUser = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: bUser.id });
    await seedShare(ctx.db, n.id, a.id, "viewer");
    const f = await seedFolder(ctx.db, { shared: a.id });
    await seedPlacement(ctx.db.$client, a.id, n.id, f.id);
    const pat = await seedTokenForUser(ctx.db, a.id, "notes:read");
    const t = await issueBulkDirect(ctx.db, pat.tokenId, { range: { kind: "folder", folderId: f.id } });
    expect((await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, t.token)).statusCode).toBe(200);
    await ctx.db.delete(folders).where(eq(folders.id, f.id));
    const r = await bulkGet(ctx.app, `/api/transfer/notes/${n.id}`, t.token);
    expect(r.statusCode).toBe(403);
    expect(errOf(r)).toEqual({ code: "forbidden", message: RANGE_GONE_MESSAGE });
  });
});
