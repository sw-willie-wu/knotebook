/**
 * #130：API token 的 scope 契約（`packages/shared`）。
 *
 * 落庫形是**集合不是單值**——write 一定把 read 顯式寫進字串、move／delete 一定帶著 write，所以只有
 * R、RW、RWM、RWD、RWMD 五種（#181 起是格不是鏈）；`hasScope` 因此是成員判定，
 * 不是寫死的階層判斷。這一族的守衛重點在「切詞比對，不是子字串比對」：
 * `includes` 式的『簡化』重構會讓 `scope=notes:writer` 拿到寫入權。
 */
import { describe, expect, it } from "vitest";
import { hasScope, narrowerScope, normalizeScope, TOKEN_SCOPES, type ScopeName, type TokenScope } from "@knotebook/shared";

const R = "notes:read";
const RW = "notes:read notes:write";
const RWM = "notes:read notes:write notes:move";
const RWD = "notes:read notes:write notes:delete";
const RWMD = "notes:read notes:write notes:move notes:delete";

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
  it("required=notes:read 對五種落庫形都成立", () => {
    expect(hasScope("notes:read", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write notes:move", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write notes:delete", "notes:read")).toBe(true);
    expect(hasScope("notes:read notes:write notes:move notes:delete", "notes:read")).toBe(true);
  });

  it("required=notes:write 需 stored 含 write", () => {
    expect(hasScope("notes:read", "notes:write")).toBe(false);
    expect(hasScope("notes:read notes:write", "notes:write")).toBe(true);
    expect(hasScope("notes:read notes:write notes:move", "notes:write")).toBe(true);
  });

  it("是成員判定，不是整串字面相等——落庫形多一個空白也不該把讀寫降成唯讀", () => {
    // cast 是刻意的：`TokenScope` 只有五個字面值，這個值在型別上不可能出現，但
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
  it("五種合法落庫形恆等（server 讀 DB 的 scope 值時拿它正規化，合法值必須原樣回來）", () => {
    for (const s of TOKEN_SCOPES) expect(normalizeScope(s)).toBe(s);
  });
});

describe("#181 normalizeScope：notes:delete", () => {
  it("要 delete 不要 write → 丟掉 delete、給 notes:read（不補 write，fail-closed）", () => {
    expect(normalizeScope("notes:delete")).toBe(R);
    expect(normalizeScope("notes:read notes:delete")).toBe(R);
  });
  it("write＋delete → RWD；四項全 → RWMD（順序無關）", () => {
    expect(normalizeScope("notes:delete notes:write")).toBe(RWD);
    expect(normalizeScope("notes:delete notes:move notes:write notes:read")).toBe(RWMD);
  });
  it("切詞比對：notes:deleter 不算 delete；tab 分隔整串不認得", () => {
    expect(normalizeScope("notes:deleter notes:write")).toBe(RW);
    expect(normalizeScope("notes:write\tnotes:delete")).toBe(R);
  });
});

describe("#239／#181 narrowerScope（交集）", () => {
  it("TOKEN_SCOPES 以五形字面釘住（含順序；不靠它自己的索引推導）", () => {
    expect(TOKEN_SCOPES).toEqual([R, RW, RWM, RWD, RWMD]);
  });
  // 逐格寫出期望值（格上的 meet）；不拿 TOKEN_SCOPES 的索引當 oracle——move 與 delete 互不包含。
  const TABLE: Record<string, Record<string, string>> = {
    [R]: { [R]: R, [RW]: R, [RWM]: R, [RWD]: R, [RWMD]: R },
    [RW]: { [R]: R, [RW]: RW, [RWM]: RW, [RWD]: RW, [RWMD]: RW },
    [RWM]: { [R]: R, [RW]: RW, [RWM]: RWM, [RWD]: RW, [RWMD]: RWM },
    [RWD]: { [R]: R, [RW]: RW, [RWM]: RW, [RWD]: RWD, [RWMD]: RWD },
    [RWMD]: { [R]: R, [RW]: RW, [RWM]: RWM, [RWD]: RWD, [RWMD]: RWMD },
  };
  for (const a of [R, RW, RWM, RWD, RWMD])
    for (const b of [R, RW, RWM, RWD, RWMD])
      it(`25 格：${a} ∧ ${b} ＝ ${TABLE[a]![b]}`, () => {
        expect(narrowerScope(a as TokenScope, b as TokenScope)).toBe(TABLE[a]![b]);
      });
  it("對稱：25 格 a∧b ＝ b∧a", () => {
    for (const a of [R, RW, RWM, RWD, RWMD])
      for (const b of [R, RW, RWM, RWD, RWMD])
        expect(narrowerScope(a as TokenScope, b as TokenScope)).toBe(narrowerScope(b as TokenScope, a as TokenScope));
  });
  it("不在五形內的值當成 notes:read（fail-closed，不回傳垃圾字串）", () => {
    expect(narrowerScope("garbage" as TokenScope, RWM)).toBe(R);
    expect(narrowerScope(RW, "notes:read notes:move" as TokenScope)).toBe(R);
  });
  it("非正規值先當 notes:read 再交集：裸 notes:write 不得被正規化成讀寫", () => {
    expect(narrowerScope("notes:write" as TokenScope, RWMD)).toBe(R);
  });
  it("順序錯的四項字串不在五形內 → notes:read", () => {
    expect(narrowerScope(RWMD, "notes:read notes:write notes:delete notes:move" as TokenScope)).toBe(R);
  });
});

describe("#239／#181 hasScope：五形 × 四個 ScopeName", () => {
  const MEMBERS: Record<string, Record<ScopeName, boolean>> = {
    [R]: { "notes:read": true, "notes:write": false, "notes:move": false, "notes:delete": false },
    [RW]: { "notes:read": true, "notes:write": true, "notes:move": false, "notes:delete": false },
    [RWM]: { "notes:read": true, "notes:write": true, "notes:move": true, "notes:delete": false },
    [RWD]: { "notes:read": true, "notes:write": true, "notes:move": false, "notes:delete": true },
    [RWMD]: { "notes:read": true, "notes:write": true, "notes:move": true, "notes:delete": true },
  };
  it("成員表", () => {
    for (const [stored, row] of Object.entries(MEMBERS))
      for (const [name, want] of Object.entries(row))
        expect(hasScope(stored as TokenScope, name as ScopeName), `${stored} ∋ ${name}`).toBe(want);
  });
  it("move 只在 RWM、RWMD", () => {
    expect(hasScope(RWM, "notes:move")).toBe(true);
    expect(hasScope(RWMD, "notes:move")).toBe(true);
    expect(hasScope(RWD, "notes:move")).toBe(false);
    expect(hasScope(RW, "notes:move")).toBe(false);
    expect(hasScope(R, "notes:move")).toBe(false);
  });
  it("delete 只在 RWD、RWMD", () => {
    expect(hasScope(RWD, "notes:delete")).toBe(true);
    expect(hasScope(RWMD, "notes:delete")).toBe(true);
    expect(hasScope(RWM, "notes:delete")).toBe(false);
    expect(hasScope(RW, "notes:delete")).toBe(false);
    expect(hasScope(R, "notes:delete")).toBe(false);
  });
  it("漂移值照實做成員判定（授權不靠它單獨判，靠 canDeleteNotes 的 write∧delete）", () => {
    expect(hasScope("notes:read notes:delete" as TokenScope, "notes:delete")).toBe(true);
  });
});
