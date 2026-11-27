import i18n from "@/i18n";
import en from "./notifications.en.json";
import zhTW from "./notifications.zh-TW.json";

// Lazy bundle for the bell's notification list: import only from modules behind `components/notifications/NotificationsLazy.tsx`
// (scripts/check-bundle-size.mjs fails when its marker reaches the entry). The bell button's own strings stay in the main JSON as `notificationBell.*`.
// addResourceBundle mutates the main JSON module objects (i18next doesn't clone resources), so tests read the main JSON via `?raw`.
// `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const NOTIFICATIONS_STRINGS_READY = true;
