import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/knowledge-index-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import indexEn from "./knowledge-index.en.json";
import indexZhTW from "./knowledge-index.zh-TW.json";
import indexEnRaw from "./knowledge-index.en.json?raw";
import indexZhTWRaw from "./knowledge-index.zh-TW.json?raw";

/** Lazy string bundle for the knowledge index page (`knowledgeIndex.*`), registered only by the lazy index page via `knowledge-index-strings.ts`. */

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

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

describe("knowledge index bundle: both locales have the same key set, top level is only knowledgeIndex", () => {
  it("same key set", () => {
    expect(flattenKeys(indexZhTW).sort()).toEqual(flattenKeys(indexEn).sort());
  });

  it("exactly one top-level key, knowledgeIndex", () => {
    expect(Object.keys(indexEn)).toEqual(["knowledgeIndex"]);
    expect(Object.keys(indexZhTW)).toEqual(["knowledgeIndex"]);
  });
});

describe("knowledge index copy literals", () => {
  const ZH: Record<string, string> = {
    "knowledgeIndex.title": "{{name}}｜索引",
    "knowledgeIndex.readOnly": "由筆記裡的知識資訊自動產生，唯讀。",
    "knowledgeIndex.total_other": "共 {{count}} 條",
    "knowledgeIndex.sectionCount_other": "{{count}} 條",
    "knowledgeIndex.untagged": "未加標籤",
    "knowledgeIndex.row.replacedBy": "→ 被「{{title}}」取代",
    "knowledgeIndex.empty.title": "這裡還沒有知識",
    "knowledgeIndex.noMatch": "沒有符合篩選條件的知識。",
    "knowledgeIndex.backfillNotice": "正在為較舊的筆記建立索引，幾分鐘內部分知識可能還沒列出。",
    "knowledgeIndex.truncated": "只列出前 {{max}} 條；開啟子資料夾的索引或加上篩選可看到其他的。",
    "knowledgeIndex.notFound.title": "找不到這個索引",
    "knowledgeIndex.groupBy.label": "分組",
    "knowledgeIndex.filter.tagsActive": "標籤（{{count}}）",
    "knowledgeIndex.filter.evidence": "依據",
    "knowledgeIndex.filter.clear": "清除篩選",
  };
  const EN: Record<string, string> = {
    "knowledgeIndex.title": "{{name}} · Index",
    "knowledgeIndex.total_one": "{{count}} piece of knowledge",
    "knowledgeIndex.total_other": "{{count}} pieces of knowledge",
    "knowledgeIndex.untagged": "No tag",
    "knowledgeIndex.row.replacedBy": "→ replaced by {{title}}",
    "knowledgeIndex.empty.title": "No knowledge here yet",
    "knowledgeIndex.noMatch": "No knowledge matches these filters.",
    "knowledgeIndex.truncated": "Showing the first {{max}}. Open the index of a subfolder or add a filter to see the rest.",
    "knowledgeIndex.notFound.title": "Index not found",
    "knowledgeIndex.filter.evidence": "Basis",
    "knowledgeIndex.filter.clear": "Clear filters",
  };
  for (const [key, text] of Object.entries(ZH)) it(`zh ${key}`, () => expect(get(indexZhTW, key)).toBe(text));
  for (const [key, text] of Object.entries(EN)) it(`en ${key}`, () => expect(get(indexEn, key)).toBe(text));
});

// Read the raw text: deep-merge addResourceBundle merges knowledgeIndex into the main JSON object from i18n init.
describe("main JSON has no knowledgeIndex top-level key (strings go only into the lazy bundle)", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("knowledgeIndex");
  });
});

describe("available after registration", () => {
  it("knowledgeIndex.total: en / zh-TW plural forms", () => {
    expect(i18n.t("knowledgeIndex.total", { count: 1, lng: "en" })).toBe("1 piece of knowledge");
    expect(i18n.t("knowledgeIndex.total", { count: 6, lng: "en" })).toBe("6 pieces of knowledge");
    expect(i18n.t("knowledgeIndex.total", { count: 6, lng: "zh-TW" })).toBe("共 6 條");
  });
});

describe("every _one has an _other", () => {
  it.each([
    ["en", indexEn],
    ["zh-TW", indexZhTW],
  ] as const)("%s", (_name, resource) => {
    const keys = new Set(flattenKeys(resource));
    const missing = [...keys].filter((k) => k.endsWith("_one") && !keys.has(`${k.slice(0, -"_one".length)}_other`));
    expect(missing).toEqual([]);
  });
});

describe("knowledge index bundle has no duplicate keys", () => {
  it.each([
    ["en", indexEnRaw],
    ["zh-TW", indexZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});
