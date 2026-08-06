import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@knotebook/shared";
import en from "./en.json";
import zhTW from "./zh-TW.json";

/** 攤平成 `a.b.c` 形式的 key 清單，供兩個語系做全量對照。 */
function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

// 兩個語系的 key 集合必須完全一致——漏一把 key 在 UI 上只會安靜地顯示成
// key 字串本身（i18next 預設行為），不會有任何錯誤，靠測試才擋得住。
describe("i18n key parity", () => {
  it("en 與 zh-TW 的 key 集合完全相同", () => {
    expect(flattenKeys(zhTW).sort()).toEqual(flattenKeys(en).sort());
  });
});

// 保護 errors.<code> 對映全部 ERROR_CODES + errors.fallback 這個介面承諾
// （Task 11+ 逐字依賴：任何 ApiFail.code 都要能在兩個語系裡查到對應文案）。
describe("i18n error message coverage", () => {
  for (const [langName, resource] of [
    ["en", en],
    ["zh-TW", zhTW],
  ] as const) {
    it(`${langName}: has an errors.<code> entry for every ErrorCode`, () => {
      for (const code of ERROR_CODES) {
        expect(resource.errors, `missing errors.${code} in ${langName}`).toHaveProperty(code);
        expect(typeof resource.errors[code as keyof typeof resource.errors]).toBe("string");
      }
    });

    it(`${langName}: has errors.fallback`, () => {
      expect(resource.errors.fallback).toBeTypeOf("string");
    });
  }
});
