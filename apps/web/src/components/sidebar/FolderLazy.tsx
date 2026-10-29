import "@/i18n/folder-strings";

/**
 * 資料夾對話框的唯一 lazy 入口（資料夾 PR-3b-1，首包上限）：只准以 `lazy(() => import("@/components/sidebar/FolderLazy"))` 引用。
 * 字串包 `folders.*.json` 與三個對話框都只經這條鏈進來。
 */
export { FolderDialogs } from "./FolderDialogs";
