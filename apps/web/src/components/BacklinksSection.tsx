import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath } from "@knotebook/shared";
import { useBacklinks } from "@/api/notes";
import { SIDEBAR_ROW_HEIGHT } from "@/components/ui/rows";
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
 * 捲軸只在溢出時出現，那 10px 會從容器底部吃掉，把 chips 往上頂約 5px——也就是
 * 恰恰在「很多筆記」這個主場景，chips 與左邊的標籤就不在同一條光學中線上。
 * 軌道本身是透明的（見 index.css 的滾動條區塊），所以沒溢出時只是留白、看不到
 * 空軌道。改回 `-auto` 會讓對齊隨篇數跳動。
 *
 * chips 容器的 `mt-2.5`（=10px＝滾動條高度）是**對齊補償**：捲軸從容器底部吃掉
 * 10px，chips 的可視中心因此比列中心高 5px；補一個等高的上邊距把 chips 推回來，
 * 就與標籤落在同一條光學中線上。
 *
 * **補償一定要做在 chips 這一側，不能改成標籤 `mb-2.5`**：那樣是把「標籤＋chips」
 * 整組往上拉 5px，於是整條 backlinks 列與側欄帳號列的內容不再共線（`ui/rows.ts`
 * 的等高守衛只看盒高，抓不到），而且 0 筆時捲軸根本不存在、標籤卻照樣偏上——
 * 這兩點在 PR #90 的審查實測中都出現過。放在容器上則天然只影響有 chips 的情況。
 *
 * 副作用：補償後 chips 容器的 margin box（10＋24＋10＝44px）高於列高 36px，下緣
 * 會超出列約 4px，落進 footer 的 `py-2` 裡（實測不裁切、距卡片底緣 5px）——別給
 * 這一列加 `overflow-hidden`，也別收掉 `py-2`，否則捲軸會被裁掉。
 *
 * 這個值與 `index.css` 的 `::-webkit-scrollbar { height: 10px }` 綁定，改捲軸粗細
 * 要一起改（`BacklinksSection.test.tsx` 的守衛案把兩邊釘在一起）。已知殘差：
 * Firefox 的 `scrollbar-width: thin` 是 8px 不是 10px（實測差 1px，肉眼無感）；
 * overlay 捲軸環境（iOS/Android、macOS Firefox 設「捲動時才顯示」）gutter 為 0，
 * chips 會低 5px——桌機瀏覽器因為本專案對所有捲動區都套了 `::-webkit-scrollbar`
 * 樣式而一律走非 overlay，故以桌機為準做這個補償。
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
          <div className="mt-2.5 flex min-w-0 flex-1 gap-2 overflow-x-scroll">
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
