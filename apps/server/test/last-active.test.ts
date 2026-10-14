/** #267：帶 session cookie 的已驗證請求、共編連線與人的共編變更順手寫 users.last_active_at（行程內節流＋SQL 條件，同一使用者至多每分鐘一次）；bearer token 不寫；登入時寫。時間一律以 DB 時鐘比。 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { LAST_ACTIVE_WRITE_INTERVAL_MS, NOTE_SCHEMA_VERSION, YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { UserGate } from "../src/auth/session.js";
import { signCollabToken } from "../src/collab/token.js";
import { buildCollabTestApp, buildTestApp, insertPasswordUser, testConfig } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";

const PW = "correct-horse-battery-staple";

async function dbNow(db: Db): Promise<string> {
  return (await db.execute<{ t: string }>(sql`select clock_timestamp()::text as t`)).rows[0]!.t;
}
async function lastActiveText(db: Db, userId: string): Promise<string | null> {
  return (await db.execute<{ t: string | null }>(sql`select last_active_at::text as t from users where id = ${userId}`)).rows[0]!.t;
}
async function activeSince(db: Db, userId: string, t0: string): Promise<boolean> {
  return (await db.execute<{ ok: boolean }>(sql`select coalesce(last_active_at >= ${t0}::timestamptz, false) as ok from users where id = ${userId}`)).rows[0]!.ok;
}
/** 把 last_active_at 設成 DB 時鐘往前 `seconds` 秒，回傳設下去的值（text）。 */
async function setActiveSecondsAgo(db: Db, userId: string, seconds: number): Promise<string> {
  return (await db.execute<{ t: string }>(
    sql`update users set last_active_at = now() - make_interval(secs => ${seconds}) where id = ${userId} returning last_active_at::text as t`,
  )).rows[0]!.t;
}

/** 共編的 touch 不 await（fire-and-forget），斷言一律在期限內輪詢 DB。 */
async function waitUntil(label: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

describe("users.last_active_at（#267）", () => {
  it("session cookie 的請求（authenticate 與 authenticateAny 的 session 路徑）寫入；沒 session 的請求不寫", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const v = await seedUser(db);
    expect(await lastActiveText(db, u.id)).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    const t0 = await dbNow(db);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(u.id) })).statusCode).toBe(200);
    expect(await activeSince(db, u.id, t0)).toBe(true);
    // authenticateAny（收 Bearer 的路由）沒帶 Authorization 時走 session：一樣算
    expect((await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(v.id) })).statusCode).toBe(200);
    expect(await activeSince(db, v.id, t0)).toBe(true);
  });

  it("bearer token（PAT）的請求不寫", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const { token } = await seedTokenForUser(db, u.id);
    expect((await app.inject({ method: "GET", url: "/api/notes", headers: bearer(token) })).statusCode).toBe(200);
    expect(await lastActiveText(db, u.id)).toBeNull();
  });

  it("行程內節流：同一 app 寫入間隔（1 分鐘）內第二次請求不再寫（即使 DB 值已舊到 SQL 條件會放行）", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const cookies = await cookieOf(u.id);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
    expect(await lastActiveText(db, u.id)).not.toBeNull();
    const old = await setActiveSecondsAgo(db, u.id, 600);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies })).statusCode).toBe(200);
    expect(await lastActiveText(db, u.id)).toBe(old);
  });

  it("SQL 條件保底：另一個行程（新 app、空節流表）見到 30 秒前的值不寫；2 分鐘前的值才寫", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const recent = await setActiveSecondsAgo(db, u.id, 30);
    const other = await buildTestApp({ db, gate: new UserGate(db) });
    expect((await other.app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(u.id) })).statusCode).toBe(200);
    expect(await lastActiveText(db, u.id)).toBe(recent);

    await setActiveSecondsAgo(db, u.id, 120);
    const third = await buildTestApp({ db, gate: new UserGate(db) });
    const t0 = await dbNow(db);
    expect((await third.app.inject({ method: "GET", url: "/api/auth/me", cookies: await cookieOf(u.id) })).statusCode).toBe(200);
    expect(await activeSince(db, u.id, t0)).toBe(true);
  });

  it("帳密登入同時寫 last_login_at 與 last_active_at", async () => {
    const { app, db } = await buildTestApp();
    const u = await insertPasswordUser(db, { password: PW });
    const t0 = await dbNow(db);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PW } })).statusCode).toBe(200);
    expect(await activeSince(db, u.id, t0)).toBe(true);
    expect((await db.execute<{ same: boolean }>(sql`select last_active_at = last_login_at as same from users where id = ${u.id}`)).rows[0]!.same).toBe(true);
  });

  it("GET /api/admin/users 帶 lastActiveAt：有值是 ISO 字串（＝DB 值）、從無紀錄是 null；lastLoginAt 仍在", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    const never = await seedUser(db);
    const seen = await seedUser(db);
    await db.execute(sql`update users set last_active_at = '2026-10-01T09:12:00.123Z' where id = ${seen.id}`);
    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies: await cookieOf(admin.id) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; lastActiveAt: string | null; lastLoginAt: string | null }>;
    expect(rows.find(r => r.id === never.id)).toMatchObject({ lastActiveAt: null, lastLoginAt: null });
    expect(rows.find(r => r.id === seen.id)!.lastActiveAt).toBe("2026-10-01T09:12:00.123Z");
    // 管理員自己這發請求就是一次 session 活動
    const self = rows.find(r => r.id === admin.id)!.lastActiveAt;
    expect(typeof self).toBe("string");
    expect(new Date(self!).toISOString()).toBe(self);
  });
});

describe("users.last_active_at × 共編（#267）", () => {
  it("共編連線建立時寫入；之後這條連線送來的文件變更也寫入（同一份節流表，滿間隔才再寫）", async () => {
    let now = 0;
    const ctx = await buildCollabTestApp({ lastActiveOptions: { now: () => now } });
    const alice = await ctx.createUser({ email: "alice@example.com", password: PW });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PW);
    // 登入本身會寫（touchLastLogin）；清掉，並把節流時鐘推過一個間隔，讓下面只量得到共編那一下。
    await ctx.db.execute(sql`update users set last_active_at = null where id = ${alice.id}`);
    now += LAST_ACTIVE_WRITE_INTERVAL_MS;
    // 不經 REST 取 token（那是一次 session 請求，會自己寫）：直接簽一張共編 token。
    const token = await signCollabToken(testConfig.appSecret, { noteId: note.id, userId: alice.id, role: "owner", tv: 0, sv: NOTE_SCHEMA_VERSION });
    const client = await session.connect(note.id, { tokenOverride: token });
    await waitUntil("連線建立後 last_active_at 有值", 3_000, async () => (await lastActiveText(ctx.db, alice.id)) !== null);

    const old = await setActiveSecondsAgo(ctx.db, alice.id, 600);
    const edit = (text: string) => {
      const element = new Y.XmlElement("paragraph");
      element.insert(0, [new Y.XmlText(text)]);
      client.doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
    };
    // 節流間隔內的變更不寫。時鐘往前推一點（仍在間隔內）：若節流被繞過，節流表的時間戳就會變成新的 now。
    const stamp = ctx.collab.lastActive.lastAttemptAt(alice.id);
    expect(stamp).toBeDefined();
    now += 1_000;
    edit("within interval");
    const serverHas = (text: string) => async () => ctx.collab.hocuspocus.documents.get(note.id)?.getXmlFragment(YDOC_FRAGMENT).toString().includes(text) ?? false;
    await waitUntil("server 收到間隔內的那筆變更", 3_000, serverHas("within interval"));
    expect(ctx.collab.lastActive.lastAttemptAt(alice.id)).toBe(stamp);
    // touch 不 await：給遲到的寫入一段沉澱時間，期間每次輪詢都必須仍是舊值
    const settleUntil = Date.now() + 500;
    while (Date.now() < settleUntil) {
      expect(await lastActiveText(ctx.db, alice.id)).toBe(old);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // 滿間隔後的變更寫入
    now += LAST_ACTIVE_WRITE_INTERVAL_MS;
    const t0 = await dbNow(ctx.db);
    edit("after interval");
    await waitUntil("文件變更後 last_active_at 更新", 3_000, () => activeSince(ctx.db, alice.id, t0));
  });

  it("bearer token 的 AI 寫入（直連，onChange 的 context 帶 source）不算活動：節流表仍空、last_active_at 仍 NULL", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "bot-owner@example.com", password: PW });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "by token" } });
    expect(res.statusCode).toBe(201);
    const settleUntil = Date.now() + 500;
    while (Date.now() < settleUntil) {
      expect(ctx.collab.lastActive.size).toBe(0);
      expect(await lastActiveText(ctx.db, u.id)).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });
});
