import { describe, expect, it } from "vitest";
import webPackage from "../../../package.json";
import tourEn from "@/i18n/tour.en.json";
import tourZhTW from "@/i18n/tour.zh-TW.json";
import { RELEASE_HIGHLIGHTS, type ReleaseHighlights } from "./release-highlights";
import { STOPS, type StopDef } from "./stops";

/**
 * 「這一版新增」登記檔的守衛。發版準備會把 package 版本往上改；登記檔沒跟著改時這裡紅，
 * 舊版的「vX.Y.Z 新增」才不會一路沿用到下一版。檢查寫成純函式，用假資料證明每一條都會紅：
 * 真的登記檔 `stops` 可能是空的，只對它跑的話站點與字串那兩條什麼都沒檢查到。
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `a` 是否 ≥ `b`（兩者都得是 X.Y.Z）。逐段比數字，不比字串：字串比會讓 0.9.0 大於 0.10.0。 */
function versionAtLeast(a: string, b: string): boolean {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (pa === null || pb === null) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

interface GuardInput {
  highlights: ReleaseHighlights;
  packageVersion: string;
  stops: Readonly<Record<string, StopDef>>;
  bundles: readonly (readonly [string, unknown])[];
}

function highlightProblems({ highlights, packageVersion, stops, bundles }: GuardInput): string[] {
  const problems: string[] = [];
  if (!SEMVER.test(highlights.version)) problems.push(`version 不是 X.Y.Z：${highlights.version}`);
  else if (!versionAtLeast(highlights.version, packageVersion)) {
    problems.push(`version ${highlights.version} 低於 apps/web/package.json 的 ${packageVersion}`);
  }
  for (const id of highlights.stops) {
    const stop = Object.prototype.hasOwnProperty.call(stops, id) ? stops[id] : undefined;
    if (stop === undefined) {
      problems.push(`站點表沒有 ${id}`);
      continue;
    }
    const keys = [stop.titleKey, stop.bodyKey, ...(stop.narrowBodyKey === undefined ? [] : [stop.narrowBodyKey])];
    for (const [lang, bundle] of bundles) {
      for (const key of keys) {
        const value = get(bundle, key);
        if (typeof value !== "string" || value.length === 0) problems.push(`${lang} 缺 ${key}`);
      }
    }
  }
  return problems;
}

const BUNDLES = [
  ["en", tourEn],
  ["zh-TW", tourZhTW],
] as const;

describe("release-highlights 登記檔", () => {
  it("真的登記檔：版本格式對、不低於 package 版本、站點都在站點表、字串雙語都有", () => {
    expect(
      highlightProblems({ highlights: RELEASE_HIGHLIGHTS, packageVersion: webPackage.version, stops: STOPS, bundles: BUNDLES }),
    ).toEqual([]);
  });
});

describe("守衛本身（假資料）", () => {
  const ok = (over: Partial<GuardInput>): string[] =>
    highlightProblems({ highlights: { version: "1.0.0", stops: [] }, packageVersion: "1.0.0", stops: STOPS, bundles: BUNDLES, ...over });

  it("版本等於 package 版本：通過", () => {
    expect(ok({})).toEqual([]);
  });

  it("版本不是 X.Y.Z：紅", () => {
    for (const version of ["1.0", "v1.0.0", "1.0.0-rc.1", "", "1.0.0 "]) {
      expect(ok({ highlights: { version, stops: [] } }), version).toHaveLength(1);
    }
  });

  it("版本低於 package 版本：紅（逐段比數字）", () => {
    expect(ok({ highlights: { version: "0.15.0", stops: [] }, packageVersion: "0.16.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "0.9.0", stops: [] }, packageVersion: "0.10.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "1.9.9", stops: [] }, packageVersion: "2.0.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "0.10.0", stops: [] }, packageVersion: "0.9.0" })).toEqual([]);
    expect(ok({ highlights: { version: "0.16.0", stops: [] }, packageVersion: "0.15.3" })).toEqual([]);
  });

  it("站點 id 不在站點表：紅", () => {
    const highlights = { version: "1.0.0", stops: ["nope"] } as unknown as ReleaseHighlights;
    expect(ok({ highlights })).toEqual(["站點表沒有 nope"]);
  });

  it("站點的字串缺了一種語言：紅", () => {
    const highlights: ReleaseHighlights = { version: "1.0.0", stops: ["header"] };
    expect(ok({ highlights })).toEqual([]);
    const enWithoutHeader = { tourGuide: { ...tourEn.tourGuide, stops: { ...tourEn.tourGuide.stops, header: undefined } } };
    const problems = ok({ highlights, bundles: [["en", enWithoutHeader], ["zh-TW", tourZhTW]] });
    expect(problems).toEqual([`en 缺 ${STOPS.header.titleKey}`, `en 缺 ${STOPS.header.bodyKey}`]);
  });

  it("窄視窗說明的字串也查", () => {
    const highlights: ReleaseHighlights = { version: "1.0.0", stops: ["versions"] };
    const narrowKey = STOPS.versions.narrowBodyKey!;
    const leaf = narrowKey.split(".").pop()!;
    const zhStops = tourZhTW.tourGuide.stops as Record<string, Record<string, string>>;
    const zhWithoutNarrow = {
      tourGuide: { ...tourZhTW.tourGuide, stops: { ...zhStops, versions: { ...zhStops.versions, [leaf]: "" } } },
    };
    expect(ok({ highlights, bundles: [["en", tourEn], ["zh-TW", zhWithoutNarrow]] })).toEqual([`zh-TW 缺 ${narrowKey}`]);
  });
});
