import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, YDOC_FRAGMENT } from "@knotebook/shared";
import type { FastifyInstance } from "fastify";
import { apiTokens, noteComments, noteShares, noteStates, notifications, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { NOTIFICATION_BODY_MAX, NOTIFICATION_SCAN_MAX } from "../src/mcp/tools/list-notifications.js";
import { EMPTY_TOP_SECTION_MESSAGE, QUOTE_NEEDS_SECTION_MESSAGE } from "../src/mcp/tools/post-comment.js";
import { BOTH_SINCE_AND_COMMENT_MESSAGE } from "../src/mcp/tools/read-comments.js";
import { NOTE_NOT_FOUND_MESSAGE, SECTION_NOT_FOUND_MESSAGE } from "../src/mcp/note-read.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { buildCollabTestApp, buildTestApp, type CollabTestCtx, type TestClient } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, sleep } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

const PASSWORD = "correct-horse-battery";

interface Comment {
  id: string;
  author: { handle: string; agentLabel: string | null };
  replyToId: string | null;
  anchor: { blockId: string; quote: string | null; sectionId: string | null } | null;
  body: string;
}
interface CommentPage {
  comments: Comment[];
  nextSince: string | null;
  truncated: boolean;
  pageCutShort?: true;
}
interface Notification {
  id: string;
  kind: string;
  noteId: string;
  noteTitle: string;
  commentId: string;
  actor: { handle: string; agentLabel: string | null };
  body: string;
  bodyTruncated?: true;
}
interface NotificationPage {
  notifications: Notification[];
  nextSince: string | null;
  truncated: boolean;
  pageCutShort?: true;
}
type Auth = { token: string } | { cookie: string };
type Result<T> = { isError?: true; structuredContent: T; content: Array<{ text: string }> };

async function call<T = Record<string, unknown>>(app: FastifyInstance, auth: Auth, name: string, args: unknown): Promise<Result<T>> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().result as Result<T>;
}

async function ok<T>(app: FastifyInstance, auth: Auth, name: string, args: unknown): Promise<T> {
  const r = await call<T>(app, auth, name, args);
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent;
}

async function errorCode(app: FastifyInstance, auth: Auth, name: string, args: unknown): Promise<{ code: string; message: string }> {
  const r = await call<{ code: string; message: string }>(app, auth, name, args);
  expect(r.isError).toBe(true);
  return r.structuredContent;
}

const sessionOf = async (userId: string): Promise<Auth> => ({ cookie: (await cookieOf(userId))[SESSION_COOKIE]! });

interface Person {
  id: string;
  email: string;
  handle: string;
}

async function person(ctx: CollabTestCtx, handle: string): Promise<Person> {
  const email = `${handle}-${randomUUID().slice(0, 8)}@example.com`;
  const u = await ctx.createUser({ email, password: PASSWORD });
  await ctx.db.update(users).set({ handle }).where(eq(users.id, u.id));
  return { id: u.id, email, handle };
}

async function agentToken(ctx: CollabTestCtx, userId: string, label: string, scope: "notes:read" | "notes:read notes:write" = "notes:read notes:write"): Promise<Auth> {
  const { token, tokenId } = await seedTokenForUser(ctx.db, userId, scope, `token ${label}`);
  await ctx.db.update(apiTokens).set({ agentLabel: label }).where(eq(apiTokens.id, tokenId));
  return { token };
}

/** Comments and notifications made within the agent lag are held back; age everything past it. */
async function age(ctx: CollabTestCtx): Promise<void> {
  await ctx.db.$client.query(`update note_comments set created_at = created_at - interval '3 seconds'`);
  await ctx.db.$client.query(`update notifications set created_at = created_at - interval '3 seconds'`);
}

type Blk = { id: string; text: string; heading?: number; children?: Blk[] };
type Top = Blk | { row: string; cols: Blk[][] };

function containerOf(b: Blk): Y.XmlElement {
  const c = new Y.XmlElement("blockContainer");
  c.setAttribute("id", b.id);
  const e = new Y.XmlElement(b.heading === undefined ? "paragraph" : "heading");
  if (b.heading !== undefined) e.setAttribute("level", String(b.heading));
  const t = new Y.XmlText();
  t.insert(0, b.text);
  e.insert(0, [t]);
  c.insert(0, [e]);
  if (b.children) {
    const g = new Y.XmlElement("blockGroup");
    g.insert(0, b.children.map(containerOf));
    c.insert(1, [g]);
  }
  return c;
}

/** Writes the note's stored document directly; nobody has it open, so reads take these bytes. */
async function seedDoc(ctx: CollabTestCtx, noteId: string, blocks: Top[]): Promise<void> {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  group.insert(
    0,
    blocks.map(b => {
      if (!("row" in b)) return containerOf(b);
      const list = new Y.XmlElement("columnList");
      list.setAttribute("id", b.row);
      list.insert(
        0,
        b.cols.map((col, i) => {
          const column = new Y.XmlElement("column");
          column.setAttribute("id", `${b.row}c${i}`);
          column.insert(0, col.map(containerOf));
          return column;
        }),
      );
      return list;
    }),
  );
  await ctx.db.insert(noteStates).values({ noteId, ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), version: 1 });
}

async function scene(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const alice = await person(ctx, "alice");
  const bob = await person(ctx, "bob");
  const carol = await person(ctx, "carol");
  const note = await ctx.createNote(alice.id, "Plan");
  await ctx.share(note.id, bob.id, "editor");
  const aliceAgent = await agentToken(ctx, alice.id, "writer");
  return { ctx, app: ctx.app, alice, bob, carol, noteId: note.id, aliceAgent };
}

describe("post_comment", () => {
  it("posts as the token's user and label, notifies the mentioned person and agent, and tells an open read-only connection", async () => {
    const s = await scene();
    await s.ctx.share(s.noteId, s.carol.id, "viewer");
    const carolSession = await s.ctx.loginAs(s.carol.email, PASSWORD);
    const viewer = await carolSession.connect(s.noteId);
    const signals = recordMessages(viewer);
    const bobAgent = await agentToken(s.ctx, s.bob.id, "claude");

    const out = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId.toUpperCase(), body: "請@bob看，also @bob/claude." });
    expect(out.comment).toMatchObject({ author: { handle: "alice", agentLabel: "writer" }, anchor: null, replyToId: null, body: "請@bob看，also @bob/claude." });
    await until(() => signals.length === 1, "the live signal");
    expect(signals[0]).toEqual({ type: "comment", op: "created", commentId: out.comment.id });

    const rows = await s.ctx.db.select({ userId: notifications.userId, agentLabel: notifications.agentLabel, kind: notifications.kind }).from(notifications);
    expect(rows.map(r => [r.userId, r.agentLabel, r.kind]).sort()).toEqual(
      [
        [s.bob.id, null, "mention"],
        [s.bob.id, "claude", "mention"],
      ].sort(),
    );
    await age(s.ctx);
    const forAgent = await ok<NotificationPage>(s.app, bobAgent, "list_notifications", {});
    expect(forAgent.notifications.map(n => [n.kind, n.commentId, n.actor])).toEqual([["mention", out.comment.id, { handle: "alice", agentLabel: "writer" }]]);
  });

  it("a session posts without a label; a stranger's note is not_found and costs no comment slot; the comment limiter is shared with REST", async () => {
    const comment = new FixedWindowLimiter({ limit: 2, windowMs: 600_000 });
    const s = await scene({ limiters: { comment } });
    const strangerNote = await s.ctx.createNote(s.carol.id, "Carol's");

    expect(await errorCode(s.app, s.aliceAgent, "post_comment", { note_id: strangerNote.id, body: "hi" })).toEqual({ code: "not_found", message: NOTE_NOT_FOUND_MESSAGE });
    const asSession = await ok<{ comment: Comment }>(s.app, await sessionOf(s.alice.id), "post_comment", { note_id: s.noteId, body: "from the app" });
    expect(asSession.comment.author).toEqual({ handle: "alice", agentLabel: null });
    const rest = await s.app.inject({ method: "POST", url: `/api/notes/${s.noteId}/comments`, cookies: await cookieOf(s.alice.id), payload: { body: "rest" } });
    expect(rest.statusCode).toBe(201);
    expect((await errorCode(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "third" })).code).toBe("too_many_requests");
  });

  it("refuses bodies the write refuses, a quote without a section, and a reply to a comment on another note", async () => {
    const s = await scene();
    expect((await errorCode(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "   " })).code).toBe("invalid_comment");
    expect(await errorCode(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "x", quote: "q" })).toEqual({ code: "invalid_body", message: QUOTE_NEEDS_SECTION_MESSAGE });
    const other = await s.ctx.createNote(s.alice.id, "Other");
    const elsewhere = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: other.id, body: "there" });
    expect((await errorCode(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "x", reply_to: elsewhere.comment.id })).code).toBe("invalid_comment");
    expect(await s.ctx.db.select().from(noteComments).where(eq(noteComments.noteId, s.noteId))).toEqual([]);
  });

  it("anchors at a section's heading, `_top` at the note's first block; an empty `_top` and an unknown section are refused", async () => {
    const s = await scene();
    await seedDoc(s.ctx, s.noteId, [{ id: "p0", text: "intro" }, { id: "h1", text: "One", heading: 1 }, { id: "p1", text: "body" }]);

    const top = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "about the intro", anchor_section_id: "_top" });
    expect(top.comment.anchor).toEqual({ blockId: "p0", quote: null, sectionId: "_top" });
    const head = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "about one", anchor_section_id: "h1", quote: "One" });
    expect(head.comment.anchor).toEqual({ blockId: "h1", quote: "One", sectionId: "h1" });
    expect(await errorCode(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "x", anchor_section_id: "nope" })).toEqual({ code: "section_not_found", message: SECTION_NOT_FOUND_MESSAGE });
    expect((await errorCode(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "x", anchor_section_id: "h1", quote: "q".repeat(201) })).code).toBe("invalid_comment");

    const headed = await s.ctx.createNote(s.alice.id, "Headed");
    await seedDoc(s.ctx, headed.id, [{ id: "hx", text: "Starts here", heading: 2 }]);
    expect(await errorCode(s.app, s.aliceAgent, "post_comment", { note_id: headed.id, body: "x", anchor_section_id: "_top" })).toEqual({ code: "invalid_body", message: EMPTY_TOP_SECTION_MESSAGE });
  });

  it("a read-only token doesn't have the tool", async () => {
    const s = await scene();
    const reader = await agentToken(s.ctx, s.bob.id, "reader", "notes:read");
    const r = await call(s.app, reader, "post_comment", { note_id: s.noteId, body: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Tool post_comment not found");
  });
});

describe("read_comments", () => {
  it("holds back comments of the last two seconds, then pages oldest first with `since`", async () => {
    const s = await scene();
    const first = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "one" });
    expect(await ok<CommentPage>(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId })).toEqual({ comments: [], nextSince: null, truncated: false });
    await ok(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "two" });
    await ok(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "three" });
    await age(s.ctx);

    const p1 = await ok<CommentPage>(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId, limit: 2 });
    expect(p1.comments.map(c => c.body)).toEqual(["one", "two"]);
    expect(p1.truncated).toBe(true);
    const p2 = await ok<CommentPage>(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId, since: p1.nextSince });
    expect(p2.comments.map(c => c.body)).toEqual(["three"]);
    expect(p2.truncated).toBe(false);

    const fresh = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "four" });
    const p3 = await ok<CommentPage>(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId, since: p2.nextSince });
    expect(p3).toEqual({ comments: [], nextSince: p2.nextSince, truncated: false });
    // Without `since` the lag still applies; `comment_id` returns the comment at once.
    const one = await ok<CommentPage>(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId, comment_id: fresh.comment.id.toUpperCase() });
    expect(one).toEqual({ comments: [expect.objectContaining({ id: fresh.comment.id, body: "four" })], nextSince: null, truncated: false });
    expect((await ok<CommentPage>(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId })).comments.map(c => c.id)).not.toContain(fresh.comment.id);
    expect(first.comment.id).toBe(p1.comments[0]!.id);
  });

  it("shows no agent presence on the note, unlike read_note_outline with the same token", async () => {
    const s = await scene();
    const { token, tokenId } = await seedTokenForUser(s.ctx.db, s.alice.id, "notes:read", "reader");
    await s.ctx.db.update(apiTokens).set({ agentLabel: "reader" }).where(eq(apiTokens.id, tokenId));
    const client = await (await s.ctx.loginAs(s.alice.email, PASSWORD)).connect(s.noteId);
    const doc = s.ctx.collab.hocuspocus.documents.get(s.noteId)!;
    const agentId = presenceClientId(s.noteId, tokenId);

    await ok(s.app, { token }, "read_comments", { note_id: s.noteId });
    await sleep(300);
    expect(doc.awareness.getStates().get(agentId)).toBeUndefined();
    await ok(s.app, { token }, "read_note_outline", { note_id: s.noteId });
    await until(() => doc.awareness.getStates().get(agentId) !== undefined, "presence from read_note_outline");
    client.disconnect();
  });

  it("comment_id of another note is comment_not_found; since with comment_id and a forged since are invalid_body; a stranger gets not_found", async () => {
    const s = await scene();
    const other = await s.ctx.createNote(s.alice.id, "Other");
    const there = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: other.id, body: "there" });
    expect((await errorCode(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId, comment_id: there.comment.id })).code).toBe("comment_not_found");
    expect(await errorCode(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId, comment_id: there.comment.id, since: "x" })).toEqual({ code: "invalid_body", message: BOTH_SINCE_AND_COMMENT_MESSAGE });
    expect((await errorCode(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId, since: "not-a-cursor" })).code).toBe("invalid_body");
    const carolAgent = await agentToken(s.ctx, s.carol.id, "c");
    expect((await errorCode(s.app, carolAgent, "read_comments", { note_id: s.noteId })).code).toBe("not_found");
    expect((await errorCode(s.app, carolAgent, "read_comments", { note_id: other.id, comment_id: there.comment.id })).code).toBe("not_found");
  });

  it("gives each anchor the section of its top-level block, for nested list items and column children; null once the block is gone", async () => {
    const s = await scene();
    await seedDoc(s.ctx, s.noteId, [
      { id: "p0", text: "intro" },
      { id: "h1", text: "One", heading: 1 },
      { id: "li", text: "item", children: [{ id: "li2", text: "nested", children: [{ id: "li3", text: "deeper" }] }] },
      { id: "h2", text: "Two", heading: 1 },
      { row: "r", cols: [[{ id: "c1", text: "left" }], [{ id: "c2", text: "right" }]] },
    ]);
    const cookies = await cookieOf(s.alice.id);
    for (const blockId of ["li3", "c2", "p0", "gone", "h2"]) {
      const res = await s.app.inject({ method: "POST", url: `/api/notes/${s.noteId}/comments`, cookies, payload: { body: blockId, anchor: { blockId, quote: "q" } } });
      expect(res.statusCode, res.body).toBe(201);
    }
    await age(s.ctx);
    const page = await ok<CommentPage>(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId });
    expect(page.comments.map(c => [c.body, c.anchor?.sectionId])).toEqual([
      ["li3", "h1"],
      ["c2", "h2"],
      ["p0", "_top"],
      ["gone", null],
      ["h2", "h2"],
    ]);
  });

  it("writes each mention as the current handle; long pages are cut short by size and paging covers every comment once", async () => {
    const s = await scene();
    await ok(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "（@bob）and @bob/nolabel" });
    await s.ctx.db.update(users).set({ handle: "robert" }).where(eq(users.id, s.bob.id));
    const big = '"'.repeat(4000);
    for (let i = 0; i < 30; i += 1) {
      await s.ctx.db.insert(noteComments).values({ noteId: s.noteId, authorId: s.alice.id, body: `${String(i).padStart(2, "0")}${big.slice(2)}` });
    }
    await age(s.ctx);

    const seen: string[] = [];
    let since: string | null = null;
    let cut = false;
    for (let i = 0; i < 20; i += 1) {
      const page: CommentPage = await ok<CommentPage>(s.app, s.aliceAgent, "read_comments", { note_id: s.noteId, limit: 50, ...(since === null ? {} : { since }) });
      if (page.pageCutShort) cut = true;
      seen.push(...page.comments.map(c => c.id));
      if (i === 0) expect(page.comments[0]!.body).toBe("（@robert）and @robert/nolabel");
      since = page.nextSince;
      if (!page.truncated) break;
    }
    expect(cut).toBe(true);
    expect(seen).toHaveLength(31);
    expect(new Set(seen).size).toBe(31);
  });
});

describe("list_notifications", () => {
  it("routes by label: a token sees its own label's rows, a session only the person's; replies to an agent's comment reach that agent", async () => {
    const s = await scene();
    const claude = await agentToken(s.ctx, s.bob.id, "claude");
    const other = await agentToken(s.ctx, s.bob.id, "other");
    const bobSession = await sessionOf(s.bob.id);
    const posted = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "@bob and @bob/claude" });
    const byAgent = await ok<{ comment: Comment }>(s.app, claude, "post_comment", { note_id: s.noteId, body: "on it" });
    await ok(s.app, await sessionOf(s.alice.id), "post_comment", { note_id: s.noteId, body: "thanks", reply_to: byAgent.comment.id });
    await age(s.ctx);

    const forClaude = await ok<NotificationPage>(s.app, claude, "list_notifications", {});
    expect(forClaude.notifications.map(n => [n.kind, n.body, n.noteTitle, n.noteId])).toEqual([
      ["mention", "@bob and @bob/claude", "Plan", s.noteId],
      ["reply", "thanks", "Plan", s.noteId],
    ]);
    expect((await ok<NotificationPage>(s.app, other, "list_notifications", {})).notifications).toEqual([]);
    const forPerson = await ok<NotificationPage>(s.app, bobSession, "list_notifications", {});
    expect(forPerson.notifications.map(n => [n.kind, n.commentId])).toEqual([["mention", posted.comment.id]]);
    const again = await ok<NotificationPage>(s.app, claude, "list_notifications", { since: forClaude.nextSince });
    expect(again).toEqual({ notifications: [], nextSince: forClaude.nextSince, truncated: false });
  });

  it("an edit that adds a mention reaches the agent once; the body is cut at 1000 code units with bodyTruncated and read_comments gives all of it", async () => {
    const s = await scene();
    const claude = await agentToken(s.ctx, s.bob.id, "claude");
    const posted = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "draft" });
    await age(s.ctx);
    expect((await ok<NotificationPage>(s.app, claude, "list_notifications", {})).notifications).toEqual([]);

    const long = `@bob/claude ${"a".repeat(NOTIFICATION_BODY_MAX - 13)}😀tail`;
    const cookies = await cookieOf(s.alice.id);
    expect((await s.app.inject({ method: "PATCH", url: `/api/comments/${posted.comment.id}`, cookies, payload: { body: long } })).statusCode).toBe(200);
    expect((await s.app.inject({ method: "PATCH", url: `/api/comments/${posted.comment.id}`, cookies, payload: { body: `${long}!` } })).statusCode).toBe(200);
    await age(s.ctx);

    const page = await ok<NotificationPage>(s.app, claude, "list_notifications", {});
    expect(page.notifications).toHaveLength(1);
    const n = page.notifications[0]!;
    expect(n.bodyTruncated).toBe(true);
    // The emoji straddles the cut, so it goes whole.
    expect(n.body).toBe(long.slice(0, NOTIFICATION_BODY_MAX - 1));
    const full = await ok<CommentPage>(s.app, claude, "read_comments", { note_id: s.noteId, comment_id: n.commentId });
    expect(full.comments[0]!.body).toBe(`${long}!`);
  });

  it("skips notifications on notes the caller can't see any more, advancing past them; a page can be empty while more wait", async () => {
    const s = await scene();
    const claude = await agentToken(s.ctx, s.bob.id, "claude");
    const lost = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: s.noteId, body: "@bob/claude secret" });
    const values = Array.from({ length: NOTIFICATION_SCAN_MAX }, () => ({
      userId: s.bob.id,
      agentLabel: "claude",
      kind: "mention",
      noteId: s.noteId,
      commentId: lost.comment.id,
      actorId: s.alice.id,
    }));
    await s.ctx.db.insert(notifications).values(values);
    await s.ctx.db.delete(noteShares).where(eq(noteShares.userId, s.bob.id));
    const kept = await s.ctx.createNote(s.alice.id, "Shared later");
    await s.ctx.share(kept.id, s.bob.id, "viewer");
    await age(s.ctx);
    const visible = await ok<{ comment: Comment }>(s.app, s.aliceAgent, "post_comment", { note_id: kept.id, body: "@bob/claude open" });
    await age(s.ctx);

    const p1 = await ok<NotificationPage>(s.app, claude, "list_notifications", {});
    expect(p1.notifications).toEqual([]);
    expect(p1.truncated).toBe(true);
    expect(JSON.stringify(p1)).not.toContain("secret");
    const p2 = await ok<NotificationPage>(s.app, claude, "list_notifications", { since: p1.nextSince });
    expect(p2.notifications.map(n => n.commentId)).toEqual([visible.comment.id]);
    expect(p2.truncated).toBe(false);
  });

  it("without the collaboration component the tool is still listed, and its description doesn't point at read_comments", async () => {
    const { app, db } = await buildTestApp();
    const [u] = await db.insert(users).values({ email: `n-${randomUUID()}@example.com`, displayName: "N" }).returning();
    const { token } = await seedTokenForUser(db, u!.id, "notes:read");
    const tools = (await mcpPost(app, rpc("tools/list"), { token })).json().result.tools as Array<{ name: string; description: string }>;
    const entry = tools.find(t => t.name === "list_notifications")!;
    expect(entry.description).not.toContain("read_comments");
    expect(tools.map(t => t.name)).not.toContain("read_comments");
    expect((await ok<NotificationPage>(app, { token }, "list_notifications", {})).notifications).toEqual([]);
  });
});

function recordMessages(client: TestClient): Array<{ type: string; op: string; commentId: string }> {
  const out: Array<{ type: string; op: string; commentId: string }> = [];
  client.provider.on("stateless", ({ payload }: { payload: string }) => out.push(JSON.parse(payload) as { type: string; op: string; commentId: string }));
  return out;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
