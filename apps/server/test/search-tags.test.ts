import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NoteSearchResultDto } from "@knotebook/shared";
import { noteTags, tags } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, seedGroup, seedShare, seedUser } from "./group-helpers.js";
import { seedIndexedNote } from "./search-helpers.js";

type Auth = { cookies: Record<string, string> };
const asUser = async (userId: string): Promise<Auth> => ({ cookies: await cookieOf(userId) });
const get = (app: FastifyInstance, auth: Auth, qs: string) => app.inject({ method: "GET", url: `/api/search${qs}`, ...auth });
async function ok(app: FastifyInstance, auth: Auth, qs: string): Promise<NoteSearchResultDto> {
  const res = await get(app, auth, qs);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NoteSearchResultDto;
}
const idsOf = (r: NoteSearchResultDto) => r.hits.map((h) => h.note.id).sort();
const blocks = [{ id: "p", text: "needle in the body" }];

async function seedTag(db: Db, space: { ownerId: string } | { groupId: string }, name: string): Promise<string> {
  const [row] = await db.insert(tags).values({ ...space, name, color: "blue" }).returning({ id: tags.id });
  return row!.id;
}
const attach = async (db: Db, noteId: string, ...tagIds: string[]) => {
  await db.insert(noteTags).values(tagIds.map((tagId) => ({ noteId, tagId })));
};

describe("GET /api/search?tags=", () => {
  it("tags=a,b keeps only notes having both, with match=all and match=body", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const auth = await asUser(alice.id);
    const [a, b] = [await seedTag(db, { ownerId: alice.id }, "a"), await seedTag(db, { ownerId: alice.id }, "b")];
    const both = await seedIndexedNote(db, { ownerId: alice.id }, "both", blocks);
    const onlyA = await seedIndexedNote(db, { ownerId: alice.id }, "only a", blocks);
    const none = await seedIndexedNote(db, { ownerId: alice.id }, "none", blocks);
    await attach(db, both.id, a, b);
    await attach(db, onlyA.id, a);

    expect(idsOf(await ok(app, auth, "?q=needle"))).toEqual([both.id, onlyA.id, none.id].sort());
    expect(idsOf(await ok(app, auth, `?q=needle&tags=${a}`))).toEqual([both.id, onlyA.id].sort());
    expect(idsOf(await ok(app, auth, `?q=needle&tags=${a},${b}`))).toEqual([both.id]);
    expect(idsOf(await ok(app, auth, `?q=needle&match=body&tags=${a.toUpperCase()},${b},${a}`))).toEqual([both.id]);
  });

  it("works on a group's notes with that group's tags, and a user outside the group can't use them", async () => {
    const { app, db } = await buildTestApp();
    const [alice, bob] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const t = await seedTag(db, { groupId: g.id }, "ops");
    const n = await seedIndexedNote(db, { groupId: g.id }, "group note", blocks);
    await attach(db, n.id, t);
    expect(idsOf(await ok(app, await asUser(alice.id), `?q=needle&tags=${t}`))).toEqual([n.id]);
    expect((await get(app, await asUser(bob.id), `?q=needle&tags=${t}`)).statusCode).toBe(400);
  });

  it("a cursor from a search with other tags is 400 invalid_body", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const auth = await asUser(alice.id);
    const [a, b] = [await seedTag(db, { ownerId: alice.id }, "a"), await seedTag(db, { ownerId: alice.id }, "b")];
    for (let i = 0; i < 3; i += 1) {
      const n = await seedIndexedNote(db, { ownerId: alice.id }, `n${i}`, blocks);
      await attach(db, n.id, a, b);
    }
    const first = await ok(app, auth, `?q=needle&limit=1&tags=${a}`);
    expect(first.nextCursor).not.toBeNull();
    const next = await ok(app, auth, `?q=needle&limit=1&tags=${a}&cursor=${first.nextCursor}`);
    expect(next.hits).toHaveLength(1);
    const wrong = await get(app, auth, `?q=needle&limit=1&tags=${b}&cursor=${first.nextCursor}`);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe("invalid_body");
    expect((await get(app, auth, `?q=needle&limit=1&cursor=${first.nextCursor}`)).statusCode).toBe(400);
  });

  it("an unknown id, tags of two spaces, another user's personal tag, a tag of a group alice isn't in, and malformed lists give the same 400 and don't use the search budget", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    const [alice, bob] = await Promise.all([seedUser(db), seedUser(db)]);
    const auth = await asUser(alice.id);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const mine = await seedTag(db, { ownerId: alice.id }, "mine");
    const inGroup = await seedTag(db, { groupId: g.id }, "ops");
    const bobs = await seedTag(db, { ownerId: bob.id }, "bobs");
    const secret = await seedGroup(db, "Secret", [{ userId: bob.id, role: "member" }]);
    const hidden = await seedTag(db, { groupId: secret.id }, "hidden");
    const missing = "00000000-0000-4000-8000-000000000001";

    const bodies = new Set<string>();
    const bad = [missing, `${mine},${inGroup}`, bobs, hidden, `${mine},${missing}`, "not-a-uuid", `${mine},`, `${mine},,${mine}x`, "", Array.from({ length: 51 }, () => mine).join(",")];
    for (const tagsParam of bad) {
      const res = await get(app, auth, `?q=needle&tags=${tagsParam}`);
      expect(res.statusCode, tagsParam).toBe(400);
      expect(res.json().error.code, tagsParam).toBe("invalid_tags");
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    expect((await get(app, auth, "?q=needle")).statusCode).toBe(200);
    expect((await get(app, auth, "?q=needle")).statusCode).toBe(200);
    expect((await get(app, auth, "?q=needle")).statusCode).toBe(429);
  });

  it("notes shared with alice never come back for a tag filter, even when she was handed the owner's tag id", async () => {
    const { app, db } = await buildTestApp();
    const [alice, bob] = await Promise.all([seedUser(db), seedUser(db)]);
    const bobsTag = await seedTag(db, { ownerId: bob.id }, "bobs");
    const mineTag = await seedTag(db, { ownerId: alice.id }, "mine");
    const shared = await seedIndexedNote(db, { ownerId: bob.id }, "shared", blocks);
    await seedShare(db, shared.id, alice.id, "editor");
    await attach(db, shared.id, bobsTag, mineTag);

    const auth = await asUser(alice.id);
    expect(idsOf(await ok(app, auth, "?q=needle"))).toEqual([shared.id]);
    expect((await get(app, auth, `?q=needle&tags=${bobsTag}`)).statusCode).toBe(400);
    expect(idsOf(await ok(app, auth, `?q=needle&tags=${mineTag}`))).toEqual([]);
  });

  it("a note_tags row left in another space doesn't make a note match", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const personal = await seedTag(db, { ownerId: alice.id }, "p");
    const n = await seedIndexedNote(db, { groupId: g.id }, "group note", blocks);
    await attach(db, n.id, personal);
    expect(await db.select().from(noteTags).where(eq(noteTags.noteId, n.id))).toHaveLength(1);
    expect(idsOf(await ok(app, await asUser(alice.id), `?q=needle&tags=${personal}`))).toEqual([]);
  });

  it("a trashed note doesn't match", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const t = await seedTag(db, { ownerId: alice.id }, "t");
    const n = await seedIndexedNote(db, { ownerId: alice.id }, "n", blocks);
    await attach(db, n.id, t);
    const del = await app.inject({ method: "DELETE", url: `/api/notes/${n.id}`, ...(await asUser(alice.id)) });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect(idsOf(await ok(app, await asUser(alice.id), `?q=needle&tags=${t}`))).toEqual([]);
  });
});
