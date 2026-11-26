import { vi, describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE, MAX_UPLOAD_BYTES, SITE_LIMITS } from "@knotebook/shared";
import { buildTestApp, testConfig, signTestSession } from "./helpers.js";
import { users, siteSettings } from "../src/db/schema.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { GENERIC } from "./helpers/provider-icon.js";
import type { Db } from "../src/db/index.js";
import type { CollabHooks } from "../src/collab/hooks.js";

// verifyPassword/hashPassword are wrapped as vi.fn(actual): default behaviour is identical to the real implementation, only individual tests
// (the HashBusyError ones) override the next call with mockRejectedValueOnce, leaving the others unaffected. More stable than forcing HashBusyError
// with setHashConcurrency + a real concurrency race, and independent of timing (vitest statically hoists vi.mock calls to the very top of the file,
// before the import below).
vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword), hashPassword: vi.fn(actual.hashPassword) };
});

import { verifyPassword, hashPassword, HashBusyError, DUMMY_HASH } from "../src/auth/password.js";
import { DEFAULT_NOTE_MAX_BYTES } from "../src/notes/note-size.js";
const MAX_MEDIA_UPLOAD_BYTES = SITE_LIMITS.uploadMediaMaxMib.default * 1_048_576;

// mockClear only clears call records (implementations other than mockRejectedValueOnce stay: they are vi.fn(actual...)'s default forwarding),
// so each test's call counts only include its own calls.
afterEach(() => {
  vi.mocked(verifyPassword).mockClear();
  vi.mocked(hashPassword).mockClear();
});

const VALID_PASSWORD = "correct-horse-battery";
const NEW_VALID_PASSWORD = "new-correct-horse-battery";

async function insertUser(
  db: Db,
  overrides: Partial<{
    email: string;
    displayName: string;
    isAdmin: boolean;
    tokenVersion: number;
    disabledAt: Date | null;
    password: string | null;
    mustChangePassword: boolean;
  }> = {}
) {
  const password = overrides.password === undefined ? VALID_PASSWORD : overrides.password;
  const passwordHash = password === null ? null : await hashPassword(password);
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
      isAdmin: overrides.isAdmin ?? false,
      tokenVersion: overrides.tokenVersion ?? 0,
      disabledAt: overrides.disabledAt ?? null,
      passwordHash,
      mustChangePassword: overrides.mustChangePassword ?? false,
    })
    .returning();
  return u;
}

function loginPayload(email: string, password: string) {
  return { email, password };
}

describe("GET /api/auth/config", () => {
  it("no auth needed; no provider -> { providers: [], registration: { enabled: true, providerIds: [] } } (default on)", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true, noteMaxBytes: DEFAULT_NOTE_MAX_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES, maxMediaUploadBytes: MAX_MEDIA_UPLOAD_BYTES });
  });

  it("lists only enabled providers, ordered by sort_order; no issuer/client id/secret", async () => {
    const { app, db } = await buildTestApp();
    const b = await seedAuthProvider(db, { issuerUrl: "https://b.example", displayName: "B", sortOrder: 2 });
    const a = await seedAuthProvider(db, { issuerUrl: "https://a.example", displayName: "A", sortOrder: 1 });
    await seedAuthProvider(db, { issuerUrl: "https://off.example", displayName: "Off", enabled: false });
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.json()).toEqual({ providers: [{ id: a.id, displayName: "A", icon: GENERIC }, { id: b.id, displayName: "B", icon: GENERIC }], registration: { enabled: true, providerIds: [a.id, b.id] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true, noteMaxBytes: DEFAULT_NOTE_MAX_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES, maxMediaUploadBytes: MAX_MEDIA_UPLOAD_BYTES });
    expect(res.body).not.toMatch(/a\.example|test-client|"ct"/);
  });

  it("noteMaxBytes = the configured NOTE_MAX_BYTES (used by the web editor's note size check)", async () => {
    const { app } = await buildTestApp({ config: { ...testConfig, limitEnv: { noteMaxBytes: 123_456 } } });
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.json().noteMaxBytes).toBe(123_456);
  });

  it("registration_enabled=false -> registration.enabled false", async () => {
    const { app, db } = await buildTestApp();
    await db.update(siteSettings).set({ registrationEnabled: false });
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.json()).toEqual({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true, noteMaxBytes: DEFAULT_NOTE_MAX_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES, maxMediaUploadBytes: MAX_MEDIA_UPLOAD_BYTES });
  });

  it("site_settings row unreadable -> registration.enabled false + error log", async () => {
    const logged: unknown[][] = [];
    const { app, db } = await buildTestApp(
      {},
      {
        logger: {
          level: "error",
          hooks: {
            logMethod(args: unknown[], method: (...a: unknown[]) => void) {
              logged.push(args);
              method.apply(this, args as never[]);
            },
          },
        },
      },
    );
    await db.delete(siteSettings);
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.json()).toEqual({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true, noteMaxBytes: DEFAULT_NOTE_MAX_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES, maxMediaUploadBytes: MAX_MEDIA_UPLOAD_BYTES });
    expect(logged.some((a) => a.some((x) => typeof x === "string" && x.includes("site_settings")))).toBe(true);
    expect(logged.some((a) => a.some((x) => typeof x === "string" && x.includes("帳密登入視同開啟")))).toBe(true);
  });

  /** Shared by the two cases below: a (sort 2, on), b (sort 1, on), c (sort 3, off), d (disabled, on). */
  async function seedAutoCreateMix(db: Db) {
    const a = await seedAuthProvider(db, { issuerUrl: "https://a.example", displayName: "A", sortOrder: 2, autoCreateEnabled: true });
    const b = await seedAuthProvider(db, { issuerUrl: "https://b.example", displayName: "B", sortOrder: 1, autoCreateEnabled: true });
    const c = await seedAuthProvider(db, { issuerUrl: "https://c.example", displayName: "C", sortOrder: 3, autoCreateEnabled: false });
    const d = await seedAuthProvider(db, { issuerUrl: "https://d.example", displayName: "D", sortOrder: 0, enabled: false, clientSecret: null, autoCreateEnabled: true });
    return { a, b, c, d };
  }

  it("providerIds = enabled providers with auto-create on, in display order; disabled ones with the switch on are not listed; independent of registration.enabled", async () => {
    const { app, db } = await buildTestApp();
    const { a, b, c } = await seedAutoCreateMix(db);
    await db.update(siteSettings).set({ registrationEnabled: false });
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    const body = res.json() as { providers: Array<Record<string, unknown>>; registration: unknown };
    expect(body.registration).toEqual({ enabled: false, providerIds: [b.id, a.id] });
    expect(body.providers.map(p => p.id)).toEqual([b.id, a.id, c.id]);
    for (const p of body.providers) expect(Object.keys(p).sort()).toEqual(["displayName", "icon", "id"]);
  });

  it("site_settings row unreadable -> providerIds []; providers still listed", async () => {
    const { app, db } = await buildTestApp();
    const { a, b, c } = await seedAutoCreateMix(db);
    await db.delete(siteSettings);
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    const body = res.json() as { providers: Array<{ id: string }>; registration: unknown };
    expect(body.registration).toEqual({ enabled: false, providerIds: [] });
    expect(body.providers.map(p => p.id)).toEqual([b.id, a.id, c.id]);
  });
});

describe("POST /api/auth/login", () => {
  it("correct credentials -> 200 + session cookie, and that cookie calling me returns the right content", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "alice@example.com", displayName: "Alice", isAdmin: false });

    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("alice@example.com", VALID_PASSWORD) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: u.id,
      email: u.email,
      handle: u.handle,
      displayName: u.displayName,
      isAdmin: false,
      mustChangePassword: false,
      hasPassword: true,
      autoVersions: true,
      avatar: null,
    });

    const cookie = res.cookies.find(c => c.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/");

    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie!.value } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toEqual({
      id: u.id,
      email: u.email,
      handle: u.handle,
      displayName: u.displayName,
      isAdmin: false,
      mustChangePassword: false,
      hasPassword: true,
      autoVersions: true,
      avatar: null,
    });
  });

  it("login with Mixed-Case input to an existing lowercase account -> 200 (the read side compares symmetrically with lower())", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "alice-mixed@example.com", displayName: "Alice", isAdmin: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("AliCE-Mixed@Example.COM", VALID_PASSWORD),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: u.id, email: u.email });
  });

  it("wrong password 5 times -> the 6th gets a pre-check 429 too_many_attempts, response has a positive retryAfterMs", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "bob@example.com" });

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("bob@example.com", "wrong-password-here") });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("bob@example.com", "wrong-password-here") });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    expect(typeof blocked.json().retryAfterMs).toBe("number");
    expect(blocked.json().retryAfterMs).toBeGreaterThan(0);
  });

  it("nonexistent account failing 5 times in a row -> the 6th is also 429 too_many_attempts", async () => {
    const { app } = await buildTestApp();

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("ghost@example.com", "whatever-password") });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("ghost@example.com", "whatever-password") });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "too_many_attempts" } });
  });

  it("401 response body: nonexistent account and existing account with wrong password are byte-for-byte identical (same code, same message, no account-existence oracle); for the nonexistent account a dummy verify (DUMMY_HASH) really ran underneath", async () => {
    const { app: appExisting, db } = await buildTestApp();
    await insertUser(db, { email: "carol@example.com" });
    const resExistingWrong = await appExisting.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("carol@example.com", "totally-wrong-password"),
    });
    expect(resExistingWrong.statusCode).toBe(401);

    // Isolate only the verifyPassword call record of the next "nonexistent account" call - the existing-account branch above already
    // verified its status code, its call record isn't needed.
    vi.mocked(verifyPassword).mockClear();

    const { app: appMissing } = await buildTestApp();
    const resMissing = await appMissing.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("nobody-at-all@example.com", "totally-wrong-password"),
    });
    expect(resMissing.statusCode).toBe(401);

    // Top security property: a nonexistent account must not short-circuit to 401; a dummy verify (with DUMMY_HASH) must really run,
    // otherwise the timing difference becomes a timing oracle for account existence.
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyPassword).mock.calls[0]?.[0]).toBe(DUMMY_HASH);

    expect(JSON.stringify(resMissing.json())).toBe(JSON.stringify(resExistingWrong.json()));
  });

  it("OIDC-only user (passwordHash null) login -> 401 invalid_credentials, same response as a normal wrong password; a dummy verify (DUMMY_HASH) really ran underneath", async () => {
    const { app: appOidc, db } = await buildTestApp();
    await insertUser(db, { email: "oidc@example.com", password: null });
    const resOidc = await appOidc.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("oidc@example.com", "any-password-at-all") });
    expect(resOidc.statusCode).toBe(401);

    // Assert before the second (existing account, real wrong password) request, so the call count/arguments measured here
    // belong only to the OIDC-only call above.
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyPassword).mock.calls[0]?.[0]).toBe(DUMMY_HASH);

    const { app: appWrong, db: db2 } = await buildTestApp();
    await insertUser(db2, { email: "dana@example.com" });
    const resWrong = await appWrong.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("dana@example.com", "any-password-at-all") });
    expect(resWrong.statusCode).toBe(401);

    expect(JSON.stringify(resOidc.json())).toBe(JSON.stringify(resWrong.json()));
  });

  it("disabled account: correct password -> 403 account_disabled; wrong password -> 401 (password verified before the disabled check, 403 doesn't override 401)", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "evan@example.com", disabledAt: new Date() });

    const resCorrect = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("evan@example.com", VALID_PASSWORD) });
    expect(resCorrect.statusCode).toBe(403);
    expect(resCorrect.json()).toMatchObject({ error: { code: "account_disabled" } });

    const resWrong = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("evan@example.com", "wrong-password-here") });
    expect(resWrong.statusCode).toBe(401);
    expect(resWrong.json()).toMatchObject({ error: { code: "invalid_credentials" } });
  });

  it("an old cookie obtained at login, account disabled afterwards (disabledAt set directly in the DB) -> me 401 (the gate treats it as revoked)", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "frank@example.com" });

    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("frank@example.com", VALID_PASSWORD) });
    expect(loginRes.statusCode).toBe(200);
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, "frank@example.com"));

    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: cookie } });
    expect(meRes.statusCode).toBe(401);
  });

  it("HashBusyError (verifyPassword concurrency exceeded) -> 429 server_busy", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "busy@example.com" });

    vi.mocked(verifyPassword).mockRejectedValueOnce(new HashBusyError());

    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("busy@example.com", VALID_PASSWORD) });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: "server_busy" } });
  });

  it("X-Forwarded-For is not trusted by default: a fake IP per request doesn't get around the IP track (issue #13)", async () => {
    // The account track uses a different account every time so it never triggers, isolating the IP track. If XFF were trusted, the five requests
    // would land on different IPs, the IP track would stay at 1 and the sixth wouldn't be 429 - the very hole of that issue.
    const { app } = await buildTestApp();

    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: loginPayload(`nobody-${i}@example.com`, "wrong-password-here"),
        headers: { "x-forwarded-for": `203.0.113.${i + 1}` },
      });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("nobody-99@example.com", "wrong-password-here"),
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "too_many_attempts" } });
  });

  it("X-Forwarded-For is trusted only after TRUST_PROXY is explicitly enabled (normal behaviour behind a reverse proxy)", async () => {
    const { app } = await buildTestApp({ config: { ...testConfig, trustProxy: true } });

    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: loginPayload(`nobody-${i}@example.com`, "wrong-password-here"),
        headers: { "x-forwarded-for": `198.51.100.${i + 1}` },
      });
      expect(res.statusCode).toBe(401);
    }

    // Every request has a different request.ip => the IP track has only 1 failure each, so the sixth still reaches password verification.
    const next = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("nobody-99@example.com", "wrong-password-here"),
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(next.statusCode).toBe(401);
  });

  it("recordSuccess only clears the account counter, not the IP counter: after a successful login the account counter is zero, and from a clean IP 4 more failures still don't give 429", async () => {
    // x-forwarded-for controls request.ip. Since issue #13 `trustProxy` defaults to false, so this must **explicitly** trust the proxy to get the ability
    // to "change IP" (trusting XFF is the deployer's choice, not a default - the point of that issue). 4 failures for the same account from IP A and 1 success,
    // then 4 failures from a brand-new IP B: if recordSuccess really cleared only the account counter (not the IP counter), the account counter in the IP B batch
    // is 0+4=4 (still <5, no 429); if recordSuccess wasn't wired/didn't clear the account counter, it would accumulate to 4 (IP A)+4 (IP B)=8
    // and the account arm would certainly block midway through this batch.
    const { app, db } = await buildTestApp({ config: { ...testConfig, trustProxy: true } });
    await insertUser(db, { email: "karen@example.com" });

    const ipA = "203.0.113.10";
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: loginPayload("karen@example.com", "wrong-password-here"),
        headers: { "x-forwarded-for": ipA },
      });
      expect(res.statusCode).toBe(401);
    }

    const successRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: loginPayload("karen@example.com", VALID_PASSWORD),
      headers: { "x-forwarded-for": ipA },
    });
    expect(successRes.statusCode).toBe(200);

    const ipB = "203.0.113.20";
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: loginPayload("karen@example.com", "wrong-password-here"),
        headers: { "x-forwarded-for": ipB },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("throttle account key uses the normalized value: after 5 failures of a Mixed-Case variant from IP A, switching case from IP B is still 429 (without normalization both IP B axes are 0 -> falls through to lookup -> 401, red)", async () => {
    // Same as above: IP A/IP B must really be two different request.ip values, which needs trusting the proxy first (issue #13).
    const { app } = await buildTestApp({ config: { ...testConfig, trustProxy: true } });
    const variants = [
      "AliCE@example.com",
      "alICe@example.com",
      "ALICE@example.com",
      "aliCE@Example.com",
      "Alice@EXAMPLE.com",
    ];

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": "10.0.0.1" },
        payload: loginPayload(variants[i]!, "wrong-password-xx"),
      });
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "10.0.0.2" },
      payload: loginPayload("alice@example.com", "wrong-password-xx"),
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("too_many_attempts");
  });
});

describe("POST /api/auth/logout", () => {
  it("clearing the cookie (empty value, maxAge 0) -> 204; calling me afterwards without the cookie -> 401", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "grace@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("grace@example.com", VALID_PASSWORD) });
    expect(loginRes.statusCode).toBe(200);

    const logoutRes = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(logoutRes.statusCode).toBe(204);
    const cleared = logoutRes.cookies.find(c => c.name === SESSION_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
    // The path must match the one used when issuing ("/"): browsers match name+path (+domain) to decide it is the same cookie and overwrite it;
    // a mismatched path only adds an empty cookie, leaving the original session-token cookie untouched.
    expect(cleared?.path).toBe("/");

    // Simulate the browser having cleared the local cookie per Set-Cookie: later requests send no cookie.
    const meRes = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(meRes.statusCode).toBe(401);
  });

  it("callable without auth (logout while not signed in) -> 204", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(204);
  });
});

describe("GET /api/auth/me", () => {
  it("not signed in -> 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/auth/password", () => {
  it("not signed in -> 401", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it("wrong old password -> 401 invalid_credentials (DB not changed)", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "henry@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("henry@example.com", VALID_PASSWORD) });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: "wrong-old-password", newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "invalid_credentials" } });

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.tokenVersion).toBe(0);
  });

  it("new password < 12 characters -> 400 password_too_short", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "ivy@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("ivy@example.com", VALID_PASSWORD) });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "password_too_short" } });
  });

  it("successful password change: the new cookie from this request -> me 200; the old cookie (before the change) -> 401; login with the old password 401, with the new password 200", async () => {
    const { app, db } = await buildTestApp();
    await insertUser(db, { email: "jack@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("jack@example.com", VALID_PASSWORD) });
    expect(loginRes.statusCode).toBe(200);
    const oldCookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const changeRes = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: oldCookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(changeRes.statusCode).toBe(204);
    const newCookie = changeRes.cookies.find(c => c.name === SESSION_COOKIE);
    expect(newCookie).toBeDefined();
    expect(newCookie!.value).not.toBe(oldCookie);

    // The new cookie from this request -> me 200: the user isn't logged out by their own tokenVersion bump
    const meNew = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: newCookie!.value } });
    expect(meNew.statusCode).toBe(200);
    expect(meNew.json()).toMatchObject({ email: "jack@example.com" });

    // The old cookie (issued before the change, tv has been bumped) -> 401: simulates other devices' sessions being kicked
    const meOld = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: oldCookie } });
    expect(meOld.statusCode).toBe(401);

    const loginOld = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("jack@example.com", VALID_PASSWORD) });
    expect(loginOld.statusCode).toBe(401);
    const loginNew = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("jack@example.com", NEW_VALID_PASSWORD) });
    expect(loginNew.statusCode).toBe(200);
  });

  it("successful password change -> collabHooks.onUserRevoked(userId) called once (test hook: revocation of live collaboration connections)", async () => {
    const onUserRevoked = vi.fn();
    const collabHooks: CollabHooks = {
      onShareChanged: vi.fn(),
      onUserRevoked,
      onSessionRevoked: vi.fn(),
      onGroupAccessChanged: vi.fn(),
      beforeNoteDeleted: vi.fn(async () => ({ release: () => {} })),
      onNotesRestored: vi.fn(),
        linkSyncGate: () => ({ ok: false as const }),
    };
    const { app, db } = await buildTestApp({ collabHooks });
    const u = await insertUser(db, { email: "laura@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("laura@example.com", VALID_PASSWORD) });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(204);
    expect(onUserRevoked).toHaveBeenCalledTimes(1);
    expect(onUserRevoked).toHaveBeenCalledWith(u.id);
  });

  it("OIDC-only user (passwordHash null) changing password -> 401 invalid_credentials (pins the dummy verify branch, not a 500 or a false success)", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "mia@example.com", password: null });
    // An OIDC-only user can't get a cookie via password login, so a valid session is signed directly to simulate being logged in.
    const cookie = await signTestSession({ userId: u.id, tv: u.tokenVersion });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: "any-password-at-all", newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "invalid_credentials" } });
  });

  it("successful password change -> mustChangePassword goes from true to false (reflected in a later me); tokenVersion still +1", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "olga@example.com", mustChangePassword: true });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("olga@example.com", VALID_PASSWORD) });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json()).toMatchObject({ mustChangePassword: true });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const changeRes = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(changeRes.statusCode).toBe(204);
    const newCookie = changeRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: newCookie } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ mustChangePassword: false });

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.mustChangePassword).toBe(false);
  });

  it("hashPassword throws HashBusyError (concurrency exceeded while hashing the new password) -> 429 server_busy (no DB change persisted)", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertUser(db, { email: "nina@example.com" });
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: loginPayload("nina@example.com", VALID_PASSWORD) });
    const cookie = loginRes.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { currentPassword: VALID_PASSWORD, newPassword: NEW_VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: "server_busy" } });

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.tokenVersion).toBe(0);
  });
});
