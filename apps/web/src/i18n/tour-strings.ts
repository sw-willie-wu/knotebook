import i18n from "@/i18n";
import en from "./tour.en.json";
import zhTW from "./tour.zh-TW.json";

/**
 * 功能導覽的字串（首包上限）：只由導覽的 lazy 鏈（`components/tour/*`）import，模組頂層註冊一次（冪等；
 * deep merge、不覆寫主檔既有鍵）。⚠ 不准從首包任何檔 import。首包只留使用者選單那一項；其餘都在頂層 `tourGuide` 之下。
 * ⚠ i18next 的 store 直接引用 init 傳入的 `resources`（不 clone）：註冊後 `@/i18n` 的 `resources` 與主 JSON 的 module 物件
 * 也帶 `tourGuide` 子樹。測試要檢查主檔內容一律讀 `?raw`（見 tour-copy.test.ts）。
 */
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const TOUR_STRINGS_READY = true;
