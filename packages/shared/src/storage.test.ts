import { describe, expect, it } from "vitest";
import { BASIC_STORAGE_QUOTA_BYTES, STORAGE_PLAN_NAME_MAX, STORAGE_QUOTA_MAX_BYTES } from "./storage.js";
import { ERROR_CODES } from "./index.js";

describe("storage 常數（spec §4.1、§7.4、A3）", () => {
  it("上限 1 PiB 是 JS 安全整數；Basic＝2 GiB；名稱上限 40", () => {
    expect(STORAGE_QUOTA_MAX_BYTES).toBe(2 ** 50);
    expect(Number.isSafeInteger(STORAGE_QUOTA_MAX_BYTES)).toBe(true);
    expect(BASIC_STORAGE_QUOTA_BYTES).toBe(2 * 1024 ** 3);
    expect(STORAGE_PLAN_NAME_MAX).toBe(40);
  });

  it("五個新錯誤碼都在 ERROR_CODES（§8.1）", () => {
    for (const code of ["storage_quota_exceeded", "storage_plan_in_use", "storage_plan_is_default", "storage_plan_name_taken", "storage_plan_not_found"]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
