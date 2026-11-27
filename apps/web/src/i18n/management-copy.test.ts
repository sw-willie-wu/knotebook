import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/management-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import managementEn from "./management.en.json";
import managementZhTW from "./management.zh-TW.json";
import managementEnRaw from "./management.en.json?raw";
import managementZhTWRaw from "./management.zh-TW.json?raw";

/**
 * Lazy string bundles for site admin (`admin.*`) and settings (`settings.*`) (`management.*.json`, registered only by the settings / admin lazy chains via `management-strings.ts`).
 * The main-JSON parity test (`index.test.ts`) does not cover these two files, so parity, no overlap with the main file, no duplicate keys, and which files must import are checked here.
 * The main file is always read as `?raw`: i18next's store references init's `resources` directly, so after registration the main JSON module object has been deep-merged with the whole admin / settings bundle.
 */

/** The 17 keys the first bundle (AdminModal, SettingsModal, UserMenu) needs and that must stay in the main file; changing this list changes the first bundle size, so update the comment in management-strings.ts too. */
const KEPT_IN_MAIN = [
  "admin.nav.label",
  "admin.nav.users",
  "admin.nav.groups",
  "admin.nav.storage",
  "admin.nav.ai",
  "admin.nav.auth",
  "admin.nav.knowledgeFields",
  "admin.nav.limits",
  "settings.entry",
  "settings.title",
  "settings.description",
  "settings.nav.account",
  "settings.nav.login",
  "settings.nav.authorization",
  "settings.nav.groups",
  "settings.nav.storage",
  "settings.nav.about",
];

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Same as `index.test.ts`: `JSON.parse` keeps only the last of duplicate keys, so scan the raw text. */
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

const mainEnKeys = flattenKeys(JSON.parse(enRaw));
const mainZhTWKeys = flattenKeys(JSON.parse(zhTWRaw));
const isManaged = (key: string) => key.startsWith("admin.") || key.startsWith("settings.");

describe("management bundle: both locales have the same key set, top level is only admin and settings", () => {
  it("same key set", () => {
    expect(flattenKeys(managementZhTW).sort()).toEqual(flattenKeys(managementEn).sort());
  });

  it("top level is exactly admin and settings", () => {
    expect(Object.keys(managementEn)).toEqual(["admin", "settings"]);
    expect(Object.keys(managementZhTW)).toEqual(["admin", "settings"]);
  });

  it("main file + bundle together have the same key set in both locales (keys other than admin / settings are guarded by index.test.ts)", () => {
    const union = (main: string[], mgmt: unknown) => [...main, ...flattenKeys(mgmt)].sort();
    expect(union(mainZhTWKeys, managementZhTW)).toEqual(union(mainEnKeys, managementEn));
  });
});

describe("no overlap with the main file", () => {
  it("no key in the bundle is in the main file", () => {
    const mainSet = new Set(mainEnKeys);
    expect(flattenKeys(managementEn).filter((key) => mainSet.has(key))).toEqual([]);
  });
});

describe("main file's admin / settings keep only the 17 first-bundle keys", () => {
  it.each([
    ["en", mainEnKeys],
    ["zh-TW", mainZhTWKeys],
  ] as const)("%s", (_name, keys) => {
    expect(keys.filter(isManaged).sort()).toEqual([...KEPT_IN_MAIN].sort());
  });
});

describe("available after registration, main file not overridden", () => {
  it("bundle keys (including plural and template keys) resolve in both locales", () => {
    expect(i18n.t("admin.auth.edit.autoCreateConfirmKeep", { lng: "en" })).toBe(get(managementEn, "admin.auth.edit.autoCreateConfirmKeep"));
    expect(i18n.t("settings.ai.actionBuiltinBadge", { lng: "zh-TW" })).toBe("內建");
    expect(i18n.t("settings.account.apiTokensScopeEdit", { lng: "en" })).toBe(get(managementEn, "settings.account.apiTokensScopeEdit"));
  });

  it("first-bundle keys are still the main file's values", () => {
    expect(i18n.t("settings.title", { lng: "en" })).toBe("Settings");
    expect(i18n.t("admin.nav.label", { lng: "zh-TW" })).toBe("站台管理");
  });
});

describe("management bundle has no duplicate keys", () => {
  it.each([
    ["en", managementEnRaw],
    ["zh-TW", managementZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

describe("every _one has an _other", () => {
  it.each([
    ["en", managementEn],
    ["zh-TW", managementZhTW],
  ] as const)("%s", (_name, resource) => {
    const keys = new Set(flattenKeys(resource));
    const missing = [...keys].filter((k) => k.endsWith("_one") && !keys.has(`${k.slice(0, -"_one".length)}_other`));
    expect(missing).toEqual([]);
  });
});

/** Strips comments (same as article-column.guard.test.ts; a `//` preceded by `:` is treated as a URL and not stripped). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function listNonTestSources(): string[] {
  return readdirSync(`${process.cwd()}/src`, { recursive: true, encoding: "utf8" })
    .map((p) => `src/${p.replace(/\\/g, "/")}`)
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.startsWith("src/test/"));
}

// Strings whose literal (single/double quote, backtick) starts with `admin.` or `settings.`. Template keys (`admin.auth.warnings.${x}`) are taken up to the `$` / `{` before it and counted too.
const KEY_LITERAL = /["'`]((?:admin|settings)\.[A-Za-z0-9_.]*)/g;
const KEPT = new Set(KEPT_IN_MAIN);

describe("files using moved keys import @/i18n/management-strings themselves", () => {
  const importer = /^import\s+["']@\/i18n\/management-strings["'];?\s*$/m;

  it("finds something (guards against a broken regex or path silently passing everything)", () => {
    const users = listNonTestSources().filter((p) => [...stripComments(readFileSync(`${process.cwd()}/${p}`, "utf8")).matchAll(KEY_LITERAL)].some((m) => !KEPT.has(m[1]!)));
    expect(users.length).toBeGreaterThan(20);
    expect(users).toContain("src/settings/ScopeChecksField.tsx");
  });

  it("every non-test file containing a non-first-bundle admin. / settings. key literal imports it; the 17 first-bundle keys do not need it", () => {
    const offenders: string[] = [];
    for (const path of listNonTestSources()) {
      if (path === "src/i18n/management-strings.ts") continue;
      const code = stripComments(readFileSync(`${process.cwd()}/${path}`, "utf8"));
      const needs = [...code.matchAll(KEY_LITERAL)].some((m) => !KEPT.has(m[1]!));
      if (needs && !importer.test(code)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("the notification retention labels differ from the trash ones in both languages (same accessible name on one page otherwise)", () => {
    for (const bundle of [managementEn, managementZhTW]) {
      const admin = (bundle as unknown as { admin: Record<"trash" | "notifications", Record<"autoLabel" | "daysLabel", string>> }).admin;
      expect(admin.notifications.autoLabel).not.toBe(admin.trash.autoLabel);
      expect(admin.notifications.daysLabel).not.toBe(admin.trash.daysLabel);
    }
  });

  it("users of the first-bundle keys (AdminModal, SettingsModal, UserMenu) must not import the string bundle (that would pull it back into the first bundle)", () => {
    for (const path of ["src/components/admin/AdminModal.tsx", "src/settings/SettingsModal.tsx", "src/components/UserMenu.tsx"]) {
      expect(readFileSync(`${process.cwd()}/${path}`, "utf8"), path).not.toContain("management-strings");
    }
  });
});
