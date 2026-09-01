import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type pino from "pino";
import { OIDC_STATE_COOKIE, SESSION_COOKIE } from "@knotebook/shared";
import { initializeInstance } from "../src/auth/bootstrap.js";
import { backfillHandleRegistry, deriveHandle } from "../src/auth/handle.js";
import { hashPassword } from "../src/auth/password.js";
import { createOidcRuntime } from "../src/auth/oidc-client.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { handles, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { createFakeIdp, type FakeIdp, type FakeIdpClaims } from "./helpers/fake-idp.js";

/**
 * #122 PR1 Task 3：三條建帳路徑的 handle 派生與 registry-first 配置（spec §2a/§2b）。
 *
 * 配置不變量（每條路徑都斷言）：建帳後 `handles` 有一列 `state='live'`、其
 * `handle`＝`users.handle` 且 `user_id`＝該使用者——這是抓 round 4 兩個 Critical
 * （admin 繞過墓碑、釋放退化）回歸的網子（spec §2c「runtime 一致性」）。
 */

async function registryOf(db: Db, email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  expect(user, email).toBeDefined();
  const [reg] = await db.select().from(handles).where(eq(handles.handle, user!.handle)).limit(1);
  return { user: user!, reg };
}

async function expectLiveRegistry(db: Db, email: string): Promise<{ handle: string }> {
  const { user, reg } = await registryOf(db, email);
  expect(reg, `registry 缺列：${user.handle}`).toBeDefined();
  expect(reg!.state).toBe("live");
  expect(reg!.userId).toBe(user.id);
  return { handle: user.handle };
}

describe("deriveHandle（候選序＋探測；spec §2b）", () => {
  it("候選序：preferred_username 優先於 email local-part", async () => {
    const { db } = await freshDb();
    expect(await deriveHandle(db, ["Cool.Name", "willie.wu@x.example".split("@")[0]], "11111111-aaaa-4bbb-8ccc-000000000001")).toBe(
      "cool-name",
    );
  });

  it("四分支退位：沒給／空字串／全非 ASCII（轉完全空）／uuid 形（截斷前判）→ 退 email local-part", async () => {
    const { db } = await freshDb();
    const uuid = "22222222-aaaa-4bbb-8ccc-000000000002";
    expect(await deriveHandle(db, [undefined, "willie"], uuid)).toBe("willie");
    expect(await deriveHandle(db, ["", "willie"], uuid)).toBe("willie");
    expect(await deriveHandle(db, ["日本語", "willie"], uuid)).toBe("willie");
    expect(await deriveHandle(db, ["550e8400-e29b-41d4-a716-446655440000", "willie"], uuid)).toBe("willie");
    // 部分 ASCII 的候選**不**退位——非 ASCII 字元段轉 dash 後的殘餘是合法候選
    // （spec §2b 管線語意：只有「空/uuid 形」才落到下一候選）
    expect(await deriveHandle(db, ["Ünsal", "willie"], uuid)).toBe("nsal");
  });

  it("全候選皆敗 → user-<uuid8>", async () => {
    const { db } = await freshDb();
    expect(await deriveHandle(db, ["日本語", "!!!"], "33333333-aaaa-4bbb-8ccc-000000000003")).toBe("user-33333333");
  });

  it("撞名探測：占用 → -2 遞增（含墓碑占位）", async () => {
    const { db } = await freshDb();
    const uuid = "44444444-aaaa-4bbb-8ccc-000000000004";
    await db.insert(users).values({ id: uuid, email: "seed@x.example", displayName: "S", handle: "seed-holder" });
    await db.insert(handles).values([
      { handle: "willie", userId: uuid, state: "live" },
      { handle: "willie-2", userId: uuid, state: "released", releasedAt: new Date() },
    ]);
    // live 與 released 都占位（永不回收）——探測必須跳過兩者落到 -3
    expect(await deriveHandle(db, ["willie"], uuid)).toBe("willie-3");
  });

  it("探測上限 20 → 退 user-<uuid8>（寫入放大上界）", async () => {
    const { db } = await freshDb();
    const uuid = "55555555-aaaa-4bbb-8ccc-000000000005";
    await db.insert(users).values({ id: uuid, email: "seed2@x.example", displayName: "S", handle: "seed2-holder" });
    const rows = [{ handle: "busy", userId: uuid, state: "live" as const }];
    for (let n = 2; n <= 25; n += 1) rows.push({ handle: `busy-${n}`, userId: uuid, state: "live" });
    await db.insert(handles).values(rows);
    expect(await deriveHandle(db, ["busy"], uuid)).toBe("user-55555555");
  });

  it("尾碼長度算術：30 字元基底補 -2 時重截、總長 ≤32 且尾不落 dash", async () => {
    const { db } = await freshDb();
    const uuid = "66666666-aaaa-4bbb-8ccc-000000000006";
    const base = `${"a".repeat(28)}-b`; // 30 字元、第 29 字元是 dash
    await db.insert(users).values({ id: uuid, email: "seed3@x.example", displayName: "S", handle: "seed3-holder" });
    await db.insert(handles).values({ handle: base, userId: uuid, state: "live" });
    const derived = await deriveHandle(db, [base], uuid);
    // 30 字元基底＋"-2" 尾碼＝32，恰好頂到上限不重截（重截後 trim 的路只有尾碼長 ≥3
    // 且截點落在 dash 上才會走到——SQL backfill 的同公式由 migrate.test 守）
    expect(derived).toBe(`${"a".repeat(28)}-b-2`);
    expect(derived.length).toBeLessThanOrEqual(32);
  });
});

describe("bootstrap 路徑（registry-first；spec §2a）", () => {
  it("env bootstrap 建帳：registry live 列＝users.handle；handle 派生自 email local-part", async () => {
    const { db } = await freshDb();
    await initializeInstance(db, { email: "Admin.Boss@corp.example", password: "a-very-long-pw" });
    const { handle } = await expectLiveRegistry(db, "admin.boss@corp.example");
    expect(handle).toBe("admin-boss");
  });

  it("雙次 bootstrap（序列）：第二次 no-op、不留孤兒 registry 列", async () => {
    const { db } = await freshDb();
    await initializeInstance(db, { email: "boss@corp.example", password: "a-very-long-pw" });
    await initializeInstance(db, { email: "boss2@corp.example", password: "a-very-long-pw" });
    const allHandles = await db.select().from(handles);
    expect(allHandles).toHaveLength(1); // 只有第一次的那列；第二次早退不得留 boss2 的孤兒
    expect(allHandles[0].handle).toBe("boss");
  });

  it("**併發** bootstrap：敗方不得 commit 孤兒 registry 列（INSERT 必須在 setupRow 守衛之後——突變審查 MAJOR-2：序列版進不了 tx 的守衛分支，只有併發才踩得到）", async () => {
    const { db } = await freshDb();
    // 兩個不同 email 同時搶 instance_setup 單列——敗方走 tx 內 `if (!setupRow) return`
    //（正常 COMMIT 早退）：registry INSERT 若在守衛之前，敗方會留下指向不存在使用者、
    // 永久燒掉名字的 live 列。勝負由 instanceSetup PK 裁決，結果集合確定、非 flaky。
    await Promise.all([
      initializeInstance(db, { email: "boss@corp.example", password: "a-very-long-pw" }),
      initializeInstance(db, { email: "other@corp.example", password: "a-very-long-pw" }),
    ]);
    const allHandles = (await db.select().from(handles)).map((row) => row.handle).sort();
    expect(allHandles).toHaveLength(1);
    expect(["boss", "other"]).toContain(allHandles[0]);
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0].handle).toBe(allHandles[0]);
  });

  it("派生名被墓碑占住 → 探測避讓到 -2（墓碑永不回收；「探測後仍撞 PK 的 fail-closed」是真競態、單執行緒無 mock 造不出——已記錄為缺口）", async () => {
    const { db } = await freshDb();
    await db.insert(users).values({ id: "77777777-aaaa-4bbb-8ccc-000000000007", email: "x@x.example", displayName: "X", handle: "x-holder" });
    await db.insert(handles).values({ handle: "boss", userId: "77777777-aaaa-4bbb-8ccc-000000000007", state: "released", releasedAt: new Date() });
    await initializeInstance(db, { email: "boss@corp.example", password: "a-very-long-pw" });
    const { handle } = await expectLiveRegistry(db, "boss@corp.example");
    expect(handle).toBe("boss-2"); // 墓碑永不回收——即使 released 也不重發
  });
});

describe("admin 建帳路徑（spec §2b；constraint 判別 M4-2）", () => {
  async function adminApp() {
    const { app, db } = await buildTestApp();
    await db.insert(users).values({
      email: "admin@x.example",
      displayName: "Admin",
      isAdmin: true,
      passwordHash: await hashPassword("a-very-long-pw"),
      handle: "admin",
    });
    await backfillHandleRegistry(db, { warn: () => {}, info: () => {} } as unknown as pino.Logger);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@x.example", password: "a-very-long-pw" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)!;
    return { app, db, cookies: { [cookie.name]: cookie.value } };
  }

  const CREATE = { email: "new.user@x.example", password: "another-long-pw", displayName: "New" };

  it("未指定 handle → 派生自 email local-part；201 body 帶 handle；registry 一致", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/users", payload: CREATE, cookies });
    expect(res.statusCode).toBe(201);
    expect(res.json().handle).toBe("new-user");
    await expectLiveRegistry(db, "new.user@x.example");
  });

  it("指定合法 handle → 原樣使用（經正規化）；registry 一致", async () => {
    const { app, db, cookies } = await adminApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { ...CREATE, handle: "Chosen-Name" },
      cookies,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().handle).toBe("chosen-name");
    await expectLiveRegistry(db, "new.user@x.example");
  });

  it("指定非法 handle → 400 invalid_body（不落 DB CHECK 500）", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { ...CREATE, handle: "bad name!" },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("指定已占用（live 或墓碑）→ 409 **handle_taken**（不得誤報 email_taken——判別契約）", async () => {
    const { app, db, cookies } = await adminApp();
    await db.insert(handles).values({ handle: "taken-live", userId: "88888888-aaaa-4bbb-8ccc-000000000008", state: "live" });
    await db.insert(handles).values({ handle: "taken-tomb", userId: "88888888-aaaa-4bbb-8ccc-000000000008", state: "released", releasedAt: new Date() });
    for (const handle of ["taken-live", "taken-tomb"]) {
      const res = await app.inject({ method: "POST", url: "/api/admin/users", payload: { ...CREATE, handle }, cookies });
      expect(res.statusCode, handle).toBe(409);
      expect(res.json().error.code, handle).toBe("handle_taken");
    }
  });

  it("email 撞名仍回 email_taken（判別契約另一方向不受影響）；失敗的建帳不得燒掉 handle（tx 原子性——突變審查 MAJOR-3）", async () => {
    const { app, db, cookies } = await adminApp();
    const before = (await db.select().from(handles)).map((row) => row.handle).sort();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { ...CREATE, email: "admin@x.example" },
      cookies,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("email_taken");
    // registry 與 users 拆成獨立 insert 的退化形：registry 先成功、users 撞 email 失敗
    // → 每次失敗建帳永久燒掉一個名字。tx 原子性由此斷言守。
    const after = (await db.select().from(handles)).map((row) => row.handle).sort();
    expect(after).toEqual(before);
  });

  it("派生撞名 → 探測自動避讓（-2），不 409；registry 一致", async () => {
    const { app, db, cookies } = await adminApp();
    // 'new-user' 先被墓碑占住
    await db.insert(handles).values({ handle: "new-user", userId: "99999999-aaaa-4bbb-8ccc-000000000009", state: "released", releasedAt: new Date() });
    const res = await app.inject({ method: "POST", url: "/api/admin/users", payload: CREATE, cookies });
    expect(res.statusCode).toBe(201);
    expect(res.json().handle).toBe("new-user-2");
    await expectLiveRegistry(db, "new.user@x.example");
  });

  it("派生撞 users_handle_unique（窗期形：users.handle 占名但無 registry 列，探測看不見）→ 重試耗盡 → 第 4 次退 user-<uuid8>（讀碼審查 m2：整條重試梯的真路徑覆蓋，無 mock）", async () => {
    const { app, db, cookies } = await adminApp();
    // 窗期形：'new-user' 只在 users.handle（無 registry 列）——deriveHandle 只探測
    // handles 表、判定可用；INSERT users 才撞 users_handle_unique。重試 1–3 次每次
    // 重新探測仍得同名、同樣撞（確定性），第 4 次退 uuid8 成功。
    await db.insert(users).values({
      id: "12121212-aaaa-4bbb-8ccc-000000000012",
      email: "window@x.example",
      displayName: "W",
      handle: "new-user",
    });
    const res = await app.inject({ method: "POST", url: "/api/admin/users", payload: CREATE, cookies });
    expect(res.statusCode).toBe(201);
    expect(res.json().handle).toMatch(/^user-[0-9a-f]{8}$/);
    await expectLiveRegistry(db, "new.user@x.example");
  });

  it("指定空字串 handle → 400（顯式給了非法值就報錯，不當成「空＝派生」）", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({ method: "POST", url: "/api/admin/users", payload: { ...CREATE, handle: "" }, cookies });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("GET /api/admin/users 清單帶 handle", async () => {
    const { app, cookies } = await adminApp();
    const res = await app.inject({ method: "GET", url: "/api/admin/users", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].handle).toBe("admin");
  });
});

describe("OIDC 建帳路徑（preferred_username；spec §2b M3-8）", () => {
  // 工具形比照 oidc-callback.test.ts 的檔內私有慣例，這裡自帶一份。
  const ISSUER_URL = "https://idp.example.com";
  function oidcConfig(): AppConfig {
    return loadConfig({
      DATABASE_URL: "postgres://u:p@localhost:5432/test",
      APP_SECRET: "a".repeat(64),
      PUBLIC_URL: "http://localhost:3000",
      OIDC_ISSUER_URL: ISSUER_URL,
      OIDC_CLIENT_ID: "test-client",
      OIDC_CLIENT_SECRET: "test-secret",
    });
  }

  async function oidcApp() {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app, db } = await buildTestApp({ config, oidc: runtime });
    return { app, db, fakeIdp };
  }

  async function loginAs(
    app: Awaited<ReturnType<typeof buildTestApp>>["app"],
    fakeIdp: FakeIdp,
    claims: FakeIdpClaims,
  ) {
    fakeIdp.setNextLogin(claims);
    const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find((c) => c.name === OIDC_STATE_COOKIE)!.value;
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      cookies: { [OIDC_STATE_COOKIE]: cookieValue },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    return res;
  }

  it("id_token 帶 preferred_username → handle 用它；registry 一致", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    await loginAs(app, fakeIdp, { sub: "u1", email: "sso.user@corp.example", email_verified: true, preferred_username: "Cool.Person" });
    const { handle } = await expectLiveRegistry(db, "sso.user@corp.example");
    expect(handle).toBe("cool-person");
  });

  it("IdP 沒給 preferred_username → 退 email local-part（不多打 userinfo——閘門不放寬）", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    await loginAs(app, fakeIdp, { sub: "u2", email: "plain.user@corp.example", email_verified: true });
    const { handle } = await expectLiveRegistry(db, "plain.user@corp.example");
    expect(handle).toBe("plain-user");
    expect(fakeIdp.counts.userinfo).toBe(0); // email 齊全→userinfo 本來就不打；不得為 handle 多打
  });

  it("preferred_username 空字串／全非 ASCII／uuid 形 → 退 email local-part", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    const cases: Array<[string, string, string]> = [
      ["", "e1@corp.example", "e1"],
      ["日本語", "e2@corp.example", "e2"],
      ["550e8400-e29b-41d4-a716-446655440000", "e3@corp.example", "e3"],
    ];
    for (const [preferred, email, expected] of cases) {
      await loginAs(app, fakeIdp, { sub: `s-${expected}`, email, email_verified: true, preferred_username: preferred });
      const { handle } = await expectLiveRegistry(db, email);
      expect(handle, email).toBe(expected);
    }
  });

  it("OIDC 建帳撞 users_handle_unique（窗期形）→ 整-tx-重投一次仍同名撞 → oidc_exchange_failed（讀碼審查 m2/m3：OIDC 無 uuid8 出口的確定性形，重登可再試；窗期由 boot 補登收斂）", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    await db.insert(users).values({
      id: "13131313-aaaa-4bbb-8ccc-000000000013",
      email: "window2@x.example",
      displayName: "W2",
      handle: "sso-window",
    });
    fakeIdp.setNextLogin({ sub: "uw", email: "sso.window@corp.example", email_verified: true, preferred_username: "sso.window" });
    const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
    const cookieValue = loginRes.cookies.find((c) => c.name === OIDC_STATE_COOKIE)!.value;
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      cookies: { [OIDC_STATE_COOKIE]: cookieValue },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
  });

  it("userinfo 本來就要打（id_token 缺 email）時順手讀 preferred_username", async () => {
    const { app, db, fakeIdp } = await oidcApp();
    // ⚠ preferred_username 也要從 id_token 省略（讀碼審查 M1）：否則 oidc.ts 已從
    // id_token 讀到值、userinfo 順手讀那行（唯一消費點）零覆蓋、刪掉照樣綠。
    fakeIdp.omitFromIdToken(["email", "email_verified", "preferred_username"]);
    await loginAs(app, fakeIdp, { sub: "u3", email: "via.userinfo@corp.example", email_verified: true, preferred_username: "From.Userinfo" });
    const { handle } = await expectLiveRegistry(db, "via.userinfo@corp.example");
    expect(handle).toBe("from-userinfo");
    expect(fakeIdp.counts.userinfo).toBe(1);
  });
});

describe("boot 補登＋DTO（spec §2a/§2b）", () => {
  it("backfillHandleRegistry 冪等；被吞的衝突列會 log warn", async () => {
    const { db } = await freshDb();
    await db.insert(users).values([
      { id: "aaaaaaaa-aaaa-4bbb-8ccc-00000000000a", email: "a@x.example", displayName: "A", handle: "alice" },
      { id: "bbbbbbbb-aaaa-4bbb-8ccc-00000000000b", email: "b@x.example", displayName: "B", handle: "bob" },
    ]);
    const warns: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warns.push(args), info: () => {} } as unknown as pino.Logger;
    await backfillHandleRegistry(db, logger);
    expect((await db.select().from(handles))).toHaveLength(2);
    await backfillHandleRegistry(db, logger); // 冪等
    expect((await db.select().from(handles))).toHaveLength(2);
    expect(warns).toHaveLength(0);

    // 衝突形：alice 的名字已被別人的 registry 列占住（窗期碰撞）→ 補登吞掉並 warn
    await db.insert(users).values({ id: "cccccccc-aaaa-4bbb-8ccc-00000000000c", email: "c@x.example", displayName: "C", handle: "charlie" });
    await db.update(handles).set({ userId: "bbbbbbbb-aaaa-4bbb-8ccc-00000000000b" }).where(eq(handles.handle, "alice"));
    await db.update(users).set({ handle: "charlie" }).where(eq(users.email, "c@x.example"));
    await db.insert(handles).values({ handle: "charlie", userId: "aaaaaaaa-aaaa-4bbb-8ccc-00000000000a", state: "live" });
    await backfillHandleRegistry(db, logger);
    expect(warns.length).toBeGreaterThan(0);
  });

  it("結構守衛：index.ts 的補登呼叫在 app.listen 之前（listen 前時序——plan 注意事項 1）", () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
      "utf8",
    );
    // 錨定**呼叫點**字面（"backfillHandleRegistry(db"），不能只找函式名——那會先命中
    // 檔頭的 import 敘述、恆早於 listen，呼叫搬走甚至刪掉都照樣綠（突變審查 MAJOR-1）。
    const callAt = src.indexOf("backfillHandleRegistry(db");
    const listenAt = src.indexOf(".listen(");
    expect(callAt, "index.ts 必須呼叫 backfillHandleRegistry(db…)").toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(callAt, "補登必須在 listen 之前（否則與首個改名請求可交錯）").toBeLessThan(listenAt);
  });

  it("/api/auth/me 與 login DTO 都帶 handle（GateUser/GateRow 接線）", async () => {
    const { app, db } = await buildTestApp();
    
    await db.insert(users).values({
      email: "who@x.example",
      displayName: "Who",
      passwordHash: await hashPassword("a-very-long-pw"),
      handle: "whoami",
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "who@x.example", password: "a-very-long-pw" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().handle).toBe("whoami");
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)!;
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { [cookie.name]: cookie.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json().handle).toBe("whoami");
  });
});
