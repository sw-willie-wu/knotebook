import { describe, expect, it } from "vitest";
import zhTW from "./zh-TW.json";
import en from "./en.json";
import groupsAdminZhTW from "./groups-admin.zh-TW.json";
import managementZhTW from "./management.zh-TW.json";

/** Literal version-history copy; since #272 vN -> 「name (short id)」. Changing these strings changes product copy: confirm with the maintainer first. */
const SPEC_COPY: Record<string, string> = {
  "versions.save": "儲存當前版本",
  "versions.dialog.saveTitle": "儲存當前版本",
  "versions.dialog.saveDescription": "以目前內容建立一個新版本。",
  "versions.dialog.nameLabel": "版本名稱（選填）",
  "versions.dialog.applyDescription": "目前有未儲存的修改，套用 {{label}} 會覆蓋它們（也包括其他人尚未存成版本的修改）。",
  "versions.dialog.applyDiscard": "不儲存，直接套用",
  "versions.dialog.applySaveFirst": "儲存當前版本",
  "versions.toast.saved": "已存為 {{label}}",
  "versions.toast.upgraded": "內容與 {{label}} 相同，已將它設為手動版本",
  "versions.toast.applied": "已套用 {{label}}",
  "versions.current.noBase": "沒有基底版本",
  "versions.current.clean": "沿自 {{label}} · 無修改",
  "versions.current.dirty": "沿自 {{label}} · 有未儲存的修改",
  "versions.autoOff": "此空間已關閉自動儲存",
  "versions.from": "沿自 {{label}}",
  "versions.siteOff": "站台已關閉自動儲存",
  "versions.title": "版本歷史",
  "note.menu.versions": "版本歷史",
  "versions.currentLabel": "目前狀態",
  "versions.autoBadge": "自動存檔",
  "versions.filter.all": "全部",
  "versions.filter.manual": "僅手動",
  "versions.filter.emptyManual": "沒有手動儲存的版本",
  "versions.applySeq": "套用 {{label}}",
  "versions.preview.banner": "正在預覽 {{label}}",
  "versions.preview.leftPicker": "左側版本",
  "versions.preview.rightPicker": "右側版本",
  "versions.preview.currentOption": "目前狀態",
  "versions.preview.split": "並排",
  "versions.preview.single": "單欄",
  "versions.preview.onlyChanges": "只看差異",
  "versions.preview.nonTextChanged": "已變更 · 看前後",
  "versions.menu.apply": "套用",
  "versions.menu.rename": "編輯版本名稱",
  "versions.menu.delete": "刪除",
  "settings.account.autoVersions.title": "自動儲存版本",
  "groups.autoVersions.title": "自動儲存版本",
  "versions.sheet.back": "返回",
  "versions.sheet.backToList": "清單",
  // Avoid sharing a name with the comparison target 「前一版」: the bottom navigation buttons do not use 「上一版」 / 「下一版」.
  "versions.sheet.prev": "較舊的版本",
  // Same: avoid sharing a name with the comparison target.
  "versions.sheet.next": "較新的版本",
  "versions.deletedSuffix": "{{label}}（已刪除）",
  "versions.deletedVersion": "已刪除的版本",
};

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("version history copy literals (zh-TW)", () => {
  for (const [key, text] of Object.entries(SPEC_COPY)) {
    // admin.* / settings.* strings are in the lazy bundle (management.*.json), groups.* ones in groups-admin.*.json, the rest in the main file.
    const source = key.startsWith("settings.") || key.startsWith("admin.") ? managementZhTW : key.startsWith("groups.") ? groupsAdminZhTW : zhTW;
    it(key, () => expect(get(source, key)).toBe(text));
  }
});

/** Keys explicitly deleted (the 「前一版」 concept, 「vs 空文件」, the 「比較對象」 label, plain-text column headers) and the keys deleted in #258: neither locale may keep them. */
const REMOVED_KEYS = [
  "versions.preview.compareLabel",
  "versions.preview.comparePrevious",
  "versions.preview.compareCurrent",
  "versions.preview.vsEmpty",
  "versions.preview.leftLabel",
  "versions.preview.rightLabelCurrent",
  "versions.preview.close",
  "versions.kind.manual",
  "versions.kind.auto",
  "versions.baseDot",
  "versions.current.none",
  "versions.current.dirtyLatest",
  "versions.current.dirtyFrom",
];

describe("deleted keys do not remain", () => {
  for (const key of REMOVED_KEYS) {
    it(key, () => {
      expect(get(zhTW, key)).toBeUndefined();
      expect(get(en, key)).toBeUndefined();
    });
  }
});

describe("#272: versions.* no longer has {{seq}} (both locales; the UI does not show vN)", () => {
  const leaves = (o: unknown, path = "versions"): Array<[string, string]> =>
    typeof o === "string" ? [[path, o]] : o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => leaves(v, `${path}.${k}`)) : [];
  for (const [lang, dict] of [["zh-TW", zhTW], ["en", en]] as const) {
    it(lang, () => {
      expect(leaves((dict as Record<string, unknown>).versions).filter(([, v]) => v.includes("{{seq}}"))).toEqual([]);
    });
  }
});
