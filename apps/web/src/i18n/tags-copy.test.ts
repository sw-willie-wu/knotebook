import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/tags-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import tagsEn from "./tags.en.json";
import tagsZhTW from "./tags.zh-TW.json";

/** The tag management strings live in a lazy bundle; `tags.manage.nav` stays in the main file because the settings and group navigation render it. */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

// Raw text: after registration the imported main JSON object has been deep-merged with the lazy bundle.
const mainKeys = (raw: string) => flattenKeys(JSON.parse(raw) as object).filter((key) => key.startsWith("tags.manage."));

describe("tags lazy bundle", () => {
  it("has the same key set in both locales", () => {
    expect(flattenKeys(tagsZhTW).sort()).toEqual(flattenKeys(tagsEn).sort());
  });

  it("does not overlap the main file, which keeps only the navigation label", () => {
    for (const raw of [enRaw, zhTWRaw]) expect(mainKeys(raw)).toEqual(["tags.manage.nav"]);
    const lazyKeys = flattenKeys(tagsEn);
    expect(lazyKeys).not.toContain("tags.manage.nav");
    expect(lazyKeys.length).toBeGreaterThan(20);
  });

  it("keeps the search-box strings out of the main files", () => {
    for (const raw of [enRaw, zhTWRaw]) expect(Object.keys(JSON.parse(raw) as object)).not.toContain("tagSearch");
    expect(Object.keys(tagsEn)).toContain("tagSearch");
    expect(i18n.t("tagSearch.removeToken", { lng: "en", name: "Work" })).toBe("Remove tag filter Work");
    expect(i18n.t("tagSearch.joiner", { lng: "zh-TW" })).toBe("＋");
  });

  it("resolves after registration without overriding the main file", () => {
    expect(i18n.t("tags.manage.rename", { lng: "en" })).toBe("Rename");
    expect(i18n.t("tags.manage.nav", { lng: "en" })).toBe("Tags");
    expect(i18n.t("tags.manage.nav", { lng: "zh-TW" })).not.toBe("tags.manage.nav");
  });

  it("keeps the custom color dialog's strings in the lazy bundle and reuses the main colors.* keys", () => {
    for (const raw of [enRaw, zhTWRaw]) {
      expect(Object.keys(JSON.parse(raw) as object)).not.toContain("tagColor");
      expect(Object.keys((JSON.parse(raw) as { colors: object }).colors)).toEqual(expect.arrayContaining(["custom", "hex_label", "hex_invalid", "apply", "recent"]));
    }
    expect(i18n.t("tagColor.customCurrent", { lng: "en", color: "#e03e3e" })).toBe("Custom color #e03e3e");
    expect(i18n.t("tagColor.title", { lng: "zh-TW" })).toBe("自訂顏色");
    expect(i18n.t("tagColor.description", { lng: "en", name: "Work" })).toContain("\"Work\"");
  });

  it("is imported by every file that renders a lazy tags.manage key", () => {
    for (const path of [
      "src/settings/TagsSection.tsx",
      "src/components/tags/RenameTagDialog.tsx",
      "src/components/tags/TagPillMenu.tsx",
      "src/components/tags/CustomTagColorDialog.tsx",
      "src/components/tags/hash-tag-batch.ts",
      "src/components/sidebar/TagSearchController.tsx",
      "src/components/sidebar/TagResultsExtras.tsx",
      "src/components/sidebar/TagHashList.tsx",
    ]) {
      expect(readFileSync(`${process.cwd()}/${path}`, "utf8"), path).toMatch(/import\s+["']@\/i18n\/tags-strings["']/);
    }
  });
});
