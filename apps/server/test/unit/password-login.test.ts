import { describe, expect, it } from "vitest";
import { effectivePasswordLogin } from "../../src/auth/password-login.js";

describe("effectivePasswordLogin（#187 §18.4：有效值＝DB 值 OR env 強制；讀不到列視同開，B17）", () => {
  it.each([
    [true, false, true],
    [false, false, false],
    [null, false, true],
    [true, true, true],
    [false, true, true],
    [null, true, true],
  ] as const)("DB=%s、env 強制=%s → %s", (dbValue, forced, expected) => {
    expect(effectivePasswordLogin(dbValue, forced)).toBe(expected);
  });
});
