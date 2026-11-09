/**
 * bulk transfer spec 2026-11-02 §7、§8：單篇下載 `GET /api/transfer/notes/:id` 與自行撤銷（plan T9 N1–N13）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { canonicalNotePath } from "@knotebook/shared";
import { folders, notes, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { TOO_MANY_BULK_TOKENS_MESSAGE } from "../src/mcp/tools/create-bulk-transfer-token.js";
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

describe("單篇下載", () => {
  it("N1 200：content-type、8 行 frontmatter＋本文＝MCP 讀出；base 對到一列基底（user、note、key_id、salt、line_hashes、segments、applied_* NULL）", async () => {
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
    expect(f.keys).toEqual(["knotebook", "id", "title", "role", "base", "url"]);
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

  it("N2 404 同字（TRANSFER_NOTE_NOT_FOUND_MESSAGE）：不存在的 uuid、看不到的、垃圾桶、非 uuid、%00", async () => {
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

  it("N3 403 不在範圍：personal 權杖讀群組筆記；folder 權杖讀資料夾外；group 權杖讀別群組", async () => {
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

  it("N4 contentRead limit 1：先 404 不扣、之後 200、再一發 429＋Retry-After", async () => {
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

  it("N4b HEAD /api/transfer/notes/:id → 404、不扣 contentRead（exposeHeadRoute: false，審查 m6）", async () => {
    const ctx = await buildCollabTestApp({ limiters: { contentRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
    const nn = await seedNote(ctx.db, { ownerId: u.id });
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    const h = await ctx.app.inject({ method: "HEAD", url: `/api/transfer/notes/${nn.id}`, headers: { authorization: `Bearer ${b.token}` } });
    expect(h.statusCode).toBe(404);
    expect((await bulkGet(ctx.app, `/api/transfer/notes/${nn.id}`, b.token)).statusCode).toBe(200);
  });

  it("N5 content-disposition：CJK＋emoji＋/ 的標題 → filename* 解回 sanitizeTitle(title).md", async () => {
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

  it("N6／N7 live：別的 client 改了內容 → 下載的是 live 內容；不 touch presence（awareness 沒有這支權杖的 entry）", async () => {
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

  it("N8 wikilink 目標讀者看不到 → 連結文字退到 snapshotTitle（與 MCP 讀出相同、不露現行標題）", async () => {
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

  it("N9 保留：同篇連抓 11 次 → 這位讀者這篇 ≤ 10 列；另一位讀者同篇的列不受影響", async () => {
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

  it("N10 撤銷：DELETE → 204、列不見、之後 GET → 401；已滿 3 支 → 撤銷一支 → 第 4 支可簽", async () => {
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
    expect((await callTool(ctx.app, p2.token, "create_bulk_transfer_token", {})).structuredContent).toEqual({ code: "too_many_requests", message: TOO_MANY_BULK_TOKENS_MESSAGE });
    expect((await bulkDelete(ctx.app, ts[0]!.token)).statusCode).toBe(204);
    expect((await callTool(ctx.app, p2.token, "create_bulk_transfer_token", {})).isError).toBeUndefined();
  });

  it("N11 兩位讀者抓同一篇 → 兩列 salt 不同、line_hashes 不同", async () => {
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

  it("N12 PR-2 起有寫回路由：PUT /api/transfer/notes 不帶 body → 不是 404（回 400）、帶 text/markdown → 不是 415；基底沒變", async () => {
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

  it("N13 範圍物件已看不到：shared 空間資料夾 F 被刪（只刪放置、筆記仍可見）→ 該篇 403 RANGE_GONE", async () => {
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
