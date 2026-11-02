import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import zhTW from "./zh-TW.json";
import en from "./en.json";

/**
 * #93 PR2 側欄搜內文的文案（zh-TW 字面，plan T4 字串表）。改這些字串＝改產品決定，先問 Willie。
 * 草稿階段：Willie 定稿前照 plan 的草案釘；定稿後只改這張表與兩個 json。
 */
const SPEC_COPY: Record<string, string> = {
  "sidebar.titleMatches_one": "標題符合 · {{count}} 篇",
  "sidebar.titleMatches_other": "標題符合 · {{count}} 篇",
  "sidebar.bodyMatchesHeading": "內文符合",
  "sidebar.bodyMatchesCount_one": "{{count}} 篇",
  "sidebar.bodyMatchesCount_other": "{{count}} 篇",
  "sidebar.bodySearching": "正在搜尋內文…",
  "sidebar.bodySearchFailed": "無法搜尋內文。",
  "sidebar.bodySearchRateLimited": "搜尋太頻繁，請稍等一下再試。",
  "sidebar.bodyLoadMore": "載入更多",
  "sidebar.bodyLoadingMore": "載入中…",
  "sidebar.bodySearchTooShort": "再多打一個字就會搜尋內文。",
  "sidebar.bodySearchTooLong": "搜尋字太長，只比對標題。",
  "sidebar.noMatch": "沒有符合搜尋的筆記。",
};

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("SC1 側欄搜尋文案＝字串表（zh-TW）", () => {
  for (const [key, text] of Object.entries(SPEC_COPY)) {
    it(key, () => expect(get(zhTW, key)).toBe(text));
  }

  it("titleMatches 的複數（count=3）", () => {
    expect(i18n.t("sidebar.titleMatches", { count: 3, lng: "zh-TW" })).toBe("標題符合 · 3 篇");
    expect(i18n.t("sidebar.titleMatches", { count: 1, lng: "en" })).toBe("1 title match");
    expect(i18n.t("sidebar.titleMatches", { count: 3, lng: "en" })).toBe("3 title matches");
  });
});

describe("SC2 舊的 searchResults 已移除（D2：改叫「標題符合」）", () => {
  for (const key of ["sidebar.searchResults_one", "sidebar.searchResults_other"]) {
    it(key, () => {
      expect(get(en, key)).toBeUndefined();
      expect(get(zhTW, key)).toBeUndefined();
    });
  }
});
