import { Suspense, type ReactNode } from "react";
import { ChunkLoadBeacon, LazyRouteErrorBoundary } from "@/components/ErrorBoundary";

/**
 * 側欄 lazy chunk 的掛載點都包這一層（比照 `VersionsLazyBoundary`）：`chunk="trash"` 是 `TrashLazy` 的兩個掛載點（AppShell 的 tabpanel、
 * SidebarFooter），`chunk="select"` 是一般 tab 選取模式的 `SelectLazy`，`chunk="folder"` 是資料夾對話框的 `FolderLazy`。不包的話 chunk 載入失敗會一路冒到 `AppErrorBoundary`、整個 app
 * 換成崩潰畫面：首頁沒有 route boundary；筆記頁的 route boundary 的載入／錯誤畫面本身含 AppShell，掛載點又渲染一次、又 throw
 * （垃圾桶：tab 有持久化，壞部署時每次載入都崩；選取：選取狀態不持久化，但同一次載入裡整個 app 照樣崩）。
 * 額度別名＝`chunk`（各 chunk 各自一份）、`frame="inline"`：只在原位顯示 #66 的錯誤＋重試。同一個 chunk 的掛載點 `import()` 同一個模組，
 * 任一成功後其餘不會再以 chunk 錯誤失敗，滿足 ErrorBoundary.tsx 的收斂前提。
 * ⚠ `ChunkLoadBeacon` 必須在 `<Suspense>` **內**（見 ErrorBoundary.tsx 的 ChunkLoadBeacon 註解）。
 */
export function SidebarLazyBoundary({
  chunk,
  fallback,
  errorClassName,
  children,
}: {
  chunk: "trash" | "select" | "folder";
  fallback: ReactNode;
  /** 只在錯誤態套用的外框（見 `LazyRouteErrorBoundary` 的 `inlineErrorClassName`）。 */
  errorClassName?: string;
  children: ReactNode;
}) {
  return (
    <LazyRouteErrorBoundary resetKey={undefined} chunk={chunk} frame="inline" inlineErrorClassName={errorClassName}>
      <Suspense fallback={fallback}>
        <ChunkLoadBeacon chunk={chunk} />
        {children}
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}
