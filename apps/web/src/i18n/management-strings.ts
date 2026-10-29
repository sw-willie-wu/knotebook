import i18n from "@/i18n";
import en from "./management.en.json";
import zhTW from "./management.zh-TW.json";

/**
 * 站台管理（`admin.*`）與設定（`settings.*`）的 lazy 字串包（首包瘦身）：設定各區塊、站台管理各區塊、群組儲存區、
 * SettingsTable、授權頁的 ScopeChecksField 等 lazy 鏈各自 import 本檔，模組頂層註冊一次（冪等；deep merge、不覆寫主檔既有鍵）。
 * 主檔 `en.json`／`zh-TW.json` 只留首包就會用到的 15 個鍵：`admin.nav.{label,users,groups,storage,ai,auth}`（AdminModal）、
 * `settings.{entry,title,description}`、`settings.nav.{account,login,authorization,groups,storage,about}`（UserMenu、SettingsModal）。
 * ⚠ 不准從首包任何檔 import（scripts/check-bundle-size.mjs 的 MANAGEMENT_I18N_MARKERS 會紅）。
 * ⚠ 每個用到被搬走鍵的非測試檔都要自己 import 本檔（不靠某個「錨點」模組帶進來——使用者可以不開設定直達 AuthorizePage 等頁）；
 * management-copy.test.ts 的 MC7 掃原始碼把關。新增 `admin.*`／`settings.*` 鍵一律加在 management.*.json，除非首包要用。
 * ⚠ i18next 的 store 直接引用 init 傳入的 `resources`（不 clone）：註冊後主 JSON 的 module 物件也帶 admin／settings 的整包子樹。
 * 測試要檢查主檔內容一律讀 `?raw`（見 management-copy.test.ts MC3）。
 */
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const MANAGEMENT_STRINGS_READY = true;
