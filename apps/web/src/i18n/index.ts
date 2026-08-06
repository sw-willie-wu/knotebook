import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import zhTW from "./zh-TW.json";

export const LANGUAGE_STORAGE_KEY = "knotebook:lang";

export const resources = {
  en: { translation: en },
  "zh-TW": { translation: zhTW },
} as const;

// 偵測順序：先看 localStorage（使用者先前的選擇），沒有再看瀏覽器語言；
// 偵測/切換後的結果一律快取回 localStorage 同一把 key，下次直接命中。
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    supportedLngs: ["en", "zh-TW"],
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    },
  });

export default i18n;
