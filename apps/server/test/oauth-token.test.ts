/**
 * #132 Task 7：`POST /oauth/token`（§5.4）。
 *
 * 這一族守的是：①authorization_code 分支的步驟 1–6 是**單一 tx**，任何失敗都回捲
 * （不留下「code 被吃掉卻沒 token」的死狀態，也不留下「I7 刪了舊 grant 卻沒發新的」）；
 * ②I3 code 單次、I4 refresh 輪替、I7 同 (user, client) 單一 grant；③錯誤碼分流——
 * `invalid_target` 不能寫成 `invalid_grant`（client 會誤判 code 壞掉重跑整輪）；
 * ④form 端點：送 JSON → 415、壞 form → 400、所有錯誤都是 400 且 no-store。
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { apiTokens, oauthClients, oauthCodes, users } from "../src/db/schema.js";
import { UserGate } from "../src/auth/session.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, createUserAndLogin, freshDb, freshLimiters, testConfig, type TestApp } from "./helpers.js";

const ISSUER = testConfig.publicUrl.origin;
const RESOURCE = `${ISSUER}/api/mcp`;
const NUL = String.fromCharCode(0);

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** 對既有 client 走一輪 authorize → decision allow，回 code 與 verifier。 */
async function authorizeAndConsent(
  app: TestApp["app"],
  cookie: string,
  clientId: string,
  redirectUri: string,
  scope?: string
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...(scope === undefined ? {} : { scope }),
  });
  const authorized = await app.inject({ method: "GET", url: `/oauth/authorize?${params.toString()}` });
  expect(authorized.statusCode, "authorize 應 302").toBe(302);
  const req = new URL(authorized.headers.location as string, "http://x").searchParams.get("req")!;
  const decided = await app.inject({
    method: "POST",
    url: "/api/oauth/decision",
    headers: { cookie },
    payload: { req, decision: "allow" },
  });
  expect(decided.statusCode, "decision 應 200").toBe(200);
  const code = new URL(decided.json().redirectTo as string).searchParams.get("code")!;
  return { code, verifier };
}

/** DCR → authorize → decision allow，回換發 code 所需的一切。 */
async function obtainCode(app: TestApp["app"], cookie: string, options: { scope?: string } = {}) {
  const registered = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: { client_name: "Test client", redirect_uris: ["http://127.0.0.1:1234/cb"] },
  });
  const clientId = registered.json().client_id as string;
  const redirectUri = "http://127.0.0.1:5678/cb";
  const { code, verifier } = await authorizeAndConsent(app, cookie, clientId, redirectUri, options.scope);
  return { clientId, redirectUri, code, verifier };
}

function exchange(app: TestApp["app"], fields: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });
}

function codeGrant(c: { clientId: string; redirectUri: string; code: string; verifier: string }): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code: c.code,
    code_verifier: c.verifier,
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    resource: RESOURCE,
  };
}

describe("POST /oauth/token — authorization_code（§5.4）", () => {
  it("換發成功：回 access／refresh／scope，header 帶 no-store 與 pragma", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie, { scope: "notes:write" });
      const res = await exchange(app, codeGrant(c));
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers.pragma).toBe("no-cache");
      const body = res.json();
      expect(body.access_token).toMatch(/^knb_[A-Za-z0-9_-]{43}$/);
      expect(body.refresh_token).toMatch(/^knbr_[A-Za-z0-9_-]{43}$/);
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(86400);
      expect(body.scope).toBe("notes:read notes:write");

      // grant 落庫：kind=oauth、name 是 client_name 快照、明文不落庫、access 24h
      const [row] = await db.select().from(apiTokens);
      expect(row!.kind).toBe("oauth");
      expect(row!.name).toBe("Test client");
      expect(row!.clientId).toBe(c.clientId);
      expect(row!.accessTokenHash).not.toBe(body.access_token);
      expect(row!.refreshTokenHash).not.toBe(body.refresh_token);
      const ttl = row!.accessExpiresAt!.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(23 * 3600_000);
      expect(ttl).toBeLessThanOrEqual(24 * 3600_000);
      // I3：code 已被消費
      expect(await db.select().from(oauthCodes)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("換來的 access token 可以打允許清單的路由；client 的 last_used_at 被更新", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const stale = new Date(Date.now() - 10 * 86_400_000);
      await db.update(oauthClients).set({ lastUsedAt: stale }).where(sql`${oauthClients.clientId} = ${c.clientId}`);

      const token = (await exchange(app, codeGrant(c))).json().access_token as string;
      // 斷言要在 Bearer 那一發**之前**：Bearer 路徑（touchLastUsed）也會更新這個欄位，
      // 放後面的話 §5.4 步驟 7 那條 UPDATE 拿掉也照樣綠。
      const [client] = await db.select().from(oauthClients);
      expect(client!.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());

      const res = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  // §9.2 全流程鏈的最後一段：oauth grant 也能從設定頁撤銷，撤了立刻失效。
  // #130 只對 PAT 測過這個端點（查詢是 kind-agnostic，但沒有守衛就會漂）。
  it("撤銷 oauth grant → 該 access token 立刻 401", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const token = (await exchange(app, codeGrant(c))).json().access_token as string;
      expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

      const [row] = await db.select({ id: apiTokens.id }).from(apiTokens);
      const revoked = await app.inject({ method: "DELETE", url: `/api/auth/tokens/${row!.id}`, headers: { cookie } });
      expect(revoked.statusCode).toBe(204);

      const after = await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${token}` } });
      expect(after.statusCode).toBe(401);
      expect(after.headers["www-authenticate"]).toContain('error="invalid_token"');
    } finally {
      await close();
    }
  });

  it("code 二次使用 → invalid_grant（I3）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      expect((await exchange(app, codeGrant(c))).statusCode).toBe(200);
      const replay = await exchange(app, codeGrant(c));
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe("invalid_grant");
      // 重放不撤銷已簽的 grant（§5.5 刻意不做）
      expect(await db.select().from(apiTokens)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // 失敗的兌換整個 tx 回捲＝**不消費 code**（spec §5.4）。同一支 code 修正參數後可重試。
  it("PKCE 不符／client_id 不符／redirect_uri 不符 → invalid_grant，且 code 仍在（tx 回捲）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const overrides: Array<Record<string, string>> = [
        { code_verifier: randomBytes(32).toString("base64url") },
        { client_id: "someone-else" },
        { redirect_uri: "http://127.0.0.1:5678/other" },
        // 註冊時 port 不同沒關係，但 code 綁的是 authorize 當次的完整值（含 port）
        { redirect_uri: "http://127.0.0.1:1234/cb" },
      ];
      for (const override of overrides) {
        const res = await exchange(app, { ...codeGrant(c), ...override });
        expect(res.statusCode, JSON.stringify(override)).toBe(400);
        expect(res.json().error, JSON.stringify(override)).toBe("invalid_grant");
        expect(await db.select().from(oauthCodes), JSON.stringify(override)).toHaveLength(1);
        expect(await db.select().from(apiTokens), JSON.stringify(override)).toHaveLength(0);
      }
      // 正對照：同一支 code 修正參數後仍可換發
      expect((await exchange(app, codeGrant(c))).statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  it("resource 錯或缺 → invalid_target（不是 invalid_grant），且 code 未被消費", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const wrong = await exchange(app, { ...codeGrant(c), resource: `${ISSUER}/api/other` });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error).toBe("invalid_target");
      const { resource: _dropped, ...withoutResource } = codeGrant(c);
      void _dropped;
      const missing = await exchange(app, withoutResource);
      expect(missing.json().error).toBe("invalid_target");
      // resource 檢查在 tx 之前，code 完全沒動
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("過期的 code → invalid_grant", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      await db.update(oauthCodes).set({ expiresAt: sql`now() - interval '1 minute'` });
      const res = await exchange(app, codeGrant(c));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_grant");
    } finally {
      await close();
    }
  });

  // 不走 gate 快取：兌換在 tx 內直接讀 users 列，所以停權後**不 invalidate** 也必須拒——
  // 這一案同時釘住「tx 內不回頭用 pool」（改回 gate.checkUser 會讀到 60s 快取的 ok 而變綠）。
  it("使用者被停用 → invalid_grant，且 code 未被消費（不經 gate 快取）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      await db.update(users).set({ disabledAt: new Date() }).where(sql`${users.id} = ${userId}`);
      const res = await exchange(app, codeGrant(c));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_grant");
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // 承重案：額度不足時整個 tx 必須 ROLLBACK。若 tx 內用回傳值表達失敗（drizzle 只在
  // throw 時 rollback），I7 的 DELETE 會被提交＝舊授權被吞掉卻沒發新 token。
  it("額度不足而拒發時，該 client 既有的 grant 必須原封不動（tx 回捲）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const first = await obtainCode(app, cookie);
      const firstBody = (await exchange(app, codeGrant(first))).json();
      expect(firstBody.access_token).toMatch(/^knb_/);

      // 對同一個 client 再走一輪授權（此時額度還沒滿，decision 才過得了）
      const second = await authorizeAndConsent(app, cookie, first.clientId, first.redirectUri);

      // ⚠ 額度**必須在同意之後、兌換之前**才填滿。I1 讓 decision 與 token 兩側的額度
      // 查詢等價（spec §3），所以沒有任何 PAT 數量能讓 decision 過而 token 拒——
      // 「token 側拒發」唯一到得了的路徑就是同意與兌換之間額度被吃掉。
      await db.insert(apiTokens).values(
        Array.from({ length: 20 }, (_, i) => ({
          userId,
          kind: "pat" as const,
          name: `pat${i}`,
          scope: "notes:read" as const,
          accessTokenHash: `pat-${i}`,
          accessExpiresAt: null,
        }))
      );

      const rejected = await exchange(app, codeGrant({ ...first, ...second }));
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toBe("invalid_grant");
      expect(rejected.json().error_description).toContain("limit");
      // 關鍵：舊 grant 還在，舊 access 仍可用，code 也還在
      const survivors = await db.select().from(apiTokens).where(sql`${apiTokens.clientId} = ${first.clientId}`);
      expect(survivors).toHaveLength(1);
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
      const stillWorks = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${firstBody.access_token}` },
      });
      expect(stillWorks.statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  // §0.2 歸 PR3 的跨棒案：20 支且其中一支屬本 client → 兩側的額度扣除等價，重新授權仍成功
  it("20 支且其中一支屬本 client：重新授權仍成功，該 client 仍只有一列，舊 access 401", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const first = await obtainCode(app, cookie);
      const firstBody = (await exchange(app, codeGrant(first))).json();
      // 再補 19 支 PAT → 計入額度的 grant 共 20 支（含本 client 那一支）
      await db.insert(apiTokens).values(
        Array.from({ length: 19 }, (_, i) => ({
          userId,
          kind: "pat" as const,
          name: `pat${i}`,
          scope: "notes:read" as const,
          accessTokenHash: `pat-${i}`,
          accessExpiresAt: null,
        }))
      );
      // decision 側的扣除述詞（authorizeAndConsent 內會斷言 200）
      const second = await authorizeAndConsent(app, cookie, first.clientId, first.redirectUri);
      // token 側的「先刪後計」
      const res = await exchange(app, codeGrant({ ...first, ...second }));
      expect(res.statusCode).toBe(200);

      const oauthRows = await db.select().from(apiTokens).where(sql`${apiTokens.clientId} = ${first.clientId}`);
      expect(oauthRows).toHaveLength(1); // I7：沒有累積成兩列
      const old = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${firstBody.access_token}` },
      });
      expect(old.statusCode).toBe(401); // 舊 access 已被取代
    } finally {
      await close();
    }
  });

  it("I7：同一 client 二次授權只留一列，舊 access 立刻 401、新的 200", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const first = await obtainCode(app, cookie);
      const firstToken = (await exchange(app, codeGrant(first))).json().access_token as string;
      const second = await authorizeAndConsent(app, cookie, first.clientId, first.redirectUri);
      const secondToken = (await exchange(app, codeGrant({ ...first, ...second }))).json().access_token as string;

      expect(await db.select().from(apiTokens)).toHaveLength(1);
      expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${firstToken}` } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/notes", headers: { authorization: `Bearer ${secondToken}` } })).statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  it("成功後跑 I5：25 小時前的殭屍 client 在這一發後消失", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      // ⚠ zombie 必須在 obtainCode **之後**才插：DCR／authorize／decision 各跑一次 I5，
      // 插在前面會被它們清掉，token 端點的 I5 拿掉也照樣綠（假綠）。
      await db.insert(oauthClients).values({
        clientId: "zombie",
        clientName: "Zombie",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      expect((await exchange(app, codeGrant(c))).statusCode).toBe(200);
      // I5 是 fire-and-forget：有 deadline 的輪詢，固定 sleep 在 WSL 容器上會 flaky
      await expect
        .poll(async () => (await db.select({ id: oauthClients.clientId }).from(oauthClients)).map(r => r.id), {
          timeout: 3_000,
          interval: 25,
        })
        .not.toContain("zombie");
    } finally {
      await close();
    }
  });
});

describe("POST /oauth/token — refresh_token", () => {
  it("輪替成功；舊 refresh 立刻 invalid_grant；scope 沿用", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie, { scope: "notes:write" });
      const first = (await exchange(app, codeGrant(c))).json();
      const stale = new Date(Date.now() - 10 * 86_400_000);
      await db.update(oauthClients).set({ lastUsedAt: stale }).where(sql`${oauthClients.clientId} = ${c.clientId}`);

      const rotated = await exchange(app, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: c.clientId,
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.headers["cache-control"]).toBe("no-store");
      expect(rotated.json().refresh_token).not.toBe(first.refresh_token);
      expect(rotated.json().access_token).not.toBe(first.access_token);
      expect(rotated.json().scope).toBe("notes:read notes:write");
      expect(rotated.json().expires_in).toBe(86400);
      expect(await db.select().from(apiTokens)).toHaveLength(1); // 輪替不是新列
      // 輪替是 I5 ① 的「使用」之一（§5.4 refresh 步驟 4）
      const [client] = await db.select().from(oauthClients);
      expect(client!.lastUsedAt.getTime()).toBeGreaterThan(stale.getTime());

      const replay = await exchange(app, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: c.clientId,
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe("invalid_grant");
      // 舊 access 也隨輪替失效（I4 一次換兩把）
      const oldAccess = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${first.access_token}` },
      });
      expect(oldAccess.statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  it("access 過期後 refresh 仍可換發，新 access 立即可用（§9.2 Bearer 段）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const first = (await exchange(app, codeGrant(c))).json();
      await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 hour'` });

      const expired = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${first.access_token}` },
      });
      expect(expired.statusCode).toBe(401);
      expect(expired.headers["www-authenticate"]).toContain('error="invalid_token"');

      const rotated = (
        await exchange(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.clientId })
      ).json();
      const ok = await app.inject({
        method: "GET",
        url: "/api/notes",
        headers: { authorization: `Bearer ${rotated.access_token}` },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await close();
    }
  });

  it("client_id 不符、前綴不對、查無、使用者停用 → invalid_grant；resource 給錯 → invalid_target", async () => {
    const { db } = await freshDb();
    const gate = new UserGate(db);
    const { app, close } = await buildTestApp({ db, gate });
    try {
      const { cookie, userId } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const first = (await exchange(app, codeGrant(c))).json();

      const wrongClient = await exchange(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "other" });
      expect(wrongClient.json().error).toBe("invalid_grant");
      // access token 當 refresh 送：前綴不對，不進 DB → invalid_grant（畸形憑證不是
      // invalid_request——長度表刻意不設下限，見 TOKEN_FIELD_LIMITS 的說明）
      const accessAsRefresh = await exchange(app, { grant_type: "refresh_token", refresh_token: first.access_token, client_id: c.clientId });
      expect(accessAsRefresh.json().error).toBe("invalid_grant");
      const unknown = await exchange(app, { grant_type: "refresh_token", refresh_token: `knbr_${"x".repeat(43)}`, client_id: c.clientId });
      expect(unknown.json().error).toBe("invalid_grant");
      const wrongResource = await exchange(app, {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: c.clientId,
        resource: `${ISSUER}/api/other`,
      });
      expect(wrongResource.json().error).toBe("invalid_target");
      // 停用：checkUser 失敗 → invalid_grant，且沒有輪替（refresh hash 不變）
      await db.update(users).set({ disabledAt: new Date() }).where(sql`${users.id} = ${userId}`);
      gate.invalidate(userId);
      const disabled = await exchange(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.clientId });
      expect(disabled.json().error).toBe("invalid_grant");
      const [row] = await db.select({ h: apiTokens.refreshTokenHash }).from(apiTokens);
      expect(row!.h).toBe(createHash("sha256").update(first.refresh_token as string).digest("hex"));
    } finally {
      await close();
    }
  });

  it("client_id 含 NUL → invalid_grant，不是 500（不變量 S）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const first = (await exchange(app, codeGrant(c))).json();
      const res = await exchange(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: NUL });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json().error).toBe("invalid_grant");
    } finally {
      await close();
    }
  });
});

describe("POST /oauth/token — 通則", () => {
  it("未知 grant_type → unsupported_grant_type；缺參數／長度不合 → invalid_request", async () => {
    const { app, close } = await buildTestApp();
    try {
      expect((await exchange(app, { grant_type: "client_credentials" })).json().error).toBe("unsupported_grant_type");
      // 缺 grant_type 是 "missing a required parameter"（RFC 6749 §5.2）→ invalid_request
      expect((await exchange(app, {})).json().error).toBe("invalid_request");
      expect((await exchange(app, { grant_type: "refresh_token", client_id: "c" })).json().error).toBe("invalid_request");
      const tooLong = await exchange(app, { grant_type: "refresh_token", refresh_token: "r".repeat(64), client_id: "c" });
      expect(tooLong.json().error).toBe("invalid_request");
      // code_verifier 有下限 43：太短要回 invalid_request，不是 PKCE 失敗的 invalid_grant
      const shortVerifier = await exchange(app, {
        grant_type: "authorization_code",
        code: "c".repeat(43),
        code_verifier: "short",
        client_id: "c",
        redirect_uri: "http://127.0.0.1/cb",
        resource: RESOURCE,
      });
      expect(shortVerifier.json().error).toBe("invalid_request");
      // 長度對但字元集錯（RFC 7636 §4.1 只收 unreserved）：拿掉 CODE_VERIFIER_RE 會變成
      // PKCE 失敗的 invalid_grant，client 會誤判 code 壞掉重跑整輪
      const badCharset = await exchange(app, {
        grant_type: "authorization_code",
        code: "c".repeat(43),
        code_verifier: "%".repeat(43),
        client_id: "c",
        redirect_uri: "http://127.0.0.1/cb",
        resource: RESOURCE,
      });
      expect(badCharset.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  // 不變量 S（code 分支）：所有請求字串都不進 SQL 述詞——code 先 hashToken、client_id／
  // redirect_uri 只在 JS 端與 DB 列比對、verifier 只進 sha256。帶 NUL 一律是 400 業務錯誤。
  it("code 分支的 client_id／code／verifier 含 NUL → 400（不是 500）", async () => {
    const { app, db, close } = await buildTestApp();
    try {
      const { cookie } = await createUserAndLogin(db);
      const c = await obtainCode(app, cookie);
      const cases: Array<[Record<string, string>, string]> = [
        [{ client_id: NUL }, "invalid_grant"],
        [{ code: `${NUL}${"c".repeat(42)}` }, "invalid_grant"],
        [{ code_verifier: `${NUL}${"v".repeat(42)}` }, "invalid_request"],
      ];
      for (const [override, expected] of cases) {
        const res = await exchange(app, { ...codeGrant(c), ...override });
        expect(res.statusCode, JSON.stringify(override)).toBe(400);
        expect(res.headers["content-type"], JSON.stringify(override)).toContain("application/json");
        expect(res.json().error, JSON.stringify(override)).toBe(expected);
      }
      // 都沒消費 code（tx 回捲或根本沒進 tx）
      expect(await db.select().from(oauthCodes)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // M-5：plan 原本有「壞掉的 form body → 400」一案，落不了地——@fastify/formbody 用
  // fast-querystring，`%%%` 之類不會丟例外、只會 parse 成 `{"%%%": ""}`，落到
  // unsupported_grant_type。scoped error handler「保留 formbody 的 415」那條因此仍無守衛。

  // Task 2 留下的假綠缺口：那時 /oauth 下沒有路由，`FORM_EXEMPT_ROUTES` 的查表是死碼，
  // 把 `wantsForm` 改成恆 false 也全綠。這兩案是唯一能釘住「守衛真的去查豁免清單」的地方。
  it("送 form → 過得了守衛（落 400 業務錯誤，不是 415）；送 JSON → 415 RFC 形", async () => {
    const { app, close } = await buildTestApp();
    try {
      const form = await exchange(app, { grant_type: "bogus" });
      expect(form.statusCode).toBe(400);
      expect(form.json().error).toBe("unsupported_grant_type");

      const json = await app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "refresh_token" } });
      expect(json.statusCode).toBe(415);
      expect(json.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  it("GET 該路由 → 404 RFC 形（錯 method 也走 prefix notFound）", async () => {
    const { app, close } = await buildTestApp();
    try {
      const notFound = await app.inject({ method: "GET", url: "/oauth/token" });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json().error).toBe("invalid_request");
    } finally {
      await close();
    }
  });

  it("所有錯誤都是 HTTP 400（RFC 6749 §5.2）且帶 no-store／pragma", async () => {
    const { app, close } = await buildTestApp();
    try {
      const res = await exchange(app, {
        grant_type: "authorization_code",
        code: "c".repeat(43),
        code_verifier: "v".repeat(43),
        client_id: "c",
        redirect_uri: "http://127.0.0.1/cb",
        resource: RESOURCE,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_grant");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers.pragma).toBe("no-cache");
    } finally {
      await close();
    }
  });

  it("超過 TOKEN_ENDPOINT 額度 → 429 RFC 形", async () => {
    const { app, close } = await buildTestApp({
      limiters: freshLimiters({ tokenEndpoint: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }),
    });
    try {
      await exchange(app, { grant_type: "bogus" });
      await exchange(app, { grant_type: "bogus" });
      const res = await exchange(app, { grant_type: "bogus" });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("invalid_request");
      expect(res.headers.pragma).toBe("no-cache");
    } finally {
      await close();
    }
  });
});
