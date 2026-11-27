import i18n from "@/i18n";
import en from "./comments.en.json";
import zhTW from "./comments.zh-TW.json";

// Lazy bundle for the comments panel: import only from modules behind `components/comments/CommentsLazy.tsx` (scripts/check-bundle-size.mjs
// fails when its marker reaches the entry or NotePage chunk). The ⋮ item and the bubble's name stay in the main JSON as `note.menu.comments`.
// addResourceBundle mutates the main JSON module objects (i18next doesn't clone resources), so tests read the main JSON via `?raw`.
// `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const COMMENTS_STRINGS_READY = true;
