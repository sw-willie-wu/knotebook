import i18n from "@/i18n";
import en from "./math.en.json";
import zhTW from "./math.zh-TW.json";

// Lazy bundle (an entry-bundle import fails scripts/check-bundle-size.mjs). addResourceBundle mutates the main JSON
// module objects (i18next doesn't clone resources), so tests read the main JSON via `?raw`.
// `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const MATH_STRINGS_READY = true;
