import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64, SESSION_COOKIE, YDOC_FRAGMENT } from "@knotebook/shared";
import { buildTestApp, freshDb, freshLimiters, signTestSession } from "./helpers.js";
import { noteShares, noteStates, notes, uploads, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { UserGate } from "../src/auth/session.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import type pino from "pino";
import { backfillHandleRegistry } from "../src/auth/handle.js";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UPLOAD_CSP, uploadFilePath } from "../src/uploads/service.js";
import { expectRangeServing } from "./helpers/upload-serving.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";

// Same error convention as the shares endpoints: no role -> 404 not_found (indistinguishable from nonexistent), readable non-owner -> 403.

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function insertUser(db: Db, email: string, handle?: string) {
  // An unspecified handle falls to the DB default (user-<uuid8>); the by-path cases need a predictable handle to build alias URLs.
  const [u] = await db.insert(users).values({ email, displayName: "Test User", ...(handle ? { handle } : {}) }).returning();
  return u;
}

async function cookieFor(userId: string): Promise<string> {
  return signTestSession({ userId, tv: 0 });
}

async function createNote(app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("public link management (GET/PUT/DELETE /api/notes/:id/public-link)", () => {
  it("owner: initial GET null -> PUT creates a 43-char token -> GET reads it back -> PUT again regenerates -> GET null after DELETE", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pl1@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);

    const g0 = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(g0.statusCode).toBe(200);
    expect(g0.json()).toEqual({ token: null, slug: null, width: "standard" });

    const p1 = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(p1.statusCode).toBe(200);
    const token1 = p1.json().token as string;
    expect(token1).toMatch(TOKEN_RE);

    const g1 = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(g1.json()).toEqual({ token: token1, slug: null, width: "standard" });

    const p2 = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    const token2 = p2.json().token as string;
    expect(token2).toMatch(TOKEN_RE);
    expect(token2).not.toBe(token1);

    const d = await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(d.statusCode).toBe(204);
    const g2 = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(g2.json()).toEqual({ token: null, slug: null, width: "standard" });

    // DELETE is idempotent on token state: deleting when already null is still 204 (404 is only for the note itself being gone).
    const d2 = await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(d2.statusCode).toBe(204);
  });

  it("readable non-owner (editor/viewer) -> 403; unrelated user -> 404; the three verbs behave the same", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pl2@example.com");
    const editor = await insertUser(db, "editor-pl2@example.com");
    const viewer = await insertUser(db, "viewer-pl2@example.com");
    const stranger = await insertUser(db, "stranger-pl2@example.com");
    const ownerCookie = await cookieFor(owner.id);
    const noteId = await createNote(app, ownerCookie);
    await db.insert(noteShares).values([
      { noteId, userId: editor.id, role: "editor" },
      { noteId, userId: viewer.id, role: "viewer" },
    ]);

    const runMatrix = async () => {
      for (const method of ["GET", "PUT", "DELETE"] as const) {
        for (const [user, expected, code] of [
          [editor, 403, "forbidden"],
          [viewer, 403, "forbidden"],
          [stranger, 404, "not_found"],
        ] as const) {
          const res = await app.inject({
            method,
            url: `/api/notes/${noteId}/public-link`,
            cookies: { [SESSION_COOKIE]: await cookieFor(user.id) },
          });
          expect(res.statusCode, `${method} as ${user.email}`).toBe(expected);
          expect(res.json().error.code, `${method} as ${user.email}`).toBe(code);
        }
      }
    };

    // A 403/404 alone is not enough: if the write moved before the authorization check, a non-owner PUT/DELETE would still
    // return 403/404 but the token would already be regenerated/revoked. Pin the token state with the owner's GET before and
    // after the matrix: first run with no token (stays null), then after the owner opens one (stays the same one).
    await runMatrix();
    const gNull = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(gNull.json()).toEqual({ token: null, slug: null, width: "standard" });

    const put = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    const ownerToken = put.json().token as string;
    await runMatrix();
    const gAfter = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    expect(gAfter.json()).toEqual({ token: ownerToken, slug: null, width: "standard" });
  });

  it("throttle only on PUT/DELETE (10 per 10 min, key = userId): 11 GETs all 200; PUT + DELETE totalling over 10 -> 429", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pl3@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);

    // GET draws nothing from the bucket: opening the dialog 11 times is normal use.
    for (let i = 0; i < 11; i += 1) {
      const g = await app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
      expect(g.statusCode).toBe(200);
    }

    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(204);
    }
    const over = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("too_many_requests");

    // Distinguishes key=userId: (1) another note of the same user is 429 too (a noteId key would give 200, and a per-note key
    // with consume before authorization would let any signed-in user lock someone else's management for 10 minutes);
    const note2 = await createNote(app, cookie);
    const otherNote = await app.inject({ method: "PUT", url: `/api/notes/${note2}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(otherNote.statusCode).toBe(429);
    // (2) another user's own note is 200 (a global-constant key would give 429).
    const other = await insertUser(db, "owner2-pl3@example.com");
    const otherCookie = await cookieFor(other.id);
    const otherOwned = await createNote(app, otherCookie);
    const otherPut = await app.inject({ method: "PUT", url: `/api/notes/${otherOwned}/public-link`, cookies: { [SESSION_COOKIE]: otherCookie } });
    expect(otherPut.statusCode).toBe(200);
  });

  it("consume happens before authorization: a stranger's 404 still draws on their own bucket (11th is 429, not 404)", async () => {
    // Order invariant: if reversed, any signed-in user could hit PUT endlessly with random noteIds, each triggering
    // resolveRole's DB query with no throttling at all.
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pl4@example.com");
    const stranger = await insertUser(db, "stranger-pl4@example.com");
    const noteId = await createNote(app, await cookieFor(owner.id));
    const sc = await cookieFor(stranger.id);
    for (let i = 0; i < 10; i += 1) {
      expect(
        (await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: sc } }))
          .statusCode,
      ).toBe(404);
    }
    const over = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: sc } });
    expect(over.statusCode).toBe(429); // if consume moved after authorization this would be 404
  });
});

describe("public alias management (PUT/DELETE /api/notes/:id/public-link/slug)", () => {
  async function publicNote(app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string): Promise<[string, string]> {
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);
    return [noteId, token];
  }
  const putSlug = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, noteId: string, slug: string) =>
    app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug } });
  const delSlug = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, noteId: string) =>
    app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie } });
  const getLink = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, noteId: string) =>
    app.inject({ method: "GET", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });

  it("owner full flow: setting an alias returns the full {token, slug, width} -> GET same shape -> DELETE slug 204 (token kept) -> idempotent 204", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps1@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId, token] = await publicNote(app, cookie);

    const p = await putSlug(app, cookie, noteId, "my-alias");
    expect(p.statusCode).toBe(200);
    // Full shape pinned: the web mutation writes the response straight into the cache; a missing token would blank the
    // cached token and make the public-link row disappear.
    expect(p.json()).toEqual({ token, slug: "my-alias", width: "standard" });

    const g = await getLink(app, cookie, noteId);
    expect(g.json()).toEqual({ token, slug: "my-alias", width: "standard" });

    const d = await delSlug(app, cookie, noteId);
    expect(d.statusCode).toBe(204);
    const g2 = await getLink(app, cookie, noteId);
    expect(g2.json()).toEqual({ token, slug: null, width: "standard" });

    expect((await delSlug(app, cookie, noteId)).statusCode).toBe(204);
  });

  it("alias on a non-public note (token NULL) -> 400 invalid_body and nothing left in the DB (rowcount-0 path)", async () => {
    // Takes the conditional-UPDATE path (predicate false -> rowcount 0 -> 400); pins both the public_token-is-not-null
    // predicate (dropping it would give 200) and honouring rowcount (ignoring it would also give 200).
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps2@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const r = await putSlug(app, cookie, noteId, "early-alias");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_body");
    const [row] = await db.select({ publicSlug: notes.publicSlug }).from(notes).where(eq(notes.id, noteId)).limit(1);
    expect(row.publicSlug).toBeNull();
  });

  it("owner matrix (editor/viewer -> 403, stranger -> 404, PUT/DELETE alike) plus no-side-effect check", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps3@example.com");
    const editor = await insertUser(db, "editor-ps3@example.com");
    const viewer = await insertUser(db, "viewer-ps3@example.com");
    const stranger = await insertUser(db, "stranger-ps3@example.com");
    const ownerCookie = await cookieFor(owner.id);
    const [noteId, token] = await publicNote(app, ownerCookie);
    await db.insert(noteShares).values([
      { noteId, userId: editor.id, role: "editor" },
      { noteId, userId: viewer.id, role: "viewer" },
    ]);
    expect((await putSlug(app, ownerCookie, noteId, "kept-alias")).statusCode).toBe(200);

    for (const [user, expected, code] of [
      [editor, 403, "forbidden"],
      [viewer, 403, "forbidden"],
      [stranger, 404, "not_found"],
    ] as const) {
      const c = await cookieFor(user.id);
      const p = await putSlug(app, c, noteId, "hijack");
      expect(p.statusCode, `PUT as ${user.email}`).toBe(expected);
      expect(p.json().error.code).toBe(code);
      const d = await delSlug(app, c, noteId);
      expect(d.statusCode, `DELETE as ${user.email}`).toBe(expected);
      expect(d.json().error.code).toBe(code);
    }
    const g = await getLink(app, ownerCookie, noteId);
    expect(g.json()).toEqual({ token, slug: "kept-alias", width: "standard" });
  });

  it("409 public_slug_taken: two notes of one owner collide; same alias across owners coexists; does not clash with private slugs", async () => {
    const { app, db } = await buildTestApp();
    const a = await insertUser(db, "owner-a-ps4@example.com");
    const b = await insertUser(db, "owner-b-ps4@example.com");
    const ca = await cookieFor(a.id);
    const cb = await cookieFor(b.id);
    const [noteA1] = await publicNote(app, ca);
    const [noteA2] = await publicNote(app, ca);
    const [noteB] = await publicNote(app, cb);

    expect((await putSlug(app, ca, noteA1, "team-doc")).statusCode).toBe(200);
    const clash = await putSlug(app, ca, noteA2, "team-doc");
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("public_slug_taken");
    // No partial write: with a single atomic UPDATE a 409 leaves nothing behind; if it ever became pre-check plus
    // stepwise writes, these two lines are the only place a leftover would show.
    const [a2row] = await db.select({ publicSlug: notes.publicSlug }).from(notes).where(eq(notes.id, noteA2)).limit(1);
    expect(a2row.publicSlug).toBeNull();
    const [a1row] = await db.select({ publicSlug: notes.publicSlug }).from(notes).where(eq(notes.id, noteA1)).limit(1);
    expect(a1row.publicSlug).toBe("team-doc");
    expect((await putSlug(app, cb, noteB, "team-doc")).statusCode).toBe(200);
    // The same owner's private slug with the same name does not occupy the alias namespace (independent columns; the
    // DB level is covered in migrate.test, this pins that the endpoint did not add a cross-column pre-check).
    const patch = await app.inject({ method: "PATCH", url: `/api/notes/${noteA2}`, cookies: { [SESSION_COOKIE]: ca }, payload: { slug: "team-doc" } });
    expect(patch.statusCode).toBe(200);
  });

  it("validation funnel shared with PATCH slug: malformed body/reserved word/uuid shape/invalid -> 400 and consumes the bucket; mixed case is normalized to lowercase", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps5@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId] = await publicNote(app, cookie);

    // Bucket arithmetic (SLUG_PATCH_LIMIT=10, counted before validation so a 400 counts too): malformed body x2 + validation
    // violations x4 + valid x1 + violations x3 = 10, so the 11th (valid) must be 429. Without this tail assertion, moving
    // consume after validation (400 not charged) would stay green, and signed-in users could probe the validation surface for free.
    // Malformed body (hand-written guard, no zod schema; without it this would be a 500)
    for (const payload of [{}, { slug: 123 }]) {
      const r = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
    }
    // `café` is a valid input (the slug charset is \p{L}\p{N}-, which allows localized slugs); do not use it as an invalid
    // case - use an underscore for a real charset violation.
    for (const bad of ["new", "f47ac10b-58cc-4372-a567-0e02b2c3d479", "under_score", ""]) {
      const r = await putSlug(app, cookie, noteId, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
    }
    const ok = await putSlug(app, cookie, noteId, "MiXeD-Alias");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().slug).toBe("mixed-alias");
    for (const bad of ["also_bad", "still_bad", "worse_bad"]) {
      expect((await putSlug(app, cookie, noteId, bad)).statusCode, bad).toBe(400);
    }
    // 11th: even valid input is 429; if a 400 did not consume, this would be 200
    const over = await putSlug(app, cookie, noteId, "over-alias");
    expect(over.statusCode).toBe(429);
  });

  it("throttle shares the slugPatch bucket (cross counting): PATCH slug and alias PUT/DELETE total 10, then the 11th is 429", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps6@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId] = await publicNote(app, cookie);

    // Cross-consume the same per-user bucket: PATCH slug x4 + alias PUT x3 + alias DELETE x3 = 10.
    for (let i = 0; i < 4; i += 1) {
      expect((await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: `pv-${i}` } })).statusCode).toBe(200);
    }
    for (let i = 0; i < 3; i += 1) {
      expect((await putSlug(app, cookie, noteId, `alias-${i}`)).statusCode).toBe(200);
      expect((await delSlug(app, cookie, noteId)).statusCode).toBe(204);
    }
    // 11th (alias PUT): if the alias endpoint had its own bucket or shared the publicLink bucket, this would be 200.
    const over = await putSlug(app, cookie, noteId, "alias-over");
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("too_many_requests");
    const patchOver = await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "pv-over" } });
    expect(patchOver.statusCode).toBe(429);
  });

  it("authorize first, then consume (opposite of the publicLink bucket): a stranger's repeated 404s do not drain the bucket - PUT and DELETE each checked", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps7@example.com");
    const stranger = await insertUser(db, "stranger-ps7@example.com");
    const [noteId] = await publicNote(app, await cookieFor(owner.id));
    const sc = await cookieFor(stranger.id);
    // Drain PUT and DELETE separately: draining only PUT would stay green even if DELETE's consume moved before authorization.
    for (let i = 0; i < 12; i += 1) {
      expect((await putSlug(app, sc, noteId, "poke")).statusCode).toBe(404);
      expect((await delSlug(app, sc, noteId)).statusCode).toBe(404);
    }
    // The stranger's own public note can still set and clear an alias: the 24 404s did not charge their slugPatch bucket.
    const [own] = await publicNote(app, sc);
    expect((await putSlug(app, sc, own, "own-alias")).statusCode).toBe(200);
    expect((await delSlug(app, sc, own)).statusCode).toBe(204);
  });

  it("regenerating the token keeps the alias (response is the full {token, slug, width}); DELETE public-link clears both and the alias does not come back", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps8@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId, token1] = await publicNote(app, cookie);
    expect((await putSlug(app, cookie, noteId, "stable-alias")).statusCode).toBe(200);

    // Regenerate: token changes, alias stays; the response is the full {token, slug, width} (web onSuccess writes it straight to the cache).
    const regen = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(regen.statusCode).toBe(200);
    const token2 = regen.json().token as string;
    expect(token2).toMatch(TOKEN_RE);
    expect(token2).not.toBe(token1);
    expect(regen.json()).toEqual({ token: token2, slug: "stable-alias", width: "standard" });

    expect((await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(204);
    expect((await getLink(app, cookie, noteId)).json()).toEqual({ token: null, slug: null, width: "standard" });
    const [row] = await db.select({ publicSlug: notes.publicSlug, publicToken: notes.publicToken }).from(notes).where(eq(notes.id, noteId)).limit(1);
    expect(row).toEqual({ publicSlug: null, publicToken: null });

    // Re-opening public: the alias must not come back ("a deleted alias reappearing" is a plausible failure).
    const reopened = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(reopened.json().slug).toBeNull();
  });

  it("note-width: GET/PUT/slug PUT all return width; DELETE does not reset it; re-opening public reuses the last width", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-ps10@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId, token] = await publicNote(app, cookie);

    const w = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-width`, cookies: { [SESSION_COOKIE]: cookie }, payload: { width: "full" } });
    expect(w.statusCode).toBe(200);
    expect(w.json()).toEqual({ width: "full" });
    expect((await getLink(app, cookie, noteId)).json()).toEqual({ token, slug: null, width: "full" });

    const s = await putSlug(app, cookie, noteId, "w-alias");
    expect(s.statusCode).toBe(200);
    expect(s.json()).toEqual({ token, slug: "w-alias", width: "full" });

    const regen = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(regen.statusCode).toBe(200);
    expect(regen.json().width).toBe("full");

    expect((await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(204);
    const [row] = await db.select({ publicWidth: notes.publicWidth }).from(notes).where(eq(notes.id, noteId)).limit(1);
    expect(row).toEqual({ publicWidth: "full" });
    expect((await getLink(app, cookie, noteId)).json()).toEqual({ token: null, slug: null, width: "full" });

    const reopened = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().width).toBe("full");
  });

  it("statement shape guard (belt and braces): alias PUT has no token pre-read and exactly one UPDATE whose predicate contains public_token is not null", async () => {
    // The behavioural check is the 'not public -> 400' case; this pins the statement shape: the predicate has no params and
    // must appear verbatim in the SQL text, so nobody moves the gate back to a pre-read (reopening the TOCTOU window).
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    // Swap the gate too (gotcha from notes-slug.test: swapping only db gives 401).
    const { app } = await buildTestApp({ db: loggedDb, gate: new UserGate(loggedDb) });
    const owner = await insertUser(db, "owner-ps9@example.com");
    const cookie = await cookieFor(owner.id);
    const [noteId] = await publicNote(app, cookie);

    queries.length = 0;
    expect((await putSlug(app, cookie, noteId, "shape-alias")).statusCode).toBe(200);
    const updates = queries.filter(q => /^update/i.test(q.trim()));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/public_token" is not null/);
    expect(queries.filter(q => /^select/i.test(q.trim()) && /public_(token|slug)/.test(q))).toHaveLength(0);

    // DELETE side: exactly one UPDATE (no predicate required, clearing NULL is idempotent anyway).
    queries.length = 0;
    expect((await delSlug(app, cookie, noteId)).statusCode).toBe(204);
    expect(queries.filter(q => /^update/i.test(q.trim()))).toHaveLength(1);
  });
});


function limitersWithPublic(overrides: Partial<Record<"publicMiss" | "publicNote" | "publicUpload", FixedWindowLimiter>> = {}) {
  // Forward as-is, do not spread key by key (reason in the comment on `freshLimiters`).
  return freshLimiters(overrides);
}

async function openPublicLink(app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, noteId: string): Promise<string> {
  const res = await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

const randomToken = () => randomBytes(32).toString("base64url");
// The public endpoint decodes the stored state, so the bytes must be a real update.
const realYdocBytes = (): Buffer => {
  const doc = new Y.Doc();
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [new Y.XmlElement("blockGroup")]);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
};

describe("public content endpoint (GET /api/public/notes/:token, no login)", () => {
  it("valid token -> 200 {title, ydoc} (base64 of the real note_states bytes, no updatedAt key) plus cache-control: no-store", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pub1@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const ydocBytes = realYdocBytes();
    await db.insert(noteStates).values({ noteId, ydoc: ydocBytes });
    await db.update(notes).set({ title: "公開的筆記" }).where(eq(notes.id, noteId));
    const token = await openPublicLink(app, cookie, noteId);

    const res = await app.inject({ method: "GET", url: `/api/public/notes/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const bodyJson = res.json();
    expect(bodyJson).toEqual({ title: "公開的筆記", ydoc: ydocBytes.toString("base64"), links: [], width: "standard" });
    expect(Object.keys(bodyJson)).not.toContain("updatedAt");
  });

  it("no note_states (editor never opened) -> 200 plus EMPTY_YDOC_UPDATE_B64 (not 404, not an empty string)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pub2@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);

    const res = await app.inject({ method: "GET", url: `/api/public/notes/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ydoc).toBe(EMPTY_YDOC_UPDATE_B64);
  });

  it("the three 404 cases are byte-for-byte identical (anti-enumeration): random token / revoked / bad format", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "owner-pub3@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const revoked = await openPublicLink(app, cookie, noteId);
    await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });

    const bodies: string[] = [];
    for (const bad of [randomToken(), revoked, "not-a-valid-token"]) {
      const res = await app.inject({ method: "GET", url: `/api/public/notes/${bad}` });
      expect(res.statusCode).toBe(404);
      // Shape assertion: without it, if the route did not exist, Fastify's default 404 would also be "same shape" and pass vacuously.
      expect(res.json().error.code).toBe("not_found");
      bodies.push(res.body);
    }
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
  });

  it("content requests for one token draw on the hit bucket (ip:token): with limit 2 the 3rd is 429", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub4@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);

    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(429);
  });

  it("miss bucket (ip) stops random-token floods, and the pre-check treats valid tokens like any other (oracle precondition)", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub5@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);

    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    // Third random token: 429 (many distinct tokens are not immune - the miss bucket key is ip, not token).
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(429);
    // A valid token is 429 now too: the pre-DB check treats hit and miss alike, so 429 is not an existence oracle.
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode).toBe(429);
  });

  it("format guard runs before the limiter: overlong/invalid input gets 404 and does not enter the miss bucket", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub6@example.com");
    const cookie = await cookieFor(owner.id);
    await createNote(app, cookie);

    // Invalid format x3: all 404, none 429 (not consumed). If the guard ran after the limiter the 2nd would be 429; an
    // overlong string also never becomes a BoundedMap key.
    const oversized = "A".repeat(200);
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: "GET", url: `/api/public/notes/${oversized}` })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(429);
  });

  it("hit bucket key includes the token: filling tokenA (limit 1) does not affect tokenB; key also includes ip: another IP on the same token is unaffected", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub7@example.com");
    const cookie = await cookieFor(owner.id);
    const noteA = await createNote(app, cookie);
    const noteB = await createNote(app, cookie);
    const tokenA = await openPublicLink(app, cookie, noteA);
    const tokenB = await openPublicLink(app, cookie, noteB);

    expect((await app.inject({ method: "GET", url: `/api/public/notes/${tokenA}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${tokenA}` })).statusCode).toBe(429);
    // A key without the token would give 429 here: readers of different notes behind one proxy would drag each other down.
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${tokenB}` })).statusCode).toBe(200);
    // A key without the ip prefix would let any reader burn everyone's quota for the note; another IP hitting tokenA must not
    // be affected by the 127.0.0.1 bucket.
    expect(
      (await app.inject({ method: "GET", url: `/api/public/notes/${tokenA}`, remoteAddress: "10.9.8.7" })).statusCode,
    ).toBe(200);
  });

  it("a hit does not eat miss quota (content endpoint): with miss limit 1 the same valid token 3 times is all 200", async () => {
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pub8@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const token = await openPublicLink(app, cookie, noteId);

    // A degenerate "still consume(ip) after a DB hit" would give 429 on the 2nd request.
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: "GET", url: `/api/public/notes/${token}` })).statusCode, `hit ${i}`).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(429);
  });
});

describe("public image endpoint (GET /api/public/notes/:token/uploads/:uploadId)", () => {
  async function seedUpload(db: Db, uploadsDir: string, noteId: string): Promise<string> {
    const [row] = await db.insert(uploads).values({ noteId, mime: "image/png", size: 3 }).returning();
    await writeFile(uploadFilePath(uploadsDir, row.id), Buffer.from([0x50, 0x4e, 0x47]));
    return row.id;
  }

  it("upload of this note -> 200 plus nosniff plus CSP sandbox plus cache-control private immutable plus mime", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, "owner-pubu1@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const uploadId = await seedUpload(db, uploadsDir, noteId);
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf-8");
    const [svgRow] = await db.insert(uploads).values({ noteId, mime: "image/svg+xml", size: svgBytes.length }).returning();
    await writeFile(uploadFilePath(uploadsDir, svgRow.id), svgBytes);
    const token = await openPublicLink(app, cookie, noteId);

    const res = await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/${uploadId}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(res.headers["content-type"]).toBe("image/png");

    const svgRes = await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/${svgRow.id}` });
    expect(svgRes.statusCode).toBe(200);
    expect(svgRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(svgRes.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox");
    expect(svgRes.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(svgRes.headers["content-type"]).toBe("image/svg+xml");
  });

  it("upload id of another note -> 404 (the token only authorizes its own note's blobs), and it counts on the hit bucket without eating miss quota", async () => {
    const { app, db, uploadsDir } = await buildTestApp({
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "owner-pubu2@example.com");
    const cookie = await cookieFor(owner.id);
    const noteA = await createNote(app, cookie);
    const noteB = await createNote(app, cookie);
    const uploadOfB = await seedUpload(db, uploadsDir, noteB);
    const tokenA = await openPublicLink(app, cookie, noteA);

    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    // Cross-note 404 x5: all 404, none 429. Hit vs miss is decided by whether the token resolves to a noteId, not by
    // request success; a cross-note reference is a 404 that normal readers produce and lands in the ip:token bucket
    // (production quota). If it were counted as a miss (limit 3, 1 already used), the 3rd would be 429.
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: "GET", url: `/api/public/notes/${tokenA}/uploads/${uploadOfB}` });
      expect(res.statusCode, `cross-note attempt ${i}`).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` })).statusCode).toBe(429);
  });
  it("revoked token plus a real uploadId -> same shape as the link 404 (not a file 404)", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, "owner-pub9@example.com");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    const [row] = await db.insert(uploads).values({ noteId, mime: "image/png", size: 3 }).returning();
    await writeFile(uploadFilePath(uploadsDir, row.id), Buffer.from([0x50, 0x4e, 0x47]));
    const token = await openPublicLink(app, cookie, noteId);
    await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link`, cookies: { [SESSION_COOKIE]: cookie } });

    const viaUpload = await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/${row.id}` });
    const viaContent = await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` });
    expect(viaUpload.statusCode).toBe(404);
    // After revocation the blob is invalid too, and the body is byte-identical to the link 404 (token resolution failure
    // goes through the same resolvePublicNote; this turns "shared" from a reading guarantee into an assertion).
    expect(viaUpload.body).toBe(viaContent.body);
  });
});

describe("public upload serving: class headers, Range and HEAD on both forms", () => {
  async function publishedVideo(overrides: Parameters<typeof buildTestApp>[0] = {}) {
    const built = await buildTestApp(overrides);
    const owner = await insertUser(built.db, "alice@example.com", "alice");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(built.app, cookie);
    const token = await openPublicLink(built.app, cookie, noteId);
    const slug = await built.app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "talk" } });
    expect(slug.statusCode).toBe(200);
    const video = Buffer.alloc(4096);
    for (let i = 0; i < video.length; i++) video[i] = (i * 31) & 0xff;
    const [row] = await built.db.insert(uploads).values({ noteId, mime: "video/mp4", size: video.length, fileName: "talk.mp4" }).returning();
    await writeFile(uploadFilePath(built.uploadsDir, row.id), video);
    return { ...built, token, uploadId: row.id, video };
  }

  it("token form: a media player's Range, If-Range and HEAD requests, with the video's inline headers", async () => {
    const { app, token, uploadId, video } = await publishedVideo();
    const url = `/api/public/notes/${token}/uploads/${uploadId}`;
    await expectRangeServing(opts => app.inject({ method: opts?.method ?? "GET", url, headers: opts?.headers }), video);
    const res = await app.inject({ method: "GET", url });
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-security-policy"]).toBe(UPLOAD_CSP);
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"talk.mp4\"; filename*=UTF-8''talk.mp4");
  });

  it("alias form: the same Range, If-Range and HEAD behaviour and headers as the token form", async () => {
    const { app, token, uploadId, video } = await publishedVideo();
    const url = `/api/public/notes/alice/talk/uploads/${uploadId}`;
    await expectRangeServing(opts => app.inject({ method: opts?.method ?? "GET", url, headers: opts?.headers }), video);
    const viaAlias = await app.inject({ method: "GET", url, headers: { range: "bytes=0-1" } });
    const viaToken = await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/${uploadId}`, headers: { range: "bytes=0-1" } });
    for (const h of ["content-type", "content-disposition", "content-security-policy", "cache-control", "content-range", "etag"]) {
      expect(viaAlias.headers[h], h).toBe(viaToken.headers[h]);
    }
  });

  it("Range requests count against publicUpload (300/min per IP and note): seeking all 206, request 301 is 429", async () => {
    const { app, token, uploadId, video } = await publishedVideo();
    const url = `/api/public/notes/${token}/uploads/${uploadId}`;
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({ method: "GET", url, headers: { range: `bytes=${i * 64}-${i * 64 + 63}` } });
      expect(res.statusCode, `range request ${i + 1}`).toBe(206);
    }
    for (let i = 50; i < 300; i++) {
      const res = await app.inject({ method: "GET", url, headers: { range: `bytes=${i % video.length}-` } });
      expect(res.statusCode, `range request ${i + 1}`).toBe(206);
    }
    const over = await app.inject({ method: "GET", url, headers: { range: "bytes=0-1" } });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("too_many_requests");
  }, 60_000);

  it("a PDF on a public link opens inline with its own CSP and no sandbox", async () => {
    const { app, db, uploadsDir, token } = await publishedVideo();
    const [note] = await db.select({ id: notes.id }).from(notes).where(eq(notes.publicToken, token));
    const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
    const [row] = await db.insert(uploads).values({ noteId: note!.id, mime: "application/pdf", size: bytes.length, fileName: "slides.pdf" }).returning();
    await writeFile(uploadFilePath(uploadsDir, row.id), bytes);
    const res = await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/${row.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"slides.pdf\"; filename*=UTF-8''slides.pdf");
  });
});


describe("token never reaches the log (req serializer masking)", () => {
  it("after hitting three token-bearing paths (/p/ HTML fallback plus two public APIs), the whole log contains no token literal and contains the masked :token", async () => {
    const captured: string[] = [];
    const webDist = mkdtempSync(path.join(tmpdir(), "knotebook-pub-log-"));
    writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>t</title>");
    try {
      // Inject only the destination stream; do not supply serializers: otherwise the assertion tests the test's own setup
      // and production (logger: true) with no masking would still pass.
      const { app, db } = await buildTestApp(
        {},
        {
          webDist,
          logger: { level: "info", stream: { write: (line: string) => void captured.push(line) } },
        },
      );
      const owner = await insertUser(db, "owner-log1@example.com");
      const cookie = await cookieFor(owner.id);
      const noteId = await createNote(app, cookie);
      const token = await openPublicLink(app, cookie, noteId);

      await app.inject({ method: "GET", url: `/p/${token}`, headers: { accept: "text/html" } });
      // Leak variants (real socket): the SPA fallback still returns 200 for both shapes.
      await app.inject({ method: "GET", url: `//p/${token}`, headers: { accept: "text/html" } });
      await app.inject({ method: "GET", url: `/P/${token}`, headers: { accept: "text/html" } });
      await app.inject({ method: "GET", url: `/api/public/notes/${token}` });
      await app.inject({ method: "GET", url: `/api/public/notes/${token}/uploads/00000000-0000-0000-0000-000000000000` });

      const all = captured.join("");
      // Logging is really on (guards against passing vacuously when the logger is silently off) and the url is masked to :token.
      expect(all).toContain(":token");
      // Core invariant: the token literal appears in not one byte. This is a load-bearing condition of the "store the original"
      // approach (Fastify's default req serializer prints req.url; the masking serializer that buildApp merges unconditionally blocks it).
      expect(all).not.toContain(token);
    } finally {
      rmSync(webDist, { recursive: true, force: true });
    }
  });
});

describe("public alias endpoint (GET /api/public/notes/:handle/:slug, no login)", () => {
  const byPath = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], handle: string, slug: string, ip?: string) =>
    app.inject({ method: "GET", url: `/api/public/notes/${handle}/${slug}`, ...(ip ? { remoteAddress: ip } : {}) });
  const byToken = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], token: string, ip?: string) =>
    app.inject({ method: "GET", url: `/api/public/notes/${token}`, ...(ip ? { remoteAddress: ip } : {}) });

  async function aliasSetup(handle: string, alias: string, overrides: Parameters<typeof buildTestApp>[0] = {}) {
    const built = await buildTestApp(overrides);
    const owner = await insertUser(built.db, `${handle}@example.com`, handle);
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(built.app, cookie);
    const token = await openPublicLink(built.app, cookie, noteId);
    const set = await built.app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: alias } });
    expect(set.statusCode).toBe(200);
    return { ...built, owner, cookie, noteId, token };
  }

  it("hit -> 200 with the same shape as the token endpoint (exactly {title, ydoc, links, width}, no token) plus cache-control: no-store", async () => {
    const { app, db, cookie, noteId, token } = await aliasSetup("alice", "my-doc");
    await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Alias Note" } });
    const ydocBytes = realYdocBytes();
    await db.insert(noteStates).values({ noteId, ydoc: ydocBytes });

    const res = await byPath(app, "alice", "my-doc");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    // Exactly four keys (#269 added links, #297 added width): any of token/noteId/updatedAt leaking in turns this red.
    expect(res.json()).toEqual({ title: "Alias Note", ydoc: ydocBytes.toString("base64"), links: [], width: "standard" });

    const viaToken = await byToken(app, token);
    expect(viaToken.json()).toEqual(res.json());
    expect(viaToken.headers["cache-control"]).toBe("no-store");
  });

  it("three negatives (security core): private slug unreachable, prev_slug not looked up, legacy_slug not looked up", async () => {
    const { app, db, cookie, noteId } = await aliasSetup("bob", "real-alias");
    // Give one note a private slug, prev and legacy value and probe each by-path expecting 404. Both PATCHes must assert
    // 200: if they fail (throttle/validation regression) the three 404s would hit nonexistent values and the test would
    // pass vacuously.
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "private-name" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${noteId}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "private-name-2" } })).statusCode).toBe(200); // prev=private-name
    // legacy is frozen by a trigger (new rows are always NULL): pause the trigger with raw SQL and write in place so all three
    // values sit on the same row (only the same row proves that the same public note's legacy is unreachable too).
    await db.execute(sql`alter table notes disable trigger notes_legacy_slug_guard`);
    await db.update(notes).set({ legacySlug: "old-global-name" }).where(eq(notes.id, noteId));
    await db.execute(sql`alter table notes enable trigger notes_legacy_slug_guard`);
    // Re-check the fixture landed (same reason: all three values really present).
    const [row] = await db.select({ slug: notes.slug, prevSlug: notes.prevSlug, legacySlug: notes.legacySlug }).from(notes).where(eq(notes.id, noteId)).limit(1);
    expect(row).toEqual({ slug: "private-name-2", prevSlug: "private-name", legacySlug: "old-global-name" });

    // Public with an alias, but the private slug is not a public surface (joining the wrong column would make every public note guessable).
    expect((await byPath(app, "bob", "private-name-2")).statusCode).toBe(404);
    // prev_slug is not looked up (copying the private by-path logic would resurrect old values).
    expect((await byPath(app, "bob", "private-name")).statusCode).toBe(404);
    expect((await byPath(app, "bob", "old-global-name")).statusCode).toBe(404);
    // Control: the real alias is alive (the 404s above are not because the whole route is broken).
    expect((await byPath(app, "bob", "real-alias")).statusCode).toBe(200);
  });

  it("read predicate requires a non-null token: a directly inserted leftover row (token NULL, alias set) -> 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "carol@example.com", "carol");
    // The production path (conditional UPDATE plus DELETE clearing both) cannot produce this shape; insert directly to simulate historical/manual leftovers.
    await db.insert(notes).values({ ownerId: owner.id, title: "Residue", publicSlug: "ghost" });
    expect((await byPath(app, "carol", "ghost")).statusCode).toBe(404);
  });

  it("revocation matrix cell by cell: revoke alias -> token alive; regenerate -> alias alive and old token dead; revoke public -> all dead", async () => {
    const { app, cookie, noteId, token } = await aliasSetup("dave", "matrix");
    const del = (url: string) => app.inject({ method: "DELETE", url, cookies: { [SESSION_COOKIE]: cookie } });
    const put = (url: string) => app.inject({ method: "PUT", url, cookies: { [SESSION_COOKIE]: cookie } });

    expect((await del(`/api/notes/${noteId}/public-link/slug`)).statusCode).toBe(204);
    expect((await byPath(app, "dave", "matrix")).statusCode).toBe(404);
    expect((await byToken(app, token)).statusCode).toBe(200);

    expect((await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "matrix" } })).statusCode).toBe(200);
    const regen = await put(`/api/notes/${noteId}/public-link`);
    const token2 = regen.json().token as string;
    expect((await byPath(app, "dave", "matrix")).statusCode).toBe(200);
    expect((await byToken(app, token)).statusCode).toBe(404);
    expect((await byToken(app, token2)).statusCode).toBe(200);

    expect((await del(`/api/notes/${noteId}/public-link`)).statusCode).toBe(204);
    expect((await byPath(app, "dave", "matrix")).statusCode).toBe(404);
    expect((await byToken(app, token2)).statusCode).toBe(404);
  });

  it("404 is byte-for-byte identical: format guard reject / not found / leftover row, cross-checked against the token endpoint 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, "erin@example.com", "erin");
    await db.insert(notes).values({ ownerId: owner.id, title: "R", publicSlug: "residue" });

    const tokenMiss = await byToken(app, randomToken());
    const guardReject = await byPath(app, "erin", "bad_slug");
    const noMatch = await byPath(app, "erin", "no-such-alias");
    const residue = await byPath(app, "erin", "residue");
    for (const [name, res] of [["guard", guardReject], ["miss", noMatch], ["residue", residue]] as const) {
      expect(res.statusCode, name).toBe(404);
      expect(res.body, name).toBe(tokenMiss.body);
    }
  });

  it("case variants: /Frank/X-Doc is normalized and still hits, sharing one hit bucket with the lowercase form", async () => {
    const { app } = await aliasSetup("frank", "x-doc", {
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    expect((await byPath(app, "Frank", "X-Doc")).statusCode).toBe(200);
    // Both variants resolve to the same note, so they share one quota (429). That the key is bound to noteId is pinned in the next
    // case (same alias across owners, separate buckets); this one only pins that variants do not open separate buckets.
    expect((await byPath(app, "frank", "x-doc")).statusCode).toBe(429);
  });

  it("hit bucket key is bound to noteId: same alias across owners gets separate buckets (a key containing the slug fails here)", async () => {
    // A key written as `${ip}:${q.slug}` would make the same IP reading two owners' same-named aliases share quota. Same-named
    // aliases across owners is a valid state pinned by the management tests, so the public side must not charge across them.
    const { app, db } = await buildTestApp({
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    for (const handle of ["ada", "brian"]) {
      const u = await insertUser(db, `${handle}@example.com`, handle);
      const cookie = await cookieFor(u.id);
      const noteId = await createNote(app, cookie);
      await openPublicLink(app, cookie, noteId);
      expect((await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "shared-name" } })).statusCode).toBe(200);
    }
    expect((await byPath(app, "ada", "shared-name")).statusCode).toBe(200);
    expect((await byPath(app, "brian", "shared-name")).statusCode).toBe(200);
  });

  it("alias slug goes through the Unicode funnel (normalizeSlug NFC plus Unicode lowercase, not the handle's ASCII funnel)", async () => {
    // Replacing pathSpec.guard's normalizeSlug with normalizeHandle (ASCII-only) would leave the suite green; the private
    // by-path had the same hole (the NFD case in notes-slug.test.ts). Management stores café as NFC; the public URL in NFD
    // (e + U+0301) and in Unicode uppercase CAFÉ must both hit. All three fixtures use code-point escapes: a literal é would be
    // auto-normalized by editors/toolchains and the NFD case would silently become NFC against NFC.
    const { app } = await aliasSetup("nfd-owner", "caf\u00e9"); // NFC
    expect((await byPath(app, "nfd-owner", "cafe\u0301")).statusCode).toBe(200);
    expect((await byPath(app, "nfd-owner", "CAF\u00c9")).statusCode).toBe(200);
  });
  it("throttle key isolation: the token form and the by-path form of one note are charged separately (same limiter instance, different key shape)", async () => {
    const { app, token } = await aliasSetup("grace", "iso-doc", {
      limiters: limitersWithPublic({ publicNote: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    expect((await byToken(app, token)).statusCode).toBe(200);
    expect((await byToken(app, token)).statusCode).toBe(429);
    // By-path form is unaffected (key = ip:path:<noteId> vs ip:token); a second request is 429.
    expect((await byPath(app, "grace", "iso-doc")).statusCode).toBe(200);
    expect((await byPath(app, "grace", "iso-doc")).statusCode).toBe(429);
  });

  it("shared miss bucket: a by-path miss uses up the ip bucket, so the token form's next miss is 429 (both forms share publicMiss)", async () => {
    const { app } = await aliasSetup("heidi", "real-doc", {
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    expect((await byPath(app, "heidi", "no-such")).statusCode).toBe(404);
    expect((await byToken(app, randomToken())).statusCode).toBe(429);
  });

  it("format guard before everything: invalid handle/slug -> same-shape 404, no miss bucket, no DB query", async () => {
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    const { app } = await buildTestApp({
      db: loggedDb,
      gate: new UserGate(loggedDb),
      limiters: limitersWithPublic({ publicMiss: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const owner = await insertUser(db, "ivan@example.com", "ivan");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(app, cookie);
    await openPublicLink(app, cookie, noteId);

    queries.length = 0;
    for (const [h, s] of [["bad_handle", "ok-slug"], ["ivan", "a_b"], ["ivan", "new"], ["x".repeat(200), "y"]] as const) {
      const res = await byPath(app, h, s);
      expect(res.statusCode, `${h}/${s}`).toBe(404);
    }
    expect(queries.filter(q => /^select/i.test(q.trim()))).toHaveLength(0);
    // Not entering the bucket: miss limit 1 was not consumed above, so a real miss still works (404 not 429).
    expect((await byPath(app, "ivan", "not-set")).statusCode).toBe(404);
  });

  it("rename interaction (#291): after a real rename /p/<old>/<slug> is 404 (before anyone takes it) and /p/<new>/<slug> works; once someone else takes the old name it resolves to the new owner", async () => {
    const { app, db, cookie } = await aliasSetup("judy", "moving-doc");
    // Uses the real endpoint (PATCH /api/auth/profile needs a registry row; backfill supplies it). Y is created first so one
    // backfill covers both (backfilling after the rename would sweep the released row and hide the release shape).
    const y = await insertUser(db, "yara@example.com", "yara");
    await backfillHandleRegistry(db, { warn: () => {}, info: () => {} } as unknown as pino.Logger);
    const renamed = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "judy-new" }, cookies: { [SESSION_COOKIE]: cookie } });
    expect(renamed.statusCode).toBe(200);

    expect((await byPath(app, "judy", "moving-doc")).statusCode).toBe(404);
    expect((await byPath(app, "judy-new", "moving-doc")).statusCode).toBe(200);

    // #291: Y takes judy. Without Y's alias -> 404; with a same-named alias -> resolves to Y's note.
    const yCookie = await cookieFor(y.id);
    const taken = await app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle: "judy" }, cookies: { [SESSION_COOKIE]: yCookie } });
    expect(taken.statusCode).toBe(200);
    expect((await byPath(app, "judy", "moving-doc")).statusCode).toBe(404);
    const yNote = await createNote(app, yCookie);
    const titled = await app.inject({ method: "PATCH", url: `/api/notes/${yNote}`, cookies: { [SESSION_COOKIE]: yCookie }, payload: { title: "Yara Doc" } });
    expect(titled.statusCode).toBe(200);
    await openPublicLink(app, yCookie, yNote);
    const setSlug = await app.inject({ method: "PUT", url: `/api/notes/${yNote}/public-link/slug`, cookies: { [SESSION_COOKIE]: yCookie }, payload: { slug: "moving-doc" } });
    expect(setSlug.statusCode).toBe(200);
    const viaOld = await byPath(app, "judy", "moving-doc");
    expect(viaOld.statusCode).toBe(200);
    expect(viaOld.json().title).toBe("Yara Doc");
    expect((await byPath(app, "judy-new", "moving-doc")).statusCode).toBe(200);
  });
});

describe("public alias image endpoint (GET /api/public/notes/:handle/:slug/uploads/:uploadId)", () => {
  async function uploadSetup() {
    const uploadsDir = mkdtempSync(path.join(tmpdir(), "knb-alias-up-"));
    const built = await buildTestApp({ uploadsDir });
    const owner = await insertUser(built.db, "kim@example.com", "kim");
    const cookie = await cookieFor(owner.id);
    const noteId = await createNote(built.app, cookie);
    await openPublicLink(built.app, cookie, noteId);
    await built.app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "pics" } });
    const [up] = await built.db.insert(uploads).values({ noteId, mime: "image/png", size: 4 }).returning();
    await writeFile(uploadFilePath(uploadsDir, up.id), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return { ...built, cookie, noteId, uploadId: up.id, uploadsDir };
  }

  it("upload of this note -> 200 with the same headers as the token version (nosniff / CSP sandbox / private immutable / mime)", async () => {
    const { app, uploadsDir, uploadId } = await uploadSetup();
    try {
      const res = await app.inject({ method: "GET", url: `/api/public/notes/kim/pics/uploads/${uploadId}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox");
      expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true });
    }
  });

  it("alias uploads draw on the publicUpload bucket (not publicNote): with uploads limit 1 the 2nd is 429 and the content endpoint is unaffected", async () => {
    // Pins the new route's limiter wiring: if it were wired to the publicNote bucket (60/min vs 300/min), images would eat
    // content quota and a looser assertion would stay green.
    const uploadsDir = mkdtempSync(path.join(tmpdir(), "knb-alias-lim-"));
    try {
      const { app, db } = await buildTestApp({
        uploadsDir,
        limiters: limitersWithPublic({ publicUpload: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
      });
      const owner = await insertUser(db, "leo@example.com", "leo");
      const cookie = await cookieFor(owner.id);
      const noteId = await createNote(app, cookie);
      await openPublicLink(app, cookie, noteId);
      await app.inject({ method: "PUT", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "pics2" } });
      const [up] = await db.insert(uploads).values({ noteId, mime: "image/png", size: 1 }).returning();
      await writeFile(uploadFilePath(uploadsDir, up.id), Buffer.from([0x89]));

      expect((await app.inject({ method: "GET", url: `/api/public/notes/leo/pics2/uploads/${up.id}` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/public/notes/leo/pics2/uploads/${up.id}` })).statusCode).toBe(429);
      // Buckets are separate: a full uploads bucket does not affect the content endpoint (publicNote bucket).
      expect((await app.inject({ method: "GET", url: "/api/public/notes/leo/pics2" })).statusCode).toBe(200);
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true });
    }
  });

  it("upload id of another note -> 404; after revoking the alias the same URL gives the same-shape 404 as the link (same resolve pipeline)", async () => {
    const { app, db, cookie, noteId, uploadsDir, uploadId } = await uploadSetup();
    try {
      const otherNote = await createNote(app, cookie);
      const [foreign] = await db.insert(uploads).values({ noteId: otherNote, mime: "image/png", size: 1 }).returning();
      const cross = await app.inject({ method: "GET", url: `/api/public/notes/kim/pics/uploads/${foreign.id}` });
      expect(cross.statusCode).toBe(404);

      await app.inject({ method: "DELETE", url: `/api/notes/${noteId}/public-link/slug`, cookies: { [SESSION_COOKIE]: cookie } });
      const gone = await app.inject({ method: "GET", url: `/api/public/notes/kim/pics/uploads/${uploadId}` });
      expect(gone.statusCode).toBe(404);
      const tokenMiss = await app.inject({ method: "GET", url: `/api/public/notes/${randomToken()}` });
      expect(gone.body).toBe(tokenMiss.body);
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true });
    }
  });
});
