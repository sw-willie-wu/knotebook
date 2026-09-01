import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOnline } from "./ErrorBoundary";
import { Button } from "./ui/button";
import { cardSurface } from "./ui/card";
import { cn } from "@/lib/utils";

/**
 * `/p/:token` 公開唯讀頁的頁面外殼（#72 Task 3）——fallback／錯誤邊界／頁面本體
 * 共用的單卡版面。
 *
 * **刻意不重用 `NotePageFallback`／`NoteRouteErrorBoundary`**：那兩個都包
 * `AppShell`——會對匿名訪客打 `/api/auth/me`、露出側欄（筆記清單、New note、
 * 搜尋）。公開頁的不變量是「整條路由零 auth 相依」，`App.publicRoute.test.tsx`
 * 用『fetch 從未被呼叫』釘住。
 *
 * 這個模組必須留在 entry bundle（App.tsx 直接 import）：fallback 是在 lazy chunk
 * 還沒到手時渲染的，放進 chunk 自己就成了雞生蛋。
 */

/** 單卡外框：滿版底色置中一張卡（與 AppShell 的 `bg-background p-3` 同款外距語彙）。 */
export function PublicPageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen justify-center overflow-hidden bg-background p-3">
      <div className={cn(cardSurface, "flex min-h-0 w-full max-w-[70rem] flex-col overflow-hidden")}>
        {children}
      </div>
    </div>
  );
}

/** chunk 載入中的極簡 loading 卡（文案沿用 `app.loading`，與頁面本體的資料載入態同款）。 */
export function PublicNoteFallback() {
  const { t } = useTranslation();
  return (
    <PublicPageFrame>
      <p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>
    </PublicPageFrame>
  );
}

interface PublicNoteErrorBoundaryProps {
  /** 測試 seam（比照 `NoteRouteErrorBoundary`）：jsdom 下 `location.reload` 是
   * non-configurable、spy 不進去，只能注入。 */
  reload?: () => void;
  children: ReactNode;
}

function defaultReload() {
  location.reload();
}

/**
 * 公開頁的錯誤邊界：chunk 載入失敗與頁面 render 錯誤（含 `decodePublicYdoc` 對毀損
 * payload 的 throw）都落進來。**沒有自動 reload、沒有 ChunkLoadBeacon**——那套
 * sessionStorage 旗標額度機制是 NotePage 專屬（`knotebook:chunk-reload:notepage`），
 * 公開頁一顆手動重試鈕（整頁 reload）就夠：匿名訪客沒有未儲存狀態，reload 零代價，
 * 也不必為單一頁面再開第二套旗標的失效模式（隱私模式寫不進、清除時序…）。
 */
export class PublicNoteErrorBoundary extends Component<PublicNoteErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  private handleRetry = () => {
    (this.props.reload ?? defaultReload)();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return <PublicNoteErrorFallback onRetry={this.handleRetry} />;
  }
}

function PublicNoteErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  // 離線時 reload 只會把頁面換成瀏覽器的網路錯誤頁——比照 ErrorBoundary 的兩個
  // 錯誤畫面，按鈕灰掉並以文字說明，恢復連線（online 事件）即重新啟用。
  const online = useOnline();
  return (
    <PublicPageFrame>
      <div role="alert" className="flex flex-col items-start gap-3 p-6">
        <p className="text-sm text-muted-foreground">{t("public.loadError")}</p>
        <Button type="button" variant="outline" size="sm" disabled={!online} onClick={onRetry}>
          {t("app.retry")}
        </Button>
        {!online && <p className="text-sm text-muted-foreground">{t("app.offlineHint")}</p>}
      </div>
    </PublicPageFrame>
  );
}
