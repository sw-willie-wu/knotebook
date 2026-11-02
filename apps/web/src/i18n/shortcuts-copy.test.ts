import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/shortcuts-strings";
import { SHORTCUT_CATEGORIES, SHORTCUTS } from "@/components/shortcuts/shortcut-list";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import guideEn from "./shortcuts.en.json";
import guideZhTW from "./shortcuts.zh-TW.json";
import guideEnRaw from "./shortcuts.en.json?raw";
import guideZhTWRaw from "./shortcuts.zh-TW.json?raw";

/**
 * 快捷鍵介紹頁的 lazy 字串包（`shortcutsGuide.*`，只由 ShortcutsLazy 鏈經 `shortcuts-strings.ts` 註冊）。
 * 主 JSON 的 parity（`index.test.ts`）不涵蓋這兩檔，所以 parity、無重複鍵、與主檔不重疊、與清單對得上都在這裡。
 * 骨架同 select-copy.test.ts。
 */

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

const BUNDLES = [
  ["en", guideEn],
  ["zh-TW", guideZhTW],
] as const;

describe("SH1 兩語系鍵集合相同、頂層只有 shortcutsGuide", () => {
  it("鍵集合相同", () => {
    expect(flattenKeys(guideZhTW).sort()).toEqual(flattenKeys(guideEn).sort());
  });

  it("頂層恰一個鍵 shortcutsGuide", () => {
    expect(Object.keys(guideEn)).toEqual(["shortcutsGuide"]);
    expect(Object.keys(guideZhTW)).toEqual(["shortcutsGuide"]);
  });
});

describe("SH2 包內必備的鍵", () => {
  const REQUIRED = [
    "keys.space",
    "keys.enter",
    "keys.esc",
    "keys.tab",
    "keys.backspace",
    "keys.delete",
    "keys.click",
    "srKeys.command",
    "srKeys.shift",
    "srKeys.option",
    "srKeys.up",
    "srKeys.down",
    "srKeys.left",
    "srKeys.right",
    "srKeys.or",
    "srKeys.pair",
    "footer",
  ];
  it.each(BUNDLES)("%s", (_name, bundle) => {
    for (const key of REQUIRED) {
      const value = get(bundle, `shortcutsGuide.${key}`);
      expect(typeof value, key).toBe("string");
      expect((value as string).length, key).toBeGreaterThan(0);
    }
  });

  it("footer 帶 <keys/> 佔位（給 Trans 用）", () => {
    for (const [, bundle] of BUNDLES) expect(get(bundle, "shortcutsGuide.footer") as string).toContain("<keys/>");
  });
});

describe("SH3 清單與字串對得上", () => {
  it.each(BUNDLES)("%s：每個 SHORTCUTS id 都有 name 與 desc", (_name, bundle) => {
    for (const e of SHORTCUTS) {
      for (const field of ["name", "desc"]) {
        const value = get(bundle, `shortcutsGuide.items.${e.id}.${field}`);
        expect(typeof value === "string" && value.length > 0, `${e.id}.${field}`).toBe(true);
      }
    }
  });

  it.each(BUNDLES)("%s：每個分類都有標題", (_name, bundle) => {
    for (const category of SHORTCUT_CATEGORIES) {
      const value = get(bundle, `shortcutsGuide.categories.${category}`);
      expect(typeof value === "string" && value.length > 0, category).toBe(true);
    }
  });

  it.each(BUNDLES)("%s：反向——字串包 items 底下沒有清單裡不存在的 id（守殘留字串）", (_name, bundle) => {
    const known = new Set(SHORTCUTS.map((e) => e.id));
    const items = get(bundle, "shortcutsGuide.items") as Record<string, unknown>;
    expect(Object.keys(items).filter((id) => !known.has(id))).toEqual([]);
  });

  it.each(BUNDLES)("%s：反向——categories 底下沒有未知的分類", (_name, bundle) => {
    const categories = get(bundle, "shortcutsGuide.categories") as Record<string, unknown>;
    expect(Object.keys(categories).filter((c) => !(SHORTCUT_CATEGORIES as readonly string[]).includes(c))).toEqual([]);
  });
});

// 讀原始文字：deep merge 的 addResourceBundle 會把 shortcutsGuide 併進 i18n 初始化時那份主 JSON 物件（同一個 import），
// 所以 import 進來的主 JSON 在 shortcuts-strings 載入後已帶 shortcutsGuide 鍵。
describe("SH4 主 JSON 沒有 shortcutsGuide 頂層鍵，且與包的頂層鍵不重疊", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    const main = Object.keys(JSON.parse(raw) as object);
    expect(main).not.toContain("shortcutsGuide");
    expect(main.filter((k) => Object.keys(guideEn).includes(k))).toEqual([]);
  });
});

describe("SH5 註冊後可用、不覆寫主檔", () => {
  it("分類標題與主檔的三把鍵", () => {
    expect(i18n.t("shortcutsGuide.categories.typing", { lng: "en" })).toBe("Typing triggers");
    expect(i18n.t("shortcutsGuide.categories.typing", { lng: "zh-TW" })).toBe("打字觸發");
    expect(i18n.t("shortcuts.title", { lng: "en" })).toBe("Keyboard shortcuts");
    expect(i18n.t("shortcuts.title", { lng: "zh-TW" })).toBe("快捷鍵介紹");
    expect(i18n.t("userMenu.shortcuts", { lng: "zh-TW" })).toBe("快捷鍵介紹");
    expect(i18n.t("shortcuts.description", { lng: "zh-TW" })).toBe("常用快捷鍵與打字觸發字");
    expect(i18n.t("userMenu.logout", { lng: "en" })).toBe("Log out");
  });
});

describe("SH6 包沒有重複鍵", () => {
  it.each([
    ["en", guideEnRaw],
    ["zh-TW", guideZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

describe("SH7 分類標題定稿", () => {
  const TITLES: Record<string, { en: string; zh: string }> = {
    global: { en: "General", zh: "通用" },
    typing: { en: "Typing triggers", zh: "打字觸發" },
    markdown: { en: "Markdown shortcuts", zh: "Markdown 速記" },
    formatting: { en: "Text formatting", zh: "文字格式" },
    columns: { en: "Columns", zh: "並排" },
    sidebar: { en: "Sidebar", zh: "側欄" },
    presentation: { en: "Presentation", zh: "簡報模式" },
    ai: { en: "AI", zh: "AI" },
    mouse: { en: "Mouse", zh: "滑鼠操作" },
  };
  for (const [category, { en, zh }] of Object.entries(TITLES)) {
    it(category, () => {
      expect(get(guideEn, `shortcutsGuide.categories.${category}`)).toBe(en);
      expect(get(guideZhTW, `shortcutsGuide.categories.${category}`)).toBe(zh);
    });
  }
});
