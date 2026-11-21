import i18n from "@/i18n";
import en from "./knowledge.en.json";
import zhTW from "./knowledge.zh-TW.json";

// Lazy bundle: never import from an entry-bundle file. addResourceBundle mutates the main JSON module objects
// (i18next doesn't clone resources), so tests read the main JSON via `?raw`.
// `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const KNOWLEDGE_STRINGS_READY = true;
