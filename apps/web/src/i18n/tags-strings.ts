import i18n from "@/i18n";
import en from "./tags.en.json";
import zhTW from "./tags.zh-TW.json";

// Lazy bundle for the tag management page (an entry-bundle import fails scripts/check-bundle-size.mjs). Only `tags.manage.nav` stays in the main
// JSON because the settings and group navigation render it. addResourceBundle mutates the main JSON module objects (i18next doesn't clone
// resources), so tests read the main JSON via `?raw`. `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const TAGS_STRINGS_READY = true;
