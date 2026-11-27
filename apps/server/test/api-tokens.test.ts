import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE, type TokenScope } from "@knotebook/shared";
import type { FastifyInstance } from "fastify";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { apiTokens, oauthClients } from "../src/db/schema.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";
import { hashToken } from "../src/auth/api-token.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { buildTestApp, freshLimiters, insertPasswordUser, signTestSession } from "./helpers.js";

/**
 * The PAT management endpoints are **cookie only**, so every case needs a signed-in session. The cookie is signed directly (repo convention, see cookieFor in
 * test/admin-ai.test.ts) rather than going through login: the `mustChangePassword: true` case would get stuck in the forced first-login password change.
 * The account is made with `insertPasswordUser` (real password, needed by the change-password case).
 */
async function signedInApp(
  over: { overrides?: Partial<AppDeps>; mustChangePassword?: boolean; password?: string } = {}
): Promise<{ app: FastifyInstance; db: Db; cookie: string; userId: string; password: string }> {
  const { app, db } = await buildTestApp(over.overrides ?? {});
  const user = await insertPasswordUser(db, {
    mustChangePassword: over.mustChangePassword ?? false,
    password: over.password,
  });
  const cookie = await signTestSession({ userId: user.id, tv: 0 });
  return { app, db, cookie, userId: user.id, password: user.password };
}

async function anotherUser(db: Db): Promise<{ userId: string; cookie: string }> {
  const user = await insertPasswordUser(db);
  return { userId: user.id, cookie: await signTestSession({ userId: user.id, tv: 0 }) };
}

type CreateBody = { name: string; scope: TokenScope | "notes:write"; expiresInDays: 30 | 90 | 365 | null };

function create(app: FastifyInstance, cookie: string, payload: CreateBody) {
  return app.inject({ method: "POST", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie }, payload });
}

const READ_FOREVER: CreateBody = { name: "n", scope: "notes:read", expiresInDays: null };

describe("PAT management endpoints", () => {
  it("create -> plaintext appears only once, DB stores only sha256", async () => {
    const { app, db, cookie } = await signedInApp();
    const res = await create(app, cookie, { name: "  Claude Desktop  ", scope: "notes:write", expiresInDays: null });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("Claude Desktop");
    expect(body.agentLabel).toBe("claude"); // the derived value must exist at creation time too - the list updates directly from this response
    expect(body.token).toMatch(/^knb_[A-Za-z0-9_-]{43}$/);
    expect(body.scope).toBe("notes:read notes:write"); // stored form is a set
    expect(body.expiresAt).toBeNull();

    const rows = await db.select().from(apiTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenHash).not.toContain(body.token);
    expect(rows[0].accessTokenHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } });
    expect(JSON.stringify(list.json())).not.toContain(body.token);
    expect(list.json().tokens[0]).toMatchObject({ kind: "pat", name: "Claude Desktop", scope: "notes:read notes:write" });
  });

  it("a created token really passes Bearer authentication (hash is the same scheme as bearer.ts)", async () => {
    const { app, cookie } = await signedInApp();
    const { token } = (await create(app, cookie, READ_FOREVER)).json();
    const res = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it("expiresInDays accepts only 30/90/365/null; other values 400; empty name 400", async () => {
    const { app, cookie } = await signedInApp();
    for (const expiresInDays of [30, 90, 365, null] as const) {
      const res = await create(app, cookie, { name: "n", scope: "notes:read", expiresInDays });
      expect(res.statusCode, String(expiresInDays)).toBe(201);
      if (expiresInDays !== null) {
        const delta = new Date(res.json().expiresAt).getTime() - Date.now();
        expect(Math.abs(delta - expiresInDays * 86_400_000)).toBeLessThan(60_000);
      }
    }
    // negative cases deliberately feed out-of-type values, single cast
    const badDays = { name: "n", scope: "notes:read", expiresInDays: 7 } as unknown as CreateBody;
    expect((await create(app, cookie, badDays)).statusCode).toBe(400);
    expect((await create(app, cookie, { name: "", scope: "notes:read", expiresInDays: null })).statusCode).toBe(400);
    expect((await create(app, cookie, { name: "   ", scope: "notes:read", expiresInDays: null })).statusCode).toBe(400);
    expect((await create(app, cookie, { name: "x".repeat(65), scope: "notes:read", expiresInDays: null })).statusCode).toBe(400);
  });

  it("the 21st token gets 409 token_limit", async () => {
    const { app, cookie } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }) },
    });
    for (let i = 0; i < 20; i += 1) {
      expect((await create(app, cookie, { name: `t${i}`, scope: "notes:read", expiresInDays: null })).statusCode, `#${i}`).toBe(201);
    }
    const over = await create(app, cookie, { name: "t20", scope: "notes:read", expiresInDays: null });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe("token_limit");
  });

  it("expired PATs don't count toward the quota", async () => {
    const { app, db, cookie, userId } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }) },
    });
    // Insert 20 PATs "expired 1 day ago" directly - they must not block the 21st
    for (let i = 0; i < 20; i += 1) {
      await db.insert(apiTokens).values({
        userId,
        kind: "pat",
        name: `old${i}`,
        scope: "notes:read",
        // Use padStart, not padEnd: `h1`.padEnd(64,"0") and `h10`.padEnd(64,"0") are the same string, so round 11 would collide with the
        // access_token_hash unique index and the test would blow up in arrange (with an error that looks unrelated to the quota).
        accessTokenHash: `${i}`.padStart(64, "0"),
        accessExpiresAt: new Date(Date.now() - 86_400_000),
      });
    }
    expect((await create(app, cookie, { name: "fresh", scope: "notes:read", expiresInDays: null })).statusCode).toBe(201);
  });

  it("an oauth grant counts toward the quota even if its access has expired (refresh never expires)", async () => {
    const { app, db, cookie, userId } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }) },
    });
    // One user can have only one oauth grant per client (per-owner partial unique), so 20 grants need 20 different clients.
    for (let i = 0; i < 20; i += 1) {
      await db.insert(oauthClients).values({ clientId: `c-quota-${i}`, clientName: "C", redirectUris: ["http://127.0.0.1:1/cb"] });
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: `g${i}`,
        scope: "notes:read",
        accessTokenHash: `a${i}`.padStart(64, "0"),
        refreshTokenHash: `r${i}`.padStart(64, "0"),
        clientId: `c-quota-${i}`,
        accessExpiresAt: new Date(Date.now() - 86_400_000),
      });
    }
    const over = await create(app, cookie, { name: "fresh", scope: "notes:read", expiresInDays: null });
    expect(over.statusCode).toBe(409);

    // The list is "all of the user's grants": the oauth row appears, has a clientId, and is still listed with expired access
    const list = await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } });
    const rows = list.json().tokens as Array<{ kind: string; clientId: string | null; expiresAt: string | null; name: string }>;
    expect(rows).toHaveLength(20);
    const g0 = rows.find(r => r.name === "g0");
    expect(g0).toMatchObject({ kind: "oauth", clientId: "c-quota-0" });
    expect(new Date(g0!.expiresAt!).getTime()).toBeLessThan(Date.now());
  });

  it("opportunistic cleanup: creating a token also removes PATs expired for more than 30 days and keeps those under 30 days; oauth grants are not cleaned", async () => {
    const { app, db, cookie, userId } = await signedInApp();
    // An oauth grant's access expiry doesn't mean the grant is invalid (refresh never expires): the only barrier against cleaning oauth grants
    // along with PATs is the query condition, which literally says kind='pat'.
    await db.insert(oauthClients).values({ clientId: "c-old", clientName: "C", redirectUris: ["http://127.0.0.1:1/cb"] });
    await db.insert(apiTokens).values({
      userId,
      kind: "oauth",
      name: "oauth-old",
      scope: "notes:read",
      accessTokenHash: "c".repeat(64),
      refreshTokenHash: "d".repeat(64),
      clientId: "c-old",
      accessExpiresAt: new Date(Date.now() - 31 * 86_400_000),
    });
    await db.insert(apiTokens).values({
      userId,
      kind: "pat",
      name: "ancient",
      scope: "notes:read",
      accessTokenHash: "a".repeat(64),
      accessExpiresAt: new Date(Date.now() - 31 * 86_400_000),
    });
    await db.insert(apiTokens).values({
      userId,
      kind: "pat",
      name: "recent",
      scope: "notes:read",
      accessTokenHash: "b".repeat(64),
      accessExpiresAt: new Date(Date.now() - 29 * 86_400_000),
    });
    // Creating a PAT runs the full set of cleanups (`oauth/cleanup.ts`), not just the PAT one. This client unused for 31 days triggers
    // the unused-client cleanup - without it, swapping the call back to the PAT-only version would still be green.
    await db.insert(oauthClients).values({
      clientId: "c-stale",
      clientName: "Stale",
      redirectUris: ["http://127.0.0.1:1/cb"],
      lastUsedAt: new Date(Date.now() - 31 * 86_400_000),
    });
    await db.insert(apiTokens).values({
      userId,
      kind: "oauth",
      name: "stale-grant",
      scope: "notes:read",
      accessTokenHash: "e".repeat(64),
      refreshTokenHash: "f".repeat(64),
      clientId: "c-stale",
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    });

    await create(app, cookie, { name: "new", scope: "notes:read", expiresInDays: null });
    const names = (await db.select().from(apiTokens)).map(r => r.name).sort();
    expect(names).toEqual(["new", "oauth-old", "recent"]);
    // the unused-for-30-days client is removed together with its grant (CASCADE)
    expect((await db.select({ id: oauthClients.clientId }).from(oauthClients)).map(r => r.id)).toEqual(["c-old"]);
  });

  it("rate limit: exceeding PAT_CREATE -> 429", async () => {
    const { app, cookie } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 2, windowMs: 3_600_000 }) }) },
    });
    for (let i = 0; i < 2; i += 1) {
      expect((await create(app, cookie, { name: `t${i}`, scope: "notes:read", expiresInDays: null })).statusCode).toBe(201);
    }
    expect((await create(app, cookie, { name: "t2", scope: "notes:read", expiresInDays: null })).statusCode).toBe(429);
  });

  it("user with mustChangePassword -> 403, and doesn't consume rate-limit quota", async () => {
    const { app, cookie } = await signedInApp({
      mustChangePassword: true,
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) }) },
    });
    for (let i = 0; i < 2; i += 1) {
      const res = await create(app, cookie, READ_FOREVER);
      expect(res.statusCode, `#${i}`).toBe(403); // if the 2nd became 429 the order would be wrong
    }
  });

  it("revoke: deletes only that token (the other must remain), 204 and takes effect immediately; nonexistent/non-uuid -> 404 token_not_found", async () => {
    const { app, db, cookie } = await signedInApp();
    const { id, token } = (await create(app, cookie, READ_FOREVER)).json();
    // A second token: if the WHERE lost the id half (only user_id left) all of the user's tokens would be deleted - with just one token
    // "deleted everything" and "deleted the right one" are indistinguishable.
    const other = (await create(app, cookie, { name: "other", scope: "notes:read", expiresInDays: null })).json();

    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    // pg uuid comparison is case-insensitive, so an uppercase path must also revoke
    expect(
      (await app.inject({ method: "DELETE", url: `/api/auth/tokens/${String(id).toUpperCase()}`, cookies: { [SESSION_COOKIE]: cookie } })).statusCode
    ).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect(await db.select().from(apiTokens).where(eq(apiTokens.id, id))).toHaveLength(0);
    expect(await db.select().from(apiTokens).where(eq(apiTokens.id, other.id))).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${other.token}` } })).statusCode).toBe(200);

    const missing = await app.inject({
      method: "DELETE",
      url: "/api/auth/tokens/00000000-0000-0000-0000-000000000000",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("token_not_found");
    // A non-uuid :id is also 404 (pg's 22P02 must not surface as a 500)
    const notUuid = await app.inject({ method: "DELETE", url: "/api/auth/tokens/not-a-uuid", cookies: { [SESSION_COOKIE]: cookie } });
    expect(notUuid.statusCode).toBe(404);
    expect(notUuid.json().error.code).toBe("token_not_found");
  });

  it("cross-user isolation: B can't see or delete A's tokens, and A filling 20 doesn't use B's quota", async () => {
    const { app, db, cookie: cookieA } = await signedInApp({
      overrides: { limiters: freshLimiters({ patCreate: new FixedWindowLimiter({ limit: 100, windowMs: 3_600_000 }) }) },
    });
    const b = await anotherUser(db);

    const created = await create(app, cookieA, { name: "A only", scope: "notes:read", expiresInDays: null });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const listB = await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: b.cookie } });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().tokens).toEqual([]);

    // B revoking A's token -> 404 and the row remains (deleting the user_id condition from the WHERE turns this red)
    const revokeByB = await app.inject({ method: "DELETE", url: `/api/auth/tokens/${id}`, cookies: { [SESSION_COOKIE]: b.cookie } });
    expect(revokeByB.statusCode).toBe(404);
    expect(revokeByB.json().error.code).toBe("token_not_found");
    expect(await db.select().from(apiTokens).where(eq(apiTokens.id, id))).toHaveLength(1);

    // B's own quota is unaffected by A's tokens (the quota query also carries user_id) - A fills 20 first;
    // without the user_id condition B's first would be 409.
    for (let i = 1; i < 20; i += 1) {
      expect((await create(app, cookieA, { name: `A${i}`, scope: "notes:read", expiresInDays: null })).statusCode, `A#${i}`).toBe(201);
    }
    expect((await create(app, cookieA, { name: "A20", scope: "notes:read", expiresInDays: null })).statusCode).toBe(409);
    expect((await create(app, b.cookie, { name: "B only", scope: "notes:read", expiresInDays: null })).statusCode).toBe(201);
  });

  it("list is newest first by creation time", async () => {
    const { app, cookie } = await signedInApp();
    await create(app, cookie, { name: "first", scope: "notes:read", expiresInDays: null });
    await new Promise(resolve => setTimeout(resolve, 5));
    await create(app, cookie, { name: "second", scope: "notes:read", expiresInDays: null });
    const list = await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } });
    expect(list.json().tokens.map((t: { name: string }) => t.name)).toEqual(["second", "first"]);
  });

  it("existing tokens stay valid after a password change", async () => {
    const { app, cookie, password } = await signedInApp({ password: "correct-horse-battery" });
    const { token } = (await create(app, cookie, READ_FOREVER)).json();
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: password, newPassword: "another-long-password-1" },
    });
    expect(changed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it("PAT management endpoints are cookie-only: Bearer on all four -> 401 without challenge", async () => {
    const { app, cookie } = await signedInApp();
    const created = (await create(app, cookie, READ_FOREVER)).json();
    const auth = { authorization: `Bearer ${created.token}` };
    const cases = [
      ["GET", "/api/auth/tokens"],
      ["POST", "/api/auth/tokens"],
      // #106: renaming is no exception - if a leaked token could rename itself, the name tag would no longer show
      // the identity the user authorized.
      ["PATCH", `/api/auth/tokens/${created.id}`],
      // #239: PATCH can also change scope; if Bearer reached it, a leaked read/write token could upgrade itself to move.
      // Authentication is in preHandler, before the body is read, so the {agentLabel} row already covers it; this row spells out the scope shape.
      ["PATCH", `/api/auth/tokens/${created.id}`, { scope: RWM }],
      ["DELETE", `/api/auth/tokens/${created.id}`],
    ] as const;
    for (const [method, url, body] of cases) {
      const res = await app.inject({
        method,
        url,
        headers: auth,
        ...(method === "POST" ? { payload: READ_FOREVER } : {}),
        ...(method === "PATCH" ? { payload: body ?? { agentLabel: "x" } } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.headers["www-authenticate"], `${method} ${url}`).toBeUndefined();
    }
  });
});

async function seedOauthGrant(db: Db, userId: string, clientId = "client-1"): Promise<string> {
  await db
    .insert(oauthClients)
    .values({ clientId, clientName: "MCP CLI Proxy", redirectUris: ["http://127.0.0.1:1/cb"] })
    .onConflictDoNothing();
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId,
      kind: "oauth",
      name: "MCP CLI Proxy",
      scope: "notes:read",
      clientId,
      accessTokenHash: hashToken(`a-${userId}-${clientId}`),
      refreshTokenHash: hashToken(`r-${userId}-${clientId}`),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: apiTokens.id });
  return row!.id;
}

describe("PATCH /api/auth/tokens/:id (agent name)", () => {
  it("both kinds PATCH 200 with the new agentLabel; GET list has agentLabel on every row (NULL returns the derived value)", async () => {
    const { app, db, cookie, userId } = await signedInApp();
    const pat = await create(app, cookie, { name: "Claude Code (knotebook)", scope: "notes:read", expiresInDays: null });
    expect(pat.statusCode).toBe(201);
    const patId = pat.json().id as string;
    const oauthId = await seedOauthGrant(db, userId);
    const list0 = (await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } })).json().tokens;
    expect(list0.find((t: { id: string }) => t.id === patId).agentLabel).toBe("claude");
    expect(list0.find((t: { id: string }) => t.id === oauthId).agentLabel).toBe("mcp");
    for (const id of [patId, oauthId]) {
      const r = await app.inject({
        method: "PATCH",
        url: `/api/auth/tokens/${id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { agentLabel: "bot-1" },
      });
      expect(r.statusCode, id).toBe(200);
      expect(r.json().agentLabel).toBe("bot-1");
    }
    const list1 = (await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } })).json().tokens;
    expect(list1.every((t: { agentLabel: unknown }) => t.agentLabel === "bot-1")).toBe(true);
  });

  it("bad format/contains NUL/unknown field/empty string/33 characters -> 400 invalid_body; null -> reset to the derived value and the column really is NULL; someone else's -> 404", async () => {
    const { app, db, cookie } = await signedInApp();
    const patId = (await create(app, cookie, { name: "Claude Code", scope: "notes:read", expiresInDays: null })).json().id as string;
    const NUL = String.fromCharCode(0);
    for (const body of [
      { agentLabel: "bad label!" },
      { agentLabel: `a${NUL}` },
      { agentLabel: "x", extra: 1 },
      { agentLabel: "" },
      { agentLabel: "a".repeat(33) },
    ]) {
      const r = await app.inject({
        method: "PATCH",
        url: `/api/auth/tokens/${patId}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: body,
      });
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
    }
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/auth/tokens/${patId}`,
          cookies: { [SESSION_COOKIE]: cookie },
          payload: { agentLabel: "renamed" },
        })
      ).json().agentLabel
    ).toBe("renamed");
    // The character set must match the DB CHECK (`api_tokens_agent_label_chk`) exactly - use a value with both underscore and dot so both sides
    // really accept those characters (placed before the "reset to NULL" step, otherwise the empty-value assertion would mask it).
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/auth/tokens/${patId}`,
          cookies: { [SESSION_COOKIE]: cookie },
          payload: { agentLabel: "bot_1.pro" },
        })
      ).json().agentLabel
    ).toBe("bot_1.pro");
    const reset = await app.inject({
      method: "PATCH",
      url: `/api/auth/tokens/${patId}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { agentLabel: null },
    });
    expect(reset.json().agentLabel).toBe("claude"); // the response is the derived value
    // The column is really cleared (not the derived value written in) - looking at the response alone, both implementations pass
    expect((await db.select({ l: apiTokens.agentLabel }).from(apiTokens).where(eq(apiTokens.id, patId)))[0]!.l).toBeNull();
    const other = await anotherUser(db);
    const r404 = await app.inject({
      method: "PATCH",
      url: `/api/auth/tokens/${patId}`,
      cookies: { [SESSION_COOKIE]: other.cookie },
      payload: { agentLabel: "x" },
    });
    expect(r404.statusCode).toBe(404);
    expect(r404.json().error.code).toBe("token_not_found");
    // Path-parameter half of the id validation (same as the not-a-uuid cell of DELETE): non-uuid and NUL-containing :id are always 404,
    // never letting the string into SQL (pg's 22P02 on the uuid column would surface as a 500). These two lines are the test of PATCH's `UUID_RE`
    // check: removing that check leaves every other case in this file green.
    for (const bad of ["not-a-uuid", encodeURIComponent(`a${NUL}b`)]) {
      const r = await app.inject({
        method: "PATCH",
        url: `/api/auth/tokens/${bad}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { agentLabel: "x" },
      });
      expect(r.statusCode, bad).toBe(404);
      expect(r.json().error.code, bad).toBe("token_not_found");
    }
  });

  it("TOKEN_RENAME_LIMIT: with limit 3 injected, the 4th is 429", async () => {
    const { app, cookie } = await signedInApp({
      overrides: { limiters: freshLimiters({ tokenRename: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) }) },
    });
    const patId = (await create(app, cookie, { name: "t", scope: "notes:read", expiresInDays: null })).json().id as string;
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/auth/tokens/${patId}`,
            cookies: { [SESSION_COOKIE]: cookie },
            payload: { agentLabel: `l${i}` },
          })
        ).statusCode,
        `#${i}`
      ).toBe(200);
    }
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/auth/tokens/${patId}`,
          cookies: { [SESSION_COOKIE]: cookie },
          payload: { agentLabel: "l3" },
        })
      ).statusCode
    ).toBe(429);
  });

  it("user A renaming doesn't affect B's grant for the same client", async () => {
    const { app, db, cookie, userId } = await signedInApp();
    const b = await anotherUser(db);
    const aGrant = await seedOauthGrant(db, userId, "shared-client");
    const bGrant = await seedOauthGrant(db, b.userId, "shared-client");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/auth/tokens/${aGrant}`,
          cookies: { [SESSION_COOKIE]: cookie },
          payload: { agentLabel: "a-name" },
        })
      ).statusCode
    ).toBe(200);
    expect((await db.select({ l: apiTokens.agentLabel }).from(apiTokens).where(eq(apiTokens.id, bGrant)))[0]!.l).toBeNull();
    const bList = (await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: b.cookie } })).json().tokens;
    expect(bList.find((t: { id: string }) => t.id === bGrant).agentLabel).toBe("mcp");
  });
});

const RWM = "notes:read notes:write notes:move";
function patch(app: FastifyInstance, cookie: string, id: string, payload: unknown) {
  return app.inject({ method: "PATCH", url: `/api/auth/tokens/${id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: payload as object });
}

describe("#239 POST scope", () => {
  it("accepts read, read/write, read/write/move and the old alias notes:write; rejects the single value notes:move", async () => {
    const { app, cookie } = await signedInApp();
    for (const [sent, stored] of [
      ["notes:read", "notes:read"],
      ["notes:read notes:write", "notes:read notes:write"],
      [RWM, RWM],
      ["notes:write", "notes:read notes:write"],
    ] as const) {
      const res = await create(app, cookie, { name: `n-${sent}`, scope: sent as never, expiresInDays: null });
      expect(res.statusCode, sent).toBe(201);
      expect(res.json().scope).toBe(stored);
    }
    expect((await create(app, cookie, { name: "bad", scope: "notes:move" as never, expiresInDays: null })).statusCode).toBe(400);
  });
});

const RWD = "notes:read notes:write notes:delete";
const RWMD = "notes:read notes:write notes:move notes:delete";

describe("#181 scope (notes:delete)", () => {
  it("POST accepts read/write/delete and read/write/move/delete: 201, response, row and GET list all keep the value; delete without write -> 400", async () => {
    const { app, db, cookie } = await signedInApp();
    const ids: Record<string, string> = {};
    for (const scope of [RWD, RWMD]) {
      const res = await create(app, cookie, { name: `n-${scope}`, scope: scope as never, expiresInDays: null });
      expect(res.statusCode, scope).toBe(201);
      expect(res.json().scope, scope).toBe(scope);
      ids[scope] = res.json().id as string;
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, ids[scope]!));
      expect(row!.scope, scope).toBe(scope);
    }
    const listed = (await app.inject({ method: "GET", url: "/api/auth/tokens", cookies: { [SESSION_COOKIE]: cookie } })).json().tokens as Array<{ id: string; scope: string }>;
    expect(listed.find(t => t.id === ids[RWD])!.scope).toBe(RWD);
    expect(listed.find(t => t.id === ids[RWMD])!.scope).toBe(RWMD);
    for (const scope of ["notes:read notes:delete", "notes:delete", "notes:read notes:write notes:delete notes:move"]) {
      expect((await create(app, cookie, { name: "bad", scope: scope as never, expiresInDays: null })).statusCode, scope).toBe(400);
    }
  });
  it("PATCH to read/write/delete and read/write/move/delete -> 200 with the original value, row too; alias notes:write and delete without write -> 400", async () => {
    const { app, db, cookie } = await signedInApp();
    const id = (await create(app, cookie, READ_FOREVER)).json().id as string;
    for (const scope of [RWD, RWMD]) {
      const res = await patch(app, cookie, id, { scope });
      expect(res.statusCode, scope).toBe(200);
      expect(res.json().scope, scope).toBe(scope);
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
      expect(row!.scope, scope).toBe(scope);
    }
    for (const scope of ["notes:write", "notes:read notes:delete"]) {
      const bad = await patch(app, cookie, id, { scope });
      expect(bad.statusCode, scope).toBe(400);
      expect(bad.json().error.message, scope).toBe("Invalid scope.");
    }
  });
});

describe("#239 PATCH scope", () => {
  it("both upgrade and downgrade take effect and return the DTO; someone else's id -> 404 and their row is unchanged", async () => {
    const { app, db, cookie } = await signedInApp();
    const id = (await create(app, cookie, READ_FOREVER)).json().id as string;
    const up = await patch(app, cookie, id, { scope: RWM });
    expect(up.statusCode).toBe(200);
    expect(up.json().scope).toBe(RWM);
    expect((await patch(app, cookie, id, { scope: "notes:read" })).json().scope).toBe("notes:read");
    const other = await anotherUser(db);
    const theirs = (await create(app, other.cookie, READ_FOREVER)).json().id as string;
    expect((await patch(app, cookie, theirs, { scope: RWM })).statusCode).toBe(404);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, theirs));
    expect(row!.scope).toBe("notes:read");
  });
  it("oauth rows can be changed too", async () => {
    const { app, db, cookie, userId } = await signedInApp();
    await db.insert(oauthClients).values({ clientId: "c-239", clientName: "C", redirectUris: ["http://127.0.0.1:1/cb"] });
    const [row] = await db
      .insert(apiTokens)
      .values({ userId, kind: "oauth", name: "app", scope: "notes:read", accessTokenHash: "e".repeat(64), refreshTokenHash: "f".repeat(64), clientId: "c-239", accessExpiresAt: new Date(Date.now() + 86_400_000) })
      .returning();
    const res = await patch(app, cookie, row!.id, { scope: RWM });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "oauth", scope: RWM });
  });
  it("{} -> 400; unknown key -> 400; scope not in stored form -> 400 with message 'Invalid scope.'", async () => {
    const { app, cookie } = await signedInApp();
    const id = (await create(app, cookie, READ_FOREVER)).json().id as string;
    expect((await patch(app, cookie, id, {})).statusCode).toBe(400);
    expect((await patch(app, cookie, id, { scope: RWM, extra: 1 })).statusCode).toBe(400);
    // PATCH doesn't accept the "notes:write" alias (the alias is only open on POST); shuffled order and sets missing write are rejected too.
    for (const scope of ["notes:move", "notes:write", "notes:read notes:move", "notes:write notes:read"]) {
      const bad = await patch(app, cookie, id, { scope });
      expect(bad.statusCode, scope).toBe(400);
      expect(bad.json().error.message, scope).toBe("Invalid scope.");
    }
    // The other two messages: invalid agentLabel -> "Invalid agentLabel."; empty object -> "Invalid request body."
    expect((await patch(app, cookie, id, { agentLabel: "bad label!" })).json().error.message).toBe("Invalid agentLabel.");
    expect((await patch(app, cookie, id, {})).json().error.message).toBe("Invalid request body.");
  });
  it("mustChangePassword: with scope -> 403 and the row unchanged; agentLabel only -> 200 (current behaviour)", async () => {
    const { app, db, cookie, userId } = await signedInApp({ mustChangePassword: true });
    const [row] = await db
      .insert(apiTokens)
      .values({ userId, kind: "pat", name: "p", scope: "notes:read", accessTokenHash: "9".repeat(64), accessExpiresAt: null })
      .returning();
    const denied = await patch(app, cookie, row!.id, { scope: RWM });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");
    const [after] = await db.select().from(apiTokens).where(eq(apiTokens.id, row!.id));
    expect(after!.scope).toBe("notes:read");
    expect((await patch(app, cookie, row!.id, { agentLabel: "bot" })).statusCode).toBe(200);
  });
  it("the 403 for mustChangePassword comes before throttling: with 1 attempt left in the bucket, two sends with scope are both 403, and a later pure rename is still 200", async () => {
    const { app, db, cookie, userId } = await signedInApp({
      mustChangePassword: true,
      overrides: { limiters: freshLimiters({ tokenRename: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }) },
    });
    const [row] = await db
      .insert(apiTokens)
      .values({ userId, kind: "pat", name: "p", scope: "notes:read", accessTokenHash: "8".repeat(64), accessExpiresAt: null })
      .returning();
    expect((await patch(app, cookie, row!.id, { scope: RWM })).statusCode).toBe(403);
    expect((await patch(app, cookie, row!.id, { scope: RWM })).statusCode).toBe(403);
    expect((await patch(app, cookie, row!.id, { agentLabel: "bot" })).statusCode).toBe(200);
  });
  it("takes effect on the next request: tools/list of the same token goes 13 <-> 14, read/write/delete 16 (buildTestApp has no collaboration; includes list_trash since #181; the folder feature adds list_folders and four folder write tools, and read/write/delete also has delete_folder; comments add list_notifications)", async () => {
    const { app, cookie } = await signedInApp();
    const created = (await create(app, cookie, { name: "live", scope: "notes:read notes:write", expiresInDays: null })).json();
    const count = async () => ((await mcpPost(app, rpc("tools/list"), { token: created.token })).json().result.tools as unknown[]).length;
    expect(await count()).toBe(13);
    await patch(app, cookie, created.id, { scope: RWM });
    expect(await count()).toBe(14);
    await patch(app, cookie, created.id, { scope: "notes:read notes:write" });
    expect(await count()).toBe(13);
    // #181: RW -> RWD also takes effect on the next request (adds delete_note, restore_note; the folder feature adds delete_folder on top).
    await patch(app, cookie, created.id, { scope: RWD });
    expect(await count()).toBe(16);
  });
});
