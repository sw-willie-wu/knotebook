/**
 * #285 無登入的邀請端點：inspect 與接受邀請（spec §5.3–§5.6）。成功建帳（B-7）、不看「允許用帳號密碼自行註冊」（B-8）、
 * strict body（V3）、無效一律 410 不洩漏原因、kind 隔離（B-14）、單次與撤銷並發（B-9）、argon2 前判斷（B-10、§5.5）、
 * 帳密開關（B-11）、hash 忙碌、顯示名、錯誤遮蔽（B-15）。速率桶在 T3b 補。
 * 每案各建一個 app（fresh DB）。並發一律以 raw client 持邀請列（或 users 唯一鍵）的鎖、`waitForLockWaiters` 排隊後放行，不靠 sleep。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, insertPasswordUser, testConfig } from "./helpers.js";
import { cookieOf, seedUser, waitForLockWaiters } from "./group-helpers.js";
import { handles, oneTimeLinks, siteSettings, users } from "../src/db/schema.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";
import { generateAccessToken, hashToken } from "../src/auth/api-token.js";
import { generateOneTimeToken } from "../src/auth/one-time-link.js";
import { INVITE_INVALID_MESSAGE } from "../src/auth/tx/accept-invite.js";

// hashPassword 包成 vi.fn(actual)：預設行為與真實實作一致（比照 password-reset.test.ts）。
vi.mock("../src/auth/password.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/password.js")>("../src/auth/password.js");
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

import { hashPassword, HashBusyError } from "../src/auth/password.js";

afterEach(() => {
  vi.mocked(hashPassword).mockClear();
});

const PW = "correct-horse-battery-staple";
const NUL = String.fromCodePoint(0);
const USER_DTO_KEYS = ["autoVersions", "displayName", "email", "handle", "hasPassword", "id", "isAdmin", "mustChangePassword"];
const REDACTED = "接受邀請時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
const LOOKUP_REDACTED = "查詢邀請時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
const PARAMS_LEAK = /params: |"params"\s*:/;
const INVALID_BODY = { error: { code: "invite_invalid", message: INVITE_INVALID_MESSAGE } };

/** pino 的 `logMethod` hook（結構化欄位）＋ stream（整份輸出字串）兩路一起收（同 password-reset.test.ts）。 */
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
  const built = await buildTestApp(overrides, log.options);
  const admin = await seedUser(built.db, { isAdmin: true });
  return { ...built, log, admin, adminCookies: await cookieOf(admin.id) };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** 經 T2 的 admin POST 建邀請，回明文 token、列 id 與建立回應的 expiresAt。 */
async function createInvite(ctx: Ctx, over: { expiresInDays?: number; label?: string } = {}): Promise<{ token: string; id: string; expiresAt: string }> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/admin/invites",
    cookies: ctx.adminCookies,
    payload: { expiresInDays: over.expiresInDays ?? 3, ...(over.label !== undefined ? { label: over.label } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { token: string; invite: { id: string; expiresAt: string } };
  return { token: body.token, id: body.invite.id, expiresAt: body.invite.expiresAt };
}

function accept(app: FastifyInstance, body: object) {
  return app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: body });
}

function inspect(app: FastifyInstance, token: string) {
  return app.inject({ method: "POST", url: "/api/auth/invite/inspect", payload: { token } });
}

function revoke(ctx: Ctx, id: string) {
  return ctx.app.inject({ method: "DELETE", url: `/api/admin/invites/${id}`, cookies: ctx.adminCookies });
}

async function linkOf(db: Db, id: string) {
  const [row] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.id, id));
  return row!;
}

function expectInvalid(res: { statusCode: number; json(): unknown }) {
  expect(res.statusCode).toBe(410);
  expect(res.json()).toEqual(INVALID_BODY);
}

function expectPasswordLoginDisabled(res: { statusCode: number; json(): unknown }) {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ error: { code: "password_login_disabled" } });
}

async function setPasswordLogin(db: Db, enabled: boolean) {
  await db.update(siteSettings).set({ passwordLoginEnabled: enabled });
}

async function countOf(db: Db, table: "users" | "handles"): Promise<number> {
  const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`));
  return r.rows[0]!.n;
}

async function expectUnused(db: Db, id: string) {
  const link = await linkOf(db, id);
  expect(link.usedAt).toBeNull();
  expect(link.usedById).toBeNull();
}

describe("POST /api/auth/invite/accept（成功）", () => {
  it("IA1（B-7、V3）：201 UserDto、一般使用者、email 小寫、顯示名預設 local-part、預設方案、session 有效、last_login_at、邀請標用掉、log 只帶 linkId／userId", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    const res = await accept(app, { token: invite.token, email: "New.Person@Example.COM", password: PW });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(USER_DTO_KEYS);
    expect(body).toMatchObject({
      email: "new.person@example.com",
      displayName: "new.person",
      isAdmin: false,
      mustChangePassword: false,
      hasPassword: true,
      autoVersions: true,
    });
    const id = body.id as string;

    const session = res.cookies.find(c => c.name === SESSION_COOKIE);
    expect(session, "回應應帶 session cookie").toBeDefined();
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: session!.value } })).statusCode).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.id, id));
    const [settings] = await db.select({ p: siteSettings.defaultUserStoragePlanId }).from(siteSettings);
    expect({ isAdmin: row!.isAdmin, mustChangePassword: row!.mustChangePassword, email: row!.email, plan: row!.storagePlanId }).toEqual({
      isAdmin: false,
      mustChangePassword: false,
      email: "new.person@example.com",
      plan: settings!.p,
    });
    expect(row!.lastLoginAt).not.toBeNull();
    const [reg] = await db.select().from(handles).where(eq(handles.handle, row!.handle));
    expect(reg).toMatchObject({ state: "live", userId: id, handle: body.handle });

    const link = await linkOf(db, invite.id);
    expect(link.usedAt).not.toBeNull();
    expect(link.usedById).toBe(id);
    expect(link.revokedAt).toBeNull();

    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "new.person@example.com", password: PW } })).statusCode).toBe(200);

    const used = ctx.log.lines.filter(l => l.msg === "邀請已使用");
    expect(used.map(l => l.obj)).toEqual([{ linkId: invite.id, userId: id }]);
  });

  it("IA2（B-8、E2）：「允許用帳號密碼自行註冊」關閉 → inspect 200、accept 201", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    await db.update(siteSettings).set({ registrationEnabled: false });
    const invite = await createInvite(ctx);
    expect((await inspect(app, invite.token)).statusCode).toBe(200);
    const res = await accept(app, { token: invite.token, email: "ia2@example.com", password: PW });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("IA3（V3 strict）：多帶 isAdmin → 400 invalid_body、邀請未用；缺 password → 400", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    const extra = await accept(app, { token: invite.token, email: "ia3@example.com", password: PW, isAdmin: true });
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toMatchObject({ error: { code: "invalid_body" } });
    const missing = await accept(app, { token: invite.token, email: "ia3@example.com" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: "invalid_body" } });
    await expectUnused(db, invite.id);
    expect(await db.select().from(users).where(eq(users.email, "ia3@example.com"))).toEqual([]);
  });
});

describe("POST /api/auth/invite/inspect", () => {
  it("IA4（B-2）：200 只回 expiresAt（等於建立回應）；連打 3 次不消耗；accept 後 410；回應與 log 不含 token、雜湊、備註", async () => {
    const ctx = await setup();
    const { app } = ctx;
    const label = "secret-label-285";
    const invite = await createInvite(ctx, { label });
    const inspected: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await inspect(app, invite.token);
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual(["expiresAt"]);
      expect(res.json().expiresAt).toBe(invite.expiresAt);
      inspected.push(res.body);
    }
    const res = await accept(app, { token: invite.token, email: "ia4@example.com", password: PW });
    expect(res.statusCode, res.body).toBe(201);
    expectInvalid(await inspect(app, invite.token));
    for (const text of [...inspected, res.body, ctx.log.out.join("")]) {
      expect(text).not.toContain(invite.token);
      expect(text).not.toContain(hashToken(invite.token));
      expect(text).not.toContain(label);
    }
  });

  it("IA4b（strict）：inspect 多帶欄位 → 400 invalid_body；缺 token → 400", async () => {
    const ctx = await setup();
    const { app } = ctx;
    const invite = await createInvite(ctx);
    const extra = await app.inject({ method: "POST", url: "/api/auth/invite/inspect", payload: { token: invite.token, x: 1 } });
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toMatchObject({ error: { code: "invalid_body" } });
    const missing = await app.inject({ method: "POST", url: "/api/auth/invite/inspect", payload: {} });
    expect(missing.statusCode).toBe(400);
  });
});

describe("無效一律 410、不洩漏原因（安全關鍵：列舉）", () => {
  it("IA5：已用、已撤銷、已過期、格式合法但查無、太短、access token 形、空字串、重設 token → inspect 與 accept 回同一個 410 body", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const used = await createInvite(ctx);
    expect((await accept(app, { token: used.token, email: "first@example.com", password: PW })).statusCode).toBe(201);
    const revoked = await createInvite(ctx);
    expect((await revoke(ctx, revoked.id)).statusCode).toBe(204);
    const expired = await createInvite(ctx);
    await db.execute(sql`update one_time_links set created_at = now() - interval '10 days', expires_at = now() - interval '1 minute' where id = ${expired.id}`);
    const target = await insertPasswordUser(db);
    const resetRes = await app.inject({ method: "POST", url: `/api/admin/users/${target.id}/password-reset`, cookies: ctx.adminCookies, payload: { expiresInHours: 1 } });
    expect(resetRes.statusCode, resetRes.body).toBe(201);
    const resetToken = (resetRes.json() as { token: string }).token;

    const tokens: Array<[string, string]> = [
      ["已用", used.token],
      ["已撤銷", revoked.token],
      ["已過期", expired.token],
      ["格式合法但查無", generateOneTimeToken("invite")],
      ["太短", "knbi_short"],
      ["access token", generateAccessToken()],
      ["空字串", ""],
      ["重設 token", resetToken],
    ];
    for (const [name, token] of tokens) {
      const i = await inspect(app, token);
      expect(i.statusCode, `inspect ${name}`).toBe(410);
      expect(i.json(), `inspect ${name}`).toEqual(INVALID_BODY);
      const a = await accept(app, { token, email: "second@example.com", password: PW });
      expect(a.statusCode, `accept ${name}`).toBe(410);
      expect(a.json(), `accept ${name}`).toEqual(INVALID_BODY);
    }
    expect(await db.select().from(users).where(eq(users.email, "second@example.com"))).toEqual([]);
  });

  it("IA6（B-14，DB 層 kind 隔離）：雜湊相符、邀請形狀的 password_reset 列 → inspect 與 accept 410、列未用", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const target = await insertPasswordUser(db);
    const t = generateOneTimeToken("invite");
    const [row] = await db
      .insert(oneTimeLinks)
      .values({ kind: "password_reset", tokenHash: hashToken(t), targetUserId: target.id, expiresAt: sql`now() + interval '1 hour'` })
      .returning({ id: oneTimeLinks.id });
    expectInvalid(await inspect(app, t));
    expectInvalid(await accept(app, { token: t, email: "ia6@example.com", password: PW }));
    expect((await linkOf(db, row!.id)).usedAt).toBeNull();
  });

  it("IA6（B-14，反向）：真邀請 token 打重設端點 → 410 reset_link_invalid、邀請未用", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    const i = await app.inject({ method: "POST", url: "/api/auth/password-reset/inspect", payload: { token: invite.token } });
    expect(i.statusCode).toBe(410);
    expect(i.json()).toMatchObject({ error: { code: "reset_link_invalid" } });
    const c = await app.inject({ method: "POST", url: "/api/auth/password-reset", payload: { token: invite.token, newPassword: PW } });
    expect(c.statusCode).toBe(410);
    expect(c.json()).toMatchObject({ error: { code: "reset_link_invalid" } });
    await expectUnused(db, invite.id);
  });
});

describe("單次與撤銷並發（B-9、V2，安全關鍵）", () => {
  it("IA7：成功一次後同 token 再 accept（不同 email）→ 410、只有一個新帳號", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    expect((await accept(app, { token: invite.token, email: "once-a@example.com", password: PW })).statusCode).toBe(201);
    expectInvalid(await accept(app, { token: invite.token, email: "once-b@example.com", password: PW }));
    expect(await db.select().from(users).where(eq(users.email, "once-b@example.com"))).toEqual([]);
  });

  it("IA7 並發：raw client 持邀請列 FOR UPDATE 時兩發 accept（不同 email）排隊 → 放行後 [201, 410]、只多一個帳號、used_by_id 是 201 那位", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    const usersBefore = await countOf(db, "users");
    const client = await db.$client.connect();
    let a: ReturnType<typeof accept> | undefined;
    let b: ReturnType<typeof accept> | undefined;
    try {
      await client.query("begin");
      await client.query("select id from one_time_links where id = $1 for update", [invite.id]);
      a = accept(app, { token: invite.token, email: "race-a@example.com", password: PW });
      b = accept(app, { token: invite.token, email: "race-b@example.com", password: PW });
      await waitForLockWaiters(db.$client, 2);
    } finally {
      await client.query("commit");
      client.release();
    }
    const results = await Promise.all([a!, b!]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 410]);
    expect(results.find(r => r.statusCode === 410)!.json()).toEqual(INVALID_BODY);
    expect(await countOf(db, "users")).toBe(usersBefore + 1);
    const winner = results.find(r => r.statusCode === 201)!.json() as { id: string };
    expect((await linkOf(db, invite.id)).usedById).toBe(winner.id);
  });

  it("IA8 兌換先：accept 先排進邀請列鎖、撤銷後排 → accept 201、撤銷 409 invite_used；列 used_at 有值、revoked_at NULL", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    const client = await db.$client.connect();
    let done: ReturnType<typeof accept> | undefined;
    let revoked: ReturnType<typeof revoke> | undefined;
    try {
      await client.query("begin");
      await client.query("select id from one_time_links where id = $1 for update", [invite.id]);
      done = accept(app, { token: invite.token, email: "ia8a@example.com", password: PW });
      await waitForLockWaiters(db.$client, 1);
      revoked = revoke(ctx, invite.id);
      await waitForLockWaiters(db.$client, 2);
    } finally {
      await client.query("commit");
      client.release();
    }
    const [doneRes, revokedRes] = await Promise.all([done!, revoked!]);
    expect(doneRes.statusCode, doneRes.body).toBe(201);
    expect(revokedRes.statusCode, revokedRes.body).toBe(409);
    expect(revokedRes.json()).toMatchObject({ error: { code: "invite_used" } });
    const link = await linkOf(db, invite.id);
    expect(link.usedAt).not.toBeNull();
    expect(link.revokedAt).toBeNull();
  });

  it("IA8 撤銷先：撤銷先排進邀請列鎖、accept 後排 → 撤銷 204、accept 410；列 revoked_at 有值、used_at NULL；沒有新帳號", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    const usersBefore = await countOf(db, "users");
    const client = await db.$client.connect();
    let done: ReturnType<typeof accept> | undefined;
    let revoked: ReturnType<typeof revoke> | undefined;
    try {
      await client.query("begin");
      await client.query("select id from one_time_links where id = $1 for update", [invite.id]);
      revoked = revoke(ctx, invite.id);
      await waitForLockWaiters(db.$client, 1);
      done = accept(app, { token: invite.token, email: "ia8b@example.com", password: PW });
      await waitForLockWaiters(db.$client, 2);
    } finally {
      await client.query("commit");
      client.release();
    }
    const [doneRes, revokedRes] = await Promise.all([done!, revoked!]);
    expect(revokedRes.statusCode).toBe(204);
    expectInvalid(doneRes);
    const link = await linkOf(db, invite.id);
    expect(link.revokedAt).not.toBeNull();
    expect(link.usedAt).toBeNull();
    expect(await countOf(db, "users")).toBe(usersBefore);
  });
});

describe("argon2 之前的判斷（B-10、§5.5，安全關鍵）", () => {
  it("IA9：email 已存在（混合大小寫舊列）→ 409 email_taken、不呼叫 hashPassword、邀請未用", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    await db.insert(users).values({ email: "Taken@x.example", displayName: "Old" });
    const invite = await createInvite(ctx);
    vi.mocked(hashPassword).mockClear();
    const res = await accept(app, { token: invite.token, email: "taken@x.example", password: PW });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "email_taken" } });
    expect(hashPassword).not.toHaveBeenCalled();
    await expectUnused(db, invite.id);
  });

  it("IA9 並發：另一連線持有同 email 的未提交 users 列 → accept 在 users_email_unique 上等 → 提交後 409 email_taken；邀請未用、handles 沒多列", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    const handlesBefore = await countOf(db, "handles");
    const client = await db.$client.connect();
    let pending: ReturnType<typeof accept> | undefined;
    try {
      await client.query("begin");
      await client.query("insert into users (email, display_name) values ('race@x.example', 'R')");
      pending = accept(app, { token: invite.token, email: "race@x.example", password: PW });
      await waitForLockWaiters(db.$client, 1);
    } finally {
      await client.query("commit");
      client.release();
    }
    const res = await pending!;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "email_taken" } });
    await expectUnused(db, invite.id);
    expect(await countOf(db, "handles")).toBe(handlesBefore);
  });

  it("IA10：body 不合、無效 token、密碼 11 字元、帳密關閉都不呼叫 hashPassword、邀請未用；成功那一發恰好一次", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    vi.mocked(hashPassword).mockClear();
    expect((await accept(app, { token: invite.token, email: "not-an-email", password: PW })).statusCode).toBe(400);
    expectInvalid(await accept(app, { token: generateOneTimeToken("invite"), email: "ia10@example.com", password: PW }));
    const short = await accept(app, { token: invite.token, email: "ia10@example.com", password: "a".repeat(11) });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ error: { code: "password_too_short" } });
    await setPasswordLogin(db, false);
    expectPasswordLoginDisabled(await accept(app, { token: invite.token, email: "ia10@example.com", password: PW }));
    expect(hashPassword).not.toHaveBeenCalled();
    await expectUnused(db, invite.id);
    await setPasswordLogin(db, true);
    expect((await accept(app, { token: invite.token, email: "ia10@example.com", password: PW })).statusCode).toBe(201);
    expect(hashPassword).toHaveBeenCalledTimes(1);
  });
});

describe("帳密登入開關（B-11、D1／D2，安全關鍵：不消耗）", () => {
  it("IA11：DB 關閉 → inspect 與 accept 403，列不動、沒有新帳號；重新開啟 → 同 token accept 201", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    const before = await linkOf(db, invite.id);
    const usersBefore = await countOf(db, "users");
    await setPasswordLogin(db, false);
    expectPasswordLoginDisabled(await inspect(app, invite.token));
    expectPasswordLoginDisabled(await accept(app, { token: invite.token, email: "ia11@example.com", password: PW }));
    const after = await linkOf(db, invite.id);
    expect({ usedAt: after.usedAt, revokedAt: after.revokedAt, expiresAt: after.expiresAt.toISOString() }).toEqual({
      usedAt: null,
      revokedAt: null,
      expiresAt: before.expiresAt.toISOString(),
    });
    expect(await countOf(db, "users")).toBe(usersBefore);
    await setPasswordLogin(db, true);
    expect((await accept(app, { token: invite.token, email: "ia11@example.com", password: PW })).statusCode).toBe(201);
  });

  it("IA11：PASSWORD_LOGIN_FORCE_ENABLE＋DB 關閉 → inspect 200、accept 201", async () => {
    const ctx = await setup({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const { app, db } = ctx;
    await setPasswordLogin(db, false);
    const invite = await createInvite(ctx);
    expect((await inspect(app, invite.token)).statusCode).toBe(200);
    expect((await accept(app, { token: invite.token, email: "ia11f@example.com", password: PW })).statusCode).toBe(201);
  });

  it("IA11 順序（spec §5.3 第 1、2 步）：DB 關閉時，格式合法但查無與已撤銷的 token → inspect 與 accept 都 410（不是 403）", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const revoked = await createInvite(ctx);
    expect((await revoke(ctx, revoked.id)).statusCode).toBe(204);
    await setPasswordLogin(db, false);
    for (const token of [generateOneTimeToken("invite"), revoked.token]) {
      expectInvalid(await inspect(app, token));
      expectInvalid(await accept(app, { token, email: "ia11o@example.com", password: PW }));
    }
  });
});

describe("hash 忙碌、顯示名", () => {
  it("IA12：HashBusyError → 429 server_busy、邀請未用；重送 → 201", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    vi.mocked(hashPassword).mockRejectedValueOnce(new HashBusyError());
    const busy = await accept(app, { token: invite.token, email: "ia12@example.com", password: PW });
    expect(busy.statusCode).toBe(429);
    expect(busy.json()).toMatchObject({ error: { code: "server_busy" } });
    await expectUnused(db, invite.id);
    expect((await accept(app, { token: invite.token, email: "ia12@example.com", password: PW })).statusCode).toBe(201);
  });

  it("IA13：顯示名 trim；含 NUL → 400；不給 → local-part；local-part 超過 100 個 code point 截到 100", async () => {
    const ctx = await setup();
    const { app } = ctx;
    const a = await createInvite(ctx);
    const trimmed = await accept(app, { token: a.token, email: "ann@example.com", password: PW, displayName: "  Ann  " });
    expect(trimmed.statusCode, trimmed.body).toBe(201);
    expect(trimmed.json().displayName).toBe("Ann");

    const b = await createInvite(ctx);
    const nul = await accept(app, { token: b.token, email: "nul@example.com", password: PW, displayName: `a${NUL}b` });
    expect(nul.statusCode).toBe(400);
    expect(nul.json()).toMatchObject({ error: { code: "invalid_body" } });
    const plain = await accept(app, { token: b.token, email: "plain.local@example.com", password: PW });
    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json().displayName).toBe("plain.local");

    const c = await createInvite(ctx);
    const longLocal = `${"a".repeat(242)}@example.com`;
    const long = await accept(app, { token: c.token, email: longLocal, password: PW });
    expect(long.statusCode, long.body).toBe(201);
    expect(long.json().displayName).toBe("a".repeat(100));
  });
});

describe("錯誤遮蔽（B-15、spec §5.6）", () => {
  it("IA14：交易的非預期 DB 錯誤 → 500，log 遮蔽（context「接受邀請」、無 password hash、無 params）；邀請未用", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    await db.execute(sql.raw("ALTER TABLE users ADD CONSTRAINT t285_block CHECK (false) NOT VALID"));
    const res = await accept(app, { token: invite.token, email: "ia14@example.com", password: PW });
    // 不洩漏的斷言放最前面：遮蔽被拿掉時要紅在這裡，不被後面的結構斷言遮住。
    const out = ctx.log.out.join("");
    expect(out).not.toContain("$argon2");
    expect(out).not.toMatch(PARAMS_LEAK);
    expect(res.statusCode).toBe(500);
    expect(ctx.log.lines.some(l => l.obj.context === "接受邀請")).toBe(true);
    expect(out).toContain(REDACTED);
    await expectUnused(db, invite.id);
  });

  it("IA14：交易外雜湊查詢的非預期 DB 錯誤 → inspect 與 accept 都 500，log 遮蔽（無 token_hash、無 params）", async () => {
    const ctx = await setup();
    const { app, db } = ctx;
    const invite = await createInvite(ctx);
    await db.execute(sql.raw("ALTER TABLE one_time_links RENAME COLUMN token_hash TO th_t285"));
    // 64-hex 只掃這兩發請求之後的 log（setup 與建邀請的 log 不算），避免別處的 sha256 形欄位誤紅。
    const mark = ctx.log.out.length;
    const inspected = await inspect(app, invite.token);
    const accepted = await accept(app, { token: invite.token, email: "ia14b@example.com", password: PW });
    const out = ctx.log.out.join("");
    // 不洩漏的斷言放最前面（同上）。
    expect(out).not.toContain(hashToken(invite.token));
    expect(ctx.log.out.slice(mark).join("")).not.toMatch(/[0-9a-f]{64}/);
    expect(out).not.toMatch(PARAMS_LEAK);
    expect(inspected.statusCode).toBe(500);
    expect(accepted.statusCode).toBe(500);
    expect(out.split(LOOKUP_REDACTED).length - 1).toBe(2);
  });
});
