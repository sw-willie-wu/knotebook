import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { KNOWLEDGE_REFS_LIMIT, type KnowledgeRefCandidateDto, type KnowledgeRefsDto } from "@knotebook/shared";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { cookieOf, seedGroup, seedShare, seedUser } from "./group-helpers.js";
import { markTrashed } from "./trash-helpers.js";
import { kh, kid, seedKnowledgeNote } from "./knowledge-helpers.js";

const UNKNOWN = "00000000-0000-4000-8000-00000000dead";
const enc = encodeURIComponent;

async function search(app: FastifyInstance, userId: string, qs: string) {
  return app.inject({ method: "GET", url: `/api/knowledge/refs${qs}`, cookies: await cookieOf(userId) });
}
async function found(app: FastifyInstance, userId: string, qs: string): Promise<KnowledgeRefCandidateDto[]> {
  const res = await search(app, userId, qs);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as KnowledgeRefsDto).candidates;
}
async function resolve(app: FastifyInstance, userId: string, noteId: string, knowledgeId: string) {
  return app.inject({ method: "GET", url: `/api/knowledge/refs/${noteId}/${knowledgeId}`, cookies: await cookieOf(userId) });
}
const heading = (id: number, text: string, extra: Parameters<typeof kh>[3] = {}) => kh(`b${id}`, kid(id), text, { level: 1, ...extra });
const headings = (c: KnowledgeRefCandidateDto[]): string[] => c.map(x => x.heading);

describe("search", () => {
  it("search finds knowledge by heading, when, conclusion or note title across own, shared and group notes, up to 20", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "member" }]);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Plain title", [heading(1, "needle in heading"), heading(2, "other", { when: "a Needle when" }), heading(3, "third", { conclusion: "NEEDLE conclusion" })]);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Has needle in the title", [heading(4, "unrelated")]);
    const shared = await seedKnowledgeNote(db, { ownerId: bob.id }, "Shared", [heading(5, "shared needle")]);
    await seedShare(db, shared.id, alice.id, "viewer");
    await seedKnowledgeNote(db, { groupId: g.id }, "Group", [heading(6, "group needle")]);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "No match", [heading(7, "haystack")]);
    const hits = await found(app, alice.id, "?q=needle");
    expect(headings(hits).sort()).toEqual(["group needle", "needle in heading", "other", "shared needle", "third", "unrelated"]);
    expect(hits.every(h => h.noteTitle !== "" && h.path.startsWith("/") && /^k_[0-9a-f]{8}$/.test(h.knowledgeId) && h.blockId !== "")).toBe(true);
    const many = Array.from({ length: 30 }, (_, i) => heading(100 + i, `bulk needle ${i}`));
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Bulk", many);
    expect((await found(app, alice.id, "?q=needle")).length).toBe(KNOWLEDGE_REFS_LIMIT);
  });

  it("headings starting with the query come first", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "N", [heading(1, "contains deploy inside"), heading(2, "Deploy first")]);
    expect(headings(await found(app, alice.id, "?q=deploy"))).toEqual(["Deploy first", "contains deploy inside"]);
  });

  it("the match is a plain substring: percent, underscore and quotes in q are literal", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "N", [heading(1, "100% done"), heading(2, "a_b"), heading(3, "axb"), heading(4, "it's")]);
    expect(headings(await found(app, alice.id, `?q=${enc("%")}`))).toEqual(["100% done"]);
    expect(headings(await found(app, alice.id, `?q=${enc("a_b")}`))).toEqual(["a_b"]);
    expect(headings(await found(app, alice.id, `?q=${enc("'")}`))).toEqual(["it's"]);
  });

  it("excludeNote leaves that note out; trashed notes and notes you can't see never appear", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client as Pool;
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const keep = await seedKnowledgeNote(db, { ownerId: alice.id }, "Keep", [heading(1, "zeta keep")]);
    const skip = await seedKnowledgeNote(db, { ownerId: alice.id }, "Skip", [heading(2, "zeta skip")]);
    const trashed = await seedKnowledgeNote(db, { ownerId: alice.id }, "Trashed", [heading(3, "zeta trashed")]);
    await seedKnowledgeNote(db, { ownerId: bob.id }, "Bob private", [heading(4, "zeta bob-private-77")]);
    await markTrashed(pool, trashed.id, alice.id);
    expect(headings(await found(app, alice.id, "?q=zeta")).sort()).toEqual(["zeta keep", "zeta skip"]);
    expect(headings(await found(app, alice.id, `?q=zeta&excludeNote=${skip.id}`))).toEqual(["zeta keep"]);
    expect(headings(await found(app, alice.id, `?q=zeta&excludeNote=${skip.id.toUpperCase()}`))).toEqual(["zeta keep"]);
    const res = await search(app, alice.id, "?q=zeta");
    expect(res.body).not.toContain("bob-private-77");
    expect(keep.id).toBeTruthy();
  });

  it("q blank after trim, over 200 characters or containing NUL is 400 and isn't charged; the 3rd search in a window of 2 is 429", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    const alice = await seedUser(db);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "N", [heading(1, "alpha")]);
    for (const qs of ["", "?q=", "?q=%20%20", `?q=${"a".repeat(201)}`, "?q=a%00b", "?q=ab&excludeNote=nope", "?q=ab&foo=1", "?q=a&q=b"]) {
      const res = await search(app, alice.id, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error.code, qs).toBe("invalid_body");
    }
    expect((await search(app, alice.id, "?q=alpha")).statusCode).toBe(200);
    expect((await search(app, alice.id, `?q=${"a".repeat(200)}`)).statusCode).toBe(200);
    const third = await search(app, alice.id, "?q=alpha");
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("too_many_requests");
  });

  it("unauthenticated -> 401", async () => {
    const { app } = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/api/knowledge/refs?q=a" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/knowledge/refs/${UNKNOWN}/${kid(1)}` })).statusCode).toBe(401);
  });
});

describe("resolve", () => {
  it("resolve returns the candidate for a visible note and 404 for invisible, trashed, unknown note, unknown knowledge id and malformed ids alike", async () => {
    const { app, db } = await buildTestApp();
    const pool = db.$client as Pool;
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const mine = await seedKnowledgeNote(db, { ownerId: alice.id }, "Mine", [heading(1, "Visible", { conclusion: "yes" })]);
    const theirs = await seedKnowledgeNote(db, { ownerId: bob.id }, "Theirs", [heading(2, "Hidden")]);
    const gone = await seedKnowledgeNote(db, { ownerId: alice.id }, "Gone", [heading(3, "Trashed")]);
    await markTrashed(pool, gone.id, alice.id);
    const ok = await resolve(app, alice.id, mine.id, kid(1));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ noteId: mine.id, noteTitle: "Mine", path: expect.stringContaining(mine.slug), knowledgeId: kid(1), blockId: "b1", heading: "Visible", conclusion: "yes" });
    expect((await resolve(app, alice.id, mine.id.toUpperCase(), kid(1))).statusCode).toBe(200);
    const bodies: string[] = [];
    for (const [n, k] of [[theirs.id, kid(2)], [gone.id, kid(3)], [UNKNOWN, kid(1)], [mine.id, kid(99)], ["nope", kid(1)], [mine.id, "k_zz"], [mine.id, "K_00000001"]] as const) {
      const res = await resolve(app, alice.id, n, k);
      expect(res.statusCode, `${n} ${k}`).toBe(404);
      expect(res.json().error.code).toBe("not_found");
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain("Hidden");
  });

  it("a group member resolves a group note and a shared note; a non-member doesn't", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const outsider = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "member" }]);
    const inGroup = await seedKnowledgeNote(db, { groupId: g.id }, "In group", [heading(1, "G heading")]);
    const shared = await seedKnowledgeNote(db, { ownerId: bob.id }, "Shared", [heading(2, "S heading")]);
    await seedShare(db, shared.id, alice.id, "viewer");
    expect((await resolve(app, alice.id, inGroup.id, kid(1))).statusCode).toBe(200);
    expect((await resolve(app, alice.id, shared.id, kid(2))).statusCode).toBe(200);
    expect((await resolve(app, outsider.id, inGroup.id, kid(1))).statusCode).toBe(404);
    expect((await resolve(app, outsider.id, shared.id, kid(2))).statusCode).toBe(404);
  });
});
