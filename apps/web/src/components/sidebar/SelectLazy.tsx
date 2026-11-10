/**
 * 一般 tab 選取模式的 lazy 模組唯一入口（首包上限）：NoteList 的標題列／清單、SidebarFooter 的動作列共用這一個 chunk。
 * **只准用 `lazy(() => import("@/components/sidebar/SelectLazy"))` 引用。**
 */
import "@/i18n/select-strings";
export { SelectHeader } from "./SelectHeader";
export { SelectableTree } from "./SelectableTree";
export { SelectActionBar } from "./SelectActionBar";
