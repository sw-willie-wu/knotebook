import { useTranslation } from "react-i18next";
import { AppShell } from "./AppShell";
import { cardSurface } from "./ui/card";
import { cn } from "@/lib/utils";

/**
 * NotePage chunk 載入中的 fallback——**必須包 AppShell**（審查抓到的 blocking：裸 <p>
 * 會讓「從首頁點開第一篇筆記」的瞬間整個側欄/選單消失、白頁閃一下再全部長回來——
 * 恰好發生在本改動要優化的路徑上，而 AppShell 的相依全在首包裡，包它零成本）。
 * 內容沿用 NotePage 自己資料載入時的同款樣式與文案（`app.loading`），如此使用者
 * 看到的才真的是同一種「載入中」，分不出是在等 chunk 還是在等資料。
 * `App.test.tsx` 有回歸釘：把 AppShell 拿掉會紅。
 *
 * 抽成獨立模組（issue #66）：ErrorBoundary 的 pending/reloading 畫面也要用同一份
 * ——留在 App.tsx 會形成 App ↔ ErrorBoundary 循環 import，且複製第二份會脫離
 * 上述回歸釘的保護。
 */
export function NotePageFallback() {
  const { t } = useTranslation();
  return (
    <AppShell>
      {/* PR2（G 節）：跟 NotePage/HomePage 同一款佔位/內文卡——main 已無自身捲動，
          overflow-y-auto 掛在卡自己身上。 */}
      <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto")}>
        <p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>
      </div>
    </AppShell>
  );
}
