/**
 * #131 Task 1／2：登入導回的兩支共用純函式（`packages/shared`）。
 *
 * `isExcludedPath` 原本是 `apps/server/src/http/spa.ts` 的私有函式（決定哪些路徑
 * 不該回 SPA 的 index.html），本 PR 搬進 shared 給 `safeNextPath` 共用——同一份
 * 「這條路徑不是 SPA 頁」的判準只能有一處，否則 OIDC callback 會把人導到裸 JSON。
 */
import { describe, expect, it } from "vitest";
import { EXCLUDED_PREFIXES, isExcludedPath } from "@knotebook/shared";

describe("isExcludedPath", () => {
  it("裸前綴本身與其子路徑都算命中", () => {
    expect(isExcludedPath("/api")).toBe(true);
    expect(isExcludedPath("/api/notes")).toBe(true);
    expect(isExcludedPath("/collab")).toBe(true);
    expect(isExcludedPath("/healthz")).toBe(true);
    expect(isExcludedPath("/assets/app.js")).toBe(true);
  });

  it("segment 邊界比對，不是字串 startsWith", () => {
    // 這兩條是防「把實作簡化成 pathname.startsWith(prefix)」的守衛：
    // /collaborators 是一個合法的 SPA 路徑，不該被 /collab 牽連。
    expect(isExcludedPath("/collaborators")).toBe(false);
    expect(isExcludedPath("/apifoo")).toBe(false);
    expect(isExcludedPath("/assetsx")).toBe(false);
  });

  it("#131 新增的兩個前綴：/oauth 與 /.well-known（#132 的 RFC 形 JSON，不是 SPA 頁）", () => {
    expect(isExcludedPath("/oauth")).toBe(true);
    expect(isExcludedPath("/oauth/token")).toBe(true);
    expect(isExcludedPath("/.well-known")).toBe(true);
    expect(isExcludedPath("/.well-known/oauth-authorization-server")).toBe(true);
    // 邊界同上：/.well-knownx 不是 /.well-known 的子路徑。
    expect(isExcludedPath("/.well-knownx")).toBe(false);
    expect(isExcludedPath("/oauthx")).toBe(false);
  });

  it("一般 SPA 路徑不命中", () => {
    expect(isExcludedPath("/")).toBe(false);
    expect(isExcludedPath("/n/alice/my-note")).toBe(false);
    expect(isExcludedPath("/settings/account")).toBe(false);
    // #132 的同意頁是 SPA 路徑 /authorize、**不在 /oauth 之下**。這一行釘住的是反向：
    // 沒有人把 /authorize（或 /auth）也塞進清單、害同意頁自己拿不到 SPA fallback；
    // 正因為排除 /oauth 並不殃及它，下一棒才沒有理由刪掉那個前綴。
    expect(isExcludedPath("/authorize")).toBe(false);
  });

  it("不做正規化：比的是餵進來的原字串", () => {
    // 這條釘住常數註解宣稱的契約。兩個呼叫端刻意餵不同的形（spa.ts 餵未解碼的
    // request.url，safeNextPath 餵 new URL(...).pathname），所以這支述詞自己絕不能
    // 偷做 dot-segment 收斂或斜線合併——否則兩端的判定都會悄悄改變。
    expect(isExcludedPath("/x/../api/notes")).toBe(false);
    // routes/public.ts 的 token 遮罩理由鏈依賴這一條（它算準了 //api/… 比不中前綴、
    // 會落進 SPA fallback）。
    expect(isExcludedPath("//api/notes")).toBe(false);
  });

  it("EXCLUDED_PREFIXES 就是這六條（新增前綴要連同 spa fallback 的行為一起想過）", () => {
    expect([...EXCLUDED_PREFIXES]).toEqual(["/api", "/collab", "/healthz", "/assets", "/oauth", "/.well-known"]);
  });
});
