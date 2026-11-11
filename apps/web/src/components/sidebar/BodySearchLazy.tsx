/**
 * 側欄搜尋「內文符合」區的 lazy 模組唯一入口（#93，新功能預設 lazy，`scripts/check-bundle-size.mjs`）：
 * `BodySearchResults`（連同查詢 hook `api/search.ts`、片段處理、點擊處理）只在搜尋字過了 `bodySearchGate`（至少 2 個字、不超過 200）時才下載。
 * **只准用 `lazy(() => import("@/components/sidebar/BodySearchLazy"))` 引用**——靜態 import 會把整個內文區併回首包。
 * 呼叫端只有 `SearchResults`（靜態卡與抽屜兩份 `SidebarContent` 各掛一份），掛載點包 `SidebarLazyBoundary chunk="bodySearch"`。
 * 防抖與 gate 留在首包（`SearchResults` 算好 `debounced` 當 prop 傳進來）：lazy 元件掛掛卸卸都不會重發請求。
 * 已知代價（接受）：
 * ① React 19 的 Suspense fallback 一旦顯示至少停 300 ms；chunk 下載與首包裡的 300 ms 防抖同時進行（掛不掛看當下的字、發不發看
 *   `debounced`），第一次搜內文時體感不加。
 * ② chunk 載入失敗時 `LazyRouteErrorBoundary` 會自動整頁 reload 一次（`ErrorBoundary.tsx`），打到一半的搜尋字會消失——比照
 *   `select`／`folder` 接受。
 */
export { BodySearchResults } from "./BodySearchResults";
