import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@knotebook/shared";
import en from "./en.json";
import zhTW from "./zh-TW.json";

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
