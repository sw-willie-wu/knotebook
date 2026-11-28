import i18n from "@/i18n";
import en from "./upload-precheck.en.json";
import zhTW from "./upload-precheck.zh-TW.json";

// Lazy bundle (an entry-bundle import fails scripts/check-bundle-size.mjs). Tests read the main JSON via `?raw`.
// `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
