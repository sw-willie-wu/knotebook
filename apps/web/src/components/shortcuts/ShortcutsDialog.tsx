import { lazy, Suspense, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { X } from "@/components/ui/icons";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { managementTray } from "@/components/management/tray";
import { cn } from "@/lib/utils";

/**
 * 內容（清單、字串、鍵面）在 lazy chunk，第一次打開才下載（plan K7）；外殼（這個檔）在首包，只有對話框骨架。
 * `ShortcutsLazy` 模組頂層註冊字串包——別從首包任何地方 import 它（scripts/check-bundle-size.mjs 會紅）。
 */
const ShortcutsContent = lazy(() => import("@/components/shortcuts/ShortcutsLazy").then((m) => ({ default: m.ShortcutsContent })));

/**
 * 快捷鍵介紹頁的對話框外殼（Ctrl+/ 或使用者選單「快捷鍵介紹」；開關 state 與監聽器在 `AppShell`，K1）。
 * 沿用管理面板的托盤＋單張卡（spec §4.1，無左欄）。
 *
 * 焦點（K11）：
 * - 開啟：聚焦內容捲動容器（`onOpenAutoFocus` preventDefault 後自己 focus）。內容純靜態、沒有可聚焦元素，焦點若在標題列的 ✕，
 *   方向鍵／PageDown 捲不到內容；Safari 也不會自動讓可捲動容器可聚焦，所以容器 `tabIndex={0}`（先例：AppShell 的 tabpanel）。
 * - 關閉：沒有 `DialogTrigger` 的受控 Dialog，Radix 關閉時不還焦點、落在 body——所以 `onCloseAutoFocus` preventDefault 後
 *   聚焦 `returnFocusRef`（鍵盤開的＝開啟當下的焦點元素；選單開的＝UserMenu 的觸發鈕）。
 * - ⚠ `DialogTitle` 不得傳 `id`：Radix 的 Title 是 `{ id: context.titleId, ...props }`，傳了會蓋掉 context 的 id，
 *   Content 的 `aria-labelledby` 仍指 `context.titleId` → 對話框沒有名稱。region 的名稱因此用 `aria-label`。
 *
 * ⚠ `ChunkLoadBeacon` 必須在 `<Suspense>` 內（擺放不變量見 ErrorBoundary.tsx）。卡面一律 `cn(cardSurface, …)`（card.guard.test.ts）。
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="panel"
        className="md:w-[min(46rem,92vw)]"
        data-shortcuts-dialog=""
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const el = returnFocusRef.current;
          returnFocusRef.current = null;
          if (el?.isConnected) el.focus();
        }}
      >
        <div className={managementTray}>
          <div className={cn(cardSurface, "relative flex min-w-0 flex-1 flex-col overflow-hidden")}>
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-5">
              <DialogTitle className="truncate text-[15px] font-semibold leading-tight tracking-normal">{t("shortcuts.title")}</DialogTitle>
              <DialogDescription className="sr-only">{t("shortcuts.description")}</DialogDescription>
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t("management.close")}>
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DialogClose>
            </div>
            <div
              ref={contentRef}
              data-shortcuts-content=""
              role="region"
              aria-label={t("shortcuts.title")}
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-8"
            >
              <LazyRouteErrorBoundary resetKey={undefined} chunk="shortcuts" frame="inline">
                <Suspense fallback={<LazyRouteLoading frame="inline" />}>
                  <ChunkLoadBeacon chunk="shortcuts" />
                  <ShortcutsContent />
                </Suspense>
              </LazyRouteErrorBoundary>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
