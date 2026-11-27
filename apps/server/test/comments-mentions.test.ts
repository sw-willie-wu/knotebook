import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { COMMENT_MENTIONS_MAX, MENTION_CANDIDATES_MAX } from "@knotebook/shared";
import { resolveMentionCandidates } from "../src/comments/mentions.js";
import type { Db } from "../src/db/index.js";
import { apiTokens, users } from "../src/db/schema.js";
import { actorOf, edit, mentionsOf, notificationsOf, post, seedAgentToken, seedNamedUser, spanOf, type NamedUser } from "./comment-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, setMemberRole } from "./group-helpers.js";
import { freshDb } from "./helpers.js";
import { markTrashed } from "./trash-helpers.js";

async function scene(db: Db) {
  const alice = await seedNamedUser(db, "alice");
  const bob = await seedNamedUser(db, "bob");
  const carol = await seedNamedUser(db, "carol");
  const note = await seedNote(db, { ownerId: alice.id });
  await seedShare(db, note.id, bob.id, "viewer");
  await seedShare(db, note.id, carol.id, "editor");
  return { alice, bob, carol, noteId: note.id };
}

/** Each mention as [text covered, user, label]. */
async function resolved(db: Db, body: string, writer: { id: string }, noteId: string): Promise<Array<[string, string, string | null]>> {
  const out = await post(db, { noteId, actor: actorOf(writer), body });
  return (await mentionsOf(db, out.comment.id)).map(m => [spanOf(body, m), m.userId, m.agentLabel]);
}

describe("mention resolution", () => {
  it("resolves handles case-insensitively to people who can read the note, after CJK text and inside full-width brackets", async () => {
    const { db } = await freshDb();
    const { alice, bob, carol, noteId } = await scene(db);
    expect(await resolved(db, "請@bob看 （@Carol） @ALICE", alice, noteId)).toEqual([
      ["@bob", bob.id, null],
      ["@Carol", carol.id, null],
      ["@ALICE", alice.id, null],
    ]);
  });

  it("leaves plain text for an unknown handle, someone who can't read the note, a disabled reader, email addresses and a handle with a trailing dash removed", async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await scene(db);
    await seedNamedUser(db, "dave");
    const erin = await seedNamedUser(db, "erin", { disabled: true });
    await seedShare(db, noteId, erin.id, "viewer");
    expect(await resolved(db, "@nobody @dave @erin bob@example.com x@bob @bob-", alice, noteId)).toEqual([["@bob", bob.id, null]]);
    expect((await notificationsOf(db)).map(n => n.userId)).toEqual([bob.id]);
  });

  it("text that looks like a stored mention names nobody unless it contains a real @handle", async () => {
    const { db } = await freshDb();
    const { alice, carol, noteId } = await scene(db);
    const body = `<@${carol.id}> {"userId":"${carol.id}","start":0,"length":6} [carol](mention:${carol.id}) <span data-mention="carol">carol</span>`;
    expect(await resolved(db, body, alice, noteId)).toEqual([]);
    expect(await notificationsOf(db)).toEqual([]);
  });

  it("on a group note resolves members whose role reads, not members without read or people with leftover shares", async () => {
    const { db } = await freshDb();
    const alice = await seedNamedUser(db, "alice");
    const bob = await seedNamedUser(db, "bob");
    const carol = await seedNamedUser(db, "carol");
    const dave = await seedNamedUser(db, "dave");
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }, { userId: bob.id, role: "member" }, { userId: carol.id, role: "member" }]);
    await setMemberRole(db, g.id, carol.id, await seedRole(db, g.id, "blind", {}));
    const n = await seedNote(db, { groupId: g.id });
    await seedShare(db, n.id, dave.id, "editor");
    expect(await resolved(db, "@bob @carol @dave", alice, n.id)).toEqual([["@bob", bob.id, null]]);
  });

  it("a label resolves only when set explicitly on a token usable now; otherwise the mention falls back to the bare handle", async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await scene(db);
    await seedAgentToken(db, bob.id, { name: "claude" });
    await seedAgentToken(db, bob.id, { label: "old", expired: true });
    await seedAgentToken(db, bob.id, { label: "idle", kind: "oauth", expired: true });
    await seedAgentToken(db, bob.id, { label: "Codex" });
    expect(await resolved(db, "@bob/claude @bob/old @bob/idle @bob/Codex @bob/codex @bob/xyz", alice, noteId)).toEqual([
      ["@bob", bob.id, null],
      ["@bob", bob.id, null],
      ["@bob/idle", bob.id, "idle"],
      ["@bob/Codex", bob.id, "Codex"],
      ["@bob", bob.id, null],
      ["@bob", bob.id, null],
    ]);
  });

  it("at the end of a sentence a label is tried as written, then without its trailing dots", async () => {
    const { db } = await freshDb();
    const { alice, bob, carol, noteId } = await scene(db);
    await seedAgentToken(db, bob.id, { label: "claude" });
    await seedAgentToken(db, carol.id, { label: "v1." });
    const l32 = "l".repeat(32);
    await seedAgentToken(db, carol.id, { label: l32 });
    expect(await resolved(db, `Ask @bob/claude. Or @carol/v1. Then @bob/claude... and @carol/${l32}.`, alice, noteId)).toEqual([
      ["@bob/claude", bob.id, "claude"],
      ["@carol/v1.", carol.id, "v1."],
      ["@bob/claude", bob.id, "claude"],
      [`@carol/${l32}`, carol.id, l32],
    ]);
  });

  it(`resolves at most ${COMMENT_MENTIONS_MAX} distinct targets; repeats of a target already counted are kept`, async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await scene(db);
    const people: NamedUser[] = [];
    for (let i = 0; i < COMMENT_MENTIONS_MAX + 1; i++) {
      const u = await seedNamedUser(db, `user${i}`);
      await seedShare(db, noteId, u.id, "viewer");
      people.push(u);
    }
    await seedAgentToken(db, bob.id, { label: "claude" });
    const body = `@bob @bob/claude ${people.map(p => `@${p.handle}`).join(" ")} @bob`;
    const out = await post(db, { noteId, actor: actorOf(alice), body });
    const rows = await mentionsOf(db, out.comment.id);
    expect(rows.map(m => spanOf(body, m))).toEqual(["@bob", "@bob/claude", ...people.slice(0, COMMENT_MENTIONS_MAX - 2).map(p => `@${p.handle}`), "@bob"]);
    expect(await notificationsOf(db)).toHaveLength(COMMENT_MENTIONS_MAX);
    expect(new Set(out.newNotificationUserIds)).toEqual(new Set([bob.id, ...people.slice(0, COMMENT_MENTIONS_MAX - 2).map(p => p.id)]));
  });

  it("the writer can mention their own agents", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await scene(db);
    await seedAgentToken(db, alice.id, { label: "claude" });
    expect(await resolved(db, "@alice/claude go", alice, noteId)).toEqual([["@alice/claude", alice.id, "claude"]]);
  });
});

describe("mentions on edit", () => {
  it("a handle released and re-registered by someone else keeps naming the original person when text before it is edited; a new occurrence resolves fresh", async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await scene(db);
    const c = (await post(db, { noteId, actor: actorOf(alice), body: "hi @bob" })).comment;
    await db.update(users).set({ handle: "bobby" }).where(eq(users.id, bob.id));
    const impostor = await seedNamedUser(db, "bob");
    await seedShare(db, noteId, impostor.id, "viewer");

    const body = "hello there @BOB, and @bob";
    const out = await edit(db, { commentId: c.id, actor: actorOf(alice), body });
    expect((await mentionsOf(db, c.id)).map(m => [spanOf(body, m), m.userId])).toEqual([
      ["@BOB", bob.id],
      ["@bob", impostor.id],
    ]);
    expect(out.newNotificationUserIds).toEqual([impostor.id]);
  });

  it("a new span matching only by handle doesn't take the mention of an unchanged span after it", async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await scene(db);
    const c = (await post(db, { noteId, actor: actorOf(alice), body: "hi @bob" })).comment;
    await db.update(users).set({ handle: "bobby" }).where(eq(users.id, bob.id));
    const impostor = await seedNamedUser(db, "bob");
    await seedShare(db, noteId, impostor.id, "viewer");

    const body = "@bob/claude hi @bob";
    await edit(db, { commentId: c.id, actor: actorOf(alice), body });
    expect((await mentionsOf(db, c.id)).map(m => [spanOf(body, m), m.userId])).toEqual([
      ["@bob", impostor.id],
      ["@bob", bob.id],
    ]);
  });

  it("a mention that fell back to the bare handle, or whose label was added or removed, keeps its person", async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await scene(db);
    await seedAgentToken(db, bob.id, { label: "claude" });
    const body1 = "@bob/xyz and @bob";
    const c = (await post(db, { noteId, actor: actorOf(alice), body: body1 })).comment;
    expect((await mentionsOf(db, c.id)).map(m => [spanOf(body1, m), m.agentLabel])).toEqual([["@bob", null], ["@bob", null]]);
    await db.update(users).set({ handle: "bobby" }).where(eq(users.id, bob.id));
    const impostor = await seedNamedUser(db, "bob");
    await seedShare(db, noteId, impostor.id, "viewer");

    const body2 = "now @bob/xyz and @bob/claude";
    await edit(db, { commentId: c.id, actor: actorOf(alice), body: body2 });
    expect((await mentionsOf(db, c.id)).map(m => [spanOf(body2, m), m.userId, m.agentLabel])).toEqual([
      ["@bob", bob.id, null],
      ["@bob/claude", bob.id, "claude"],
    ]);
    const body3 = "@bob @bob";
    await edit(db, { commentId: c.id, actor: actorOf(alice), body: body3 });
    expect((await mentionsOf(db, c.id)).map(m => [m.userId, m.agentLabel])).toEqual([
      [bob.id, null],
      [bob.id, null],
    ]);
  });

  it("an agent mention keeps its label after the label is renamed, as long as the text is the same", async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await scene(db);
    const tokenId = await seedAgentToken(db, bob.id, { label: "claude" });
    const c = (await post(db, { noteId, actor: actorOf(alice), body: "@bob/claude." })).comment;
    await db.update(apiTokens).set({ agentLabel: "claude2" }).where(eq(apiTokens.id, tokenId));
    const body = "Again: @bob/claude.";
    const out = await edit(db, { commentId: c.id, actor: actorOf(alice), body });
    expect((await mentionsOf(db, c.id)).map(m => [spanOf(body, m), m.agentLabel])).toEqual([["@bob/claude", "claude"]]);
    expect(out.newNotificationUserIds).toEqual([]);
  });
});

describe("resolveMentionCandidates", () => {
  it("lists people who can read the note, the caller included, matched on handle or display name but never email, with explicit live labels", async () => {
    const { db, pool } = await freshDb();
    const { alice, bob, carol, noteId } = await scene(db);
    const dave = await seedNamedUser(db, "dave", { displayName: "Dave" });
    const erin = await seedNamedUser(db, "erin", { disabled: true });
    await seedShare(db, noteId, erin.id, "viewer");
    await db.update(users).set({ displayName: "Roberta" }).where(eq(users.id, carol.id));
    await seedAgentToken(db, alice.id, { label: "claude" });
    await seedAgentToken(db, alice.id, { label: "codex" });
    await seedAgentToken(db, alice.id, { name: "derived" });
    await seedAgentToken(db, alice.id, { label: "stale", expired: true });

    const all = await resolveMentionCandidates(db, { noteId, viewerId: bob.id, q: "" });
    expect(all!.map(c => c.handle)).toEqual(["alice", "bob", "carol"]);
    expect(all!.find(c => c.handle === "alice")).toEqual({ userId: alice.id, handle: "alice", displayName: "Alice", avatar: null, agentLabels: ["claude", "codex"] });
    expect((await resolveMentionCandidates(db, { noteId, viewerId: bob.id, q: "ROB" }))!.map(c => c.handle)).toEqual(["carol"]);
    expect((await resolveMentionCandidates(db, { noteId, viewerId: bob.id, q: "@b" }))!.map(c => c.handle)).toEqual(["bob", "carol"]);
    expect(await resolveMentionCandidates(db, { noteId, viewerId: bob.id, q: "example.com" })).toEqual([]);
    expect(await resolveMentionCandidates(db, { noteId, viewerId: bob.id, q: "%" })).toEqual([]);
    expect(await resolveMentionCandidates(db, { noteId, viewerId: dave.id, q: "" })).toBeNull();
    expect(await resolveMentionCandidates(db, { noteId: "nope", viewerId: bob.id, q: "" })).toBeNull();
    await markTrashed(pool, noteId, alice.id);
    expect(await resolveMentionCandidates(db, { noteId, viewerId: alice.id, q: "" })).toBeNull();
  });

  it(`returns at most ${MENTION_CANDIDATES_MAX}, prefix matches first`, async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await scene(db);
    for (let i = 0; i < MENTION_CANDIDATES_MAX + 2; i++) {
      const u = await seedNamedUser(db, `xa${i}`, { displayName: `Member ${i}` });
      await seedShare(db, noteId, u.id, "viewer");
    }
    const zed = await seedNamedUser(db, "zed", { displayName: "Ann Xa" });
    await seedShare(db, noteId, zed.id, "viewer");
    const out = await resolveMentionCandidates(db, { noteId, viewerId: alice.id, q: "xa" });
    expect(out).toHaveLength(MENTION_CANDIDATES_MAX);
    expect(out!.map(c => c.handle)).not.toContain("zed");
  });
});
