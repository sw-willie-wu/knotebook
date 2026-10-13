import { describe, expect, it } from "vitest";
import zhTW from "./zh-TW.json";
import en from "./en.json";

/** spec rev 8 §3.1 D7、§8.2–§8.5 的字面（Willie 逐題定案）。改這些字串＝改產品決定，先問 Willie。 */
const SPEC_COPY: Record<string, string> = {
  "versions.save": "儲存當前版本",
  "versions.dialog.saveTitle": "儲存當前版本",
  "versions.dialog.saveDescription": "以目前內容建立版本 v{{seq}}",
  "versions.dialog.nameLabel": "版本名稱（選填）",
  "versions.dialog.applyDescription": "目前有未儲存的修改，套用 v{{seq}} 會覆蓋它們（也包括其他人尚未存成版本的修改）。",
  "versions.dialog.applyDiscard": "不儲存，直接套用",
  "versions.dialog.applySaveFirst": "儲存當前版本",
  "versions.toast.saved": "已存為 v{{seq}}",
  "versions.toast.upgraded": "內容與 v{{seq}} 相同，已將 v{{seq}} 設為手動版本",
  "versions.toast.applied": "已套用 v{{seq}}",
  // #258（Willie 2026-10-11）：「目前狀態」副標只看 baseSeq／dirty；列的來源字樣改「沿自」。
  "versions.current.noBase": "沒有基底版本",
  "versions.current.clean": "沿自 v{{seq}} · 無修改",
  "versions.current.dirty": "沿自 v{{seq}} · 有未儲存的修改",
  "versions.autoOff": "此空間已關閉自動儲存",
  "versions.from": "沿自 v{{seq}}",
  "versions.siteOff": "站台已關閉自動儲存",
  "versions.title": "版本歷史",
  "note.menu.versions": "版本歷史",
  // gate r1 M-8：§3.1 D7、§8.3、§8.4 的其餘字面
  "versions.currentLabel": "目前狀態",
  // #258：只有自動版本的列標「自動存檔」pill；清單加「全部／僅手動」篩選
  "versions.autoBadge": "自動存檔",
  "versions.filter.all": "全部",
  "versions.filter.manual": "僅手動",
  "versions.filter.emptyManual": "沒有手動儲存的版本",
  "versions.applySeq": "套用 v{{seq}}",
  // rev 10（§8.4【rev 10】）：橫幅拿掉時間／editors／「比較對象」標籤；比較對象改左右一對下拉
  "versions.preview.banner": "正在預覽 v{{seq}}",
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
  // Task 11 裁定（避免與比較對象「前一版」同名）：底部導覽鈕不沿用 brief 的「上一版」「下一版」
  "versions.sheet.prev": "較舊的版本",
  // Task 11 裁定（避免與比較對象同名）
  "versions.sheet.next": "較新的版本",
};

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("版本歷史文案＝spec 字面（zh-TW）", () => {
  for (const [key, text] of Object.entries(SPEC_COPY)) {
    it(key, () => expect(get(zhTW, key)).toBe(text));
  }
});

/** spec rev 10 §8.4【rev 10】明列刪除的鍵（「前一版」概念、「vs 空文件」、「比較對象」標籤、純文字欄標頭）與 #258 刪除的鍵：兩個語系都不得殘留。 */
const REMOVED_KEYS = [
  "versions.preview.compareLabel",
  "versions.preview.comparePrevious",
  "versions.preview.compareCurrent",
  "versions.preview.vsEmpty",
  "versions.preview.leftLabel",
  "versions.preview.rightLabelCurrent",
  // Task 19：橫幅不再有 ✕。
  "versions.preview.close",
  // #258：列不再標手動／自動文字、不再有基底綠點；「目前狀態」不再看清單第一筆。
  "versions.kind.manual",
  "versions.kind.auto",
  "versions.baseDot",
  "versions.current.none",
  "versions.current.dirtyLatest",
  "versions.current.dirtyFrom",
];

describe("已刪除的鍵不殘留", () => {
  for (const key of REMOVED_KEYS) {
    it(key, () => {
      expect(get(zhTW, key)).toBeUndefined();
      expect(get(en, key)).toBeUndefined();
    });
  }
});
