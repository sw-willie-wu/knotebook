/**
 * 卡面樣式的單一出處（#81）：`AppShell` 側欄卡、`NoteEditor` 內文卡、`NotePage` 佔位卡、`HomePage`／
 * `NotePageFallback`／`ErrorBoundary` 的全寬內文卡，以及 `ManagementShell`／`VersionsPanel`／
 * `VersionsLazyBoundary`——這 9 個檔 11 處視覺上是同一款卡片
 * （圓角＋邊框＋卡片底色），過去各自手抄同一串 class 字面量。改卡片語彙（圓角
 * 大小、邊框、底色）只需要動這裡；呼叫端一律 `cn(cardSurface, "<其餘 class>")`。
 *
 * 選常數而非元件：這些呼叫處橫跨 `<aside>`/`<div>`，各自掛著佈局用 class，
 * 元件化要嘛引入 `asChild`、要嘛改變 DOM 形狀——兩者都會動到既有的 layout
 * 測試（斷言 tag／class 鏈）。常數是零 DOM 變更的單一真相。
 */
export const cardSurface = "rounded-xl border border-border bg-card";
