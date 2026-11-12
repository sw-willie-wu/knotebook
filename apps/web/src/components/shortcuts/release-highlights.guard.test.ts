import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import webPackage from "../../../package.json";
import shortcutsEn from "@/i18n/shortcuts.en.json";
import shortcutsZhTW from "@/i18n/shortcuts.zh-TW.json";
import { RELEASE_HIGHLIGHTS, visibleHighlightItems, type HighlightItem, type ReleaseHighlights } from "./release-highlights";
import registrySource from "./release-highlights.ts?raw";

/**
 * 「這一版新增」登記檔的守衛。發版準備會把 package 版本往上改；登記檔沒跟著改時這裡紅，
 * 舊版的「vX.Y.Z 新增」才不會一路沿用到下一版。檢查寫成純函式，用假資料證明每一條都會紅：
 * 真的登記檔的條目之後可能被清空，只對它跑的話字串那一條什麼都沒檢查到。
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
  bundles: readonly (readonly [string, unknown])[];
}

function highlightProblems({ highlights, packageVersion, bundles }: GuardInput): string[] {
  const problems: string[] = [];
  if (!SEMVER.test(highlights.version)) problems.push(`version 不是 X.Y.Z：${highlights.version}`);
  else if (!versionAtLeast(highlights.version, packageVersion)) {
    problems.push(`version ${highlights.version} 低於 apps/web/package.json 的 ${packageVersion}`);
  }
  for (const { id, adminOnly } of highlights.items) {
    if (adminOnly !== undefined && typeof adminOnly !== "boolean") problems.push(`${id} 的 adminOnly 不是布林：${String(adminOnly)}`);
    for (const [lang, bundle] of bundles) {
      for (const field of ["title", "desc"]) {
        const key = `helpGuide.whatsNew.items.${id}.${field}`;
        const value = get(bundle, key);
        if (typeof value !== "string" || value.length === 0) problems.push(`${lang} 缺 ${key}`);
      }
    }
  }
  return problems;
}

const BUNDLES = [
  ["en", shortcutsEn],
  ["zh-TW", shortcutsZhTW],
] as const;

describe("release-highlights 登記檔", () => {
  it("真的登記檔：版本格式對、不低於 package 版本、每個條目的雙語字串都有", () => {
    expect(highlightProblems({ highlights: RELEASE_HIGHLIGHTS, packageVersion: webPackage.version, bundles: BUNDLES })).toEqual([]);
  });

  it("條目 id 不重複", () => {
    const ids = RELEASE_HIGHLIGHTS.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("字串包裡沒有登記檔沒列的條目（守殘留字串）", () => {
    const ids = RELEASE_HIGHLIGHTS.items.map((item) => item.id);
    for (const [lang, bundle] of BUNDLES) {
      const items = (get(bundle, "helpGuide.whatsNew.items") ?? {}) as Record<string, unknown>;
      expect(Object.keys(items).filter((id) => !ids.includes(id)), lang).toEqual([]);
    }
  });
});

describe("守衛本身（假資料）", () => {
  const ok = (over: Partial<GuardInput>): string[] =>
    highlightProblems({ highlights: { version: "1.0.0", items: [] }, packageVersion: "1.0.0", bundles: BUNDLES, ...over });

  it("版本等於 package 版本：通過", () => {
    expect(ok({})).toEqual([]);
  });

  it("版本不是 X.Y.Z：紅", () => {
    for (const version of ["1.0", "v1.0.0", "1.0.0-rc.1", "", "1.0.0 "]) {
      expect(ok({ highlights: { version, items: [] } }), version).toHaveLength(1);
    }
  });

  it("版本低於 package 版本：紅（逐段比數字）", () => {
    expect(ok({ highlights: { version: "0.15.0", items: [] }, packageVersion: "0.16.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "0.9.0", items: [] }, packageVersion: "0.10.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "1.9.9", items: [] }, packageVersion: "2.0.0" })).toHaveLength(1);
    expect(ok({ highlights: { version: "0.10.0", items: [] }, packageVersion: "0.9.0" })).toEqual([]);
    expect(ok({ highlights: { version: "0.16.0", items: [] }, packageVersion: "0.15.3" })).toEqual([]);
  });

  it("條目缺一種語言的字串：紅", () => {
    const bundle = (title: string, desc: string | undefined): unknown => ({
      helpGuide: { whatsNew: { items: { sample: { title, desc } } } },
    });
    const highlights: ReleaseHighlights = { version: "1.0.0", items: [{ id: "sample" }] };
    expect(ok({ highlights, bundles: [["en", bundle("T", "D")], ["zh-TW", bundle("標題", "說明")]] })).toEqual([]);
    expect(ok({ highlights, bundles: [["en", bundle("T", undefined)], ["zh-TW", bundle("標題", "說明")]] })).toEqual([
      "en 缺 helpGuide.whatsNew.items.sample.desc",
    ]);
    expect(ok({ highlights, bundles: [["en", bundle("T", "D")], ["zh-TW", bundle("", "說明")]] })).toEqual([
      "zh-TW 缺 helpGuide.whatsNew.items.sample.title",
    ]);
    expect(ok({ highlights: { version: "1.0.0", items: [{ id: "missing" }] }, bundles: BUNDLES })).toHaveLength(4);
  });

  it("adminOnly 不是布林：紅；省略、true、false：通過", () => {
    const bundle: unknown = { helpGuide: { whatsNew: { items: { sample: { title: "T", desc: "D" } } } } };
    const bundles = [
      ["en", bundle],
      ["zh-TW", bundle],
    ] as const;
    const withAdminOnly = (adminOnly: unknown): string[] =>
      ok({ highlights: { version: "1.0.0", items: [{ id: "sample", adminOnly } as HighlightItem] }, bundles });
    expect(withAdminOnly(undefined)).toEqual([]);
    expect(withAdminOnly(true)).toEqual([]);
    expect(withAdminOnly(false)).toEqual([]);
    for (const bad of ["true", 1, 0, null, {}]) expect(withAdminOnly(bad), String(bad)).toHaveLength(1);
  });
});

describe("visibleHighlightItems", () => {
  const items: HighlightItem[] = [{ id: "a" }, { id: "b", adminOnly: true }, { id: "c", adminOnly: false }, { id: "d", adminOnly: true }];

  it("一般使用者看不到 adminOnly 的條目，順序不變", () => {
    expect(visibleHighlightItems(items, false).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("站台管理員全部看得到", () => {
    expect(visibleHighlightItems(items, true).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("空清單與全是 adminOnly：一般使用者得到空陣列", () => {
    expect(visibleHighlightItems([], false)).toEqual([]);
    expect(visibleHighlightItems([{ id: "x", adminOnly: true }], false)).toEqual([]);
  });

  it("不改傳入的陣列", () => {
    const copy = [...items];
    visibleHighlightItems(items, false);
    expect(items).toEqual(copy);
  });

  it("真的登記檔：adminOnly 條目一般使用者看不到、管理員看得到，其餘兩邊都看得到", () => {
    const all = RELEASE_HIGHLIGHTS.items.map((i) => i.id);
    const adminOnlyIds = RELEASE_HIGHLIGHTS.items.filter((i) => i.adminOnly === true).map((i) => i.id);
    const everyoneIds = RELEASE_HIGHLIGHTS.items.filter((i) => i.adminOnly !== true).map((i) => i.id);
    const asUser = visibleHighlightItems(RELEASE_HIGHLIGHTS.items, false).map((i) => i.id);
    const asAdmin = visibleHighlightItems(RELEASE_HIGHLIGHTS.items, true).map((i) => i.id);
    expect(asUser).toEqual(everyoneIds);
    expect(asUser.filter((id) => adminOnlyIds.includes(id))).toEqual([]);
    expect(asAdmin).toEqual(all);
  });
});

/** 說明視窗的 chunk 會讀登記檔，所以登記檔與說明視窗都不能把導覽的程式（站點表等）帶進同一個 chunk。 */
describe("匯入守衛", () => {
  const IMPORT_FROM = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  const importsOf = (source: string): string[] => [...source.matchAll(IMPORT_FROM)].map((m) => m[1]!);

  /** 把 import 的路徑解成相對於 `src/`、沒有副檔名的路徑；套件名回 null。 */
  function resolveImport(fromFile: string, spec: string): string | null {
    let resolved: string;
    if (spec.startsWith("@/")) resolved = posix.normalize(spec.slice(2));
    else if (spec.startsWith(".")) resolved = posix.join(posix.dirname(fromFile), spec);
    else return null;
    return resolved.replace(/\/index$/, "").replace(/\.(tsx?|jsx?)$/, "");
  }

  /** `sources` 的鍵是相對於 `src/` 的檔案路徑；回傳有 import 到 `isTarget` 為真的那些檔。 */
  function importers(sources: Record<string, string>, isTarget: (resolved: string) => boolean): string[] {
    return Object.entries(sources)
      .filter(([file, source]) =>
        importsOf(source).some((spec) => {
          const resolved = resolveImport(file, spec);
          return resolved !== null && isTarget(resolved);
        }),
      )
      .map(([file]) => file);
  }

  const REGISTRY = "components/shortcuts/release-highlights";
  const isRegistry = (resolved: string): boolean => resolved === REGISTRY;
  const isTourDir = (resolved: string): boolean => resolved === "components/tour" || resolved.startsWith("components/tour/");

  /** glob 的鍵（相對於本檔）轉成相對於 `src/` 的路徑。 */
  const fromSrc = (sources: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(sources).map(([key, source]) => [posix.join("components/shortcuts", key), source]));

  const tourSources = fromSrc(
    import.meta.glob(["../tour/**/*.{ts,tsx}", "../../lib/tour-*.{ts,tsx}", "../../collab/tour-*.{ts,tsx}"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  );
  const shortcutSources = fromSrc(
    import.meta.glob(["./*.{ts,tsx}", "!./*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  );

  it("掃得到檔案（glob 沒落空）", () => {
    const tourFiles = Object.keys(tourSources);
    expect(tourFiles.filter((f) => f.startsWith("components/tour/")).length).toBeGreaterThan(5);
    expect(tourFiles).toContain("lib/tour-bridge.ts");
    expect(tourFiles).toContain("collab/tour-transaction-filter.ts");
    expect(Object.keys(shortcutSources)).toContain("components/shortcuts/ShortcutsDialog.tsx");
  });

  it("導覽程式（導覽目錄、lib/tour-*、collab/tour-*）沒有任何檔 import 登記檔", () => {
    expect(importers(tourSources, isRegistry)).toEqual([]);
  });

  it("登記檔本身沒有 import", () => {
    expect(importsOf(registrySource)).toEqual([]);
    expect(registrySource).not.toMatch(/^\s*(import|export\s+.*\s+from)\b/m);
  });

  it("說明視窗目錄底下（非測試）沒有檔 import 導覽目錄", () => {
    expect(importers(shortcutSources, isTourDir)).toEqual([]);
  });

  describe("守衛本身（假資料）", () => {
    const from = (file: string, spec: string): Record<string, string> => ({ [file]: `import { x } from "${spec}";` });

    it("各種寫法都解得到同一個目標", () => {
      for (const spec of [
        "@/components/shortcuts/release-highlights",
        "../shortcuts/release-highlights",
        "../../components/shortcuts/release-highlights",
        "./../shortcuts/./release-highlights",
        "../shortcuts/release-highlights.ts",
      ]) {
        expect(importers(from("components/tour/a.ts", spec), isRegistry), spec).toEqual(["components/tour/a.ts"]);
      }
      expect(importers(from("lib/tour-bridge.ts", "../components/shortcuts/release-highlights"), isRegistry)).toEqual(["lib/tour-bridge.ts"]);
      expect(importers(from("components/shortcuts/A.tsx", "./../tour/stops"), isTourDir)).toEqual(["components/shortcuts/A.tsx"]);
      expect(importers(from("components/shortcuts/A.tsx", "../tour"), isTourDir)).toEqual(["components/shortcuts/A.tsx"]);
    });

    it("不相干的 import 不算", () => {
      const src = {
        "components/tour/a.ts": 'import a from "react"; import b from "./stops"; import c from "@/lib/x"; import d from "../shortcuts/shortcut-list";',
      };
      expect(importers(src, isRegistry)).toEqual([]);
      expect(importers(from("components/shortcuts/A.tsx", "../tourist/x"), isTourDir)).toEqual([]);
    });

    it("動態 import 與 re-export 也抓得到", () => {
      expect(importers({ "lib/tour-x.ts": 'const m = import("@/components/shortcuts/release-highlights");' }, isRegistry)).toEqual(["lib/tour-x.ts"]);
      expect(importers({ "lib/tour-x.ts": 'export * from "../components/shortcuts/release-highlights";' }, isRegistry)).toEqual(["lib/tour-x.ts"]);
    });
  });
});
