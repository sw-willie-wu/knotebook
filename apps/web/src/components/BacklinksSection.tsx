import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath } from "@knotebook/shared";
import { useBacklinks } from "@/api/notes";
import { BACKLINKS_SCROLL_ROW, SIDEBAR_ROW_HEIGHT } from "@/components/ui/rows";
import { cn } from "@/lib/utils";

/**
 * 內文卡頁尾——「N 篇筆記提及」＋來源 chips（spec §12.3 UI）。掛在
 * `NoteEditor` 的 `footerSlot`（由 `NotePage` 組裝），讀 Task 6a 的
 * `GET /api/notes/:id/backlinks`（經 `useBacklinks`，React Query 開啟筆記時
 * fetch + 預設 focus refetch）。
 *
 * 版面（**單排**）：標籤與 chips 同一列，chips 不換行、多到放不下時**水平捲動**
 * ——內文卡的高度因此完全不受 backlinks 篇數影響（上限 MAX_BACKLINKS=200）。
 * 列高用 `SIDEBAR_ROW_HEIGHT`，與側欄底部的帳號列等高（見該常數註解）。
 *
 * chips 容器用 `overflow-x-scroll` 而非 `-auto`：**捲軸一律佔位**。`-auto` 之下
 * 捲軸只在溢出時出現，chips 的垂直位置就會隨「這篇有幾筆」跳動。軌道本身是透明的
 * （見 index.css 的滾動條區塊），沒溢出時只是留白、看不到空軌道。
 *
 * **捲軸幾何**走 `ui/rows.ts` 的 `BACKLINKS_SCROLL_ROW`（容器高＝列高＋捲軸、負
 * 邊距把 margin box 拉回列高、strip 專用的 6px 捲軸與 1px thumb border；四個值
 * 互相咬合，理由與換算寫在該常數的註解）。
 *
 * 這組值算出來的版面（實測，Chromium）：容器與列同高但內容區只有 36−6＝30px，
 * chips 在其中置中 → 與標籤共用同一條光學中線（±0.2px）；捲軸落在列的下緣之外、
 * footer `py-2` 的留白裡，距卡片底 2px、距 chip 底 5.8px。
 *
 * **對齊補償一定要做在 chips 這一側**（早期版本把 `mb-2.5` 加在標籤上）：那是把
 * 「標籤＋chips」整組往上拉，於是整條 backlinks 列與側欄帳號列的內容不再共線
 * （`ui/rows.ts` 的等高守衛只看盒高，抓不到），而且 0 筆、根本沒有捲軸時標籤照樣
 * 偏上——兩點都在 PR #90 的審查實測中出現過。
 *
 * 捲軸落在 `py-2` 的留白裡：**別給這一列加 `overflow-hidden`，也別收掉 `py-2`**，
 * 否則捲軸會被裁掉。已知殘差：Firefox 的 `scrollbar-width: thin` 固定 8px（不吃
 * 上面那條 6px 覆寫），chips 會比標籤低約 1px，肉眼無感；overlay 捲軸環境
 * （iOS/Android、macOS Firefox 設「捲動時才顯示」）gutter 為 0，chips 會低 3px。
 * 桌機瀏覽器因為本專案對所有捲動區都套了 `::-webkit-scrollbar` 樣式而一律走非
 * overlay，故以桌機為準。
 *
 * **區塊常駐**：0 筆也保留這一列並顯示空狀態文案。改版前是 0 筆整塊隱藏，
 * 代價是反向連結這個功能完全沒有存在感（沒被連過的筆記看不出有這回事），
 * 且內文卡高度會隨有無 backlinks 跳動。
 *
 * 查詢未完成（pending）或失敗時**只保留空列、不顯示任何文案**：此時「有幾筆」
 * 未知，寫「尚無筆記提及」會是謊報，噴錯誤訊息則對這個次要區塊太吵
 * （本頁主體已有自己的 loading/error 顯示）。
 */
export function BacklinksSection({ noteId }: { noteId: string | undefined }) {
  const { t } = useTranslation();
  const backlinksQuery = useBacklinks(noteId);
  const backlinks = backlinksQuery.data;
  const settled = backlinks !== undefined;

  return (
    <div className="shrink-0 border-t border-border px-5 py-2 text-sm">
      <div className={cn("flex items-center gap-3", SIDEBAR_ROW_HEIGHT)}>
        {settled && (
          <p className="shrink-0 text-xs font-medium text-muted-foreground">
            {backlinks.length === 0
              ? t("note.backlinks.empty")
              : t("note.backlinks.title", { count: backlinks.length })}
          </p>
        )}
        {settled && backlinks.length > 0 && (
          <div className={cn("flex min-w-0 flex-1 items-center gap-2 overflow-x-scroll", BACKLINKS_SCROLL_ROW)}>
            {backlinks.map((backlink) => (
              <Link
                key={backlink.id}
                to={canonicalNotePath(backlink)}
                className="shrink-0 whitespace-nowrap rounded-full bg-accent/60 px-3 py-1 text-xs hover:bg-accent"
              >
                {backlink.title}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
