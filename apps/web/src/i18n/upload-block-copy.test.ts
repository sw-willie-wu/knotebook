import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/upload-block-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import blockEn from "./upload-block.en.json";
import blockZhTW from "./upload-block.zh-TW.json";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

const lookup = (obj: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);

describe("upload block lazy bundle", () => {
  it("has the same keys and placeholders in both locales, none empty", () => {
    const keys = flattenKeys(blockEn).sort();
    expect(flattenKeys(blockZhTW).sort()).toEqual(keys);
    for (const key of keys) {
      expect((lookup(blockEn, key) as string).trim(), key).not.toBe("");
      expect((lookup(blockZhTW, key) as string).trim(), key).not.toBe("");
      expect(placeholders(lookup(blockZhTW, key) as string), key).toEqual(placeholders(lookup(blockEn, key) as string));
    }
  });

  it("is not in the main files, and the strings it replaced are gone from them", () => {
    for (const raw of [enRaw, zhTWRaw]) {
      const main = JSON.parse(raw) as { uploadBlock?: unknown; note: { transferNonImage?: unknown; filePanel: { upload: Record<string, unknown> } } };
      expect(main.uploadBlock).toBeUndefined();
      expect(main.note.transferNonImage).toBeUndefined();
      expect(main.note.filePanel.upload.error).toBeUndefined();
    }
  });

  it("resolves after registration, in Taiwan usage for zh-TW", () => {
    expect(i18n.t("uploadBlock.progress", { lng: "en", percent: 46, loaded: "110 MB", total: "240 MB" })).toBe("46% · 110 MB / 240 MB");
    expect(i18n.t("uploadBlock.progress", { lng: "zh-TW", percent: 46, loaded: "110 MB", total: "240 MB" })).toBe("46% · 110 MB／240 MB");
    expect(i18n.t("uploadBlock.startsOver", { lng: "zh-TW" })).toBe("（會從頭重新上傳）");
  });

  it("is imported by every module that renders one of its keys", () => {
    for (const path of ["src/collab/upload-block-status.ts", "src/components/FilePanel.tsx"]) {
      expect(readFileSync(join(process.cwd(), path), "utf8"), path).toMatch(/import\s+["']@\/i18n\/upload-block-strings["']/);
    }
    // NoteEditor's toast key resolves because NoteEditor imports the schema, which imports the block status module.
    expect(readFileSync(join(process.cwd(), "src/collab/schema.ts"), "utf8")).toMatch(/from\s+["']\.\/upload-block-status["']/);
  });
});
