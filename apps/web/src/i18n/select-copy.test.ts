import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/select-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import selectEn from "./select.en.json";
import selectZhTW from "./select.zh-TW.json";
import selectEnRaw from "./select.en.json?raw";
import selectZhTWRaw from "./select.zh-TW.json?raw";

/**
 * #181 PR-2c 一般 tab 選取模式的 lazy 字串包（`select.*`，只由 SelectLazy 鏈經 `select-strings.ts` 註冊）。
 * 主 JSON 的 parity（`index.test.ts`）不涵蓋這兩檔，所以 parity、逐字、與主檔不重疊、無重複鍵都在這裡。
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

describe("SC1 select 包：兩語系鍵集合相同、頂層只有 select", () => {
  it("鍵集合相同", () => {
    expect(flattenKeys(selectZhTW).sort()).toEqual(flattenKeys(selectEn).sort());
  });

  it("頂層恰一個鍵 select", () => {
    expect(Object.keys(selectEn)).toEqual(["select"]);
    expect(Object.keys(selectZhTW)).toEqual(["select"]);
  });
});

describe("SC2 spec §6.11／§6.12 字面（zh-TW）", () => {
  const SPEC_COPY: Record<string, string> = {
    "select.selected_other": "已選 {{count}} 項",
    "select.moveTo": "移動到",
    "select.copyTo": "複製到",
    "select.deleteSelected_other": "刪除選取的 {{count}} 項",
    "select.trashed_other": "已移到垃圾桶 {{count}} 篇",
  };
  for (const [key, text] of Object.entries(SPEC_COPY)) {
    it(key, () => expect(get(selectZhTW, key)).toBe(text));
  }
});

/** 資料夾 spec §6.10、§6.16 的逐字字串（PR-3b-2 T5；zh-TW 的 `_one`／`_other` 同字）。 */
const FOLDER_SPEC_ZH: Record<string, string> = {
  acrossGroups: "選取的筆記分屬不同群組，無法一起移動",
  foldersOnlyWithinSpace: "資料夾只能在同一個空間內移動",
  foldersCantCopy: "資料夾不能複製",
  deleteFoldersTitle_one: "刪除 {{count}} 個資料夾？",
  deleteFoldersTitle_other: "刪除 {{count}} 個資料夾？",
  deleteFoldersBody_one: "這些資料夾與其中的子資料夾會刪除，{{count}} 篇筆記會移到垃圾桶。",
  deleteFoldersBody_other: "這些資料夾與其中的子資料夾會刪除，{{count}} 篇筆記會移到垃圾桶。",
  deleteFoldersAlsoNotes_one: "另外 {{count}} 篇選取的筆記也會移到垃圾桶。",
  deleteFoldersAlsoNotes_other: "另外 {{count}} 篇選取的筆記也會移到垃圾桶。",
  removeFoldersTitle_one: "移除 {{count}} 個資料夾？",
  removeFoldersTitle_other: "移除 {{count}} 個資料夾？",
  removeFoldersBody: "資料夾會移除，裡面的共享筆記回到最上層，不會刪除任何筆記。",
  foldersBlockedSuffix_one: "，{{count}} 個資料夾沒有刪除（裡面有你不能刪除的筆記）",
  foldersBlockedSuffix_other: "，{{count}} 個資料夾沒有刪除（裡面有你不能刪除的筆記）",
  foldersGoneSuffix_one: "，{{count}} 個資料夾已不存在",
  foldersGoneSuffix_other: "，{{count}} 個資料夾已不存在",
};

const FOLDER_SPEC_EN: Record<string, string> = {
  acrossGroups: "The selected notes are in different groups and can't be moved together",
  foldersOnlyWithinSpace: "Folders can only move within the same space",
  foldersCantCopy: "Folders can't be copied",
  deleteFoldersTitle_one: "Delete 1 folder?",
  deleteFoldersTitle_other: "Delete {{count}} folders?",
  deleteFoldersBody_one: "These folders and their subfolders will be deleted, and 1 note will move to the trash.",
  deleteFoldersBody_other: "These folders and their subfolders will be deleted, and {{count}} notes will move to the trash.",
  deleteFoldersAlsoNotes_one: "The 1 selected note will also move to the trash.",
  deleteFoldersAlsoNotes_other: "The {{count}} selected notes will also move to the trash.",
  removeFoldersTitle_one: "Remove 1 folder?",
  removeFoldersTitle_other: "Remove {{count}} folders?",
  removeFoldersBody: "The folders will be removed and their shared notes moved back to the top level. No notes are deleted.",
  foldersBlockedSuffix_one: ", 1 folder wasn't deleted (it holds notes you can't delete)",
  foldersBlockedSuffix_other: ", {{count}} folders weren't deleted (they hold notes you can't delete)",
  foldersGoneSuffix_one: ", 1 folder no longer exists",
  foldersGoneSuffix_other: ", {{count}} folders no longer exist",
};

describe("SC7 資料夾 spec 逐字（PR-3b-2）", () => {
  it.each(Object.entries(FOLDER_SPEC_ZH))("zh-TW select.%s", (key, text) => {
    expect(get(selectZhTW, `select.${key}`)).toBe(text);
  });

  it.each(Object.entries(FOLDER_SPEC_EN))("en select.%s", (key, text) => {
    expect(get(selectEn, `select.${key}`)).toBe(text);
  });
});

// 讀原始文字：deep merge 的 addResourceBundle 會把 select 併進 i18n 初始化時那份主 JSON 物件（同一個 import），
// 所以 import 進來的主 JSON 在 select-strings 載入後已帶 select 鍵。
describe("SC3 主 JSON 沒有 select 頂層鍵（字串只進 lazy 包）", () => {
  it.each([
    ["en", enRaw],
    ["zh-TW", zhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(Object.keys(JSON.parse(raw) as object)).not.toContain("select");
  });
});

describe("SC4 註冊後可用、不覆寫主檔", () => {
  it("select.selected：en「3 selected」、zh-TW「已選 3 項」", () => {
    expect(i18n.t("select.selected", { count: 3, lng: "en" })).toBe("3 selected");
    expect(i18n.t("select.selected", { count: 3, lng: "zh-TW" })).toBe("已選 3 項");
  });

  it("trash.select 仍是 Select", () => {
    expect(i18n.t("trash.select", { lng: "en" })).toBe("Select");
  });
});

describe("SC5 select 包沒有重複鍵", () => {
  it.each([
    ["en", selectEnRaw],
    ["zh-TW", selectZhTWRaw],
  ] as const)("%s", (_name, raw) => {
    expect(duplicateKeys(raw)).toEqual([]);
  });
});

describe("SC6 每個 _one 都有 _other", () => {
  it.each([
    ["en", selectEn],
    ["zh-TW", selectZhTW],
  ] as const)("%s", (_name, resource) => {
    const keys = new Set(flattenKeys(resource));
    const missing = [...keys].filter((k) => k.endsWith("_one") && !keys.has(`${k.slice(0, -"_one".length)}_other`));
    expect(missing).toEqual([]);
  });
});
