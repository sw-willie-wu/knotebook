import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/tour-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import tourEn from "./tour.en.json";
import tourZhTW from "./tour.zh-TW.json";
import tourEnRaw from "./tour.en.json?raw";
import tourZhTWRaw from "./tour.zh-TW.json?raw";

/**
 * 功能導覽的 lazy 字串包（`tourGuide.*`，只由導覽的 lazy 鏈經 `tour-strings.ts` 註冊）。
 * 主 JSON 的 parity（`index.test.ts`）不涵蓋這兩檔，所以 parity、無空字串、無重複鍵、與主檔不重疊都在這裡。
 * 骨架同 shortcuts-copy.test.ts。
 */

function leaves(value: unknown, prefix = ""): [string, unknown][] {
  if (typeof value !== "object" || value === null) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

/** 同 `index.test.ts`：`JSON.parse` 遇重複鍵只留最後一份，直接掃原始文字。 */
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

const BUNDLES = [
  ["en", tourEn],
  ["zh-TW", tourZhTW],
] as const;

describe("兩語系鍵集合相同、頂層只有 tourGuide", () => {
  it("鍵集合相同", () => {
    const keys = (bundle: unknown) => leaves(bundle).map(([k]) => k).sort();
    expect(keys(tourZhTW)).toEqual(keys(tourEn));
  });

  it("頂層恰一個鍵 tourGuide", () => {
    expect(Object.keys(tourEn)).toEqual(["tourGuide"]);
    expect(Object.keys(tourZhTW)).toEqual(["tourGuide"]);
  });
});

describe("每個值都是非空字串", () => {
  it.each(BUNDLES)("%s", (_name, bundle) => {
    const bad = leaves(bundle).filter(([, v]) => typeof v !== "string" || v.trim().length === 0);
    expect(bad.map(([k]) => k)).toEqual([]);
  });
});

// 讀原始文字：deep merge 的 addResourceBundle 會把 tourGuide 併進 i18n 初始化時那份主 JSON 物件（同一個 import），
// 所以 import 進來的主 JSON 在 tour-strings 載入後已帶 tourGuide 鍵。
describe("主 JSON 沒有 tourGuide 頂層鍵", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("tourGuide");
  });
});

describe("包沒有重複鍵", () => {
  it.each([
    ["en", tourEnRaw],
    ["zh-TW", tourZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

// 「導覽」兩個字已經是窄視窗側欄抽屜的名稱（`sidebar.drawerTitle`、`sidebar.openDrawer`），
// 這個功能一律寫「功能導覽」，免得和抽屜混在一起。
describe("zh-TW 沒有不帶「功能」的「導覽」", () => {
  it("每個值", () => {
    const bad = leaves(tourZhTW).filter(([, v]) => typeof v === "string" && /(?<!功能)導覽/.test(v));
    expect(bad).toEqual([]);
  });
});

// 最後一站那句提問要獨立成一把鍵：卡片的兩顆鈕以 `aria-describedby` 指向它，併在站點說明裡的話，
// 報讀器每顆鈕都會把整段說明念一次。
describe("最後一站的提問是獨立的鍵，不在站點說明裡", () => {
  const QUESTION = { en: "Keep the sample note, or move it to the trash?", "zh-TW": "要保留示範筆記，還是移到垃圾桶？" } as const;
  it.each(BUNDLES)("%s", (name, bundle) => {
    expect(bundle.tourGuide.keepOrDeleteSample).toBe(QUESTION[name]);
    const stops = leaves(bundle.tourGuide.stops).filter(([, v]) => typeof v === "string" && v.includes(QUESTION[name]));
    expect(stops).toEqual([]);
  });
});

describe("註冊後可用、不覆寫主檔", () => {
  it("包裡的鍵查得到，主檔的鍵照舊", () => {
    expect(i18n.t("tourGuide.progress", { lng: "en", n: 1, total: 7 })).toBe("1 / 7");
    expect(i18n.t("userMenu.shortcuts", { lng: "zh-TW" })).toBe("快捷鍵介紹");
    expect(i18n.t("userMenu.logout", { lng: "en" })).toBe("Log out");
  });
});
