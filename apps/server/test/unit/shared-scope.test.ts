/**
 * #130 Task 1：API token 的 scope 契約（`packages/shared`）。
 *
 * 落庫形是**集合不是單值**——write 一定把 read 顯式寫進字串、move 一定帶著 write，所以只有
 * `"notes:read"`、`"notes:read notes:write"`、`"notes:read notes:write notes:move"` 三種；`hasScope` 因此是成員判定，
 * 不是寫死的階層判斷。這一族的守衛重點在「切詞比對，不是子字串比對」：
 * `includes` 式的『簡化』重構會讓 `scope=notes:writer` 拿到寫入權。
 */
import { describe, expect, it } from "vitest";
import { hasScope, narrowerScope, normalizeScope, TOKEN_SCOPES, type TokenScope } from "@knotebook/shared";

describe("normalizeScope", () => {
  it("undefined／null／空／全空白 → notes:read（最小權限）", () => {
    expect(normalizeScope(undefined)).toBe("notes:read");
    expect(normalizeScope(null)).toBe("notes:read");
    expect(normalizeScope("")).toBe("notes:read");
    expect(normalizeScope("   ")).toBe("notes:read");
  });

  it("含 notes:write → 把 read 顯式補進落庫形", () => {
    expect(normalizeScope("notes:write")).toBe("notes:read notes:write");
    expect(normalizeScope("notes:write notes:read")).toBe("notes:read notes:write");
    expect(normalizeScope("notes:read  notes:write")).toBe("notes:read notes:write");
  });

  it("只有 read（含重複）", () => {
    expect(normalizeScope("notes:read")).toBe("notes:read");
    expect(normalizeScope("notes:read notes:read")).toBe("notes:read");
  });

  it("忽略不認得的值（RFC 6749 §3.3；MCP client 可能自行加 offline_access）", () => {
    expect(normalizeScope("offline_access notes:write")).toBe("notes:read notes:write");
    expect(normalizeScope("openid profile email")).toBe("notes:read");
  });

  it("切詞比對而非子字串比對：含 notes:write 子字串的未知值不得升權", () => {
    // 這條是防「把實作簡化成 input.includes("notes:write")」的守衛。normalizeScope 的
    // 輸入在 #132 是 client 完全可控的 authorize `scope` 參數，子字串比對＝scope 放大。
    expect(normalizeScope("notes:writer")).toBe("notes:read");
    expect(normalizeScope("xnotes:write")).toBe("notes:read");
    expect(normalizeScope("notes:write-all")).toBe("notes:read");
  });

  it("分隔字元只認半形空白（RFC 6749 的 scope 是 SP-delimited），其餘一律 fail-closed", () => {
    // tab 分隔不會被切開 → 整串成為一個不認得的值 → 最小權限。方向刻意是保守的。
    expect(normalizeScope("notes:read\tnotes:write")).toBe("notes:read");
  });
});

describe("hasScope", () => {
  it("required=notes:read 對三種落庫形都成立", () => {
    expect(hasScope("notes:read", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write notes:move", "notes:read")).toBe(true);
  });

  it("required=notes:write 需 stored 含 write", () => {
    expect(hasScope("notes:read", "notes:write")).toBe(false);
    expect(hasScope("notes:read notes:write", "notes:write")).toBe(true);
    expect(hasScope("notes:read notes:write notes:move", "notes:write")).toBe(true);
  });

  it("是成員判定，不是整串字面相等——落庫形多一個空白也不該把讀寫降成唯讀", () => {
    // cast 是刻意的：`TokenScope` 只有三個字面值，這個值在型別上不可能出現，但
    // `stored` 實際來自 `text` 欄位、型別是 `as TokenScope` 斷言來的。這條釘住
    // 「授權判定不依賴 scope 欄的 CHECK」——寫成 `stored === "notes:read notes:write"`
    // 的版本會在這裡紅掉。
    const drifted = "notes:read  notes:write" as TokenScope;
    expect(hasScope(drifted, "notes:write")).toBe(true);
    expect(hasScope(drifted, "notes:read")).toBe(true);

    // 對稱的另一面：成員判定也不能退化成對 `stored` 做子字串比對（那是 fail-open，
    // 會讓 `notes:writer` 這種值拿到寫入權）。與 normalizeScope 的 tokenize 守衛同理。
    expect(hasScope("notes:writer" as TokenScope, "notes:write")).toBe(false);
  });
});

describe("#239 normalizeScope：notes:move", () => {
  it("要 move 不要 write → 丟掉 move、給 notes:read（不補 write，fail-closed）", () => {
    expect(normalizeScope("notes:move")).toBe("notes:read");
    expect(normalizeScope("notes:read notes:move")).toBe("notes:read");
  });
  it("write＋move → 第三形（順序與重複無關）", () => {
    expect(normalizeScope("notes:move notes:write")).toBe("notes:read notes:write notes:move");
    expect(normalizeScope("notes:read notes:write notes:move notes:move")).toBe("notes:read notes:write notes:move");
  });
  it("切詞比對：notes:mover 不算 move；tab 分隔整串不認得", () => {
    expect(normalizeScope("notes:mover notes:write")).toBe("notes:read notes:write");
    expect(normalizeScope("notes:write\tnotes:move")).toBe("notes:read");
  });
  it("三種合法落庫形恆等（server 讀 DB 的 scope 值時拿它正規化，合法值必須原樣回來）", () => {
    for (const s of TOKEN_SCOPES) expect(normalizeScope(s)).toBe(s);
  });
});

describe("#239 narrowerScope", () => {
  it("鏈序以字面釘住（不靠 TOKEN_SCOPES 自己的索引推導）：讀寫搬移與讀寫取較小者＝讀寫", () => {
    expect(TOKEN_SCOPES).toEqual(["notes:read", "notes:read notes:write", "notes:read notes:write notes:move"]);
    expect(narrowerScope("notes:read notes:write", "notes:read notes:write notes:move")).toBe("notes:read notes:write");
    expect(narrowerScope("notes:read notes:write notes:move", "notes:read notes:write")).toBe("notes:read notes:write");
    expect(narrowerScope("notes:read", "notes:read notes:write notes:move")).toBe("notes:read");
  });
  it("九格：取鏈上較小者", () => {
    for (const [i, a] of TOKEN_SCOPES.entries())
      for (const [j, b] of TOKEN_SCOPES.entries()) expect(narrowerScope(a, b)).toBe(TOKEN_SCOPES[Math.min(i, j)]);
  });
  it("不在三形內的值當成 notes:read（fail-closed，不回傳垃圾字串）", () => {
    expect(narrowerScope("garbage" as TokenScope, "notes:read notes:write notes:move")).toBe("notes:read");
    expect(narrowerScope("notes:read notes:write", "notes:read notes:move" as TokenScope)).toBe("notes:read");
  });
});

describe("#239 hasScope(notes:move)", () => {
  it("只有第三形有 move", () => {
    expect(hasScope("notes:read notes:write notes:move", "notes:move")).toBe(true);
    expect(hasScope("notes:read notes:write", "notes:move")).toBe(false);
    expect(hasScope("notes:read", "notes:move")).toBe(false);
  });
});
