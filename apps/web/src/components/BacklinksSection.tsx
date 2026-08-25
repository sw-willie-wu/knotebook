import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath } from "@knotebook/shared";
import { useBacklinks } from "@/api/notes";

/**
 * 內文卡頁尾——「N 篇筆記提到本頁」（spec §12.3 UI，PR2 F 節改版）。掛在
 * `NoteEditor` 的 `footerSlot`（由 `NotePage` 組裝），讀 Task 6a 的
 * `GET /api/notes/:id/backlinks`（經 `useBacklinks`，React Query 開啟筆記時
 * fetch + 預設 focus refetch）。
 *
 * 0 篇：整塊隱藏（含 loading/error 態——沒有反向連結可看時，不值得為這個次要
 * 區塊額外佔用畫面空間或噴錯誤訊息；本頁主體已經有自己的 loading/error 顯示）。
 *
 * PR2：原本折疊的 `<details>/<summary>`（預設收合、要點開才看得到）改成**常駐、
 * 低高度的 chips 列**——backlinks 通常不多、常駐顯示的成本比「藏起來要多一次點擊
 * 才看得到」低，且跟內文卡整體的卡片感一致。chips 容器（`flex flex-wrap gap-2`）
 * 本身帶 `max-h-48 overflow-y-auto`：篇數多（上限 MAX_BACKLINKS=200）時這個容器
 * 自己捲動，不會把內文卡撐高（比照改版前掛在 `<ul>` 上的等效寫法）。
 */
export function BacklinksSection({ noteId }: { noteId: string | undefined }) {
  const { t } = useTranslation();
  const backlinksQuery = useBacklinks(noteId);
  const backlinks = backlinksQuery.data;

  if (!backlinks || backlinks.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-border px-5 py-3 text-sm">
      <p className="mb-2 font-medium text-muted-foreground">
        {t("note.backlinks.title", { count: backlinks.length })}
      </p>
      <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
        {backlinks.map((backlink) => (
          <Link
            key={backlink.id}
            to={canonicalNotePath(backlink)}
            className="rounded-full bg-accent/60 px-3 py-1 text-xs hover:bg-accent"
          >
            {backlink.title}
          </Link>
        ))}
      </div>
    </div>
  );
}
