import i18n from "@/i18n";
import en from "./comment-toolbar.en.json";
import zhTW from "./comment-toolbar.zh-TW.json";

// The selection toolbars' Comment button lives in the NotePage chunk, where the comments panel pack must not be (scripts/check-bundle-size.mjs),
// and the entry chunk has no room to spare; so this one string has its own pack. `true, false`: deep merge, never overwriting main keys.
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
export const COMMENT_TOOLBAR_STRINGS_READY = true;
