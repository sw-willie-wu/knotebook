/**
 * #286 無登入端點：inspect 與以重設連結設定新密碼（spec §4.3）、登出手段與「不動 PAT／OAuth」（§4.4、A-7）、
 * 並發（A-9、A-10）、帳密開關（A-11）、argon2 前判斷（A-13 前半）、kind 隔離（A-14）、錯誤遮蔽（§3.8）。
 * 每案各建一個 app（fresh DB），限流桶不跨案累積。共編連線的關閉在 `collab-revocation.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { count, eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, insertPasswordUser, testConfig } from "./helpers.js";
import { seedNote, seedUser, cookieOf, waitForLockWaiters } from "./group-helpers.js";
import { codeGrant, exchange, obtainCode } from "./helpers/oauth-flow.js";
import { fileBody, issueDirect, PNG_BYTES, upload } from "./transfer-helpers.js";
import { apiTokens, oauthCodes, oauthRequests, oneTimeLinks, siteSettings, transferTokens, users } from "../src/db/schema.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";
import type { CollabHooks } from "../src/collab/hooks.js";
import { generateAccessToken, hashToken } from "../src/auth/api-token.js";
import { generateOneTimeToken } from "../src/auth/one-time-link.js";
import { RESET_LINK_INVALID_MESSAGE } from "../src/auth/tx/password-reset.js";

// hashPassword 包成 vi.fn(actual)：預設行為與真實實作一致（比照 admin-users.test.ts）。
vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

import { hashPassword, HashBusyError } from "../src/auth/password.js";

afterEach(() => {
  vi.mocked(hashPassword).mockClear();
});

const OLD_PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "brand-new-password-286";
const USER_DTO_KEYS = ["autoVersions", "displayName", "email", "handle", "hasPassword", "id", "isAdmin", "mustChangePassword"];
const REDACTED = "重設密碼時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
const LOOKUP_REDACTED = "查詢重設密碼連結時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
/** 同 `admin-password-reset.test.ts`：DrizzleQueryError 的 params 落進 JSON log 的兩形。 */
const PARAMS_LEAK = /params: |"params"\s*:/;
/** 所有無效原因（含交易內並發造成的）回同一個 body，不洩漏原因（spec §4.3）。 */
const INVALID_BODY = { error: { code: "reset_link_invalid", message: RESET_LINK_INVALID_MESSAGE } };

function spyCollabHooks(): CollabHooks {
  return {
    onShareChanged: vi.fn(),
    onUserRevoked: vi.fn(),
    onGroupAccessChanged: vi.fn(),
    beforeNoteDeleted: vi.fn(async () => ({ release: () => {} })),
    linkSyncGate: () => ({ ok: false as const }),
  };
}

/** pino 的 `logMethod` hook（結構化欄位）＋ stream（整份輸出字串）兩路一起收。 */
function logged() {
  const lines: Array<{ msg?: string; obj: Record<string, unknown> }> = [];
  const out: string[] = [];
  return {
    lines,
    out,
    options: {
      logger: {
        level: "info",
        stream: { write: (chunk: string) => void out.push(chunk) },
        hooks: {
          logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
            const [obj, msg] = args as [Record<string, unknown>, string | undefined];
            if (typeof obj === "object" && obj !== null) lines.push({ msg, obj });
            method.apply(this, args as never[]);
          },
        },
      },
    },
  };
}

async function setup(overrides: Partial<AppDeps> = {}) {
  const log = logged();
  const collabHooks = spyCollabHooks();
  const built = await buildTestApp({ collabHooks, ...overrides }, log.options);
  const admin = await seedUser(built.db, { isAdmin: true });
  return { ...built, collabHooks, log, adminCookies: await cookieOf(admin.id) };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** 經 T2 的 admin POST 產生連結，回明文 token 與產生回應的 expiresAt。 */
async function issue(ctx: Ctx, targetId: string): Promise<{ token: string; expiresAt: string }> {
  const res = await ctx.app.inject({ method: "POST", url: `/api/admin/users/${targetId}/password-reset`, cookies: ctx.adminCookies, payload: { expiresInHours: 1 } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { token: string; expiresAt: string };
}

function inspect(app: FastifyInstance, token: string) {
  return app.inject({ method: "POST", url: "/api/auth/password-reset/inspect", payload: { token } });
}

function complete(app: FastifyInstance, token: string, newPassword = NEW_PASSWORD) {
  return app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { token, newPassword } });
}

function login(app: FastifyInstance, email: string, password: string) {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
}

function me(app: FastifyInstance, session: string) {
  return app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: session } });
}

function sessionOf(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find(one => one.name === SESSION_COOKIE);
  expect(c, "回應應帶 session cookie").toBeDefined();
  return c!.value;
}

async function linkOf(db: Db, token: string) {
  const [row] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.tokenHash, hashToken(token)));
  return row!;
}

async function userRow(db: Db, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row!;
}

function expectInvalid(res: { statusCode: number; json(): unknown }) {
  expect(res.statusCode).toBe(410);
  expect(res.json()).toEqual(INVALID_BODY);
}

async function setPasswordLogin(db: Db, enabled: boolean) {
  await db.update(siteSettings).set({ passwordLoginEnabled: enabled });
}

describe("POST /api/auth/password-reset（完成）", () => {
  it("C1：新密碼生效、其他 session 立即登出、must_change_password 清除、回應 UserDto 並簽新 session", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db, { mustChangePassword: true });
    const loggedIn = await login(app, target.email, OLD_PASSWORD);
    expect(loggedIn.statusCode).toBe(200);
    const other = sessionOf(loggedIn);
    expect((await me(app, other)).statusCode).toBe(200); // gate 快取熱起來
    // 登入已寫過 last_login_at；歸零後才看得出完成路徑有沒有寫。
    await db.update(users).set({ lastLoginAt: null }).where(eq(users.id, target.id));
    const { token } = await issue(ctx, target.id);

    const res = await complete(app, token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(USER_DTO_KEYS);
    expect(body).toMatchObject({ id: target.id, email: target.email, mustChangePassword: false, hasPassword: true });

    expect((await me(app, sessionOf(res))).statusCode).toBe(200);
    expect((await me(app, other)).statusCode).toBe(401);

    const row = await userRow(db, target.id);
    expect(row.tokenVersion).toBe(1);
    expect(row.mustChangePassword).toBe(false);
    expect(row.lastLoginAt).not.toBeNull();
    const link = await linkOf(db, token);
    expect(link.usedAt).not.toBeNull();
    expect(link.revokedAt).toBeNull();

    expect((await login(app, target.email, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(app, target.email, OLD_PASSWORD)).statusCode).toBe(401);

    expect(ctx.collabHooks.onUserRevoked).toHaveBeenCalledTimes(1);
    expect(ctx.collabHooks.onUserRevoked).toHaveBeenCalledWith(target.id);

    const used = ctx.log.lines.filter(l => l.msg === "重設密碼連結已使用");
    expect(used.map(l => l.obj)).toEqual([{ targetUserId: target.id, linkId: link.id }]);
    const out = ctx.log.out.join("");
    expect(out).not.toContain(token);
    expect(out).not.toContain(hashToken(token));
  });

  it("C3：用過、被取代、取消、過期、形狀不合 → inspect 與完成都 410；缺欄或多欄 → 400 invalid_body", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);

    const { token: first } = await issue(ctx, target.id);
    expect((await complete(app, first)).statusCode).toBe(200);
    expectInvalid(await complete(app, first, "yet-another-password"));

    const { token: replaced } = await issue(ctx, target.id);
    const { token: current } = await issue(ctx, target.id);
    expectInvalid(await inspect(app, replaced));
    expectInvalid(await complete(app, replaced));

    const cancelled = await app.inject({ method: "DELETE", url: `/api/admin/users/${target.id}/password-reset`, cookies: ctx.adminCookies });
    expect(cancelled.statusCode).toBe(204);
    expectInvalid(await inspect(app, current));
    expectInvalid(await complete(app, current));

    const { token: expiring } = await issue(ctx, target.id);
    await db.execute(sql`update one_time_links set created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where token_hash = ${hashToken(expiring)}`);
    expectInvalid(await inspect(app, expiring));
    expectInvalid(await complete(app, expiring));

    for (const bad of ["knbp_short", generateAccessToken(), ""]) {
      expectInvalid(await inspect(app, bad));
      expectInvalid(await complete(app, bad));
    }

    const { token: live } = await issue(ctx, target.id);
    for (const payload of [{ token: live }, { token: live, newPassword: NEW_PASSWORD, extra: 1 }]) {
      const res = await app.inject({ method: "POST", url: "/api/auth/password-reset", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
    }
    const extraInspect = await app.inject({ method: "POST", url: "/api/auth/password-reset/inspect", payload: { token: live, extra: 1 } });
    expect(extraInspect.statusCode).toBe(400);
    expect(extraInspect.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect((await linkOf(db, live)).usedAt).toBeNull();
  });

  // A-7（安全關鍵）：完成重設只動 users 與 one_time_links——agent 的 token 全部照常可用。
  it("C4：完成前建立的 PAT、OAuth access／refresh、transfer token 完成後都照常可用；四張表列數不變", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const cookie = await cookieOf(target.id);
    const cookieHeader = `${SESSION_COOKIE}=${cookie[SESSION_COOKIE]}`;

    const pat = await app.inject({ method: "POST", url: "/api/auth/tokens", cookies: cookie, payload: { name: "agent", scope: "notes:read notes:write", expiresInDays: null } });
    expect(pat.statusCode, pat.body).toBe(201);
    const { token: patToken, id: patId } = pat.json() as { token: string; id: string };
    const code = await obtainCode(app, cookieHeader);
    const granted = await exchange(app, codeGrant(code));
    expect(granted.statusCode, granted.body).toBe(200);
    const { access_token: access, refresh_token: refresh } = granted.json() as { access_token: string; refresh_token: string };
    const note = await seedNote(db, { ownerId: target.id });
    const transfer = await issueDirect(db, patId, note.id, "upload");

    const counts = async () => ({
      apiTokens: (await db.select({ n: count() }).from(apiTokens))[0]!.n,
      transferTokens: (await db.select({ n: count() }).from(transferTokens))[0]!.n,
      oauthCodes: (await db.select({ n: count() }).from(oauthCodes))[0]!.n,
      oauthRequests: (await db.select({ n: count() }).from(oauthRequests))[0]!.n,
    });
    const before = await counts();

    const { token } = await issue(ctx, target.id);
    expect((await complete(app, token)).statusCode).toBe(200);
    const after = await counts();

    // 列數與四種 token 的結果收成一個斷言：任何一條防線被拿掉，失敗輸出一次列出全部受影響的項目。
    const viaPat = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${patToken}` } });
    const viaAccess = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${access}` } });
    const refreshed = await exchange(app, { grant_type: "refresh_token", refresh_token: refresh, client_id: code.clientId });
    const uploaded = await upload(app, note.id, fileBody(PNG_BYTES), { token: transfer.token });
    expect({
      counts: after,
      pat: viaPat.statusCode,
      oauthAccess: viaAccess.statusCode,
      oauthRefresh: refreshed.statusCode,
      transfer: uploaded.statusCode,
    }).toEqual({ counts: before, pat: 200, oauthAccess: 200, oauthRefresh: 200, transfer: 201 });
  });

  // A-9（安全關鍵）：兩發並發恰好一發成功；token_version 只加一次。
  it("C5：raw client 持 users 列鎖時兩發完成排隊 → 放行後 [200, 410]、token_version = 1", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    const client = await db.$client.connect();
    let a: ReturnType<typeof complete> | undefined;
    let b: ReturnType<typeof complete> | undefined;
    try {
      await client.query("begin");
      await client.query("select 1 from users where id = $1 for no key update", [target.id]);
      a = complete(app, token, "first-new-password");
      b = complete(app, token, "second-new-password");
      await waitForLockWaiters(db.$client, 2);
    } finally {
      await client.query("commit");
      client.release();
    }
    const results = await Promise.all([a!, b!]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 410]);
    expect(results.find(r => r.statusCode === 410)!.json()).toEqual(INVALID_BODY);
    expect((await linkOf(db, token)).usedAt).not.toBeNull();
    expect((await userRow(db, target.id)).tokenVersion).toBe(1);
  });
});

describe("停用與重設（A-10、§4.6）", () => {
  // 停用的撤銷由 T2 的 disableUserInTx 負責（T2-M23 守）；本案驗的是端點對撤銷後的連結回 410、重新啟用不復活。
  it("C6：經 API 停用 → inspect 與完成 410；重新啟用後仍 410", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: ctx.adminCookies })).statusCode).toBe(204);
    expectInvalid(await inspect(app, token));
    expectInvalid(await complete(app, token));
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/enable`, cookies: ctx.adminCookies })).statusCode).toBe(204);
    expectInvalid(await inspect(app, token));
    expectInvalid(await complete(app, token));
  });

  it("C6：完成先、停用後（同一把 users 列鎖排隊）→ 完成 200、停用 204，完成簽的 session 被停用作廢", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    const client = await db.$client.connect();
    let done: ReturnType<typeof complete> | undefined;
    let disabled: Promise<{ statusCode: number }> | undefined;
    try {
      await client.query("begin");
      await client.query("select 1 from users where id = $1 for no key update", [target.id]);
      done = complete(app, token);
      await waitForLockWaiters(db.$client, 1);
      disabled = app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: ctx.adminCookies });
      await waitForLockWaiters(db.$client, 2);
    } finally {
      await client.query("commit");
      client.release();
    }
    const [doneRes, disabledRes] = await Promise.all([done!, disabled!]);
    expect(doneRes.statusCode, doneRes.body).toBe(200);
    expect(disabledRes.statusCode).toBe(204);
    expect((await me(app, sessionOf(doneRes))).statusCode).toBe(401);
  });

  it("C6：停用先、完成後 → 停用 204、完成 410；連結已撤銷未使用", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    const client = await db.$client.connect();
    let done: ReturnType<typeof complete> | undefined;
    let disabled: Promise<{ statusCode: number }> | undefined;
    try {
      await client.query("begin");
      await client.query("select 1 from users where id = $1 for no key update", [target.id]);
      disabled = app.inject({ method: "POST", url: `/api/admin/users/${target.id}/disable`, cookies: ctx.adminCookies });
      await waitForLockWaiters(db.$client, 1);
      done = complete(app, token);
      await waitForLockWaiters(db.$client, 2);
    } finally {
      await client.query("commit");
      client.release();
    }
    const [doneRes, disabledRes] = await Promise.all([done!, disabled!]);
    expect(disabledRes.statusCode).toBe(204);
    expectInvalid(doneRes);
    const link = await linkOf(db, token);
    expect(link.revokedAt).not.toBeNull();
    expect(link.usedAt).toBeNull();
  });

  it("C6 防禦：DB 直接停用（未經撤銷）→ inspect 200、完成 410、password_hash 不變", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, target.id));
    const hashBefore = (await userRow(db, target.id)).passwordHash;
    expect((await inspect(app, token)).statusCode).toBe(200);
    expectInvalid(await complete(app, token));
    expect((await userRow(db, target.id)).passwordHash).toBe(hashBefore);
    expect((await linkOf(db, token)).usedAt).toBeNull();
  });
});

describe("POST /api/auth/password-reset/inspect", () => {
  it("C2：200 只回 email／expiresAt；連打 3 次不消耗連結；用過之後 410", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token, expiresAt } = await issue(ctx, target.id);
    for (let i = 0; i < 3; i++) {
      const res = await inspect(app, token);
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json() as object).sort()).toEqual(["email", "expiresAt"]);
      expect(res.json()).toEqual({ email: target.email, expiresAt });
      expect(res.body).not.toContain(token);
      expect(res.body).not.toContain(hashToken(token));
    }
    expect((await linkOf(db, token)).usedAt).toBeNull();
    expect((await complete(app, token)).statusCode).toBe(200);
    expectInvalid(await inspect(app, token));
  });
});

describe("帳密登入開關（A-11、D2）", () => {
  it("C7：DB 關閉 → inspect 403、完成 403，連結列不動；重新開啟 → 同一 token 完成 200", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    const before = await linkOf(db, token);
    await setPasswordLogin(db, false);

    for (const res of [await inspect(app, token), await complete(app, token)]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "password_login_disabled" } });
    }
    const after = await linkOf(db, token);
    expect(after.usedAt).toBeNull();
    expect(after.revokedAt).toBeNull();
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());

    await setPasswordLogin(db, true);
    expect((await complete(app, token)).statusCode).toBe(200);
  });

  it("C7：PASSWORD_LOGIN_FORCE_ENABLE＋DB 關閉 → 完成 200", async () => {
    const ctx = await setup({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    await setPasswordLogin(db, false);
    expect((await inspect(app, token)).statusCode).toBe(200);
    expect((await complete(app, token)).statusCode).toBe(200);
  });
});

describe("argon2 之前的判斷與 hash 忙碌", () => {
  // A-13 前半（安全關鍵）：能在 argon2 之前判斷的都先判，太短、帳密關閉、無效連結都不跑 hashPassword。
  it("C9：太短 400、帳密關閉 403、無效連結 410 都不呼叫 hashPassword；成功那一發恰好一次", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    vi.mocked(hashPassword).mockClear();

    const short = await complete(app, token, "short");
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ error: { code: "password_too_short" } });
    expect((await linkOf(db, token)).usedAt).toBeNull();
    expect(hashPassword).not.toHaveBeenCalled();

    await setPasswordLogin(db, false);
    expect((await complete(app, token)).statusCode).toBe(403);
    expect(hashPassword).not.toHaveBeenCalled();
    await setPasswordLogin(db, true);

    expectInvalid(await complete(app, generateOneTimeToken("password_reset")));
    expect(hashPassword).not.toHaveBeenCalled();

    expect((await complete(app, token)).statusCode).toBe(200);
    expect(hashPassword).toHaveBeenCalledTimes(1);
  });

  it("C10：HashBusyError → 429 server_busy、連結未用；重送 → 200", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());
    const busy = await complete(app, token);
    expect(busy.statusCode).toBe(429);
    expect(busy.json()).toMatchObject({ error: { code: "server_busy" } });
    expect((await linkOf(db, token)).usedAt).toBeNull();
    expect((await complete(app, token)).statusCode).toBe(200);
  });
});

describe("kind 隔離與錯誤遮蔽", () => {
  it("C11：別的 kind 的列（雜湊相符、未過期）→ inspect 與完成 410", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    await db.execute(sql.raw("ALTER TABLE one_time_links DROP CONSTRAINT one_time_links_kind_chk"));
    const token = generateOneTimeToken("password_reset");
    await db.execute(
      sql`insert into one_time_links (kind, token_hash, target_user_id, expires_at) values ('invite', ${hashToken(token)}, ${target.id}, now() + interval '1 hour')`,
    );
    expectInvalid(await inspect(app, token));
    expectInvalid(await complete(app, token));
    expect((await linkOf(db, token)).usedAt).toBeNull();
  });

  it("C12：交易的非預期 DB 錯誤 → 500，log 遮蔽（無 password hash、無 params）；連結未用", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    await db.execute(sql.raw("ALTER TABLE users ADD CONSTRAINT t286_block CHECK (token_version < 1) NOT VALID"));
    const res = await complete(app, token);
    expect(res.statusCode).toBe(500);
    const out = ctx.log.out.join("");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("$argon2");
    expect(out).not.toMatch(PARAMS_LEAK);
    expect((await linkOf(db, token)).usedAt).toBeNull();
  });

  it("C12b：交易外雜湊查詢的非預期 DB 錯誤 → inspect 與完成都 500，log 遮蔽（無 token_hash、無 params）", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const { token } = await issue(ctx, target.id);
    await db.execute(sql.raw("ALTER TABLE one_time_links RENAME COLUMN token_hash TO token_hash_t286"));
    expect((await inspect(app, token)).statusCode).toBe(500);
    expect((await complete(app, token)).statusCode).toBe(500);
    const out = ctx.log.out.join("");
    expect(out.split(LOOKUP_REDACTED).length - 1).toBe(2);
    expect(out).not.toContain(hashToken(token));
    expect(out).not.toMatch(PARAMS_LEAK);
  });
});
