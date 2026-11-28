import i18n from "@/i18n";
import en from "./file-preview.en.json";
import zhTW from "./file-preview.zh-TW.json";

// Lazy bundle for the file preview modal: import only from `components/file-preview/FilePreviewDialog.tsx`
// (scripts/check-bundle-size.mjs fails when its marker reaches the entry).
// `true, false`: deep merge, never overwriting main keys (idempotent).
i18n.addResourceBundle("en", "translation", en, true, false);
i18n.addResourceBundle("zh-TW", "translation", zhTW, true, false);
