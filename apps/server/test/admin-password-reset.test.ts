/**
 * #286 管理員端：產生／取消重設密碼連結（spec §4.2）、`AdminUserDto` 兩欄、log 與錯誤遮蔽（§3.8）、清理掛點（§3.7）。
 * 停用連帶撤銷在 `admin-users.test.ts` 的停用段。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { cookieOf, seedUser, waitForBlockedOrSettled, waitForLockWaiters } from "./group-helpers.js";
import { oneTimeLinks, siteSettings, users } from "../src/db/schema.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { hashToken } from "../src/auth/api-token.js";

const PASSWORD = "correct-horse-battery";
const TOKEN_RE = /^knbp_[A-Za-z0-9_-]{43}$/;
const REDACTED = "產生重設密碼連結時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
/** 同 `admin-ai-log-redaction.test.ts:27`：DrizzleQueryError 的 params 落進 JSON log 的兩形。 */
const PARAMS_LEAK = /params: |"params"\s*:/;

/** 以真 `hashPassword` 建有密碼的帳號（比照 `admin-users.test.ts` 的 insertUser）。 */
async function userWithPassword(db: Db, over: { disabled?: boolean; email?: string } = {}) {
  const tag = randomUUID().slice(0, 12);
  const [u] = await db
    .insert(users)
    .values({
      email: over.email ?? `pr-${tag}@example.com`,
      handle: `pr-${tag}`,
      displayName: `PR ${tag}`,
      passwordHash: await hashPassword(PASSWORD),
      ...(over.disabled ? { disabledAt: new Date() } : {}),
    })
    .returning();
  return u!;
}

/** pino 的 `logMethod` hook（結構化欄位）＋ stream（整份輸出字串）兩路一起收。 */
function logs() {
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
  const log = logs();
  const built = await buildTestApp(overrides, log.options);
  const admin = await seedUser(built.db, { isAdmin: true });
  return { ...built, admin, cookies: await cookieOf(admin.id), log };
}

const url = (id: string) => `/api/admin/users/${id}/password-reset`;

function issue(app: FastifyInstance, cookies: Record<string, string>, id: string, payload: unknown = { expiresInHours: 1 }) {
  return app.inject({ method: "POST", url: url(id), cookies, payload: payload as object });
}

function cancel(app: FastifyInstance, cookies: Record<string, string>, id: string) {
  return app.inject({ method: "DELETE", url: url(id), cookies });
}

async function allLinks(db: Db) {
  return db.select().from(oneTimeLinks).orderBy(asc(oneTimeLinks.createdAt), asc(oneTimeLinks.id));
}

async function linkById(db: Db, id: string) {
  const [row] = await db.select().from(oneTimeLinks).where(eq(oneTimeLinks.id, id));
  return row!;
}

/** 把連結整列推回過去（同時推 `created_at`，守住 `expiry_chk`）。 */
async function expireLink(db: Db, id: string) {
  await db.execute(sql`update one_time_links set created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where id = ${id}`);
}

async function disablePasswordLogin(db: Db) {
  await db.update(siteSettings).set({ passwordLoginEnabled: false });
}

describe("POST /api/admin/users/:id/password-reset", () => {
  it("G1：201 只回 token／expiresAt；DB 一列只存雜湊、時效＝expiresInHours", async () => {
    const { app, db, admin, cookies } = await setup();
    const target = await userWithPassword(db);
    const res = await issue(app, cookies, target.id, { expiresInHours: 3 });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "token"]);
    expect(body.token).toMatch(TOKEN_RE);

    const rows = await allLinks(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ kind: "password_reset", targetUserId: target.id, createdById: admin.id, usedAt: null, revokedAt: null });
    expect(row.tokenHash).toBe(hashToken(body.token));
    const [{ secs }] = (await db.execute<{ secs: number }>(sql`select extract(epoch from expires_at - created_at)::int as secs from one_time_links where id = ${row.id}`)).rows;
    expect(secs).toBe(10800);
    expect(body.expiresAt).toBe(row.expiresAt.toISOString());
  });

  it.each([
    ["0", { expiresInHours: 0 }],
    ["25", { expiresInHours: 25 }],
    ["1.5", { expiresInHours: 1.5 }],
    ["字串 \"1\"", { expiresInHours: "1" }],
    ["空物件", {}],
    ["多欄", { expiresInHours: 1, extra: 1 }],
  ])("G2：body %s → 400 invalid_body、不插列", async (_name, payload) => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    const res = await issue(app, cookies, target.id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(await allLinks(db)).toHaveLength(0);
  });

  it("G2：邊界 1 與 24 → 201", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id, { expiresInHours: 1 })).statusCode).toBe(201);
    expect((await issue(app, cookies, target.id, { expiresInHours: 24 })).statusCode).toBe(201);
  });

  it("G3：停用 409 user_disabled；無密碼 409 password_not_set；不存在／非 uuid 404；都不插列", async () => {
    const { app, db, cookies } = await setup();
    const disabled = await userWithPassword(db, { disabled: true });
    const res1 = await issue(app, cookies, disabled.id);
    expect(res1.statusCode).toBe(409);
    expect(res1.json()).toMatchObject({ error: { code: "user_disabled" } });

    const sso = await seedUser(db);
    const res2 = await issue(app, cookies, sso.id);
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toMatchObject({ error: { code: "password_not_set" } });

    const res3 = await issue(app, cookies, randomUUID());
    expect(res3.statusCode).toBe(404);
    expect(res3.json()).toMatchObject({ error: { code: "user_not_found" } });

    const res4 = await issue(app, cookies, "not-a-uuid");
    expect(res4.statusCode).toBe(404);
    expect(res4.json()).toMatchObject({ error: { code: "user_not_found" } });

    expect(await allLinks(db)).toHaveLength(0);
  });

  it("G3 回歸：大寫 UUID → 201、恰插一列", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id.toUpperCase())).statusCode).toBe(201);
    expect(await allLinks(db)).toHaveLength(1);
  });

  it("G4：帳密有效值關 → 合法目標與不存在的 uuid 都 403；非 uuid 404；壞 body 400；不插列", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    await disablePasswordLogin(db);

    const res1 = await issue(app, cookies, target.id);
    expect(res1.statusCode).toBe(403);
    expect(res1.json()).toMatchObject({ error: { code: "password_login_disabled" } });
    const res2 = await issue(app, cookies, randomUUID());
    expect(res2.statusCode).toBe(403);
    const res3 = await issue(app, cookies, "not-a-uuid");
    expect(res3.statusCode).toBe(404);
    const res4 = await issue(app, cookies, target.id, { expiresInHours: 0 });
    expect(res4.statusCode).toBe(400);
    expect(await allLinks(db)).toHaveLength(0);
  });

  it("G4：PASSWORD_LOGIN_FORCE_ENABLE＋DB 關閉 → 201", async () => {
    const { app, db, cookies } = await setup({ config: { ...testConfig, passwordLoginForceEnable: true } });
    const target = await userWithPassword(db);
    await disablePasswordLogin(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
  });

  it("G5：連產兩支 → 第一支撤銷、第二支有效；log 的 replaced 依序 0、1", async () => {
    const { app, db, cookies, log } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [first, second] = await allLinks(db);
    expect(first!.revokedAt).not.toBeNull();
    expect(second!.revokedAt).toBeNull();
    expect(second!.usedAt).toBeNull();
    expect(log.lines.filter(l => l.msg === "產生重設密碼連結").map(l => l.obj.replaced)).toEqual([0, 1]);
  });

  it("G7：產生不影響現有登入與密碼（cookie 仍有效、舊密碼仍可登入、token_version 不變）", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: target.email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const targetCookie = login.cookies.find(c => c.name === SESSION_COOKIE)!.value;

    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [SESSION_COOKIE]: targetCookie } });
    expect(me.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: target.email, password: PASSWORD } });
    expect(again.statusCode).toBe(200);
    const [row] = await db.select({ tv: users.tokenVersion }).from(users).where(eq(users.id, target.id));
    expect(row!.tv).toBe(0);
  });

  it("G9：產生 log 的欄位恰為五鍵；整份 log 不含 token 明文與雜湊", async () => {
    const { app, db, admin, cookies, log } = await setup();
    const target = await userWithPassword(db);
    const res = await issue(app, cookies, target.id);
    expect(res.statusCode).toBe(201);
    const { token } = res.json() as { token: string };
    const lines = log.lines.filter(l => l.msg === "產生重設密碼連結");
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!.obj).sort()).toEqual(["expiresAt", "linkId", "replaced", "targetUserId", "userId"]);
    expect(lines[0]!.obj).toMatchObject({ userId: admin.id, targetUserId: target.id, replaced: 0 });
    const out = log.out.join("");
    expect(out).toContain("產生重設密碼連結");
    expect(out).not.toContain(token);
    expect(out).not.toContain(hashToken(token));
  });

  it("G10：交易的非預期 DB 錯誤 → 500，log 遮蔽（無 params、無 64 位十六進位）", async () => {
    const { app, db, cookies, log } = await setup();
    const target = await userWithPassword(db);
    await db.execute(sql.raw("ALTER TABLE one_time_links ADD CONSTRAINT t286_block CHECK (false) NOT VALID"));
    const res = await issue(app, cookies, target.id);
    expect(res.statusCode).toBe(500);
    const out = log.out.join("");
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(PARAMS_LEAK);
    expect(out).not.toMatch(/[0-9a-f]{64}/);
  });

  it("G11：產生成功後機會性清理 30 天前結束的舊列", async () => {
    const { app, db, cookies } = await setup();
    const other = await userWithPassword(db);
    const target = await userWithPassword(db);
    const [{ id: oldId }] = (
      await db.execute<{ id: string }>(
        sql`insert into one_time_links (kind, token_hash, target_user_id, created_at, expires_at, revoked_at)
            values ('password_reset', ${hashToken(randomUUID())}, ${other.id}, now() - interval '32 days', now() - interval '31 days' + interval '1 hour', now() - interval '31 days')
            returning id`,
      )
    ).rows;
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const deadline = Date.now() + 2_000;
    let gone = false;
    while (Date.now() < deadline) {
      const rows = await db.select({ id: oneTimeLinks.id }).from(oneTimeLinks).where(eq(oneTimeLinks.id, oldId!));
      if (rows.length === 0) {
        gone = true;
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(gone).toBe(true);
  });

  // spec §3.5／§4.6：產生先鎖 users 列。沒有這把鎖時，產生讀到「未停用」後停用才 commit，INSERT 的 FK 只取 KEY SHARE
  // 不被擋 → 停用帳號留下一支有效連結（重新啟用即可用）。
  it("G12：產生與停用並發——raw client 持 users 列鎖時停用，產生被擋，放行後 409 user_disabled、不插列", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    const client = await db.$client.connect();
    let pending: ReturnType<typeof issue> | undefined;
    try {
      await client.query("begin");
      await client.query("select 1 from users where id = $1 for no key update", [target.id]);
      pending = issue(app, cookies, target.id);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await client.query("update users set disabled_at = now() where id = $1", [target.id]);
    } finally {
      await client.query("commit");
      client.release();
    }
    const res = await pending!;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "user_disabled" } });
    expect(await allLinks(db)).toHaveLength(0);
  });

  // 同一人並發產生兩支：users 列鎖讓兩發排隊，後一發把前一支標為取代，不撞 I3 的 partial unique index。
  // 交錯：raw client 以 SHARE MODE 鎖住 one_time_links，兩發都卡在撤銷那句之前——鎖是 NO KEY UPDATE 時第二發卡在 users 列；
  // 鎖若弱成 FOR SHARE，兩發都會拿到列鎖、各自 INSERT，後到的撞 23505 → 500。
  it("G13：同一人並發產生兩支 → 兩發都 201、最後恰一支有效", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    const client = await db.$client.connect();
    let first: ReturnType<typeof issue> | undefined;
    let second: ReturnType<typeof issue> | undefined;
    try {
      await client.query("begin");
      await client.query("lock table one_time_links in share mode");
      first = issue(app, cookies, target.id);
      second = issue(app, cookies, target.id);
      await waitForLockWaiters(db.$client, 2);
    } finally {
      await client.query("commit");
      client.release();
    }
    const results = await Promise.all([first!, second!]);
    expect(results.map(r => r.statusCode)).toEqual([201, 201]);
    const active = (await allLinks(db)).filter(l => l.usedAt === null && l.revokedAt === null);
    expect(active).toHaveLength(1);
  });
});

describe("DELETE /api/admin/users/:id/password-reset", () => {
  it("G6：204 撤銷；再取消 204；從未產生 204；不存在／非 uuid 404；log 三鍵", async () => {
    const { app, db, admin, cookies, log } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [link] = await allLinks(db);

    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);
    expect((await linkById(db, link!.id)).revokedAt).not.toBeNull();
    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);

    const never = await userWithPassword(db);
    expect((await cancel(app, cookies, never.id)).statusCode).toBe(204);

    const missing = await cancel(app, cookies, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "user_not_found" } });
    const bad = await cancel(app, cookies, "not-a-uuid");
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toMatchObject({ error: { code: "user_not_found" } });

    const cancelLogs = log.lines.filter(l => l.msg === "取消重設密碼連結");
    expect(cancelLogs.map(l => l.obj)).toEqual([
      { userId: admin.id, targetUserId: target.id, revoked: 1 },
      { userId: admin.id, targetUserId: target.id, revoked: 0 },
      { userId: admin.id, targetUserId: never.id, revoked: 0 },
    ]);
  });

  it("G6：過期但未用的列也撤銷", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [link] = await allLinks(db);
    await expireLink(db, link!.id);
    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);
    expect((await linkById(db, link!.id)).revokedAt).not.toBeNull();
  });

  it("G6：帳密關閉時取消照樣 204 且撤銷", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [link] = await allLinks(db);
    await disablePasswordLogin(db);
    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);
    expect((await linkById(db, link!.id)).revokedAt).not.toBeNull();
  });

  it("G6：DB 直接標停用的人 → 取消 204 且撤銷", async () => {
    const { app, db, cookies } = await setup();
    const target = await userWithPassword(db);
    expect((await issue(app, cookies, target.id)).statusCode).toBe(201);
    const [link] = await allLinks(db);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, target.id));
    expect((await cancel(app, cookies, target.id)).statusCode).toBe(204);
    expect((await linkById(db, link!.id)).revokedAt).not.toBeNull();
  });
});

describe("AdminUserDto 的 hasPassword／passwordResetExpiresAt（G8）", () => {
  type Dto = { id: string; hasPassword: boolean; passwordResetExpiresAt: string | null };

  async function listed(app: FastifyInstance, cookies: Record<string, string>): Promise<Map<string, Dto>> {
    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies });
    expect(res.statusCode).toBe(200);
    return new Map((res.json() as Dto[]).map(u => [u.id, u]));
  }

  it("GET／PATCH storage-plan 兩種回應；過期與撤銷 → null；回應不含 token 或雜湊", async () => {
    const { app, db, cookies } = await setup();
    const a = await userWithPassword(db);
    const b = await userWithPassword(db);
    const c = await seedUser(db);
    const issued = await issue(app, cookies, a.id);
    expect(issued.statusCode).toBe(201);
    const tokens = [(issued.json() as { token: string }).token];
    const [link] = await allLinks(db);
    const iso = link!.expiresAt.toISOString();
    const bodies: string[] = [];

    const getRes = await app.inject({ method: "GET", url: "/api/admin/users", cookies });
    bodies.push(getRes.body);
    const list = await listed(app, cookies);
    expect(list.get(a.id)).toMatchObject({ hasPassword: true, passwordResetExpiresAt: iso });
    expect(list.get(b.id)).toMatchObject({ hasPassword: true, passwordResetExpiresAt: null });
    expect(list.get(c.id)).toMatchObject({ hasPassword: false, passwordResetExpiresAt: null });

    // RETURNING 的關聯（drizzle 單表 RETURNING 去表名的雷）：有效連結時 PATCH 回應也要帶到期時間。
    const [{ id: planId }] = (await db.execute<{ id: string }>(sql`select id from storage_plans limit 1`)).rows;
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/users/${a.id}/storage-plan`, cookies, payload: { planId } });
    expect(patched.statusCode).toBe(200);
    bodies.push(patched.body);
    expect(patched.json()).toMatchObject({ id: a.id, hasPassword: true, passwordResetExpiresAt: iso });

    await expireLink(db, link!.id);
    expect((await listed(app, cookies)).get(a.id)!.passwordResetExpiresAt).toBeNull();

    const reissued = await issue(app, cookies, a.id);
    expect(reissued.statusCode).toBe(201);
    tokens.push((reissued.json() as { token: string }).token);
    expect((await listed(app, cookies)).get(a.id)!.passwordResetExpiresAt).not.toBeNull();
    await db.execute(sql`update one_time_links set revoked_at = now() where target_user_id = ${a.id} and revoked_at is null`);
    expect((await listed(app, cookies)).get(a.id)!.passwordResetExpiresAt).toBeNull();

    for (const body of bodies) {
      for (const token of tokens) {
        expect(body).not.toContain(token);
        expect(body).not.toContain(hashToken(token));
      }
    }
  });
});
