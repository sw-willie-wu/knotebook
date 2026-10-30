import i18n from "@/i18n";
import en from "./select.en.json";
import zhTW from "./select.zh-TW.json";

/**
 * PR-2c 一般 tab 選取模式的字串（首包上限，讀碼發現 2／3）：只由 SelectLazy 鏈 import，模組頂層註冊一次（冪等；
 * deep merge、不覆寫主檔既有鍵）。⚠ 不准從首包任何檔 import（scripts/check-bundle-size.mjs 的 SELECT_I18N_MARKER 會紅）。
 * 資料夾（PR-3b）的選取／目的地字串也在這兩檔。
 * ⚠ i18next 的 store 直接引用 init 傳入的 `resources`（不 clone）：註冊後 `@/i18n` 的 `resources` 與主 JSON 的 module 物件
 * （`import en from "./en.json"`）也帶 `select` 子樹。測試要檢查主檔內容一律讀 `?raw`（見 select-copy.test.ts SC3）。
 */
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const SELECT_STRINGS_READY = true;
