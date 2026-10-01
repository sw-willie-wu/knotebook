/**
 * #175 PR3：`packages/shared/src/group-roles.ts` 的單元案。閱讀恆真（plan spec 疑點 10）、六個可設旗標彼此不蘊含
 * （spec 疑點 11）——shared 只剩旗標清單與角色名稱規則。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_ROLE_DISPLAY_NAMES, GROUP_ROLE_FLAGS, isReservedRoleName, normalizeRoleName } from "@knotebook/shared";

describe("GROUP_ROLE_FLAGS", () => {
  it("恰為六個可設旗標、不含 read", () => {
    expect([...GROUP_ROLE_FLAGS]).toEqual(["create", "edit", "delete", "managePublicLink", "manageMembers", "manageGroup"]);
  });
});

describe("角色名稱（spec §4.1；gate r1 I6、r2 M-9）", () => {
  it("normalizeRoleName：trim 之後 NFC", () => {
    expect(normalizeRoleName("  Reader \t")).toBe("Reader");
    // NFD (e + U+0301) must compose to NFC (U+00E9); written as escapes so the two forms are distinguishable by eye.
    expect(normalizeRoleName("Cafe\u0301")).toBe("Caf\u00e9");
  });
  it("isReservedRoleName：等於任一語系的內建顯示名（不分大小寫）才算；相近的不算", () => {
    for (const n of ["admin", "ADMIN", "Member", "member", "管理員", "一般成員", "\u3000管理員\u3000"]) expect(isReservedRoleName(normalizeRoleName(n)), n).toBe(true);
    for (const n of ["Admins", "Reader", "管理者", "成員"]) expect(isReservedRoleName(normalizeRoleName(n)), n).toBe(false);
  });
  it("BUILTIN_ROLE_DISPLAY_NAMES 恰四個（en 兩、zh-TW 兩；與 web i18n 的一致性由 web 的 i18n 測試守）", () => {
    expect([...BUILTIN_ROLE_DISPLAY_NAMES].sort()).toEqual(["Admin", "Member", "一般成員", "管理員"].sort());
  });
});
