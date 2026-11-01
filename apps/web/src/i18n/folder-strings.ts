import i18n from "@/i18n";
import en from "./folders.en.json";
import zhTW from "./folders.zh-TW.json";

/**
 * 資料夾對話框的字串（`folderDialogs.*`，資料夾 PR-3b-1）：只由 FolderLazy 鏈與測試 import，模組頂層註冊一次（冪等；deep merge、
 * 不覆寫主檔既有鍵）。⚠ 不准從首包任何檔 import（首包上限）。做法同 `select-strings.ts`（主檔內容的檢查一律讀 `?raw`）。
 */
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const FOLDER_STRINGS_READY = true;
