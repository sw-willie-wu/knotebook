import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/math-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import mathEn from "./math.en.json";
import mathZhTW from "./math.zh-TW.json";

/**
 * Lazy string bundle for the math block (`note.math.*`, registered by `math-strings.ts` and imported only from lazy chunks).
 * The main-JSON parity test (`index.test.ts`) does not cover these two files, so placement, parity and literal text are pinned here.
 */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("math bundle placement", () => {
  it("note.math is not in the main JSON (it would land in the entry bundle)", () => {
    expect((JSON.parse(enRaw) as { note: Record<string, unknown> }).note.math).toBeUndefined();
    expect((JSON.parse(zhTWRaw) as { note: Record<string, unknown> }).note.math).toBeUndefined();
  });

  it("both locales have the same key set, nested under note.math only", () => {
    expect(flattenKeys(mathZhTW).sort()).toEqual(flattenKeys(mathEn).sort());
    expect(Object.keys(mathEn)).toEqual(["note"]);
    expect(Object.keys((mathEn as { note: object }).note)).toEqual(["math"]);
  });
});

describe("math copy literals", () => {
  it("resolves in both locales once the bundle is registered", () => {
    expect(i18n.getFixedT("en")("note.math.empty")).toBe("Click to add a formula (LaTeX)");
    expect(i18n.getFixedT("zh-TW")("note.math.empty")).toBe("點一下輸入數學式（LaTeX）");
    expect(i18n.getFixedT("zh-TW")("note.math.slashTitle")).toBe("數學式");
    expect(i18n.getFixedT("en")("note.math.sourceFallback")).toBe("This formula couldn't be drawn — here is its source");
    expect(i18n.getFixedT("zh-TW")("note.math.sourceFallback")).toBe("數學式無法繪製，以下是原始碼");
  });
});
