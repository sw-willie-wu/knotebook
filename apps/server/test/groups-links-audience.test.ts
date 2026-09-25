import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteLinks } from "../src/db/schema.js";
import { noopCollabHooks, type CollabHooks } from "../src/collab/hooks.js";
import { visibleNoteTitles } from "../src/notes/editing/candidates.js";
import { loadNoteAudience } from "../src/notes/service.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";

/** links 端點要 `linkSyncGate` 放行才會寫（比照 notes-links.test.ts：從 noop spread）。 */
const linksAllowed: CollabHooks = { ...noopCollabHooks, linkSyncGate: () => ({ ok: true as const, clock: 1 }) };

describe("#103 其餘可見性查詢的群組分支（spec §5.3–§5.5）", () => {
  it("visibleNoteTitles：成員看得到群組筆記的標題、非成員看不到；owner 兼成員時自己的群組筆記只出現一次（RF5）", async () => {
    const { db } = await buildTestApp();
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const stranger = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const note = await seedNote(db, owner.id, { title: "Group Doc", groupId: g.id });

    expect((await visibleNoteTitles(db, member.id)).filter(t => t.id === note.id)).toEqual([{ id: note.id, title: "Group Doc" }]);
    expect((await visibleNoteTitles(db, stranger.id)).map(t => t.id)).not.toContain(note.id);
    expect((await visibleNoteTitles(db, owner.id)).filter(t => t.id === note.id)).toHaveLength(1);
  });

  it("loadNoteAudience：含 owner、逐人分享、群組全體成員；不含非成員", async () => {
    const { db } = await buildTestApp();
    const owner = await seedUser(db);
    const m1 = await seedUser(db);
    const m2 = await seedUser(db);
    const stranger = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: m1.id, role: "admin" }, { userId: m2.id, role: "member" }]);
    const note = await seedNote(db, owner.id, { groupId: g.id });

    const audience = await loadNoteAudience(db, note.id);
    expect([...audience].sort()).toEqual([owner.id, m1.id, m2.id].sort());
    expect(audience.has(stranger.id)).toBe(false);
  });

  it("attemptOnce（POST …/links）：成員在自己的筆記寫 [[群組筆記]] 會寫進 note_links；非成員提交同一個 target 被靜默丟棄", async () => {
    const { app, db } = await buildTestApp({ collabHooks: linksAllowed });
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const stranger = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const target = await seedNote(db, owner.id, { groupId: g.id });
    const memberSource = await seedNote(db, member.id);
    const strangerSource = await seedNote(db, stranger.id);

    const ok = await app.inject({ method: "POST", url: `/api/notes/${memberSource.id}/links`, cookies: await cookieOf(member.id), payload: { link_target_ids: [target.id] } });
    expect(ok.statusCode).toBe(204);
    const dropped = await app.inject({ method: "POST", url: `/api/notes/${strangerSource.id}/links`, cookies: await cookieOf(stranger.id), payload: { link_target_ids: [target.id] } });
    expect(dropped.statusCode).toBe(204);

    const rowsOf = async (source: string) =>
      (await db.select({ t: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, source))).map(r => r.t);
    expect(await rowsOf(memberSource.id)).toEqual([target.id]);
    expect(await rowsOf(strangerSource.id)).toEqual([]);
  });

  it("fetchBacklinks：群組筆記連到我的筆記 → 成員看得到那條反向連結；只是我這篇的 viewer（非成員）看不到", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const member = await seedUser(db);
    const viewer = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const target = await seedNote(db, member.id, { title: "Mine" });
    await seedShare(db, target.id, viewer.id, "viewer");
    const source = await seedNote(db, owner.id, { title: "Group Source", groupId: g.id });
    await db.insert(noteLinks).values({ sourceNoteId: source.id, targetNoteId: target.id });

    const asMember = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, cookies: await cookieOf(member.id) });
    expect(asMember.statusCode).toBe(200);
    expect((asMember.json().backlinks as Array<{ id: string }>).map(b => b.id)).toEqual([source.id]);
    const asViewer = await app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, cookies: await cookieOf(viewer.id) });
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.json().backlinks).toEqual([]);
  });
});
