/**
 * #130 Task 1：API token 的 scope 契約（`packages/shared`）。
 *
 * 落庫形是**集合不是單值**——write 一定把 read 顯式寫進字串，所以只有
 * `"notes:read"` 與 `"notes:read notes:write"` 兩種；`hasScope` 因此是成員判定，
 * 不是寫死的階層判斷。這一族的守衛重點在「切詞比對，不是子字串比對」：
 * `includes` 式的『簡化』重構會讓 `scope=notes:writer` 拿到寫入權。
 */
import { describe, expect, it } from "vitest";
import { hasScope, normalizeScope, type TokenScope } from "@knotebook/shared";

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
  it("required=notes:read 對兩種落庫形都成立", () => {
    expect(hasScope("notes:read", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write", "notes:read")).toBe(true);
  });

  it("required=notes:write 需 stored 含 write", () => {
    expect(hasScope("notes:read", "notes:write")).toBe(false);
    expect(hasScope("notes:read notes:write", "notes:write")).toBe(true);
  });

  it("是成員判定，不是整串字面相等——落庫形多一個空白也不該把讀寫降成唯讀", () => {
    // cast 是刻意的：`TokenScope` 只有兩個字面值，這個值在型別上不可能出現，但
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
