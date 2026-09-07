/**
 * #108 PR1 Task 2：`/api/mcp` 的**傳輸層形狀**（規格 §14.1）。
 *
 * 這一族用 `buildTestApp`（**無 collab**）——測的是傳輸層，與 collab 無關，而且只有它
 * 收得到 `Partial<AppDeps>` 的 `mcpTestHooks` 注入縫。
 *
 * ⚠ **Task 3 起這個 app 上有工具了**（`list_notes`／`search_notes` 只查 DB，依 D-A 在無
 * collab 的 app 上照樣註冊），所以 `tools/list`／`tools/call` 回的是真的工具清單／結果。
 * 本檔刻意**不**斷言那些 body——工具面的驗收全在 `mcp-notes.test.ts`（含案 29(a)/(b)/(c)）。
 * Task 2 當時的零工具形回的是 `-32601 Method not found`（那兩個 handler 由第一次
 * `registerTool()` 裝上）；那個形今天已經到不了，成因記在 `routes/mcp.ts` 檔頭。
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { users } from "../src/db/schema.js";
import { buildTestApp, type TestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { INITIALIZE, PUBLIC_HOST, mcpPost, mcpRequest, rpc } from "./mcp-helpers.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";

const ISSUER = "http://localhost:3000";

// 刻意不用 `helpers.ts` 既有的 `insertPasswordUser`——本族任何一案都不需要密碼登入，
// 借用它會讓每個測試多付一次 argon2 雜湊的真實成本（本檔案案例數乘下來是 18 次）。
async function seedUser(db: Db): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `mcp-${randomUUID()}@example.com`, displayName: "M" })
    .returning();
  return user!.id;
}

/** 一個帶讀寫 PAT 的 app（本族全部只需要「認證過得去」）。 */
async function appWithToken(
  overrides: Partial<AppDeps> = {}
): Promise<{ app: TestApp["app"]; db: Db; token: string; userId: string }> {
  const { app, db } = await buildTestApp(overrides);
  const userId = await seedUser(db);
  const { token } = await seedTokenForUser(db, userId);
  return { app, db, token, userId };
}

describe("#108 /api/mcp 傳輸層形狀", () => {
  it("案 2：有效 token 的 POST initialize → 200，單一 JSON-RPC 回應（不是 501）", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpPost(app, INITIALIZE, { token });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.error).toBeUndefined();
    expect(body.result.serverInfo.name).toBe("knotebook");
    expect(body.result.serverInfo.version).toBeTruthy();
    expect(body.result.instructions).toBeTruthy();
    // ⚠ `capabilities.tools.listChanged` 的順序斷言（D32）在 `mcp-tools-list.test.ts`，
    // 這裡刻意不斷言：本檔測的是傳輸層，而那條契約要有 `registerTool` 才有鑑別力。
  });

  it("案 2b：同一 app 連兩發 tools/list 都回 200（stateless transport 沒有被跨請求重用）", async () => {
    const { app, token } = await appWithToken();
    // ⚠ 敘述是「都 200」不是「都成功」：鑑別力刻意只放在狀態碼層，body 一個字都不看
    // （Task 2 的零工具形下兩發都是 -32601，Task 3 起是真的清單——兩種形都該綠）。
    // transport／server 若被跨請求重用，SDK 會丟
    // `Stateless transport cannot be reused across requests.`，第二發變 500。
    const first = await mcpPost(app, rpc("tools/list", undefined, 1), { token });
    const second = await mcpPost(app, rpc("tools/list", undefined, 2), { token });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("案 2e：三發請求之後 close() 恰被呼叫三次（含搬運段丟例外的那一發）", async () => {
    let closes = 0;
    let n = 0;
    // `beforeReply` 是 app 級單一函式、每一發都會被呼叫——「只在第三發丟」是測試自己數的。
    const { app, token } = await appWithToken({
      mcpTestHooks: {
        afterClose: () => {
          closes += 1;
        },
        beforeReply: () => {
          n += 1;
          if (n === 3) throw new Error("boom");
        },
      },
    });
    await mcpPost(app, INITIALIZE, { token });
    await mcpPost(app, rpc("tools/list", undefined, 2), { token });
    const third = await mcpPost(app, INITIALIZE, { token });
    // ⚠ 刻意不斷言前兩發的 body——第 (2) 發的語意在 Task 3 註冊工具之後已經從 `-32601`
    // 變成真的工具清單，這一案守的是 `close()` 的計數，與 body 無關。
    // 若這一案日後紅了而斷言變多了，是有人多加了 body 斷言，刪斷言不要改實作。
    expect(closes).toBe(3);
    expect(third.statusCode).toBe(500);
    expect(third.json()).toEqual({ error: { code: "internal", message: expect.any(String) } });
  });

  it("案 3 ＋ D-D：有效 token 的 GET → 405 ＋ Allow: POST ＋ JSON-RPC error body", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpRequest(app, "GET", { token });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(res.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: expect.any(String) } });
  });

  it("案 3 ＋ D-D：有效 token 的 DELETE → 405 ＋ Allow: POST ＋ JSON-RPC error body", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpRequest(app, "DELETE", { token });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(res.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: expect.any(String) } });
  });

  it("案 4：未帶憑證的 GET → 401 ＋ challenge（不是 405——405 不得排在認證之前）", async () => {
    const { app } = await buildTestApp();
    const res = await mcpRequest(app, "GET");
    expect(res.statusCode).toBe(401);
    const challenge = res.headers["www-authenticate"] as string;
    expect(challenge).toContain(`scope="notes:read notes:write"`);
    expect(challenge).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`);
  });

  it("案 5（M7）：401／405／200／403 四種回應都帶 nosniff", async () => {
    const { app, token } = await appWithToken();
    const unauthorized = await mcpRequest(app, "GET");
    const methodNotAllowed = await mcpRequest(app, "GET", { token });
    const ok = await mcpPost(app, INITIALIZE, { token });
    const forbidden = await mcpPost(app, INITIALIZE, {
      token,
      origin: "http://evil.example",
      host: "evil.example",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(methodNotAllowed.statusCode).toBe(405);
    expect(ok.statusCode).toBe(200);
    expect(forbidden.statusCode).toBe(403);
    for (const [label, res] of [
      ["401", unauthorized],
      ["405", methodNotAllowed],
      ["200", ok],
      ["403", forbidden],
    ] as const) {
      expect(res.headers["x-content-type-options"], label).toBe("nosniff");
    }
  });

  it("案 6：Content-Type: text/plain → 本站標準形 415（全域守衛排在 SDK 之前）", async () => {
    const { app, token } = await appWithToken();
    // ⚠ 對本棒實作零鑑別力：擋下它的是全域 `onRequest` 守衛的 415，排在我們的 handler
    // 之前、也在 SDK 之前——就算實作還停在舊的 501 暫時形，這一案照樣會綠。
    const res = await mcpPost(app, INITIALIZE, { token, contentType: "text/plain" });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: { code: "unsupported_media_type", message: expect.any(String) } });
  });

  it("案 6b：Accept 少一個 media type → 406（⚠ SDK 特徵化測試，對我們的實作零鑑別力）", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpPost(app, INITIALIZE, { token, accept: "application/json" });
    expect(res.statusCode).toBe(406);
    const body = res.json();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("Not Acceptable");
  });

  // Origin 守衛（M3）——四發全部帶有效 token：守衛排在 `authenticateAny` 之後，
  // 不帶 token 一律先拿 401，會讓人誤以為守衛沒接上。
  it("案 7a：Origin ＝ Host ＝ evil.example（都不是 PUBLIC_URL host）→ 403", async () => {
    const { app, token } = await appWithToken();
    // 殺「只比 Origin 對 request.host」的寫法——那種寫法在這一發會放行（兩者相等）。
    const res = await mcpPost(app, INITIALIZE, { token, origin: "http://evil.example", host: "evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: "forbidden", message: expect.any(String) } });
  });

  it("案 7b：Origin ＝ PUBLIC_URL host、Host ＝ evil.example → 403", async () => {
    const { app, token } = await appWithToken();
    // 殺「只比 Origin 對 PUBLIC_URL」的寫法。
    const res = await mcpPost(app, INITIALIZE, { token, origin: `http://${PUBLIC_HOST}`, host: "evil.example" });
    expect(res.statusCode).toBe(403);
  });

  it("案 7c：Origin: null 與不可解析的 Origin → 403（不是 500）", async () => {
    const { app, token } = await appWithToken();
    // 殺「new URL(origin) 沒包 try/catch」的寫法——那種寫法這兩發都是 500。
    for (const origin of ["null", "%%%"]) {
      const res = await mcpPost(app, INITIALIZE, { token, origin, host: PUBLIC_HOST });
      expect(res.statusCode, origin).toBe(403);
    }
  });

  it("案 7d：不帶 Origin、Host 任意 → 正常處理（D10 刻意的放行面）", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpPost(app, INITIALIZE, { token, host: "whatever.example" });
    expect(res.statusCode).toBe(200);
  });

  it("案 7a′：GET ＋ 壞 Origin ＋ 壞 Host → 403（不是 405——守衛掛在三條 route 上且排在 handler 之前）", async () => {
    const { app, token } = await appWithToken();
    // 只把守衛掛在 POST 上的實作，會讓這一發變成 405 而不是 403。
    const res = await mcpRequest(app, "GET", { token, origin: "http://evil.example", host: "evil.example" });
    expect(res.statusCode).toBe(403);
  });

  it("案 21c ＋ 30b：body 超過 262 144 bytes → 413 content_too_large，且一個 server 實例都沒建", async () => {
    let closes = 0;
    const { app, token } = await appWithToken({ mcpTestHooks: { afterClose: () => { closes += 1; } } });
    const huge = rpc("tools/list", { pad: "x".repeat(300_000) });
    const res = await mcpPost(app, huge, { token });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: { code: "content_too_large", message: expect.any(String) } });
    // M6 的邊界形：handler 之前就被擋下來，所以 `afterClose` 一次都沒被呼叫。
    expect(closes).toBe(0);
  });

  it("P1：壞 JSON body → 本站標準形 400 bad_request（不是 JSON-RPC -32700）", async () => {
    const { app, token } = await appWithToken();
    // 擋下它的是 Fastify 的 content-type parser，在我們的 handler 之前、也在 SDK 之前——
    // 規格 §8.1 D12 (2) 那一格描述的是 SDK 單飛時的行為。
    // ⚠ 對本棒實作零鑑別力：就算實作還停在舊的 501 暫時形，這一案照樣會綠；它釘住的是
    // 這個實測事實與規格描述之間的落差，不是我們的實作。
    const res = await mcpPost(app, undefined, { token, raw: "{not json" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "bad_request", message: expect.any(String) } });
  });

  it("P1(i)：不帶 Content-Type、不帶 body 的 POST → SDK 的 415 -32000（Fastify 直接進 handler）", async () => {
    const { app, token } = await appWithToken();
    const res = await mcpPost(app, undefined, { token, contentType: null });
    expect(res.statusCode).toBe(415);
    const body = res.json();
    expect(body.error.code).toBe(-32000);
    // 這句字串來自 SDK，SDK 升版措辭變了這裡可能要跟著改；但跟 6b／P1／P1(ii) 不同，
    // 這一案有鑑別力——它證明的是 SDK 真的接上了、`parsedBody` 有送進去。
    expect(body.error.message).toContain("Unsupported Media Type");
  });

  it("P1(ii)：帶 Content-Type: application/json 但空 body 的 POST → 本站標準形 400 bad_request", async () => {
    const { app, token } = await appWithToken();
    // ⚠ 對本棒實作零鑑別力：擋下它的是 content-type parser 的 400，在我們的 handler
    // 之前——就算實作還停在舊的 501 暫時形，這一案照樣會綠；它釘住的是 P1 的實測事實
    // 與規格 §8.1 D12 (2) 的誤導，不是我們的實作。
    const res = await mcpPost(app, undefined, { token, raw: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "bad_request", message: expect.any(String) } });
  });
});
