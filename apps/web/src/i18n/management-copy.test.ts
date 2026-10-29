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
 * 站台管理（`admin.*`）與設定（`settings.*`）的 lazy 字串包（`management.*.json`，只由設定／管理各 lazy 鏈經 `management-strings.ts` 註冊）。
 * 主 JSON 的 parity（`index.test.ts`）不涵蓋這兩檔，所以 parity、與主檔不重疊、無重複鍵、誰該 import 都在這裡。
 * ⚠ 主檔內容一律讀 `?raw`：i18next 的 store 直接引用 init 的 `resources`，註冊後主 JSON 的 module 物件已被 deep merge 帶上整包 admin／settings。
 */

/** 首包（AdminModal、SettingsModal、UserMenu）用得到、必須留在主檔的 15 個鍵——改這份清單＝改首包大小，同時改 management-strings.ts 的註解。 */
const KEPT_IN_MAIN = [
  "admin.nav.label",
  "admin.nav.users",
  "admin.nav.groups",
  "admin.nav.storage",
  "admin.nav.ai",
  "admin.nav.auth",
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

/** 同 `index.test.ts`：`JSON.parse` 遇重複鍵只留最後一份，直接掃原始文字。 */
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

describe("MC1 management 包：兩語系鍵集合相同、頂層只有 admin 與 settings", () => {
  it("鍵集合相同", () => {
    expect(flattenKeys(managementZhTW).sort()).toEqual(flattenKeys(managementEn).sort());
  });

  it("頂層恰為 admin、settings", () => {
    expect(Object.keys(managementEn)).toEqual(["admin", "settings"]);
    expect(Object.keys(managementZhTW)).toEqual(["admin", "settings"]);
  });

  it("主檔＋包合起來兩語系鍵集合相同（admin／settings 以外的鍵本來就由 index.test.ts 守）", () => {
    const union = (main: string[], mgmt: unknown) => [...main, ...flattenKeys(mgmt)].sort();
    expect(union(mainZhTWKeys, managementZhTW)).toEqual(union(mainEnKeys, managementEn));
  });
});

describe("MC2 與主檔不重疊", () => {
  it("包裡的鍵一個都不在主檔", () => {
    const mainSet = new Set(mainEnKeys);
    expect(flattenKeys(managementEn).filter((key) => mainSet.has(key))).toEqual([]);
  });
});

describe("MC3 主檔的 admin／settings 只剩首包的 15 個鍵", () => {
  it.each([
    ["en", mainEnKeys],
    ["zh-TW", mainZhTWKeys],
  ] as const)("%s", (_name, keys) => {
    expect(keys.filter(isManaged).sort()).toEqual([...KEPT_IN_MAIN].sort());
  });
});

describe("MC4 註冊後可用、不覆寫主檔", () => {
  it("包裡的鍵（含複數與模板鍵）在兩語系都解得到", () => {
    expect(i18n.t("admin.auth.edit.autoCreateConfirmKeep", { lng: "en" })).toBe(get(managementEn, "admin.auth.edit.autoCreateConfirmKeep"));
    expect(i18n.t("settings.ai.actionBuiltinBadge", { lng: "zh-TW" })).toBe("內建");
    expect(i18n.t("settings.account.apiTokensScopeEdit", { lng: "en" })).toBe(get(managementEn, "settings.account.apiTokensScopeEdit"));
  });

  it("首包的鍵仍是主檔的值", () => {
    expect(i18n.t("settings.title", { lng: "en" })).toBe("Settings");
    expect(i18n.t("admin.nav.label", { lng: "zh-TW" })).toBe("站台管理");
  });
});

describe("MC5 management 包沒有重複鍵", () => {
  it.each([
    ["en", managementEnRaw],
    ["zh-TW", managementZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

describe("MC6 每個 _one 都有 _other", () => {
  it.each([
    ["en", managementEn],
    ["zh-TW", managementZhTW],
  ] as const)("%s", (_name, resource) => {
    const keys = new Set(flattenKeys(resource));
    const missing = [...keys].filter((k) => k.endsWith("_one") && !keys.has(`${k.slice(0, -"_one".length)}_other`));
    expect(missing).toEqual([]);
  });
});

/** 剝掉註解（同 article-column.guard.test.ts；`//` 前是 `:` 的當 URL 不剝）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** `src/` 下所有非測試的 .ts／.tsx（相對 web 根、`/` 分隔）。 */
function listNonTestSources(): string[] {
  return readdirSync(`${process.cwd()}/src`, { recursive: true, encoding: "utf8" })
    .map((p) => `src/${p.replace(/\\/g, "/")}`)
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.startsWith("src/test/"));
}

// 字面（單／雙引號、反引號）開頭是 `admin.` 或 `settings.` 的字串。模板鍵（`admin.auth.warnings.${x}`）取到 `$`、`{` 前一併算入。
const KEY_LITERAL = /["'`]((?:admin|settings)\.[A-Za-z0-9_.]*)/g;
const KEPT = new Set(KEPT_IN_MAIN);

describe("MC7 用到被搬走鍵的檔自己 import @/i18n/management-strings", () => {
  const importer = /^import\s+["']@\/i18n\/management-strings["'];?\s*$/m;

  it("掃得到東西（防正則或路徑壞掉而靜默全過）", () => {
    const users = listNonTestSources().filter((p) => [...stripComments(readFileSync(`${process.cwd()}/${p}`, "utf8")).matchAll(KEY_LITERAL)].some((m) => !KEPT.has(m[1]!)));
    expect(users.length).toBeGreaterThan(20);
    expect(users).toContain("src/settings/ScopeChecksField.tsx");
  });

  it("每個含非首包 admin.／settings. 鍵字面的非測試檔都有 import；首包用的 15 鍵不需要", () => {
    const offenders: string[] = [];
    for (const path of listNonTestSources()) {
      if (path === "src/i18n/management-strings.ts") continue;
      const code = stripComments(readFileSync(`${process.cwd()}/${path}`, "utf8"));
      const needs = [...code.matchAll(KEY_LITERAL)].some((m) => !KEPT.has(m[1]!));
      if (needs && !importer.test(code)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("首包保留鍵的使用者（AdminModal、SettingsModal、UserMenu）不得 import 字串包（會把它拉回首包）", () => {
    for (const path of ["src/components/admin/AdminModal.tsx", "src/settings/SettingsModal.tsx", "src/components/UserMenu.tsx"]) {
      expect(readFileSync(`${process.cwd()}/${path}`, "utf8"), path).not.toContain("management-strings");
    }
  });
});
