import { lazy, Suspense, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { X } from "@/components/ui/icons";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { managementTray } from "@/components/management/tray";
import { cn } from "@/lib/utils";
import type { ShortcutsStartPage } from "@/lib/shortcuts-dialog";

/**
 * 內容（分類清單、字串、鍵面）在 lazy chunk，第一次打開才下載；外殼（這個檔）在首包，只有對話框骨架。
 * `ShortcutsLazy` 模組頂層註冊字串包——別從首包任何地方 import 它（scripts/check-bundle-size.mjs 會紅）。
 */
const ShortcutsContent = lazy(() => import("@/components/shortcuts/ShortcutsLazy").then((m) => ({ default: m.ShortcutsContent })));

/** chunk 下載中與載入失敗時佔住右邊整塊托盤的一張卡（標題、✕、Esc 都在外殼，所以這兩個狀態下對話框一樣關得掉）。 */
const FALLBACK_CARD = cn(cardSurface, "min-w-0 flex-1 overflow-y-auto p-8 pt-12");

/**
 * 說明視窗的對話框外殼（Ctrl+/ 或使用者選單「說明」；開關 state 與監聽器在 `AppShell`）。
 * 版面沿用設定的托盤＋兩張卡（左：功能導覽、這一版新增與快捷鍵分類，右：所選那一頁），兩張卡在 lazy chunk 裡（`ShortcutsLazy`）。
 * 這裡持有的是「不依賴 chunk」的部分：Dialog、sr-only 的標題與描述（對話框的名稱）、✕、托盤、焦點進出。
 *
 * 焦點：
 * - 開啟：聚焦內容區（`onOpenAutoFocus` preventDefault 後自己 focus）；chunk 還沒到時先聚焦對話框本身，內容元件掛上後自己接手。
 *   DOM 順序是 ✕ → 左欄分類 → （窄螢幕的返回鈕）→ 內容區，Radix FocusScope `loop` 讓 Tab 在內容區與 ✕ 之間循環。
 * - 關閉：沒有 `DialogTrigger` 的受控 Dialog，Radix 關閉時不還焦點、落在 body——所以 `onCloseAutoFocus` preventDefault 後
 *   聚焦 `returnFocusRef`（鍵盤開的＝開啟當下的焦點元素；選單開的＝UserMenu 的觸發鈕）。
 * - ⚠ `DialogTitle` 不得傳 `id`：Radix 的 Title 是 `{ id: context.titleId, ...props }`，傳了會蓋掉 context 的 id，
 *   Content 的 `aria-labelledby` 仍指 `context.titleId` → 對話框沒有名稱。
 *
 * ⚠ `ChunkLoadBeacon` 必須在 `<Suspense>` 內（擺放不變量見 ErrorBoundary.tsx）。卡面一律 `cn(cardSurface, …)`（card.guard.test.ts）。
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  returnFocusRef,
  page = "global",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  /** 這一次打開停在哪一頁（內容元件掛上時取用；每次打開重新掛上，打開後不會跟著變）。 */
  page?: ShortcutsStartPage;
}) {
  const { t } = useTranslation();
  // 每次由關到開換一個 key，內容元件重新掛上、起始頁重設：關閉動畫還沒跑完（內容仍掛著）就再打開時也一樣。
  const [wasOpen, setWasOpen] = useState(open);
  const [openCount, setOpenCount] = useState(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenCount((n) => n + 1);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="panel"
        data-shortcuts-dialog=""
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const dialog = event.currentTarget as HTMLElement;
          (dialog.querySelector<HTMLElement>("[data-shortcuts-content]") ?? dialog).focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const el = returnFocusRef.current;
          returnFocusRef.current = null;
          if (el?.isConnected) el.focus();
        }}
      >
        <DialogTitle className="sr-only">{t("shortcuts.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("shortcuts.description")}</DialogDescription>
        <div className={cn(managementTray, "relative")}>
          {/* 唯讀說明頁：不需要設定那種「點外面不關」的保護，✕／Esc／點外面都能關。✕ 在 DOM 最前面（落在托盤右上角）。 */}
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4 z-20 h-7 w-7 bg-card md:right-5 md:top-5"
              aria-label={t("management.close")}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DialogClose>
          <LazyRouteErrorBoundary resetKey={undefined} chunk="shortcuts" frame="inline" inlineErrorClassName={FALLBACK_CARD}>
            <Suspense
              fallback={
                <div className={FALLBACK_CARD}>
                  <LazyRouteLoading frame="inline" />
                </div>
              }
            >
              <ChunkLoadBeacon chunk="shortcuts" />
              <ShortcutsContent key={openCount} startPage={page} onClose={() => onOpenChange(false)} />
            </Suspense>
          </LazyRouteErrorBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}
