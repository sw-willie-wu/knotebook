import { describe, expect, it } from "vitest";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import packEn from "./upload-precheck.en.json";
import packZhTW from "./upload-precheck.zh-TW.json";

/** Lazy pre-check copy (`uploadPrecheck.*`, registered by `uploads/precheck.ts`); the main-JSON parity test doesn't cover these files. */

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

describe("upload pre-check copy pack", () => {
  it("only the uploadPrecheck top-level key, same keys in both locales", () => {
    expect(Object.keys(packEn)).toEqual(["uploadPrecheck"]);
    expect(Object.keys(packZhTW)).toEqual(["uploadPrecheck"]);
    expect(Object.keys(packZhTW.uploadPrecheck).sort()).toEqual(Object.keys(packEn.uploadPrecheck).sort());
  });

  it("every message has the same {{placeholders}} in both locales and is non-empty", () => {
    const en = packEn.uploadPrecheck as Record<string, string>;
    const zh = packZhTW.uploadPrecheck as Record<string, string>;
    for (const key of Object.keys(en)) {
      expect(en[key]!.trim(), key).not.toBe("");
      expect(zh[key]!.trim(), key).not.toBe("");
      expect(placeholders(zh[key]!), key).toEqual(placeholders(en[key]!));
    }
    expect(placeholders(en.noRoom!)).toEqual(["room", "size"]);
    expect(placeholders(en.tooLarge!)).toEqual(["limit", "size"]);
  });

  it("the unsupported-type message names OpenDocument files, which the server accepts too, in both locales", () => {
    expect(packEn.uploadPrecheck.unsupported).toBe(
      "This file type isn't supported. You can upload images, audio, video, PDFs, Office and OpenDocument files, and text files.",
    );
    expect(packZhTW.uploadPrecheck.unsupported).toContain("OpenDocument");
  });

  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("main %s JSON has no uploadPrecheck key", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("uploadPrecheck");
  });
});
