import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { COMMENT_BODY_MAX, COMMENT_QUOTE_MAX } from "@knotebook/shared";
import { deleteCommentInTx, postCommentInTx } from "../src/comments/tx/write.js";
import type { Db } from "../src/db/index.js";
import { commentNotified, groupMembers, noteCommentMentions, noteComments, noteShares, notes, notifications } from "../src/db/schema.js";
import { deleteNotesInTx } from "../src/notes/tx/delete-notes.js";
import { moveNoteToGroupInTx } from "../src/notes/tx/move.js";
import {
  actorOf,
  edit,
  expectAbort,
  mentionsOf,
  notificationsOf,
  notifiedOf,
  post,
  remove,
  seedAgentToken,
  seedNamedUser,
  type NamedUser,
} from "./comment-helpers.js";
import { noteState, seedGroup, seedNote, seedRole, seedShare, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { freshDb } from "./helpers.js";
import { markTrashed, sixRoleScene } from "./trash-helpers.js";

const MISSING = "00000000-0000-4000-8000-000000000000";

async function personalScene(db: Db) {
  const alice = await seedNamedUser(db, "alice");
  const bob = await seedNamedUser(db, "bob");
  const carol = await seedNamedUser(db, "carol");
  const note = await seedNote(db, { ownerId: alice.id });
  await seedShare(db, note.id, bob.id, "editor");
  await seedShare(db, note.id, carol.id, "viewer");
  return { alice, bob, carol, noteId: note.id };
}

const say = (db: Db, user: NamedUser | { id: string }, noteId: string, body = "hello") => post(db, { noteId, actor: actorOf(user), body });

describe("postCommentInTx: who can post", () => {
  it("the owner, an edit share and a view share can post on a personal note; anyone else, a trashed note and a bad id are 404 not_found", async () => {
    const { db, pool } = await freshDb();
    const { alice, bob, carol, noteId } = await personalScene(db);
    const dave = await seedNamedUser(db, "dave");
    const admin = await seedNamedUser(db, "erin", { isAdmin: true });

    for (const u of [alice, bob, carol]) {
      const out = await say(db, u, noteId, `from ${u.handle}`);
      expect(out.noteId).toBe(noteId);
      expect(out.comment).toMatchObject({ noteId, authorId: u.id, body: `from ${u.handle}`, tokenId: null, agentLabel: null, editedAt: null });
    }
    await expectAbort(say(db, dave, noteId), 404, "not_found");
    await expectAbort(post(db, { noteId, actor: actorOf(admin, { isSiteAdmin: true }), body: "x" }), 404, "not_found");
    await expectAbort(say(db, alice, MISSING), 404, "not_found");
    await expectAbort(say(db, alice, "not-a-uuid"), 404, "not_found");
    await markTrashed(pool, noteId, alice.id);
    await expectAbort(say(db, alice, noteId), 404, "not_found");
    expect(await db.select().from(noteComments)).toHaveLength(3);
  });

  it("on a group note every role that reads can post; a role without read, a non-member and a non-member site admin are 404; a member site admin can post", async () => {
    const { db } = await freshDb();
    const scene = await sixRoleScene(db);
    const n = await seedNote(db, { groupId: scene.groupId });
    for (const u of [scene.admin, scene.member, scene.editDelete, scene.deleteOnly, scene.editOnly, scene.readOnly]) {
      expect((await say(db, u, n.id)).comment.authorId).toBe(u.id);
    }
    const blind = await seedUser(db);
    await db.insert(groupMembers).values({ groupId: scene.groupId, userId: blind.id, roleId: await seedRole(db, scene.groupId, "blind", {}) });
    await expectAbort(say(db, blind, n.id), 404, "not_found");
    await expectAbort(say(db, scene.outsider, n.id), 404, "not_found");
    const outsiderAdmin = await seedUser(db, { isAdmin: true });
    await expectAbort(post(db, { noteId: n.id, actor: actorOf(outsiderAdmin, { isSiteAdmin: true }), body: "x" }), 404, "not_found");
    const memberAdmin = await seedUser(db, { isAdmin: true });
    await db.insert(groupMembers).values({ groupId: scene.groupId, userId: memberAdmin.id, roleId: await seedRole(db, scene.groupId, "reader", { canRead: true }) });
    expect((await post(db, { noteId: n.id, actor: actorOf(memberAdmin, { isSiteAdmin: true }), body: "x" })).comment.authorId).toBe(memberAdmin.id);
  });

  it("an agent's comment records its token and label", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await personalScene(db);
    const tokenId = await seedAgentToken(db, alice.id, { name: "Claude Code" });
    const out = await post(db, { noteId, actor: actorOf(alice, { tokenId, agentLabel: "claude-code" }), body: "done" });
    expect(out.comment).toMatchObject({ tokenId, agentLabel: "claude-code", authorId: alice.id });
  });
});

describe("editCommentInTx: who can edit", () => {
  it("only the author: the same person through an agent and the other way round; other readers and a site admin get 403; lost access, trash and bad ids are 404 comment_not_found", async () => {
    const { db, pool } = await freshDb();
    const { alice, bob, carol, noteId } = await personalScene(db);
    const admin = await seedNamedUser(db, "erin", { isAdmin: true });
    await seedShare(db, noteId, admin.id, "viewer");
    const tokenId = await seedAgentToken(db, bob.id, { label: "claude" });
    const byBob = (await say(db, bob, noteId, "v1")).comment;
    const byAgent = (await post(db, { noteId, actor: actorOf(bob, { tokenId, agentLabel: "claude" }), body: "a1" })).comment;

    expect((await edit(db, { commentId: byBob.id, actor: actorOf(bob, { tokenId, agentLabel: "claude" }), body: "v2" })).comment.body).toBe("v2");
    expect((await edit(db, { commentId: byAgent.id, actor: actorOf(bob), body: "a2" })).comment.body).toBe("a2");
    await expectAbort(edit(db, { commentId: byBob.id, actor: actorOf(alice), body: "x" }), 403, "forbidden");
    await expectAbort(edit(db, { commentId: byBob.id, actor: actorOf(carol), body: "x" }), 403, "forbidden");
    await expectAbort(edit(db, { commentId: byBob.id, actor: actorOf(admin, { isSiteAdmin: true }), body: "x" }), 403, "forbidden");
    await expectAbort(edit(db, { commentId: MISSING, actor: actorOf(bob), body: "x" }), 404, "comment_not_found");
    await expectAbort(edit(db, { commentId: "nope", actor: actorOf(bob), body: "x" }), 404, "comment_not_found");

    await db.delete(noteShares).where(eq(noteShares.userId, bob.id));
    await expectAbort(edit(db, { commentId: byBob.id, actor: actorOf(bob), body: "x" }), 404, "comment_not_found");
    await seedShare(db, noteId, bob.id, "viewer");
    await markTrashed(pool, noteId, alice.id);
    await expectAbort(edit(db, { commentId: byBob.id, actor: actorOf(bob), body: "x" }), 404, "comment_not_found");
    const [row] = await db.select().from(noteComments).where(eq(noteComments.id, byBob.id));
    expect(row!.body).toBe("v2");
  });

  it("an edit sets edited_at; an edit that changes nothing leaves the comment as it was", async () => {
    const { db } = await freshDb();
    const { bob, noteId } = await personalScene(db);
    const c = (await say(db, bob, noteId, "same")).comment;
    expect((await edit(db, { commentId: c.id, actor: actorOf(bob), body: "same" })).comment.editedAt).toBeNull();
    const out = await edit(db, { commentId: c.id, actor: actorOf(bob), body: "changed" });
    expect(out.comment.editedAt).toBeInstanceOf(Date);
    expect(out.comment.createdAt.getTime()).toBe(c.createdAt.getTime());
  });
});

describe("deleteCommentInTx: who can delete", () => {
  it("personal note: the author and the owner; an edit share can't delete others'; a site admin who can read can, one who can't gets 404", async () => {
    const { db, pool } = await freshDb();
    const { alice, bob, carol, noteId } = await personalScene(db);
    const reader = await seedNamedUser(db, "erin", { isAdmin: true });
    await seedShare(db, noteId, reader.id, "viewer");
    const stranger = await seedNamedUser(db, "frank", { isAdmin: true });

    const c1 = (await say(db, carol, noteId)).comment;
    await expectAbort(remove(db, { commentId: c1.id, actor: actorOf(bob) }), 403, "forbidden");
    await expectAbort(remove(db, { commentId: c1.id, actor: actorOf(stranger, { isSiteAdmin: true }) }), 404, "comment_not_found");
    expect((await remove(db, { commentId: c1.id, actor: actorOf(carol) })).comment.id).toBe(c1.id);
    const c2 = (await say(db, carol, noteId)).comment;
    await remove(db, { commentId: c2.id, actor: actorOf(alice) });
    const c3 = (await say(db, bob, noteId)).comment;
    await remove(db, { commentId: c3.id, actor: actorOf(reader, { isSiteAdmin: true }) });
    await expectAbort(remove(db, { commentId: c3.id, actor: actorOf(alice) }), 404, "comment_not_found");
    expect(await db.select().from(noteComments)).toEqual([]);

    const c4 = (await say(db, bob, noteId)).comment;
    await markTrashed(pool, noteId, alice.id);
    await expectAbort(remove(db, { commentId: c4.id, actor: actorOf(alice) }), 404, "comment_not_found");
  });

  it("group note: roles with the delete flag delete others' comments; roles without it get 403", async () => {
    const { db } = await freshDb();
    const scene = await sixRoleScene(db);
    const n = await seedNote(db, { groupId: scene.groupId });
    for (const u of [scene.admin, scene.editDelete, scene.deleteOnly]) {
      const c = (await say(db, scene.readOnly, n.id)).comment;
      await remove(db, { commentId: c.id, actor: actorOf(u) });
    }
    const c = (await say(db, scene.readOnly, n.id)).comment;
    for (const u of [scene.member, scene.editOnly]) await expectAbort(remove(db, { commentId: c.id, actor: actorOf(u) }), 403, "forbidden");
    await expectAbort(remove(db, { commentId: c.id, actor: actorOf(scene.outsider) }), 404, "comment_not_found");
    expect((await db.select().from(noteComments)).map(r => r.id)).toEqual([c.id]);
  });
});

describe("validation", () => {
  it("rejects an empty or blank body, more than COMMENT_BODY_MAX code points, NUL and lone surrogates with 400 invalid_comment", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await personalScene(db);
    for (const body of ["", "   \n", "a".repeat(COMMENT_BODY_MAX + 1), "a\0b", "a\uD800b", "\uDC00"]) {
      await expectAbort(say(db, alice, noteId, body), 400, "invalid_comment");
    }
    const emoji = "😀".repeat(COMMENT_BODY_MAX);
    expect(emoji.length).toBe(COMMENT_BODY_MAX * 2);
    expect((await say(db, alice, noteId, emoji)).comment.body).toBe(emoji);
    const c = (await say(db, alice, noteId, "ok")).comment;
    for (const body of ["", "a".repeat(COMMENT_BODY_MAX + 1), "\0"]) {
      await expectAbort(edit(db, { commentId: c.id, actor: actorOf(alice), body }), 400, "invalid_comment");
    }
  });

  it("checks the passage: a block id matching BLOCK_ANCHOR_RE other than _top, and a quote of 1 to COMMENT_QUOTE_MAX storable code points or none", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await personalScene(db);
    const bad = [
      { blockId: "_top", quote: "q" },
      { blockId: "has space", quote: "q" },
      { blockId: "", quote: "q" },
      { blockId: "b".repeat(65), quote: "q" },
      { blockId: "b1", quote: "" },
      { blockId: "b1", quote: "q".repeat(COMMENT_QUOTE_MAX + 1) },
      { blockId: "b1", quote: "q\0" },
      { blockId: "b1", quote: "\uD83D" },
    ];
    for (const anchor of bad) await expectAbort(post(db, { noteId, actor: actorOf(alice), body: "x", anchor }), 400, "invalid_comment");
    const quote = `${"😀".repeat(COMMENT_QUOTE_MAX - 1)}…`;
    const out = await post(db, { noteId, actor: actorOf(alice), body: "x", anchor: { blockId: "b-1_A", quote } });
    expect(out.comment).toMatchObject({ anchorBlockId: "b-1_A", anchorQuote: quote });
    const bare = await post(db, { noteId, actor: actorOf(alice), body: "x", anchor: { blockId: "b2", quote: null } });
    expect(bare.comment).toMatchObject({ anchorBlockId: "b2", anchorQuote: null });
  });

  it("a reply must answer a comment on the same note", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await personalScene(db);
    const other = await seedNote(db, { ownerId: alice.id });
    const elsewhere = (await say(db, alice, other.id)).comment;
    const here = (await say(db, alice, noteId)).comment;
    for (const replyToId of ["nope", MISSING, elsewhere.id]) {
      await expectAbort(post(db, { noteId, actor: actorOf(alice), body: "x", replyToId }), 400, "invalid_comment");
    }
    expect((await post(db, { noteId, actor: actorOf(alice), body: "x", replyToId: here.id })).comment.replyToId).toBe(here.id);
  });
});

describe("notifications", () => {
  it("a mention notifies the person mentioned once, with the writer as actor", async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await personalScene(db);
    const out = await say(db, alice, noteId, "@bob look, @bob");
    expect(out.newNotificationUserIds).toEqual([bob.id]);
    expect(await notificationsOf(db)).toEqual([
      { userId: bob.id, agentLabel: null, kind: "mention", commentId: out.comment.id, actorId: alice.id, actorAgentLabel: null },
    ]);
    expect(await notifiedOf(db, out.comment.id)).toEqual([{ userId: bob.id, agentLabel: null }]);
  });

  it("a reply notifies the answered author (their agent when an agent wrote it), not when they can't read the note, not twice with a mention, not oneself", async () => {
    const { db } = await freshDb();
    const { alice, bob, carol, noteId } = await personalScene(db);
    const tokenId = await seedAgentToken(db, bob.id, { label: "claude" });
    const byBob = (await say(db, bob, noteId, "q")).comment;
    const byAgent = (await post(db, { noteId, actor: actorOf(bob, { tokenId, agentLabel: "claude" }), body: "q" })).comment;
    const byCarol = (await say(db, carol, noteId, "q")).comment;

    const r1 = await post(db, { noteId, actor: actorOf(alice), body: "answer", replyToId: byBob.id });
    const r2 = await post(db, { noteId, actor: actorOf(alice), body: "answer", replyToId: byAgent.id });
    const r3 = await post(db, { noteId, actor: actorOf(alice), body: "answer @bob", replyToId: byBob.id });
    const r4 = await post(db, { noteId, actor: actorOf(carol), body: "me again", replyToId: byCarol.id });
    await db.delete(noteShares).where(eq(noteShares.userId, carol.id));
    const r5 = await post(db, { noteId, actor: actorOf(alice), body: "answer", replyToId: byCarol.id });

    expect([r1, r2, r3, r4, r5].map(r => r.newNotificationUserIds)).toEqual([[bob.id], [bob.id], [bob.id], [], []]);
    const rows = await notificationsOf(db);
    expect(rows.map(r => [r.commentId, r.userId, r.agentLabel, r.kind])).toEqual([
      [r1.comment.id, bob.id, null, "reply"],
      [r2.comment.id, bob.id, "claude", "reply"],
      [r3.comment.id, bob.id, null, "mention"],
    ]);
  });

  it("never notifies the writer: a person's own handle and an agent's own label are skipped, a person mentioning their own agent and an agent mentioning its person are not", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await personalScene(db);
    const tokenId = await seedAgentToken(db, alice.id, { label: "claude" });
    const agent = actorOf(alice, { tokenId, agentLabel: "claude" });

    const own = await say(db, alice, noteId, "note to @alice");
    expect(await mentionsOf(db, own.comment.id)).toEqual([{ userId: alice.id, agentLabel: null, start: 8, length: 6 }]);
    expect(own.newNotificationUserIds).toEqual([]);
    const ownAgent = await post(db, { noteId, actor: agent, body: "@alice/claude self" });
    expect(ownAgent.newNotificationUserIds).toEqual([]);

    const toAgent = await say(db, alice, noteId, "@alice/claude please");
    const toPerson = await post(db, { noteId, actor: agent, body: "@alice done" });
    expect(await notificationsOf(db)).toEqual([
      { userId: alice.id, agentLabel: "claude", kind: "mention", commentId: toAgent.comment.id, actorId: alice.id, actorAgentLabel: null },
      { userId: alice.id, agentLabel: null, kind: "mention", commentId: toPerson.comment.id, actorId: alice.id, actorAgentLabel: "claude" },
    ]);
  });

  it("an edit notifies only targets never notified for the comment; removing a mention keeps the notification already sent", async () => {
    const { db } = await freshDb();
    const { alice, bob, carol, noteId } = await personalScene(db);
    const c = (await say(db, alice, noteId, "@bob")).comment;
    const e1 = await edit(db, { commentId: c.id, actor: actorOf(alice), body: "@bob and @carol" });
    expect(e1.newNotificationUserIds).toEqual([carol.id]);
    const e2 = await edit(db, { commentId: c.id, actor: actorOf(alice), body: "only @bob" });
    expect(e2.newNotificationUserIds).toEqual([]);
    const e3 = await edit(db, { commentId: c.id, actor: actorOf(alice), body: "@carol @bob again" });
    expect(e3.newNotificationUserIds).toEqual([]);
    expect((await notificationsOf(db)).map(r => r.userId)).toEqual([bob.id, carol.id]);
    expect(await mentionsOf(db, c.id)).toEqual([
      { userId: carol.id, agentLabel: null, start: 0, length: 6 },
      { userId: bob.id, agentLabel: null, start: 7, length: 4 },
    ]);
    await edit(db, { commentId: c.id, actor: actorOf(alice), body: "nobody" });
    expect(await mentionsOf(db, c.id)).toEqual([]);
    expect(await notificationsOf(db)).toHaveLength(2);
  });

  it("an edit doesn't notify the author of the answered comment", async () => {
    const { db } = await freshDb();
    const { alice, bob, noteId } = await personalScene(db);
    const q = (await say(db, bob, noteId, "q")).comment;
    const r = (await post(db, { noteId, actor: actorOf(alice), body: "a", replyToId: q.id })).comment;
    await db.delete(notifications);
    await db.delete(commentNotified);
    expect((await edit(db, { commentId: r.id, actor: actorOf(alice), body: "a2" })).newNotificationUserIds).toEqual([]);
  });

  it("deleting a comment deletes its mentions, notified rows and notifications", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await personalScene(db);
    const c = (await say(db, alice, noteId, "@bob @carol")).comment;
    const keep = (await say(db, alice, noteId, "@bob")).comment;
    await remove(db, { commentId: c.id, actor: actorOf(alice) });
    expect(await mentionsOf(db, c.id)).toEqual([]);
    expect(await notifiedOf(db, c.id)).toEqual([]);
    expect((await notificationsOf(db)).map(r => r.commentId)).toEqual([keep.id]);
  });
});

describe("races", () => {
  it("a move committed between the access read and the lock is 409 conflict for post, edit and delete, and nothing is written", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await personalScene(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const c = (await say(db, alice, noteId, "before")).comment;
    const moveAway = async (point: string) => {
      if (point !== "comment-authorized") return;
      await db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, noteId));
    };
    const reset = () => db.update(notes).set({ ownerId: alice.id, groupId: null }).where(eq(notes.id, noteId));

    await expectAbort(post(db, { noteId, actor: actorOf(alice), body: "@bob late" }, moveAway), 409, "conflict");
    await reset();
    await expectAbort(edit(db, { commentId: c.id, actor: actorOf(alice), body: "@bob late" }, moveAway), 409, "conflict");
    await reset();
    await expectAbort(remove(db, { commentId: c.id, actor: actorOf(alice) }, moveAway), 409, "conflict");
    expect((await db.select().from(noteComments)).map(r => r.body)).toEqual(["before"]);
    expect(await notificationsOf(db)).toEqual([]);
  });

  it("access lost between the access read and the lock (share removed, role without read) is checked again under the lock", async () => {
    const { db } = await freshDb();
    const { bob, noteId } = await personalScene(db);
    const c = (await say(db, bob, noteId, "mine")).comment;
    const unshare = async (point: string) => {
      if (point === "comment-authorized") await db.delete(noteShares).where(eq(noteShares.userId, bob.id));
    };
    await expectAbort(post(db, { noteId, actor: actorOf(bob), body: "late" }, unshare), 404, "not_found");
    await seedShare(db, noteId, bob.id, "editor");
    await expectAbort(edit(db, { commentId: c.id, actor: actorOf(bob), body: "late" }, unshare), 404, "comment_not_found");
    await seedShare(db, noteId, bob.id, "editor");
    await expectAbort(remove(db, { commentId: c.id, actor: actorOf(bob) }, unshare), 404, "comment_not_found");

    const dave = await seedNamedUser(db, "dave");
    const g = await seedGroup(db, "Garden", [{ userId: dave.id, role: "member" }]);
    const gn = await seedNote(db, { groupId: g.id });
    const blind = await seedRole(db, g.id, "blind", {});
    const demote = async (point: string) => {
      if (point === "comment-authorized") await db.update(groupMembers).set({ roleId: blind }).where(eq(groupMembers.userId, dave.id));
    };
    await expectAbort(post(db, { noteId: gn.id, actor: actorOf(dave), body: "late" }, demote), 404, "not_found");
    expect((await db.select().from(noteComments)).map(r => r.body)).toEqual(["mine"]);
  });

  it("a role change holding the group's row is seen by the access check after the group lock, for post and edit", async () => {
    const { db, pool } = await freshDb();
    const dave = await seedNamedUser(db, "dave");
    const g = await seedGroup(db, "Garden", [{ userId: dave.id, role: "member" }]);
    const gn = await seedNote(db, { groupId: g.id });
    const c = (await say(db, dave, gn.id, "mine")).comment;
    const blind = await seedRole(db, g.id, "blind", {});
    const member = (await db.select({ roleId: groupMembers.roleId }).from(groupMembers).where(eq(groupMembers.userId, dave.id)))[0]!.roleId;

    const holder: { pending?: Promise<unknown>; demotion?: Promise<string> } = {};
    const demoteUnderGroupLock = async (point: string) => {
      if (point !== "comment-authorized") return;
      const conn = await pool.connect();
      await conn.query("begin");
      await conn.query("select id from groups where id = $1 for update", [g.id]);
      await conn.query("update group_members set role_id = $1 where group_id = $2 and user_id = $3", [blind, g.id, dave.id]);
      holder.demotion = (async () => {
        try {
          const seen = await waitForBlockedOrSettled(pool, holder.pending!);
          await conn.query("commit");
          return seen;
        } finally {
          conn.release();
        }
      })();
    };

    holder.pending = post(db, { noteId: gn.id, actor: actorOf(dave), body: "late" }, demoteUnderGroupLock);
    await expectAbort(holder.pending, 404, "not_found");
    expect(await holder.demotion).toBe("blocked");

    await db.update(groupMembers).set({ roleId: member }).where(eq(groupMembers.userId, dave.id));
    holder.pending = edit(db, { commentId: c.id, actor: actorOf(dave), body: "late" }, demoteUnderGroupLock);
    await expectAbort(holder.pending, 404, "comment_not_found");
    expect(await holder.demotion).toBe("blocked");
    expect((await db.select().from(noteComments)).map(r => r.body)).toEqual(["mine"]);
  });

  it("a post waits for a move holding the note, then gets conflict; the retry checks the group's audience; a comment posted before a move that keeps history stays", async () => {
    const { db, pool } = await freshDb();
    const { alice, bob, noteId } = await personalScene(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const early = await say(db, alice, noteId, "early @bob");

    const seen: { pending?: Promise<unknown>; interleave?: string } = {};
    await db.transaction(tx =>
      moveNoteToGroupInTx(
        tx,
        { noteId, userId: alice.id, userHandle: alice.handle, groupId: g.id, folderId: null, lockTimeoutMs: 5000, keepHistory: true },
        async point => {
          if (point !== "note-move-locked") return;
          seen.pending = post(db, { noteId, actor: actorOf(alice), body: "racing @bob" }).catch((e: unknown) => e);
          seen.interleave = await waitForBlockedOrSettled(pool, seen.pending);
        },
      ),
    );
    expect(seen.interleave).toBe("blocked");
    await expectAbort(seen.pending!.then(e => Promise.reject(e)), 409, "conflict");

    const retry = await say(db, alice, noteId, "retry @bob");
    expect(await mentionsOf(db, retry.comment.id)).toEqual([]);
    expect(retry.newNotificationUserIds).toEqual([]);
    await expectAbort(say(db, bob, noteId), 404, "not_found");
    expect((await db.select().from(noteComments)).map(r => r.body).sort()).toEqual(["early @bob", "retry @bob"]);
    expect(await mentionsOf(db, early.comment.id)).toHaveLength(1);
  });

  it("an edit waits for a move holding the note, then gets conflict; a retry by a sharee who lost access is 404, by the owner resolves against the group", async () => {
    const { db, pool } = await freshDb();
    const { alice, bob, noteId } = await personalScene(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const mine = (await say(db, alice, noteId, "mine")).comment;
    const bobs = (await say(db, bob, noteId, "bobs")).comment;

    const seen: { pending?: Promise<unknown>; interleave?: string } = {};
    await db.transaction(tx =>
      moveNoteToGroupInTx(
        tx,
        { noteId, userId: alice.id, userHandle: alice.handle, groupId: g.id, folderId: null, lockTimeoutMs: 5000, keepHistory: true },
        async point => {
          if (point !== "note-move-locked") return;
          seen.pending = edit(db, { commentId: mine.id, actor: actorOf(alice), body: "mine @carol" }).catch((e: unknown) => e);
          seen.interleave = await waitForBlockedOrSettled(pool, seen.pending);
        },
      ),
    );
    expect(seen.interleave).toBe("blocked");
    await expectAbort(seen.pending!.then(e => Promise.reject(e)), 409, "conflict");

    await expectAbort(edit(db, { commentId: bobs.id, actor: actorOf(bob), body: "bobs 2" }), 404, "comment_not_found");
    const retry = await edit(db, { commentId: mine.id, actor: actorOf(alice), body: "mine @carol" });
    expect(retry.newNotificationUserIds).toEqual([]);
    expect(await mentionsOf(db, mine.id)).toEqual([]);
  });

  it("a post that holds the note while a move without keepHistory waits commits first and is then deleted with the note's other comments, mentions, notified rows and notifications", async () => {
    const { db, pool } = await freshDb();
    const { alice, bob, noteId } = await personalScene(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    await say(db, alice, noteId, "early @bob");

    const seen: { move?: Promise<unknown>; interleave?: string } = {};
    const out = await post(db, { noteId, actor: actorOf(alice), body: "racing @bob" }, async point => {
      if (point !== "comment-locked") return;
      seen.move = db.transaction(tx =>
        moveNoteToGroupInTx(tx, { noteId, userId: alice.id, userHandle: alice.handle, groupId: g.id, folderId: null, lockTimeoutMs: 5000, keepHistory: false }),
      );
      seen.interleave = await waitForBlockedOrSettled(pool, seen.move);
    });
    expect(seen.interleave).toBe("blocked");
    expect(out.newNotificationUserIds).toEqual([bob.id]);
    await seen.move;

    expect(await db.select().from(noteComments).where(eq(noteComments.noteId, noteId))).toEqual([]);
    expect(await db.select().from(noteCommentMentions)).toEqual([]);
    expect(await db.select().from(commentNotified)).toEqual([]);
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it("a write on a group note takes the group's row before the note's, so a group delete (group, then its notes, FOR UPDATE) waits for it without a deadlock", async () => {
    const { db, pool } = await freshDb();
    const alice = await seedNamedUser(db, "alice");
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id });
    const seen: { other?: Promise<string>; interleave?: string } = {};
    const out = await post(db, { noteId: n.id, actor: actorOf(alice), body: "hi" }, async point => {
      if (point !== "comment-locked") return;
      seen.other = (async () => {
        const c = await pool.connect();
        try {
          await c.query("begin");
          await c.query("select id from groups where id = $1 for update", [g.id]);
          await c.query("select id from notes where group_id = $1 for update", [g.id]);
          await c.query("commit");
          return "committed";
        } catch (err) {
          await c.query("rollback").catch(() => {});
          return `error ${(err as { code?: string }).code}`;
        } finally {
          c.release();
        }
      })();
      seen.interleave = await waitForBlockedOrSettled(pool, seen.other);
    });
    expect(seen.interleave).toBe("blocked");
    expect(out.comment.body).toBe("hi");
    expect(await seen.other!).toBe("committed");
  });
});

describe("the note itself", () => {
  it("post, edit and delete leave notes.updated_at and the rest of the note row unchanged", async () => {
    const { db, pool } = await freshDb();
    const { alice, bob, noteId } = await personalScene(db);
    const before = await noteState(pool, noteId);
    const c = (await say(db, bob, noteId, "@alice")).comment;
    await edit(db, { commentId: c.id, actor: actorOf(bob), body: "@alice!" });
    await remove(db, { commentId: c.id, actor: actorOf(alice) });
    expect(await noteState(pool, noteId)).toEqual(before);
  });

  it("created_at is the insert time, not the transaction start; notifications use the same clock", async () => {
    const { db } = await freshDb();
    const { alice, noteId } = await personalScene(db);
    const { started, comment } = await db.transaction(async tx => {
      const res = await tx.execute<{ t: string }>(sql`select now()::text as t`);
      await tx.execute(sql`select pg_sleep(0.3)`);
      const out = await postCommentInTx(tx, { noteId, actor: actorOf(alice), body: "@bob" });
      return { started: res.rows[0]!.t, comment: out.comment };
    });
    const [row] = (
      await db.execute<{ lag_ms: number; n_lag_ms: number }>(
        sql`select extract(epoch from (c.created_at - ${started}::timestamptz)) * 1000 as lag_ms,
                   extract(epoch from (n.created_at - ${started}::timestamptz)) * 1000 as n_lag_ms
              from note_comments c join notifications n on n.comment_id = c.id where c.id = ${comment.id}`,
      )
    ).rows;
    expect(Number(row!.lag_ms)).toBeGreaterThanOrEqual(300);
    expect(Number(row!.n_lag_ms)).toBeGreaterThanOrEqual(Number(row!.lag_ms));
  });
});

describe("large threads", () => {
  it("deleting a note with a thread of 2,000 comments, each with mentions and notifications, removes every row", async () => {
    const { db } = await freshDb();
    const { alice, bob, carol, noteId } = await personalScene(db);
    const keep = await seedNote(db, { ownerId: alice.id });
    await seedShare(db, keep.id, bob.id, "viewer");
    const kept = (await say(db, alice, keep.id, "@bob stays")).comment;
    await db.execute(sql`
      with c as (
        insert into note_comments (note_id, author_id, body)
        select ${noteId}::uuid, ${alice.id}::uuid, '@bob @carol #' || g from generate_series(1, 2000) g
        returning id
      ), m as (
        insert into note_comment_mentions (comment_id, user_id, start, length)
        select id, ${bob.id}::uuid, 0, 4 from c union all select id, ${carol.id}::uuid, 5, 6 from c
      ), d as (
        insert into comment_notified (comment_id, user_id)
        select id, ${bob.id}::uuid from c union all select id, ${carol.id}::uuid from c
      )
      insert into notifications (user_id, kind, note_id, comment_id, actor_id)
      select ${bob.id}::uuid, 'mention', ${noteId}::uuid, id, ${alice.id}::uuid from c
      union all select ${carol.id}::uuid, 'mention', ${noteId}::uuid, id, ${alice.id}::uuid from c
    `);
    const one = (await db.select({ id: noteComments.id }).from(noteComments).where(eq(noteComments.noteId, noteId)).limit(1))[0]!;
    await db.transaction(tx => deleteCommentInTx(tx, { commentId: one.id, actor: actorOf(alice) }));
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(notifications))[0]!.n).toBe(2 * 1999 + 1);

    await db.transaction(tx => deleteNotesInTx(tx, [noteId]));
    expect((await db.select({ id: noteComments.id }).from(noteComments)).map(r => r.id)).toEqual([kept.id]);
    expect(await db.select({ c: noteCommentMentions.commentId }).from(noteCommentMentions)).toEqual([{ c: kept.id }]);
    expect(await db.select({ c: commentNotified.commentId }).from(commentNotified)).toEqual([{ c: kept.id }]);
    expect((await notificationsOf(db)).map(r => r.commentId)).toEqual([kept.id]);
  });
});
