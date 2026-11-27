import i18n from "@/i18n";
import en from "./groups-admin.en.json";
import zhTW from "./groups-admin.zh-TW.json";

// Lazy bundle for the group settings sections and dialogs (an entry-bundle import fails scripts/check-bundle-size.mjs). Keys rendered by
// entry-chunk components stay in the main JSON. addResourceBundle mutates the
// main JSON module objects (i18next doesn't clone resources), so tests read the main JSON via `?raw`. `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const GROUPS_ADMIN_STRINGS_READY = true;
