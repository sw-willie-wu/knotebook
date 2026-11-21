// Tags through the file path: the `tags` front matter line, who may change it, and what the reply says when the body was written but the tags were not.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { TAGS_PER_NOTE_MAX, TAGS_PER_SPACE_MAX } from "@knotebook/shared";
import { noteAiEdits, noteTags, notes, tags, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { loadNoteTagNames } from "../src/tags/queries.js";
import { TAGS_FRONT_MATTER_MESSAGE } from "../src/transfer/note-tags-format.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, sleep, waitForBlockedOrSettled } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, issueBulkDirect, liveMarkdown, seedMd, seedNoteTags, setTagsLine } from "./bulk-transfer-helpers.js";
import { inject } from "./trash-helpers.js";

type Opts = Parameters<typeof buildCollabTestApp>[0];
const PARAS = "Para 0\n\nPara 1\n\nPara 2";
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string; reason?: string } }).error;
const tagNames = (ctx: CollabTestCtx, noteId: string) => loadNoteTagNames(ctx.db, noteId);
const edits = (ctx: CollabTestCtx, noteId: string) => ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId));

/** Takes the space to the per-space limit with other tags, the way a burst of other writers could between the checks and the write. */
async function fillSpace(ctx: CollabTestCtx, ownerId: string): Promise<void> {
  const [{ n }] = (await ctx.db.$client.query<{ n: number }>("select count(*)::int as n from tags where owner_id = $1", [ownerId])).rows as [{ n: number }];
  const rows = Array.from({ length: TAGS_PER_SPACE_MAX - n }, (_, i) => ({ ownerId, name: `race${i}`, color: "blue" as const }));
  for (let i = 0; i < rows.length; i += 200) await ctx.db.insert(tags).values(rows.slice(i, i + 200));
}

async function scene(opts: Opts = {}, initialTags: string[] = ["a", "b"]) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  await seedMd(ctx.db, note.id, PARAS);
  if (initialTags.length > 0) await seedNoteTags(ctx.db, note.id, initialTags, u.id);
  const dl = () => downloadNote(ctx.app, bulk.token, note.id);
  const put = (text: string) => bulkPut(ctx.app, bulk.token, text);
  return { ctx, u, pat, bulk, note, dl, put };
}

describe("changing the tags line", () => {
  it("sets the note's tags, creating new names in the note's space; tagsChanged true, result tagged, no AI edit row", async () => {
    const s = await scene();
    const d = await s.dl();
    const r = await s.put(setTagsLine(d.text, '["a", "NewOne", "b"]'));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: s.note.id, created: false, result: "tagged", applied: 0, renamed: false, tagsChanged: true, base: null });
    expect(r.json()).not.toHaveProperty("tagsFailed");
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "b", "NewOne"]);
    const [row] = await s.ctx.db.select().from(tags).where(eq(tags.nameKey, "newone"));
    expect(row).toMatchObject({ ownerId: s.u.id, groupId: null, createdBy: s.u.id });
    expect(await edits(s.ctx, s.note.id)).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("sending the same file again is unchanged; a file with the tags only reordered or recased changes nothing", async () => {
    const s = await scene();
    const d = await s.dl();
    expect((await s.put(setTagsLine(d.text, '["a", "b", "c"]'))).json()).toMatchObject({ result: "tagged", tagsChanged: true });
    const again = await s.put(setTagsLine(d.text, '["a", "b", "c"]'));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ result: "unchanged", tagsChanged: false });
    const d2 = await s.dl();
    const reordered = await s.put(setTagsLine(d2.text, '["C", "B", "a", "A"]'));
    expect(reordered.json()).toMatchObject({ result: "unchanged", tagsChanged: false });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "b", "c"]);
    await s.ctx.destroy();
  });

  it("a file without a tags line leaves the tags alone", async () => {
    const s = await scene();
    const d = await s.dl();
    const r = await s.put(editBody(setTagsLine(d.text, undefined), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1, tagsChanged: false });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "b"]);
    await s.ctx.destroy();
  });

  it("tags: [] removes every tag", async () => {
    const s = await scene();
    const d = await s.dl();
    const r = await s.put(setTagsLine(d.text, "[]"));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "tagged", tagsChanged: true });
    expect(await tagNames(s.ctx, s.note.id)).toEqual([]);
    await s.ctx.destroy();
  });

  it("a tags value that isn't a JSON array of strings is 400 invalid_body with the fixed message and nothing is written", async () => {
    const s = await scene();
    const d = await s.dl();
    const before = await liveMarkdown(s.ctx, s.note.id);
    const r = await s.put(editBody(setTagsLine(d.text, "a, b"), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode).toBe(400);
    expect(errOf(r)).toEqual({ code: "invalid_body", message: TAGS_FRONT_MATTER_MESSAGE });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "b"]);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    await s.ctx.destroy();
  });

  it("body and tags changed together: both are written, one AI edit row for the body", async () => {
    const s = await scene();
    const d = await s.dl();
    const r = await s.put(editBody(setTagsLine(d.text, '["z"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1, tagsChanged: true });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["z"]);
    expect(await liveMarkdown(s.ctx, s.note.id)).toContain("Para 1 new");
    expect(await edits(s.ctx, s.note.id)).toHaveLength(1);
    await s.ctx.destroy();
  });

  it("tags changes add no note_ai_edits row", async () => {
    const s = await scene();
    const d = await s.dl();
    await s.put(setTagsLine(d.text, '["q"]'));
    expect(await edits(s.ctx, s.note.id)).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("a file whose body starts with #todo #urgent keeps that line as paragraph text and leaves the note's tags as the tags line says", async () => {
    const s = await scene();
    const d = await s.dl();
    const r = await s.put(editBody(d.text, b => `#todo #urgent\n\n${b}`));
    expect(r.statusCode, r.body).toBe(200);
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "b"]);
    expect(await liveMarkdown(s.ctx, s.note.id)).toContain("#todo #urgent");
    await s.ctx.destroy();
  });
});

describe("someone changed the tags after the download", () => {
  it("a file that changes only the body keeps their tags", async () => {
    const s = await scene();
    const d = await s.dl();
    await seedNoteTags(s.ctx.db, s.note.id, ["a", "web"], s.u.id);
    const r = await s.put(editBody(d.text, b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", tagsChanged: false });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "web"]);
    await s.ctx.destroy();
  });

  it("a file that changes the tags is 409 note_changed and nothing is written", async () => {
    const s = await scene();
    const d = await s.dl();
    await seedNoteTags(s.ctx.db, s.note.id, ["a", "web"], s.u.id);
    const before = await liveMarkdown(s.ctx, s.note.id);
    const r = await s.put(editBody(setTagsLine(d.text, '["mine"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(409);
    expect(errOf(r)).toMatchObject({ code: "base_unavailable", reason: "note_changed" });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "web"]);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    await s.ctx.destroy();
  });

  it("tags changed between the checks and the tags transaction give tagsFailed changed_meanwhile, leave their tags, and keep the body", async () => {
    let fire: (() => Promise<void>) | null = null;
    const s = await scene({ editingTestHooks: { afterTagsLock: async () => { await fire?.(); } } });
    const d = await s.dl();
    fire = async () => { await seedNoteTags(s.ctx.db, s.note.id, ["a", "web"], s.u.id); };
    const r = await s.put(editBody(setTagsLine(d.text, '["mine"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", tagsChanged: false, tagsFailed: "changed_meanwhile" });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "web"]);
    expect(await liveMarkdown(s.ctx, s.note.id)).toContain("Para 1 new");
    await s.ctx.destroy();
  });

  it("a tags-only file that loses the same race is 409 note_changed", async () => {
    let fire: (() => Promise<void>) | null = null;
    const s = await scene({ editingTestHooks: { afterTagsLock: async () => { await fire?.(); } } });
    const d = await s.dl();
    fire = async () => { await seedNoteTags(s.ctx.db, s.note.id, ["a", "web"], s.u.id); };
    const r = await s.put(setTagsLine(d.text, '["mine"]'));
    expect(r.statusCode, r.body).toBe(409);
    expect(errOf(r)).toMatchObject({ code: "base_unavailable", reason: "note_changed" });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "web"]);
    await s.ctx.destroy();
  });
});

describe("who may change the tags", () => {
  async function shared(opts: Opts = {}) {
    const ctx = await buildCollabTestApp(opts);
    const owner = await seedUser(ctx.db);
    const editor = await seedUser(ctx.db);
    const note = await seedNote(ctx.db, { ownerId: owner.id }, { title: "Shared" });
    await seedMd(ctx.db, note.id, PARAS);
    await seedNoteTags(ctx.db, note.id, ["a"], owner.id);
    await seedShare(ctx.db, note.id, editor.id, "editor");
    const pat = await seedTokenForUser(ctx.db, editor.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    return { ctx, owner, editor, note, bulk };
  }

  it("an edit share writing back a body change with the tags line unchanged succeeds; changing the tags is 403 and nothing is written", async () => {
    const s = await shared();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.fm.tags).toBe('["a"]');
    const ok = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Para 1 new")));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ result: "applied", tagsChanged: false });
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const before = await liveMarkdown(s.ctx, s.note.id);
    const no = await bulkPut(s.ctx.app, s.bulk.token, editBody(setTagsLine(d2.text, '["a", "mine"]'), b => b.replace("Para 2", "Para 2 new")));
    expect(no.statusCode, no.body).toBe(403);
    expect(errOf(no)).toEqual({
      code: "forbidden",
      message: "You can't change this note's tags: that needs edit rights in the note's own space, not through a share. Leave the tags line as it was downloaded, or take it out.",
    });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a"]);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    expect(await s.ctx.db.select().from(tags).where(eq(tags.ownerId, s.editor.id))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("an edit share sees the owner's tags in the file but can't create a tag in the owner's space or its own", async () => {
    const s = await shared();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.fm.tags).toBe('["a"]');
    const no = await bulkPut(s.ctx.app, s.bulk.token, setTagsLine(d.text, '["a", "intruder"]'));
    expect(no.statusCode).toBe(403);
    expect((await s.ctx.db.select().from(tags).where(eq(tags.nameKey, "intruder")))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("a group member who can edit the group's notes can change the tags, in the group's space", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const note = await seedNote(ctx.db, { groupId: g.id }, { title: "GN" });
    await seedMd(ctx.db, note.id, PARAS);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const d = await downloadNote(ctx.app, bulk.token, note.id);
    const r = await bulkPut(ctx.app, bulk.token, setTagsLine(d.text, '["team"]'));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "tagged", tagsChanged: true });
    const [row] = await ctx.db.select().from(tags).where(eq(tags.nameKey, "team"));
    expect(row).toMatchObject({ groupId: g.id, ownerId: null });
    await ctx.destroy();
  });

  it("a group member whose role can't edit gets the same 403 as before, tags line or not", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const note = await seedNote(ctx.db, { groupId: g.id }, { title: "GN" });
    await seedMd(ctx.db, note.id, PARAS);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const d = await downloadNote(ctx.app, bulk.token, note.id);
    await setMemberRole(ctx.db, g.id, u.id, await seedRole(ctx.db, g.id, "viewer", { canRead: true }));
    const r = await bulkPut(ctx.app, bulk.token, setTagsLine(d.text, '["team"]'));
    expect(r.statusCode).toBe(403);
    await ctx.destroy();
  });
});

describe("checks that run before anything is written", () => {
  it("an invalid name is 400 invalid_tag_name and more than 50 distinct names is 409 tag_limit_reached; the body change in the same file is not written", async () => {
    const s = await scene();
    const d = await s.dl();
    const before = await liveMarkdown(s.ctx, s.note.id);
    const bad = await s.put(editBody(setTagsLine(d.text, '["ok", "   "]'), b => b.replace("Para 1", "Para 1 new")));
    expect(bad.statusCode, bad.body).toBe(400);
    expect(errOf(bad).code).toBe("invalid_tag_name");
    const many = Array.from({ length: TAGS_PER_NOTE_MAX + 1 }, (_, i) => `t${i}`);
    const over = await s.put(editBody(setTagsLine(d.text, JSON.stringify(many)), b => b.replace("Para 1", "Para 1 new")));
    expect(over.statusCode, over.body).toBe(409);
    expect(errOf(over)).toMatchObject({ code: "tag_limit_reached", message: "This note already has the most tags allowed (50)." });
    const dup = await s.put(setTagsLine(d.text, JSON.stringify([...many.slice(0, 50), "T0", "t1"])));
    expect(dup.statusCode, dup.body).toBe(200);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    expect(await tagNames(s.ctx, s.note.id)).toHaveLength(50);
    await s.ctx.destroy();
  });

  it("new names that would take the space past TAGS_PER_SPACE_MAX are 409 tag_limit_reached before anything is written", async () => {
    const s = await scene({}, ["a"]);
    const filler = Array.from({ length: TAGS_PER_SPACE_MAX - 2 }, (_, i) => ({ ownerId: s.u.id, name: `fill${i}`, color: "blue" as const }));
    for (let i = 0; i < filler.length; i += 200) await s.ctx.db.insert(tags).values(filler.slice(i, i + 200));
    const d = await s.dl();
    const before = await liveMarkdown(s.ctx, s.note.id);
    const over = await s.put(editBody(setTagsLine(d.text, '["a", "new1", "new2"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(over.statusCode, over.body).toBe(409);
    expect(errOf(over)).toMatchObject({ code: "tag_limit_reached", message: "This space already has the most tags allowed (1000)." });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    const ok = await s.put(setTagsLine(d.text, '["a", "new1"]'));
    expect(ok.statusCode, ok.body).toBe(200);
    await s.ctx.destroy();
  });

  it("a copy whose body was already sent can't change the tags (already_sent)", async () => {
    const s = await scene();
    const d = await s.dl();
    const first = editBody(d.text, b => b.replace("Para 1", "Para 1 new"));
    expect((await s.put(first)).statusCode).toBe(200);
    const r = await s.put(setTagsLine(first, '["a", "b", "late"]'));
    expect(r.statusCode, r.body).toBe(409);
    expect(errOf(r)).toMatchObject({ code: "base_unavailable", reason: "already_sent" });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "b"]);
    await s.ctx.destroy();
  });

  it("a tags-only change is charged to the write budget: past the limit it is 429, and an unchanged file isn't charged", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d1 = await s.dl();
    expect((await s.put(d1.text)).json()).toMatchObject({ result: "unchanged" });
    expect((await s.put(setTagsLine(d1.text, '["x"]'))).statusCode).toBe(200);
    const d2 = await s.dl();
    const r = await s.put(setTagsLine(d2.text, '["y"]'));
    expect(r.statusCode, r.body).toBe(429);
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["x"]);
    await s.ctx.destroy();
  });

  it("a base from before the upgrade (tags_sha null): an unchanged tags line matching the note changes nothing; a different one sets them", async () => {
    const s = await scene();
    const d = await s.dl();
    await s.ctx.db.update(transferBases).set({ tagsSha: null }).where(eq(transferBases.key, d.fm.base!));
    const same = await s.put(d.text);
    expect(same.json()).toMatchObject({ result: "unchanged", tagsChanged: false });
    const diff = await s.put(setTagsLine(d.text, '["a", "b", "c"]'));
    expect(diff.statusCode, diff.body).toBe(200);
    expect(diff.json()).toMatchObject({ result: "tagged", tagsChanged: true });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "b", "c"]);
    await s.ctx.destroy();
  });

  it("with a base from before the upgrade, a body-only file keeps tags a person changed after the download only when the file's line matches the note's tags now", async () => {
    const s = await scene();
    const d = await s.dl();
    await s.ctx.db.update(transferBases).set({ tagsSha: null }).where(eq(transferBases.key, d.fm.base!));
    await seedNoteTags(s.ctx.db, s.note.id, ["a", "web"], s.u.id);
    const r = await s.put(editBody(setTagsLine(d.text, undefined), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "web"]);
    await s.ctx.destroy();
  });
});

describe("the body was written and the tags step failed", () => {
  it("a move into a group right before the tags step gives 200 with tagsFailed conflict and the body written", async () => {
    let moveIt: (() => Promise<void>) | null = null;
    const s = await scene({ editingTestHooks: { beforeTags: async () => { await moveIt?.(); } } });
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    const d = await s.dl();
    moveIt = async () => {
      const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/move`, cookies: await cookieOf(s.u.id), payload: { groupId: g.id } });
      expect(res.statusCode, res.body).toBe(200);
    };
    const r = await s.put(editBody(setTagsLine(d.text, '["z"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", tagsChanged: false, tagsFailed: "conflict" });
    expect(await liveMarkdown(s.ctx, s.note.id)).toContain("Para 1 new");
    expect(await s.ctx.db.select().from(tags).where(eq(tags.nameKey, "z"))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("a tags-only file whose note moved right before the tags step is 409 conflict and writes nothing", async () => {
    let moveIt: (() => Promise<void>) | null = null;
    const s = await scene({ editingTestHooks: { beforeTags: async () => { await moveIt?.(); } } });
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    const d = await s.dl();
    moveIt = async () => {
      await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/move`, cookies: await cookieOf(s.u.id), payload: { groupId: g.id } });
    };
    const r = await s.put(setTagsLine(d.text, '["z"]'));
    expect(r.statusCode, r.body).toBe(409);
    expect(errOf(r)).toEqual({ code: "conflict", message: "The note moved to another space while the file was being sent, so its tags were not changed. Fetch the note again." });
    await s.ctx.destroy();
  });

  it("a database error in the tags transaction after the body was written gives 200 with tagsFailed failed, not 500", async () => {
    let boom = false;
    const s = await scene({ editingTestHooks: { afterTagsLock: async () => { if (boom) throw Object.assign(new Error("boom"), { code: "XX000" }); } } });
    const d = await s.dl();
    boom = true;
    const r = await s.put(editBody(setTagsLine(d.text, '["z"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", tagsChanged: false, tagsFailed: "failed" });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a", "b"]);
    await s.ctx.destroy();
  });

  it("the same error on a tags-only file is a 500 that carries no detail", async () => {
    let boom = false;
    const s = await scene({ editingTestHooks: { afterTagsLock: async () => { if (boom) throw Object.assign(new Error("secret-detail"), { code: "XX000" }); } } });
    const d = await s.dl();
    boom = true;
    const r = await s.put(setTagsLine(d.text, '["z"]'));
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("secret-detail");
    await s.ctx.destroy();
  });

  it("the space filled up in the moment before the tags were written: tagsFailed tag_limit_reached with the body, 409 tag_limit_reached without", async () => {
    let fill = false;
    const s = await scene({ editingTestHooks: { afterTagsLock: async () => { if (fill) await fillSpace(s.ctx, s.u.id); } } }, ["a"]);
    const d = await s.dl();
    fill = true;
    const withBody = await s.put(editBody(setTagsLine(d.text, '["a", "fresh"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(withBody.statusCode, withBody.body).toBe(200);
    expect(withBody.json()).toMatchObject({ result: "applied", tagsChanged: false, tagsFailed: "tag_limit_reached" });
    const d2 = await s.dl();
    const only = await s.put(setTagsLine(d2.text, '["a", "fresh2"]'));
    expect(only.statusCode, only.body).toBe(409);
    expect(errOf(only)).toMatchObject({ code: "tag_limit_reached" });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["a"]);
    await s.ctx.destroy();
  });

  it("a tags-only file whose note was trashed right before the tags step is 404 not_found", async () => {
    let trash: (() => Promise<void>) | null = null;
    const s = await scene({ editingTestHooks: { beforeTags: async () => { await trash?.(); } } });
    const d = await s.dl();
    trash = async () => { await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, s.note.id)); };
    const r = await s.put(setTagsLine(d.text, '["z"]'));
    expect(r.statusCode, r.body).toBe(404);
    expect(errOf(r).code).toBe("not_found");
    await s.ctx.destroy();
  });

  it("the note trashed right before the tags step: tagsFailed not_found when the body was written", async () => {
    let trash: (() => Promise<void>) | null = null;
    const s = await scene({ editingTestHooks: { beforeTags: async () => { await trash?.(); } } });
    const d = await s.dl();
    trash = async () => { await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, s.note.id)); };
    const r = await s.put(editBody(setTagsLine(d.text, '["z"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ tagsChanged: false, tagsFailed: "not_found" });
    await s.ctx.destroy();
  });
});

describe("what a revert does", () => {
  it("reverting the file_sync rows restores the body and leaves the tags as the file set them", async () => {
    const s = await scene();
    const d = await s.dl();
    const before = await liveMarkdown(s.ctx, s.note.id);
    const r = await s.put(editBody(setTagsLine(d.text, '["z"]'), b => b.replace("Para 1", "Para 1 new")));
    const ids = r.json().editIds as string[];
    expect(ids).toHaveLength(1);
    const rev = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${ids[0]}/revert`, headers: bearer(s.pat.token) });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(before);
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["z"]);
    await s.ctx.destroy();
  });
});

describe("a new-note file with tags", () => {
  const NEW = (tagsLine: string | undefined, body = "hello") => `---\nknotebook: 1\ntitle: "Fresh"\n${tagsLine === undefined ? "" : `${tagsLine}\n`}---\n${body}\n`;

  it("creates the note with them, in the creator's space", async () => {
    const s = await scene();
    const r = await s.put(NEW('tags: ["x", "Y"]'));
    expect(r.statusCode, r.body).toBe(201);
    expect(await tagNames(s.ctx, r.json().id as string)).toEqual(["x", "Y"]);
    const [row] = await s.ctx.db.select().from(tags).where(eq(tags.nameKey, "x"));
    expect(row).toMatchObject({ ownerId: s.u.id, groupId: null });
    await s.ctx.destroy();
  });

  it("in a group where the role can create but not edit it is 403 and no note is left", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    await setMemberRole(ctx.db, g.id, u.id, await seedRole(ctx.db, g.id, "creator", { canRead: true, canCreate: true }));
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write", range: { kind: "group", groupId: g.id } });
    const before = (await ctx.db.select({ id: notes.id }).from(notes)).length;
    const r = await bulkPut(ctx.app, bulk.token, NEW('tags: ["x"]'));
    expect(r.statusCode, r.body).toBe(403);
    expect(errOf(r).code).toBe("forbidden");
    expect((await ctx.db.select({ id: notes.id }).from(notes)).length).toBe(before);
    expect(await ctx.db.select().from(tags)).toHaveLength(0);
    const plain = await bulkPut(ctx.app, bulk.token, NEW(undefined));
    expect(plain.statusCode, plain.body).toBe(201);
    await ctx.destroy();
  });

  it("an invalid name is 400 invalid_tag_name and creates no note", async () => {
    const s = await scene();
    const before = (await s.ctx.db.select({ id: notes.id }).from(notes)).length;
    const r = await s.put(NEW('tags: ["  "]'));
    expect(r.statusCode, r.body).toBe(400);
    expect(errOf(r).code).toBe("invalid_tag_name");
    expect((await s.ctx.db.select({ id: notes.id }).from(notes)).length).toBe(before);
    await s.ctx.destroy();
  });

  it("a file whose content fails to apply leaves neither the note nor note_tags rows", async () => {
    let fail = false;
    const s = await scene({ editingTestHooks: { beforeMerge: async () => { if (fail) throw new Error("apply failed"); } } });
    const notesBefore = (await s.ctx.db.select({ id: notes.id }).from(notes)).length;
    const linksBefore = (await s.ctx.db.select().from(noteTags)).length;
    fail = true;
    const r = await s.put(NEW('tags: ["x"]'));
    expect(r.statusCode).toBe(500);
    expect((await s.ctx.db.select({ id: notes.id }).from(notes)).length).toBe(notesBefore);
    expect((await s.ctx.db.select().from(noteTags)).length).toBe(linksBefore);
    await s.ctx.destroy();
  });

  it("a file whose comment says outdated without superseded_by is 400 invalid_knowledge naming the heading and creates no note", async () => {
    const s = await scene();
    const before = (await s.ctx.db.select({ id: notes.id }).from(notes)).length;
    const r = await s.put(NEW('tags: ["x"]', "## Old way\n<!-- knotebook:knowledge\nwhen: w\nstatus: outdated\n-->\n\nx"));
    expect(r.statusCode, r.body).toBe(400);
    expect(errOf(r).code).toBe("invalid_knowledge");
    expect(errOf(r).message).toContain('"Old way"');
    expect((await s.ctx.db.select({ id: notes.id }).from(notes)).length).toBe(before);
    expect(await s.ctx.db.select().from(tags).where(eq(tags.nameKey, "x"))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("an identical file sent again returns the note it created and doesn't touch its tags", async () => {
    const s = await scene();
    const file = NEW('tags: ["x"]');
    const first = await s.put(file);
    const again = await s.put(file);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, created: false, result: "unchanged" });
    await s.ctx.destroy();
  });
});

describe("lock order against other writers of the same tags", () => {
  it("a tag merge that starts while the write-back holds the tag rows waits for it; both finish without a deadlock and the merge sees the file's tags", async () => {
    let gate: Promise<void> | null = null;
    let release!: () => void;
    let reached!: () => void;
    const reachedP = new Promise<void>(r => { reached = r; });
    const s = await scene({ editingTestHooks: { afterTagsWrite: async () => { if (gate) { reached(); await gate; } } } }, ["a", "b"]);
    const d = await s.dl();
    gate = new Promise<void>(r => { release = r; });
    const put = s.put(setTagsLine(d.text, '["a", "b", "c"]'));
    await reachedP;
    const [a] = await s.ctx.db.select({ id: tags.id }).from(tags).where(eq(tags.nameKey, "a"));
    const [b] = await s.ctx.db.select({ id: tags.id }).from(tags).where(eq(tags.nameKey, "b"));
    const merge = inject(s.ctx.app, "POST", `/api/tags/${a!.id}/merge`, s.u.id, { into: b!.id });
    expect(await waitForBlockedOrSettled(s.ctx.db.$client, merge)).toBe("blocked");
    release();
    const [pr, mr] = await Promise.all([put, merge]);
    expect(pr.statusCode, pr.body).toBe(200);
    expect(mr.statusCode, mr.body).toBe(200);
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["b", "c"]);
    await s.ctx.destroy();
  });

  it("a tag merge that commits while the write-back holds only the note lock makes the write-back report changed_meanwhile and leaves the merge's result", async () => {
    let fire: (() => Promise<void>) | null = null;
    const s = await scene({ editingTestHooks: { afterTagsLock: async () => { await fire?.(); } } }, ["a", "b"]);
    const d = await s.dl();
    fire = async () => {
      const [a] = await s.ctx.db.select({ id: tags.id }).from(tags).where(eq(tags.nameKey, "a"));
      const [b] = await s.ctx.db.select({ id: tags.id }).from(tags).where(eq(tags.nameKey, "b"));
      const res = await inject(s.ctx.app, "POST", `/api/tags/${a!.id}/merge`, s.u.id, { into: b!.id });
      expect(res.statusCode, res.body).toBe(200);
    };
    const r = await s.put(editBody(setTagsLine(d.text, '["a", "b", "c"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", tagsChanged: false, tagsFailed: "changed_meanwhile" });
    expect(await tagNames(s.ctx, s.note.id)).toEqual(["b"]);
    await s.ctx.destroy();
  });

  it("a note move that holds the note row FOR UPDATE makes the tags step wait, and after it commits the write-back reports conflict", async () => {
    let hold: (() => Promise<void>) | null = null;
    const s = await scene({ editingTestHooks: { beforeTags: async () => { await hold?.(); } } });
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    const d = await s.dl();
    const pool = s.ctx.db.$client;
    const raw = await pool.connect();
    hold = async () => {
      await raw.query("begin");
      await raw.query("select id from notes where id = $1 for update", [s.note.id]);
    };
    const put = s.put(editBody(setTagsLine(d.text, '["z"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(await waitForBlockedOrSettled(pool, put)).toBe("blocked");
    await raw.query("update notes set owner_id = null, group_id = $2 where id = $1", [s.note.id, g.id]);
    await raw.query("commit");
    raw.release();
    const r = await put;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ tagsChanged: false, tagsFailed: "conflict" });
    await s.ctx.destroy();
  });

  it("a group delete that holds the group row FOR UPDATE makes the tags step wait before it takes the note lock, and the write-back then finds the note gone", async () => {
    let hold: (() => Promise<void>) | null = null;
    const ctx = await buildCollabTestApp({ editingTestHooks: { beforeTags: async () => { await hold?.(); } } });
    const u = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "admin" }]);
    const note = await seedNote(ctx.db, { groupId: g.id }, { title: "GN" });
    await seedMd(ctx.db, note.id, PARAS);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const d = await downloadNote(ctx.app, bulk.token, note.id);
    const pool = ctx.db.$client;
    const raw = await pool.connect();
    hold = async () => {
      await raw.query("begin");
      await raw.query("select id from groups where id = $1 for update", [g.id]);
    };
    const put = bulkPut(ctx.app, bulk.token, editBody(setTagsLine(d.text, '["z"]'), b => b.replace("Para 1", "Para 1 new")));
    expect(await waitForBlockedOrSettled(pool, put)).toBe("blocked");
    const held = await raw.query("select 1 from notes where id = $1 for update nowait", [note.id]);
    expect(held.rowCount).toBe(1);
    await raw.query("delete from notes where id = $1", [note.id]);
    await raw.query("commit");
    raw.release();
    const r = await put;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ tagsChanged: false, tagsFailed: "not_found" });
    await sleep(0);
    expect(await ctx.db.select().from(noteTags).where(and(eq(noteTags.noteId, note.id)))).toHaveLength(0);
    await ctx.destroy();
  });
});
