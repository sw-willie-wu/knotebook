import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NoteDto, NoteSearchHitDto, NoteSearchResultDto } from "@knotebook/shared";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedShare, seedUser } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedIndexedNote } from "./search-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { Blk } from "./search-doc.js";

type Auth = { cookies: Record<string, string> } | { headers: Record<string, string> };
const asUser = async (userId: string): Promise<Auth> => ({ cookies: await cookieOf(userId) });

function get(app: FastifyInstance, auth: Auth | null, qs: string) {
  return app.inject({ method: "GET", url: `/api/search${qs}`, ...(auth ?? {}) });
}
async function ok(app: FastifyInstance, auth: Auth, qs: string): Promise<NoteSearchResultDto> {
  const res = await get(app, auth, qs);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NoteSearchResultDto;
}
const idsOf = (r: NoteSearchResultDto) => r.hits.map(h => h.note.id);
const enc = encodeURIComponent;
const body = (text: string): Blk[] => [{ id: "p", text }];
function tamper(cursor: string, edit: (parts: string[]) => string[]): string {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  return Buffer.from(edit(parts).join("|"), "utf8").toString("base64url");
}

describe("unauthenticated", () => {
  it("no session and no token -> 401", async () => {
    const { app } = await buildTestApp();
    expect((await get(app, null, "?q=abc")).statusCode).toBe(401);
  });
});

describe("validation -> 400 invalid_body (does not charge the bucket)", () => {
  it("missing q, empty, whitespace, 201 code units, 101 emoji, NUL, limit 0/51/abc/1.5, match=title, duplicate q, unknown parameter", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    const bad = [
      "", "?q=", "?q=%20%20", `?q=${"a".repeat(201)}`, `?q=${enc("😀".repeat(101))}`, "?q=a%00b",
      "?q=ab&limit=0", "?q=ab&limit=51", "?q=ab&limit=abc", "?q=ab&limit=1.5", "?q=ab&match=title", "?q=a&q=b", "?q=ab&foo=1",
    ];
    for (const qs of bad) {
      const res = await get(app, auth, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error.code, qs).toBe("invalid_body");
    }
    expect((await get(app, auth, `?q=${"a".repeat(200)}`)).statusCode).toBe(200);
    expect((await get(app, auth, `?q=${enc("😀".repeat(100))}`)).statusCode).toBe(200);
  });

  it("70 requests of 400, then one valid request is still 200 (validation failures do not charge; the search bucket is 60 per minute)", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 70; i += 1) expect((await get(app, auth, "?q=%20")).statusCode).toBe(400);
    expect((await get(app, auth, "?q=ab")).statusCode).toBe(200);
  });
});

describe("trim", () => {
  it("q=%20report%20 and q=report give the same result; cursors interoperate (the fingerprint uses the trimmed text)", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 3; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `plain ${i}`, body("a report inside"));
    const a = await ok(app, auth, "?q=%20report%20");
    const b = await ok(app, auth, "?q=report");
    expect(a).toEqual(b);
    expect(idsOf(a).length).toBe(3);
    const first = await ok(app, auth, "?q=report&limit=1");
    const next = await ok(app, auth, `?q=%20report%20&limit=1&cursor=${first.nextCursor}`);
    expect(idsOf(next)).toEqual([idsOf(a)[1]]);
  });
});

describe("shape", () => {
  it("three matchedOn values; title's matches is []; body's sectionId = heading id and snippet contains the query; note is the same as GET /api/notes except sizeBytes, tags and hasKnowledge", async () => {
    const { app, db } = await buildTestApp();
    const [u, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const auth = await asUser(u.id);
    const t = await seedIndexedNote(db, { ownerId: u.id }, "kappa title", body("nothing"));
    const bo = await seedIndexedNote(db, { ownerId: u.id }, "kappa both", [{ id: "hb", type: "heading", level: 1, text: "Sec" }, { id: "p", text: "kappa here" }]);
    const shared = await seedIndexedNote(db, { ownerId: other.id }, "plain shared", [{ id: "hs", type: "heading", level: 2, text: "Shared sec" }, { id: "p", text: "the kappa word" }]);
    await seedShare(db, shared.id, u.id, "editor");
    const g = await seedGroup(db, "G", [{ userId: other.id, role: "admin" }, { userId: u.id, role: "member" }]);
    const gn = await seedIndexedNote(db, { groupId: g.id }, "plain group", body("group kappa"));
    const r = await ok(app, auth, "?q=kappa");
    const byId = new Map(r.hits.map(h => [h.note.id, h]));
    expect(byId.get(t.id)!.matchedOn).toBe("title");
    expect(byId.get(t.id)!.matches).toEqual([]);
    expect(byId.get(bo.id)!.matchedOn).toBe("both");
    expect(byId.get(shared.id)!.matchedOn).toBe("body");
    const m = byId.get(shared.id)!.matches[0]!;
    expect(m.sectionId).toBe("hs");
    expect(m.heading).toBe("Shared sec");
    expect(m.snippet).toContain("kappa");
    expect(Object.keys(m).sort()).toEqual(["heading", "sectionId", "snippet"]);
    const list = (await app.inject({ method: "GET", url: "/api/notes", ...auth })).json() as NoteDto[];
    for (const id of [t.id, bo.id, shared.id, gn.id]) {
      const hit = byId.get(id)!;
      const { sizeBytes, tags, hasKnowledge, ...rest } = list.find(n => n.id === id)!;
      expect(sizeBytes, "清單有 sizeBytes").toBeTypeOf("number");
      expect(tags, "list rows carry tags").toEqual([]);
      expect(hasKnowledge, "list rows carry hasKnowledge").toBe(false);
      expect(hit.note, id).toEqual(rest);
      expect("sizeBytes" in hit.note).toBe(false);
      expect("tags" in hit.note).toBe(false);
      expect("hasKnowledge" in hit.note).toBe(false);
    }
    expect(byId.get(shared.id)!.note.role).toBe("editor");
    expect(Object.keys(r).sort()).toEqual(["hits", "nextCursor"]);
  });
});

describe("truncation and snippet length", () => {
  it("300-char heading -> 200 code units; body of 400 double-quote characters, query for one -> snippet length 150-160 code units", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    await seedIndexedNote(db, { ownerId: u.id }, "h", [{ id: "hh", type: "heading", level: 1, text: "H".repeat(300) }, { id: "p", text: "omega" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "q", body('"'.repeat(400)));
    const h = (await ok(app, auth, "?q=omega")).hits[0]!.matches[0]!;
    expect(h.heading.length).toBe(200);
    const s = (await ok(app, auth, `?q=${enc('"')}`)).hits[0]!.matches[0]!;
    expect(s.snippet.length).toBeGreaterThanOrEqual(150);
    expect(s.snippet.length).toBeLessThanOrEqual(160);
  });

  it("query with emoji: the matched segment counts code points (qlen), and whitespace after the hit still collapses to one", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    // Three spaces right after the hit: qlen counts code points = 2, the matched segment is the emoji plus x and the following
    // whitespace collapses to one; with code units (3) the matched segment would swallow the first space (matched segments do
    // not collapse whitespace), leaving two spaces.
    await seedIndexedNote(db, { ownerId: u.id }, "e", body(`${"a".repeat(60)} 😀x   ${"b".repeat(200)}`));
    const s = (await ok(app, auth, `?q=${enc("😀x")}`)).hits[0]!.matches[0]!;
    expect(s.snippet).toContain("😀x b");
    expect(s.snippet).not.toContain("😀x  ");
    expect(s.snippet.length).toBeLessThanOrEqual(160);
  });
});

describe("visibility", () => {
  it("a stranger's private note 0; after sharing 1; group member sees it, non-member 0; trashed 0", async () => {
    const { app, db } = await buildTestApp();
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const n = await seedIndexedNote(db, { ownerId: a.id }, "plain", body("visprobe"));
    expect(idsOf(await ok(app, await asUser(b.id), "?q=visprobe"))).toEqual([]);
    await seedShare(db, n.id, b.id, "viewer");
    expect(idsOf(await ok(app, await asUser(b.id), "?q=visprobe"))).toEqual([n.id]);
    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "member" }]);
    const gn = await seedIndexedNote(db, { groupId: g.id }, "g", body("grpprobe"));
    expect(idsOf(await ok(app, await asUser(b.id), "?q=grpprobe"))).toEqual([gn.id]);
    expect(idsOf(await ok(app, await asUser(c.id), "?q=grpprobe"))).toEqual([]);
    const del = await app.inject({ method: "DELETE", url: `/api/notes/${n.id}`, cookies: await cookieOf(a.id) });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect(idsOf(await ok(app, await asUser(a.id), "?q=visprobe"))).toEqual([]);
    expect(idsOf(await ok(app, await asUser(b.id), "?q=visprobe"))).toEqual([]);
  });
});

describe("folderId (caller's perspective)", () => {
  it("a sharee puts the note in their own folder -> note.folderId is the sharee's, not the owner's", async () => {
    const { app, db } = await buildTestApp();
    const [owner, sharee] = await Promise.all([seedUser(db), seedUser(db)]);
    const n = await seedIndexedNote(db, { ownerId: owner.id }, "plain", body("fldprobe"));
    const of = await seedFolder(db, { personal: owner.id });
    const sf = await seedFolder(db, { shared: sharee.id });
    await db.execute(sql`update notes set folder_id = ${of.id}::uuid where id = ${n.id}::uuid`);
    await seedShare(db, n.id, sharee.id, "viewer");
    await db.execute(sql`insert into note_placements (user_id, note_id, folder_id) values (${sharee.id}::uuid, ${n.id}::uuid, ${sf.id}::uuid)`);
    expect((await ok(app, await asUser(sharee.id), "?q=fldprobe")).hits[0]!.note.folderId).toBe(sf.id);
    expect((await ok(app, await asUser(owner.id), "?q=fldprobe")).hits[0]!.note.folderId).toBe(of.id);
  });
});

describe("rate limit (shared with MCP) and tokens", () => {
  it("search bucket 1 -> second request 429; REST first, then MCP search_notes -> too_many_requests", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    expect((await get(app, auth, "?q=ab")).statusCode).toBe(200);
    const second = await get(app, auth, "?q=ab");
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("too_many_requests");

    const { app: app2, db: db2 } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const v = await seedUser(db2);
    const { token } = await seedTokenForUser(db2, v.id, "notes:read");
    expect((await get(app2, await asUser(v.id), "?q=ab")).statusCode).toBe(200);
    const res = await mcpPost(app2, rpc("tools/call", { name: "search_notes", arguments: { query: "ab" } }), { token });
    const result = res.json().result as { isError?: true; structuredContent: { code: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("too_many_requests");
  });

  it("notes:read token -> 200; the same bucket charges tokens too", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id, "notes:read");
    await seedIndexedNote(db, { ownerId: u.id }, "plain", body("tokprobe"));
    const auth: Auth = { headers: bearer(token) };
    expect(idsOf(await ok(app, auth, "?q=tokprobe")).length).toBe(1);
    expect((await get(app, auth, "?q=tokprobe")).statusCode).toBe(429);
  });
});

describe("match=body", () => {
  it("title-only matches do not appear; they appear without match", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    const t = await seedIndexedNote(db, { ownerId: u.id }, "lambda title", body("nothing"));
    const b = await seedIndexedNote(db, { ownerId: u.id }, "plain", body("lambda body"));
    expect(idsOf(await ok(app, auth, "?q=lambda&match=body"))).toEqual([b.id]);
    expect(idsOf(await ok(app, auth, "?q=lambda&match=all"))).toEqual([t.id, b.id]);
    expect(idsOf(await ok(app, auth, "?q=lambda"))).toEqual([t.id, b.id]);
  });
});

describe("pagination", () => {
  it("25 notes: default 20 + nextCursor -> with cursor 5 + null; union equals one fetch with limit=50, no duplicates", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 25; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `plain ${i}`, body("pageprobe"));
    const p1 = await ok(app, auth, "?q=pageprobe");
    expect(p1.hits.length).toBe(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await ok(app, auth, `?q=pageprobe&cursor=${p1.nextCursor}`);
    expect(p2.hits.length).toBe(5);
    expect(p2.nextCursor).toBeNull();
    const all = await ok(app, auth, "?q=pageprobe&limit=50");
    expect([...idsOf(p1), ...idsOf(p2)]).toEqual(idsOf(all));
    expect(new Set([...idsOf(p1), ...idsOf(p2)]).size).toBe(25);
  });

  it("exactly 40 notes, limit=20 -> second page has 20 and nextCursor: null", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 40; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `plain ${i}`, body("fortyprobe"));
    const p1 = await ok(app, auth, "?q=fortyprobe&limit=20");
    const p2 = await ok(app, auth, `?q=fortyprobe&limit=20&cursor=${p1.nextCursor}`);
    expect(p2.hits.length).toBe(20);
    expect(p2.nextCursor).toBeNull();
  });
});

describe("cursor tampering and no leaks", () => {
  it("every tampered cursor is 400 (not 500) and does not charge the bucket; an old cursor with a different q / match is also 400", async () => {
    const { app, db } = await buildTestApp({ limiters: freshLimiters({ search: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    const u = await seedUser(db);
    const auth = await asUser(u.id);
    for (let i = 0; i < 2; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `plain ${i}`, body("tamperprobe"));
    const first = await ok(app, auth, "?q=tamperprobe&limit=1"); // charges 1
    const c = first.nextCursor!;
    expect(c).not.toBeNull();
    const bad = [
      "!!!notbase64",
      tamper(c, p => ["t", ...p.slice(1)]),
      tamper(c, p => p.slice(0, 4)),
      tamper(c, p => [p[0]!, p[1]!, "4", p[3]!, p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, "-1", p[3]!, p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, "1.0", p[3]!, p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, p[2]!, "2026-13-01T00:00:00.000000Z", p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, p[2]!, p[3]!.replace(/\d{6}Z$/, "00000Z"), p[4]!]),
      tamper(c, p => [p[0]!, p[1]!, p[2]!, p[3]!, "not-a-uuid"]),
    ];
    for (const cur of bad) {
      const res = await get(app, auth, `?q=tamperprobe&limit=1&cursor=${enc(cur)}`);
      expect(res.statusCode, cur).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    for (const qs of [`?q=tamperprob&limit=1&cursor=${c}`, `?q=tamperprobe&limit=1&match=body&cursor=${c}`]) {
      const res = await get(app, auth, qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error.code).toBe("invalid_body");
    }
    expect((await get(app, auth, `?q=tamperprobe&limit=1&cursor=${c}`)).statusCode).toBe(200); // charges 2 (the 11 before did not charge)
    expect((await get(app, auth, "?q=tamperprobe")).statusCode).toBe(429);
  });

  it("A's cursor given to B (same q, same match) -> 200, containing only what B can see", async () => {
    const { app, db } = await buildTestApp();
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    await seedIndexedNote(db, { ownerId: a.id }, "a1", body("leakcur"));
    await seedIndexedNote(db, { ownerId: a.id }, "a2", body("leakcur"));
    const bn = await seedIndexedNote(db, { ownerId: b.id }, "b1", body("leakcur"));
    await db.execute(sql`update notes set updated_at = '2000-01-01T00:00:00Z' where id = ${bn.id}::uuid`);
    const first = await ok(app, await asUser(a.id), "?q=leakcur&limit=1");
    const r = await ok(app, await asUser(b.id), `?q=leakcur&limit=1&cursor=${first.nextCursor}`);
    expect(idsOf(r)).toEqual([bn.id]);
    const hit: NoteSearchHitDto = r.hits[0]!;
    expect(hit.note.ownerId).toBe(b.id);
  });
});
