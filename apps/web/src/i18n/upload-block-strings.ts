import i18n from "@/i18n";
import en from "./upload-block.en.json";
import zhTW from "./upload-block.zh-TW.json";

// Lazy bundle for upload states drawn inside note blocks and the file panel: import only from note-chunk modules
// (scripts/check-bundle-size.mjs fails when its marker reaches the entry). Tests read the main JSON via `?raw`.
// `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
