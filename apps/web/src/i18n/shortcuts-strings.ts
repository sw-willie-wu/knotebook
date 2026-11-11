import i18n from "@/i18n";
import en from "./shortcuts.en.json";
import zhTW from "./shortcuts.zh-TW.json";

/**
 * 快捷鍵介紹頁（Ctrl+/）的清單字串（首包上限）：只由 ShortcutsLazy 鏈 import，模組頂層註冊一次（冪等；
 * deep merge、不覆寫主檔既有鍵）。⚠ 不准從首包任何檔 import（scripts/check-bundle-size.mjs 的 SHORTCUTS_I18N_MARKER 會紅）。
 * 首包只留 `userMenu.shortcuts`、`shortcuts.title`、`shortcuts.description` 三把鍵（外殼要用）；其餘都在頂層 `shortcutsGuide` 之下。
 * ⚠ i18next 的 store 直接引用 init 傳入的 `resources`（不 clone）：註冊後 `@/i18n` 的 `resources` 與主 JSON 的 module 物件
 * 也帶 `shortcutsGuide` 子樹。測試要檢查主檔內容一律讀 `?raw`（見 shortcuts-copy.test.ts）。
 */
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const SHORTCUTS_STRINGS_READY = true;
