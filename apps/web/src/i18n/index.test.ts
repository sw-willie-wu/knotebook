import { describe, expect, it } from "vitest";
import { BUILTIN_ROLE_DISPLAY_NAMES, ERROR_CODES } from "@knotebook/shared";
import en from "./en.json";
import zhTW from "./zh-TW.json";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";

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

/**
 * `JSON.parse` 遇到同一物件內的重複 key 只留最後一份，parity 與 lint 都抓不到；前一份變成死字串、
 * PR diff 還會出現看似新增的行。這裡直接掃原始文字，同一物件層出現第二次的 key 就回報。
 */
function duplicateKeys(raw: string): string[] {
  const dups: string[] = [];
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const top = stack[stack.length - 1];
    if (ch === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ keys: null, expectKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ":" && top) top.expectKey = false;
    else if (ch === "," && top?.keys) top.expectKey = true;
    else if (ch === '"') {
      let j = i + 1;
      while (raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      if (top?.keys && top.expectKey) {
        const key = raw.slice(i + 1, j);
        if (top.keys.has(key)) dups.push(key);
        top.keys.add(key);
      }
      i = j;
    }
  }
  return dups;
}

describe("i18n 無重複 key", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s：同一物件內沒有重複的 key", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

// 保護 errors.<code> 對映全部 ERROR_CODES + errors.fallback 這個介面承諾
// （Task 11+ 逐字依賴：任何 ApiFail.code 都要能在兩個語系裡查到對應文案）。
//
// 這把測試正是 `errors.not_loaded`／`errors.file_too_large` 兩個 key 存在的原因
// （Plan 3，ERROR_CODES 新增碼，見 packages/shared/src/index.ts 的 provenance 註解）：
// - `errors.not_loaded`：僅為 ERROR_CODES parity 而存在，目前**無 UI 呼叫路徑**——
//   link-sync client（Task 7）收到 409 `not_loaded` 是靜默重試一次後放棄，不會把
//   這則文案顯示給使用者；此文案暫不可能被真人看到。
// - `errors.file_too_large`：**會**經 uploadFile 的錯誤處理路徑以 toast 顯示給使用者
//   （Plan 3 圖片上傳流程，見該 task 的 i18n 段落）。
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

// #175 PR3（spec §4.1、§15 第 7 條）：server 用 `BUILTIN_ROLE_DISPLAY_NAMES` 擋「自訂角色取內建顯示名」——
// 那份常數必須等於兩語系 `groups.role.admin`／`groups.role.member` 的值，改顯示名時這裡會紅；
// 新增語系不會自動紅（這裡只比對寫死 import 的 en／zh-TW），要同步這個陣列與 `BUILTIN_ROLE_DISPLAY_NAMES`。
describe("內建角色顯示名＝保留名常數", () => {
  it("BUILTIN_ROLE_DISPLAY_NAMES 恰等於 en／zh-TW 的 groups.role.admin 與 groups.role.member", () => {
    expect([...BUILTIN_ROLE_DISPLAY_NAMES].sort()).toEqual(
      [en.groups.role.admin, en.groups.role.member, zhTW.groups.role.admin, zhTW.groups.role.member].sort(),
    );
  });
});
