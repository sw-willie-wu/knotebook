import { describe, expect, it } from "vitest";
import { checksFromScope, scopeFromChecks } from "./token-scope";

describe("token-scope", () => {
  it("scopeFromChecks 四格（搬移不搭編輯 → 唯讀，fail-closed）", () => {
    expect(scopeFromChecks(false, false)).toBe("notes:read");
    expect(scopeFromChecks(true, false)).toBe("notes:read notes:write");
    expect(scopeFromChecks(true, true)).toBe("notes:read notes:write notes:move");
    expect(scopeFromChecks(false, true)).toBe("notes:read");
  });
  it("checksFromScope 三格", () => {
    expect(checksFromScope("notes:read")).toEqual({ write: false, move: false });
    expect(checksFromScope("notes:read notes:write")).toEqual({ write: true, move: false });
    expect(checksFromScope("notes:read notes:write notes:move")).toEqual({ write: true, move: true });
  });
});
