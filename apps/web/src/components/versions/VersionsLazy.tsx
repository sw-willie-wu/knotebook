/**
 * 版本歷史 UI 的 lazy 模組唯一入口（起草裁定 2）。**只准用 `lazy(() => import("@/components/versions/VersionsLazy"))` 引用**——
 * 任何靜態 import 都會讓 Rollup 把 `diff` 與整組元件併回 NotePage chunk，`VersionsLazy-<hash>.js` 隨即消失
 * （`scripts/check-bundle-size.mjs` 守著）。
 */
export { VersionsPanel } from "./VersionsPanel";
export { VersionPreview, DiffEditor } from "./VersionPreview";
export { PreviewBanner } from "./PreviewBanner";
