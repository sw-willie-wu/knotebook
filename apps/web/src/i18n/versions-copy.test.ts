import { describe, expect, it } from "vitest";
import zhTW from "./zh-TW.json";

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
  "versions.current.none": "尚無版本",
  "versions.current.noBase": "沒有基底版本",
  "versions.current.clean": "＝ v{{seq}}，沒有未儲存的修改",
  "versions.current.dirtyLatest": "v{{seq}} 之後有未儲存的修改",
  "versions.current.dirtyFrom": "從 v{{seq}} 接著改，有未儲存的修改",
  "versions.autoOff": "此空間已關閉自動儲存",
  "versions.from": "從 v{{seq}} 接著改",
  "versions.siteOff": "站台已關閉自動儲存",
  "versions.title": "版本歷史",
  "note.menu.versions": "版本歷史",
  "note.menu.saveVersion": "儲存當前版本",
  // gate r1 M-8：§3.1 D7、§8.3、§8.4 的其餘字面
  "versions.currentLabel": "目前狀態",
  "versions.kind.manual": "手動",
  "versions.kind.auto": "自動",
  "versions.applySeq": "套用 v{{seq}}",
  "versions.preview.banner": "正在預覽 v{{seq}} · {{when}} · {{who}}",
  "versions.preview.compareLabel": "比較對象",
  "versions.preview.comparePrevious": "前一版",
  "versions.preview.compareCurrent": "目前狀態",
  "versions.preview.vsEmpty": "vs 空文件",
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
