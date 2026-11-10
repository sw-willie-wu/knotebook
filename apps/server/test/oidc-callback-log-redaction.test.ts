import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { OIDC_STATE_COOKIE } from "@knotebook/shared";
import { createFakeIdp, type FakeIdp, type FakeIdpClaims } from "./helpers/fake-idp.js";
import { InstanceNotInitializedError, logInitFailure } from "../src/auth/bootstrap.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { buildTestApp } from "./helpers.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import type { OidcTestHook } from "../src/auth/oidc-test-hook.js";

// #211：callback 其餘失敗路徑（code 交換、userinfo、race 重查、catch-all）的 log 不得再帶整個 `err`
// （DrizzleQueryError 的 params 可能含登入者的 sub／email；fetch 錯誤的 message 可能含網址）。

const ISSUER_URL = "https://idp.example.com";
const SECRET = "LEAKME-sub-and-email@example.com";

type Line = Record<string, unknown>;

async function appWithLogs(oidcTestHook?: OidcTestHook): Promise<{ app: FastifyInstance; fakeIdp: FakeIdp; out: string[] }> {
  const out: string[] = [];
  const fakeIdp = createFakeIdp(ISSUER_URL);
  const built = await buildTestApp(
    { oidcRegistry: createOidcRuntimeRegistry({ fetch: fakeIdp.fetch }), ...(oidcTestHook === undefined ? {} : { oidcTestHook }) },
    { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } },
  );
  await seedAuthProvider(built.db, { issuerUrl: ISSUER_URL, legacyCallback: true });
  return { app: built.app, fakeIdp, out };
}

async function runCallback(app: FastifyInstance, fakeIdp: FakeIdp, claims: FakeIdpClaims, prepare?: (idp: FakeIdp) => void): Promise<void> {
  fakeIdp.setNextLogin(claims);
  const loginRes = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
  const { code, state } = fakeIdp.authorize(loginRes.headers.location as string);
  const cookieValue = loginRes.cookies.find(c => c.name === OIDC_STATE_COOKIE)!.value;
  prepare?.(fakeIdp);
  const res = await app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    cookies: { [OIDC_STATE_COOKIE]: cookieValue },
  });
  expect(res.headers.location).toBe("/login?error=oidc_exchange_failed");
}

function lineFor(out: string[], msgPart: string): Line {
  const lines = out.map(s => JSON.parse(s) as Line).filter(l => typeof l.msg === "string" && l.msg.includes(msgPart));
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

function expectNoRawErr(out: string[], line: Line): void {
  expect(line).not.toHaveProperty("err");
  expect(JSON.stringify(line)).not.toContain("stack");
  expect(out.join("")).not.toContain(SECRET);
}

/** 模擬帶值的 DB 錯誤（DrizzleQueryError 形：message 與 params 都有使用者值）。 */
function dbErrorWithValues(code: string): Error {
  const cause = Object.assign(new Error(`duplicate key value (${SECRET})`), { code, detail: `Key (email)=(${SECRET}) already exists.` });
  return Object.assign(new Error(`Failed query: insert ... params: ${SECRET}`, { cause }), { params: [SECRET], code });
}

describe("OIDC callback 失敗路徑的 log 不帶整個 err（#211）", () => {
  it("code 交換失敗：不記 err，只記 errName 摘要", async () => {
    const { app, fakeIdp, out } = await appWithLogs();
    await runCallback(app, fakeIdp, { sub: "u1", email: "a@example.com", email_verified: true }, idp => idp.failNext("token"));
    const line = lineFor(out, "OIDC code 交換失敗");
    expectNoRawErr(out, line);
    expect(line).toHaveProperty("errName");
  });

  it("userinfo 取得失敗：不記 err，只記 errName 摘要", async () => {
    const { app, fakeIdp, out } = await appWithLogs();
    fakeIdp.omitFromIdToken(["email"]);
    await runCallback(app, fakeIdp, { sub: "u2", email: "b@example.com", email_verified: true }, idp => idp.failNext("userinfo"));
    const line = lineFor(out, "OIDC userinfo 取得失敗");
    expectNoRawErr(out, line);
    expect(line).toHaveProperty("errName");
  });

  it("race 重查後仍失敗（DB 錯誤）：走 redactDbError，只記 code／constraint／context", async () => {
    const hook: OidcTestHook = async point => {
      if (point === "login-identity-missed") throw dbErrorWithValues("23505");
    };
    const { app, fakeIdp, out } = await appWithLogs(hook);
    await runCallback(app, fakeIdp, { sub: "u3", email: "c@example.com", email_verified: true });
    const line = lineFor(out, "資料庫錯誤");
    expectNoRawErr(out, line);
    expect(line).toMatchObject({ code: "23505", context: "OIDC 帳號解析 race 重查" });
    expect(line).not.toHaveProperty("params");
  });

  it("callback catch-all（未預期的 DB 錯誤）：不記 err／params", async () => {
    const hook: OidcTestHook = async point => {
      if (point === "login-identity-missed") throw dbErrorWithValues("XX000");
    };
    const { app, fakeIdp, out } = await appWithLogs(hook);
    await runCallback(app, fakeIdp, { sub: "u4", email: "d@example.com", email_verified: true });
    const line = lineFor(out, "資料庫錯誤");
    expectNoRawErr(out, line);
    expect(line).toMatchObject({ code: "XX000", context: "OIDC callback" });
  });

  it("callback catch-all（非 DB 的未預期錯誤）：不記 err，只記 errName 摘要", async () => {
    const hook: OidcTestHook = async point => {
      if (point === "login-identity-missed") throw new Error(`boom ${SECRET}`);
    };
    const { app, fakeIdp, out } = await appWithLogs(hook);
    await runCallback(app, fakeIdp, { sub: "u5", email: "e@example.com", email_verified: true });
    const line = lineFor(out, "OIDC callback 發生未預期錯誤");
    expectNoRawErr(out, line);
    expect(line).toHaveProperty("errName");
  });
});

describe("開機建管理員失敗的 log（#211）", () => {
  function capture(err: unknown): { out: string; lines: Line[] } {
    const lines: Line[] = [];
    const out: string[] = [];
    const log = {
      error(obj: object, msg: string): void {
        // 模擬 pino：err 欄位會被序列化成 message／stack／可列舉屬性（含 params）。
        const e = (obj as { err?: unknown }).err;
        const ser = e instanceof Error ? { ...e, message: e.message, stack: e.stack } : e;
        const line = { ...obj, ...(e === undefined ? {} : { err: ser }), msg };
        lines.push(line as Line);
        out.push(JSON.stringify(line));
      },
    };
    logInitFailure(log, err);
    return { out: out.join(String.fromCharCode(10)), lines };
  }
  const drizzleShaped = (cause: Error): Error => Object.assign(new Error(`Failed query: insert into users params: ${SECRET}`, { cause }), { params: [SECRET] });

  it("DrizzleQueryError 形、帶 SQLSTATE：只記 code／context", () => {
    const { out, lines } = capture(drizzleShaped(Object.assign(new Error(`dup ${SECRET}`), { code: "23505" })));
    expect(out).not.toContain(SECRET);
    expect(lines[0]).toMatchObject({ code: "23505", context: "實例初始化" });
    expect(lines[0]).not.toHaveProperty("err");
  });

  it("DrizzleQueryError 形、cause 沒有 code（連線中斷）：不記 err，記 name", () => {
    const { out, lines } = capture(drizzleShaped(new Error("Connection terminated unexpectedly")));
    expect(out).not.toContain(SECRET);
    expect(lines[0]).toMatchObject({ code: null, context: "實例初始化" });
    expect(lines[0]).toHaveProperty("name");
    expect(lines[0]).not.toHaveProperty("err");
  });

  it("已知的「尚未初始化」錯誤：原樣記（訊息可行動）", () => {
    const { lines } = capture(new InstanceNotInitializedError("此實例尚未初始化：請設定 ADMIN_EMAIL"));
    expect(lines[0]).toHaveProperty("err");
    expect((lines[0]!.err as { message: string }).message).toContain("ADMIN_EMAIL");
  });

  it("結構守衛：index.ts 呼叫 logInitFailure", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"), "utf8");
    const catchAt = src.indexOf("catch (err)", src.indexOf("await initializeInstance("));
    expect(src.slice(catchAt, src.indexOf("process.exit(1)", catchAt))).toContain("logInitFailure(logger, err)");
  });
});
