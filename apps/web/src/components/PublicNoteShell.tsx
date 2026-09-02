import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOnline } from "./ErrorBoundary";
import { Button } from "./ui/button";

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

/**
 * 滿版外框（user 定案，2026-09-02）：公開唯讀頁直接鋪滿視窗——**無卡面、無圓角、
 * 無 70rem 上限、無 p-3 外距**（原本的「置中一張卡」是 #72 時期的單卡版面，#115
 * 之後與主 app 的滿版卡語彙不一致）。內文行寬仍由 PublicNotePage 內的文章欄常數
 * （ARTICLE_COLUMN）管，這裡只負責把底鋪滿。`flex flex-col`＋`overflow-hidden`
 * 是承重的（別當裝飾拿掉）：內文容器的 `min-h-0 flex-1 overflow-y-auto` 依賴前者，
 * 「頁面本身不得整體捲動」依賴後者——與 AppShell 的高度鏈同款。
 *
 * 底色是 **bg-card 不是 bg-background**（承重）：BlockNote 編輯器的底色
 * light/dark 都耦合到 `--color-card`（index.css 的兩條 `.bn-root[data-color-scheme]`
 * 覆寫——dark 是 PR2 原有、light 是本次把數值巧合升級成的耦合；主 app 裡編輯器
 * 坐在內文卡上）——公開頁底若用更深的 bg-background，文章欄寬的卡色長條會浮在
 * 頁底上、看起來仍像一張內文卡（user 第二次回報的形）。整頁同卡色＝編輯器天然
 * 融入。不選 per-page 覆寫 bn 變數的理由是成本：那要 light＋dark 兩條新規則＋
 * 新錨點 class，還會讓編輯器底色離開 --color-card、牽動 BlockNote 以它為基底的
 * 內建 color-mix——換一個 token 的改動不划算。
 */
export function PublicPageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-card">
      {children}
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
