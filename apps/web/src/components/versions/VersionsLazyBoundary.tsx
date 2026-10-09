import { Suspense, type ReactNode } from "react";
import { ChunkLoadBeacon, LazyRouteErrorBoundary } from "@/components/ErrorBoundary";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * `VersionsLazy` 的每個掛載點都包這一層（起草裁定 23）。版本 UI 是 NotePage 底下、render 時才 throw 的巢狀 lazy——
 * 不包的話 chunk 載入失敗會落到 NotePage 的 route boundary、用掉 **notepage** 的自動 reload 額度把整頁重整。
 * 這裡用自己的額度別名 `versions`、`frame="inline"`（只在原位顯示 #66 的錯誤＋重試）。
 * 非 chunk 的 render 錯誤顯示 `versions.crash`（不是 `app.noteCrash`——那會讓人以為整篇筆記壞了，gate r2 M-5）；
 * `errorClassName` 由呼叫端給它所在位置的外框（面板＝卡片、對話框／整頁＝浮在右下的小卡），只在錯誤態套用。
 * ⚠ `ChunkLoadBeacon` 必須在 `<Suspense>` **內**（擺到外面會在 lazy pending 時就清旗標 → 無限重整，見 ErrorBoundary.tsx 的 ChunkLoadBeacon 註解）。
 */
export function VersionsLazyBoundary({
  noteId,
  fallback = null,
  reload,
  errorClassName,
  children,
}: {
  noteId: string | null;
  fallback?: ReactNode;
  reload?: () => void;
  errorClassName?: string;
  children: ReactNode;
}) {
  return (
    <LazyRouteErrorBoundary
      resetKey={noteId ?? undefined}
      chunk="versions"
      frame="inline"
      reload={reload}
      crashMessageKey="versions.crash"
      inlineErrorClassName={errorClassName}
    >
      <Suspense fallback={fallback}>
        <ChunkLoadBeacon chunk="versions" />
        {children}
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}

/** 各掛載點的錯誤外框（gate r2 M-5）。面板：與 VersionsPanel 同位置同寬的卡；對話框與整頁：浮在右下的小卡（不落在版面末端）。 */
export const VERSIONS_ERROR_FRAME = {
  panel: cn(cardSurface, "shrink-0 p-3 md:w-80"),
  inline: "px-5 py-2",
  floating: cn(cardSurface, "fixed inset-x-3 bottom-5 z-50 p-3 shadow-lg md:inset-x-auto md:right-6 md:w-80"),
};
