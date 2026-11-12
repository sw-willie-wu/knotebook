/**
 * 說明視窗「這一版新增」頁的登記檔：列出這一版比上一版多了什麼。
 *
 * 這個檔不 import 任何模組：說明視窗的 chunk 會讀它，不能因此把別的 chunk 的程式帶進來。
 *
 * - 帶來新功能的 PR：在 `items` 加條目（`id`），雙語字串加進 `i18n/shortcuts.*.json`
 *   的 `helpGuide.whatsNew.items.<id>.title`／`.desc`。`version` 還是上一個已發布版本時，
 *   順手改成下一版，並拿掉上一版的條目（對應的中英字串也要一起刪，否則殘留字串的守衛會紅）。
 * - 只有站台管理員用得到的功能，條目標 `adminOnly: true`：一般使用者的頁面不列它（用 `visibleHighlightItems` 過濾）。
 * - 發版：改這裡——確認 `version` 等於這次的版本、刪掉不想列的條目（連同 `i18n/shortcuts.*.json` 的
 *   `helpGuide.whatsNew.items.<id>` 一起刪）；這一版沒有就清空 `items`，
 *   頁面只顯示「這一版沒有要特別介紹的新功能。」
 * - 頁面標題的「vX.Y.Z 新增」取這裡的 `version`，不取 app 版本：兩次發版之間 app 版本仍是上一版，
 *   用它會把還沒發布的功能標成舊版。`release-highlights.guard.test.ts` 擋 `version` 低於 `apps/web/package.json`。
 */
export interface HighlightItem {
  id: string;
  /** 只給站台管理員看。省略等於 false。 */
  adminOnly?: boolean;
}

export interface ReleaseHighlights {
  version: string;
  items: readonly HighlightItem[];
}

export const RELEASE_HIGHLIGHTS: ReleaseHighlights = {
  version: "0.16.0",
  items: [
    { id: "favorites" },
    { id: "customColors" },
    { id: "sideBySideColumns" },
    { id: "installApp" },
    { id: "confirmRemoveMember" },
    { id: "helpAndTour" },
    { id: "siteLimits", adminOnly: true },
  ],
};

/** 這位使用者看得到的條目：一般使用者看不到 `adminOnly` 的，站台管理員全部看得到。保留原順序。 */
export function visibleHighlightItems(items: readonly HighlightItem[], isSiteAdmin: boolean): HighlightItem[] {
  return items.filter((item) => isSiteAdmin || item.adminOnly !== true);
}
