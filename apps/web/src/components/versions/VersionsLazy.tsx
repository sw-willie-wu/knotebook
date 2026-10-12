/**
 * 版本歷史 UI 的 lazy 模組唯一入口（起草裁定 2）。**只准用 `lazy(() => import("@/components/versions/VersionsLazy"))` 引用**——
 * 任何靜態 import 都會讓 Rollup 把被 import 的元件（及其相依，例如 `diff` 套件）**搬進**呼叫端的 chunk；
 * `VersionsLazy-<hash>.js` 本身仍在（M1 實測），所以守衛不是 chunk 存在性，而是 `scripts/check-bundle-size.mjs` 的
 * `VERSIONS_MARKERS`：非 VersionsLazy 的 chunk 含有這些模組獨有的字串就紅。新增匯出模組時，替它補一個 marker。
 * #263 的 `SelectionAiPreview` 例外：它 import `@/lib/version-diff` 的值，被靜態 import 時 `diff` 套件一起搬家、既有的 `u{2DE}-` marker 就抓得到；i18n 型 marker 只收 `versions.*`（check-bundle-size.test.mjs）。
 */
export { VersionsPanel } from "./VersionsPanel";
export { VersionPreview, DiffEditor } from "./VersionPreview";
export { PreviewBanner } from "./PreviewBanner";
export { VersionsDialogs } from "./VersionsDialogs";
export { VersionsSheet } from "./VersionsSheet";
export { SelectionAiPreview } from "@/components/ai/SelectionAiPreview";
