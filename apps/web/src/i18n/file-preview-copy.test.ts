import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/file-preview-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import previewEn from "./file-preview.en.json";
import previewZhTW from "./file-preview.zh-TW.json";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

const lookup = (obj: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);

describe("file preview lazy bundle", () => {
  it("has the same keys and placeholders in both locales, none empty", () => {
    const keys = flattenKeys(previewEn).sort();
    expect(flattenKeys(previewZhTW).sort()).toEqual(keys);
    for (const key of keys) {
      expect((lookup(previewEn, key) as string).trim(), key).not.toBe("");
      expect((lookup(previewZhTW, key) as string).trim(), key).not.toBe("");
      expect(placeholders(lookup(previewZhTW, key) as string), key).toEqual(placeholders(lookup(previewEn, key) as string));
    }
  });

  it("is not in the main files", () => {
    for (const raw of [enRaw, zhTWRaw]) expect((JSON.parse(raw) as { filePreview?: unknown }).filePreview).toBeUndefined();
  });

  it("resolves after registration, in Taiwan usage for zh-TW", () => {
    expect(i18n.t("filePreview.openInNewTab", { lng: "en" })).toBe("Open in new tab");
    expect(i18n.t("filePreview.openInNewTab", { lng: "zh-TW" })).toBe("在新分頁開啟");
    expect(i18n.t("filePreview.download", { lng: "zh-TW" })).toBe("下載");
    expect(i18n.t("filePreview.truncated", { lng: "zh-TW" })).toBe("只顯示前 1 MB。");
    expect(i18n.t("filePreview.frameTitle", { lng: "zh-TW", name: "spec.pdf" })).toBe("spec.pdf 預覽");
  });

  it("is imported by the modal, the only module that renders its keys", () => {
    const dialog = readFileSync(join(process.cwd(), "src/components/file-preview/FilePreviewDialog.tsx"), "utf8");
    expect(dialog).toMatch(/import\s+["']@\/i18n\/file-preview-strings["']/);
    for (const path of ["src/components/file-preview/FilePreviewLayer.tsx", "src/components/file-preview/file-preview-chunk.ts", "src/components/file-preview/file-preview-target.ts"]) {
      expect(readFileSync(join(process.cwd(), path), "utf8"), path).not.toContain("file-preview-strings");
    }
  });
});
