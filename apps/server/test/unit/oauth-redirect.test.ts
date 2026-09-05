/**
 * #132：D10 的兩個判準——DCR 收件（loopback-only）與授權時的比對（port 忽略）。
 * 這兩支是釣魚防線的一半，邊界要逐格釘住。
 */
import { describe, expect, it } from "vitest";
import { isLoopbackRedirectUri, matchesLoopbackRedirect } from "../../src/oauth/redirect.js";

describe("isLoopbackRedirectUri（DCR 的收件判準，D10）", () => {
  it("接受三種 loopback host，任意 port 與 path", () => {
    expect(isLoopbackRedirectUri("http://localhost/cb")).toBe(true);
    expect(isLoopbackRedirectUri("http://127.0.0.1:1234/cb")).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]:5678/callback")).toBe(true);
    expect(isLoopbackRedirectUri("https://127.0.0.1/cb")).toBe(true);
  });

  // hostname 才不含 port——用 host 判定會讓帶 port 的 loopback 全部落榜
  it("接受帶 port 的 loopback（hostname 判定）", () => {
    expect(isLoopbackRedirectUri("http://localhost:65535/cb")).toBe(true);
  });

  // 前綴形與**後綴形**都要有：只擋前綴的話，把集合比對改成 endsWith 仍全綠，
  // 而 `mylocalhost` 是真實可解析的區網主機名。
  it("拒絕看起來像 loopback 的遠端 host（前綴與後綴形）", () => {
    expect(isLoopbackRedirectUri("http://localhost.evil.com/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1.evil.com/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://mylocalhost/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://evil.localhost/cb")).toBe(false);
  });

  // DCR 唯一的收件述詞：帶帳密的形不收（比對那頭完全忽略 userinfo，收了就是兩邊
  // 對「這是誰」的認知不一致）。
  it("拒絕帶 userinfo 的形", () => {
    expect(isLoopbackRedirectUri("http://user:pw@127.0.0.1/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://user@localhost/cb")).toBe(false);
    // 只有密碼的形：述詞若被砍成只看 username 就會放行
    expect(isLoopbackRedirectUri("http://:pw@127.0.0.1/cb")).toBe(false);
  });

  it("拒絕遠端 https、非 http(s) scheme、query 與 fragment", () => {
    expect(isLoopbackRedirectUri("https://example.com/cb")).toBe(false);
    expect(isLoopbackRedirectUri("myapp://127.0.0.1/cb")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1/cb?x=1")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1/cb#f")).toBe(false);
  });

  // NUL 與落單代理：`new URL()` 照收，但 jsonb 存不下（22P05）——不擋就是無認證端點的 500
  it("拒絕含 NUL 或落單代理的形（jsonb 存不下）", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1/a\u0000b")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1/a\uD800b")).toBe(false);
    // 正對照：成對的代理是合法 astral 字元，不能誤擋
    expect(isLoopbackRedirectUri("http://127.0.0.1/cb-\u{1F600}")).toBe(true);
  });

  it("拒絕解析不了的字串", () => {
    expect(isLoopbackRedirectUri("/cb")).toBe(false);
  });
});

describe("matchesLoopbackRedirect（授權時的比對，port 忽略）", () => {
  it("port 不同仍相符（RFC 8252 §7.3 MUST）", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1:1234/cb", "http://127.0.0.1:5678/cb")).toBe(true);
  });

  // 「逐字相等」要真的逐字：大小寫案殺掉 toLowerCase 突變，前綴案殺掉 startsWith
  // 突變（後者等於把註冊的 /cb 放寬成接受 /cbx，D10 的比對基礎就鬆掉一格）。
  it("path 不同不相符，且逐字比對（大小寫敏感、非前綴）", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1:1234/cb", "http://127.0.0.1:1234/other")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/CB")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/cbx")).toBe(false);
    // 反向也要：startsWith 突變的另一個方向（註冊 /cbx 收 actual /cb）
    expect(matchesLoopbackRedirect("http://127.0.0.1/cbx", "http://127.0.0.1/cb")).toBe(false);
  });

  it("hostname 不同不相符（localhost 與 127.0.0.1 是兩回事）", () => {
    expect(matchesLoopbackRedirect("http://localhost:1234/cb", "http://127.0.0.1:1234/cb")).toBe(false);
  });

  it("scheme 不同不相符", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "https://127.0.0.1/cb")).toBe(false);
  });

  it("任一側帶 query 或 fragment 都不相符", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/cb?x=1")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb?x=1", "http://127.0.0.1/cb")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/cb#f")).toBe(false);
  });

  it("任一側帶 userinfo 都不相符", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://u:p@127.0.0.1/cb")).toBe(false);
    expect(matchesLoopbackRedirect("http://u:p@127.0.0.1/cb", "http://127.0.0.1/cb")).toBe(false);
  });

  // 百分號編碼的 %00 可合法註冊，而裸 NUL 的 pathname 正規化後與它相等——放行等於
  // 讓 raw actual 落庫再炸 500（Task 5 存的是這個 actual 值）。
  it("任一側含 NUL 或落單代理都不相符（即使正規化後看起來相等）", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb%00", "http://127.0.0.1/cb\u0000")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb\u0000", "http://127.0.0.1/cb%00")).toBe(false);
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "http://127.0.0.1/cb\uD800")).toBe(false);
  });

  it("任一側解析不了都不相符", () => {
    expect(matchesLoopbackRedirect("http://127.0.0.1/cb", "not a url")).toBe(false);
  });
});
