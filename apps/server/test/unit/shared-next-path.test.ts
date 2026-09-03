/**
 * #131 Task 1／2：登入導回的兩支共用純函式（`packages/shared`）。
 *
 * `isExcludedPath` 原本是 `apps/server/src/http/spa.ts` 的私有函式（決定哪些路徑
 * 不該回 SPA 的 index.html），本 PR 搬進 shared 給 `safeNextPath` 共用——同一份
 * 「這條路徑不是 SPA 頁」的判準只能有一處，否則 OIDC callback 會把人導到裸 JSON。
 */
import { describe, expect, it } from "vitest";
import { EXCLUDED_PREFIXES, isExcludedPath, MAX_NEXT_PATH_LENGTH, safeNextPath } from "@knotebook/shared";

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

describe("safeNextPath", () => {
  it("合法的站內路徑：原字串逐字回傳", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/x")).toBe("/x");
    expect(safeNextPath("/n/alice/my-note")).toBe("/n/alice/my-note");
    expect(safeNextPath("/n/alice/my-note?x=1")).toBe("/n/alice/my-note?x=1");
    expect(safeNextPath("/n/alice/my-note?x=1#frag")).toBe("/n/alice/my-note?x=1#frag");
    // segment 邊界：/apifoo 不受 /api 牽連。
    expect(safeNextPath("/apifoo")).toBe("/apifoo");
  });

  it("回傳的是輸入原字串，不是正規化形——這是 open redirect 的分水嶺", () => {
    // /..//evil 通過所有檢查（相對於本站解析仍是本站），但 new URL(...).pathname
    // 正規化後是 "//evil"：把正規化形當回傳值送進 Location/navigate，瀏覽器會把它
    // 當 protocol-relative URL，人就被送到 http://evil。回原字串則無害。
    expect(safeNextPath("/..//evil")).toBe("/..//evil");
    // 相反的機制：百分比編碼**不會**被解析器還原，所以這串從頭到尾都只是一個
    // 奇怪的檔名，跟上面那條不同源。
    expect(safeNextPath("/%2F%2Fevil")).toBe("/%2F%2Fevil");
  });

  it("不是以單一 / 開頭的一律 null（相對路徑、空字串、其他 scheme）", () => {
    expect(safeNextPath("x")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath("?x=1")).toBeNull();
    expect(safeNextPath("#frag")).toBeNull();
    expect(safeNextPath("https://evil")).toBeNull();
    expect(safeNextPath("http://evil/x")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("跨站形（會被解析成 authority 的次字元）一律 null", () => {
    expect(safeNextPath("//evil")).toBeNull();
    expect(safeNextPath("/\\evil")).toBeNull();
  });

  it("spec §9.1 逐字點名的四個控制字元（對照組）", () => {
    // URL 解析器會靜默吃掉 CR/LF/TAB，所以必須在解析前擋——Location 標頭注入。
    expect(safeNextPath("/x\r\nSet-Cookie: a=b")).toBeNull();
    expect(safeNextPath("/x\ny")).toBeNull();
    expect(safeNextPath("/x\ty")).toBeNull();
    // NUL：**用 String.fromCharCode 組**，不要在原始碼裡打入裸控制字元。
    expect(safeNextPath("/x" + String.fromCharCode(0) + "y")).toBeNull();
  });

  it("非可見 ASCII 一律拒收：C0、空白、DEL、latin-1、未編碼的非 ASCII", () => {
    // 理由見 safeNextPath 的 JSDoc 第 4 條（成功導向不做編碼，所以字串必須可以逐字
    // 當 Location 用）。這一組殺的是「退回四字元版」與「上界只到 U+007F」兩種突變。
    for (const code of [0x01, 0x0b, 0x0c, 0x1f, 0x7f]) {
      expect(safeNextPath("/x" + String.fromCharCode(code) + "y")).toBeNull();
    }
    expect(safeNextPath("/x y")).toBeNull();
    // 未編碼的 CJK 路徑（/n/alice/筆記）：U+0100 起 → Node 的標頭驗證會丟
    // ERR_INVALID_CHAR。用 fromCharCode 組，避免原始碼裡的 NFC/NFD 不穩。
    expect(safeNextPath("/n/alice/" + String.fromCharCode(0x7b46, 0x8a18))).toBeNull();
    // latin-1（é）：Node 的標頭驗證其實放行，但我們一律不收——判準只有一條，不隨
    // 下游放寬。
    expect(safeNextPath("/x" + String.fromCharCode(0xe9) + "y")).toBeNull();
  });

  it("可見 ASCII 的邊界與百分比編碼形收受", () => {
    // 0x21（!）與 0x7e（~）是可見區間的兩端，都不該被擋。
    expect(safeNextPath("/x!y")).toBe("/x!y");
    expect(safeNextPath("/x~y")).toBe("/x~y");
    // 已編碼形合法，而且這正是瀏覽器實際會送來的形（location.pathname 是編碼形）。
    expect(safeNextPath("/n/alice/%E7%AD%86%E8%A8%98")).toBe("/n/alice/%E7%AD%86%E8%A8%98");
  });

  it("長度上限 2048（含）", () => {
    // 常數值本身也要釘：只用常數推導的話，把 2048 改成 512 兩條斷言仍會全綠。
    expect(MAX_NEXT_PATH_LENGTH).toBe(2048);
    const atLimit = "/" + "a".repeat(2047);
    expect(atLimit).toHaveLength(2048);
    expect(safeNextPath(atLimit)).toBe(atLimit);
    expect(safeNextPath("/" + "a".repeat(2048))).toBeNull();
  });

  it("非 SPA 頁的路徑一律 null（否則登入後會落在裸 JSON）", () => {
    expect(safeNextPath("/api")).toBeNull();
    expect(safeNextPath("/api/notes")).toBeNull();
    expect(safeNextPath("/collab/xyz")).toBeNull();
    expect(safeNextPath("/healthz")).toBeNull();
    expect(safeNextPath("/assets/app.js")).toBeNull();
    expect(safeNextPath("/oauth/token")).toBeNull();
    expect(safeNextPath("/.well-known/oauth-protected-resource")).toBeNull();
  });

  it("排除判定看的是**解析後**的 pathname，不是原字串的字面前綴", () => {
    // 這族釘住「用 new URL(...).pathname 餵 isExcludedPath」這個實作選擇。
    // （對照組在上面 isExcludedPath 那族：同一個字串直接問述詞是 false。）
    expect(safeNextPath("/x/../api/notes")).toBeNull();
    // %2e%2e 會被解析器還原成 dot-segment → 同樣擋得掉。
    expect(safeNextPath("/x/%2e%2e/api/notes")).toBeNull();
    expect(safeNextPath("/x/%2E%2E/api/notes")).toBeNull();
    // 反過來 %2f **不會**被還原：這串的 pathname 是 /x/..%2fapi/notes，比不中任何
    // 前綴，所以放行——它導過去會落到 App.tsx 的 /* catch-all（首頁），不是 API，無害。
    expect(safeNextPath("/x/..%2fapi/notes")).toBe("/x/..%2fapi/notes");
  });

  it("/login 自己不是合法目標（登入完又回登入表單的死路）", () => {
    expect(safeNextPath("/login")).toBeNull();
    expect(safeNextPath("/login?next=%2Fx")).toBeNull();
    // 尾斜線與大小寫都要收斂：react-router 的比對忽略尾斜線、預設大小寫不敏感，
    // 這兩種形一樣會渲染登入頁。
    expect(safeNextPath("/login/")).toBeNull();
    // `+` 是 load-bearing：react-router 對 end 路由編出來的是 `\/login\/*$`，多個尾
    // 斜線一樣會渲染登入頁；只吃一個斜線的 `\/$` 會漏掉這個形。
    expect(safeNextPath("/login//")).toBeNull();
    expect(safeNextPath("/LOGIN")).toBeNull();
    // 但 /login 開頭的其他路徑不受牽連（不是前綴比對）。
    expect(safeNextPath("/loginx")).toBe("/loginx");
  });

  it("非字串輸入 → null（query string 讀出來可能是 null 或陣列）", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    // ⚠ fixture 的形很重要：Fastify 對 `?next=/&next=x` 給的是 ["/", "x"]，它的 [0]
    // 正好是 "/"，所以**只有這個形**能證明 typeof 守衛真的在守——換成 ["/x", "/y"]
    // 的話，拿掉 typeof 那行測試依然全綠（它是被 input[0] !== "/" 擋掉的）。
    expect(safeNextPath(["/", "x"] as unknown as string)).toBeNull();
  });
});
