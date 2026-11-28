import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/upload-list-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import listEn from "./upload-list.en.json";
import listZhTW from "./upload-list.zh-TW.json";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

const lookup = (obj: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);

describe("upload list lazy bundle", () => {
  it("has the same keys and placeholders in both locales", () => {
    const keys = flattenKeys(listEn).sort();
    expect(flattenKeys(listZhTW).sort()).toEqual(keys);
    for (const key of keys) expect(placeholders(lookup(listZhTW, key) as string), key).toEqual(placeholders(lookup(listEn, key) as string));
  });

  it("does not overlap the main files, which keep only the indicator button's strings, with matching placeholders", () => {
    const mains = [enRaw, zhTWRaw].map((raw) => JSON.parse(raw) as { uploadList?: unknown; uploadIndicator: Record<string, string> });
    for (const main of mains) {
      expect(main.uploadList).toBeUndefined();
      expect(Object.keys(main.uploadIndicator).sort()).toEqual(["active_one", "active_other", "attention_one", "attention_other", "both"]);
    }
    for (const key of Object.keys(mains[0]!.uploadIndicator)) {
      expect(placeholders(mains[1]!.uploadIndicator[key]!), key).toEqual(placeholders(mains[0]!.uploadIndicator[key]!));
    }
  });

  it("resolves after registration, in Taiwan usage for zh-TW", () => {
    expect(i18n.t("uploadList.placeGone", { lng: "en" })).toBe("Uploaded, but its place in the note is gone.");
    expect(i18n.t("uploadList.uploading", { lng: "zh-TW", count: 2 })).toBe("上傳中 2 個");
    expect(i18n.t("uploadIndicator.active", { lng: "en", count: 2, percent: 63 })).toBe("2 uploads in progress, 63%");
    expect(i18n.t("uploadIndicator.active", { lng: "en", count: 1, percent: 5 })).toBe("1 upload in progress, 5%");
    expect(i18n.t("uploadIndicator.active", { lng: "zh-TW", count: 2, percent: 63 })).toBe("上傳中 2 個，63%");
  });

  it("is imported by every uploads list module that renders a lazy key, and by nothing outside the lazy chunk", () => {
    const dir = join(process.cwd(), "src/components/uploads");
    const lazyKey = /\bt\(\s*["'`]uploadList\./;
    const modules = readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes(".test."));
    expect(modules.some((name) => lazyKey.test(readFileSync(join(dir, name), "utf8")))).toBe(true);
    for (const name of modules) {
      const src = readFileSync(join(dir, name), "utf8");
      if (lazyKey.test(src)) expect(src, name).toMatch(/import\s+["']@\/i18n\/upload-list-strings["']/);
    }
    for (const path of [
      "src/components/UploadIndicator.tsx",
      "src/components/ui/sidebar-panel-lazy-boundary.tsx",
      "src/components/AppShell.tsx",
      "src/components/UserMenu.tsx",
      "src/uploads/upload-queue-store.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), path), "utf8"), path).not.toMatch(/upload-list-strings|components\/uploads\/Upload(List|sPanel)/);
    }
  });
});
