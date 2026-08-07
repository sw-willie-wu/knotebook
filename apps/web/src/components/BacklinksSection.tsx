import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath } from "@knotebook/shared";
import { useBacklinks } from "@/api/notes";

/**
 * 頁尾折疊區塊——「N 篇筆記提到本頁」（spec §12.3 UI）。掛在 `NotePage` 底部，
 * 讀 Task 6a 的 `GET /api/notes/:id/backlinks`（經 `useBacklinks`，React Query
 * 開啟筆記時 fetch + 預設 focus refetch）。
 *
 * 0 篇：整塊隱藏（含 loading/error 態——沒有反向連結可看時，不值得為這個次要
 * 區塊額外佔用畫面空間或噴錯誤訊息；本頁主體已經有自己的 loading/error 顯示）。
 *
 * 折疊用原生 `<details>/<summary>`，不建新的 Radix collapsible 元件：repo 目前
 * 沒有其他地方需要這個折疊互動，原生元素就有免費的無障礙語意（鍵盤可操作、
 * 螢幕閱讀器會報告展開狀態），不值得為單一使用場景多養一個 ui 元件。
 */
export function BacklinksSection({ noteId }: { noteId: string | undefined }) {
  const { t } = useTranslation();
  const backlinksQuery = useBacklinks(noteId);
  const backlinks = backlinksQuery.data;

  if (!backlinks || backlinks.length === 0) return null;

  return (
    // `shrink-0`：這個區塊跟編輯器共用同一個 `flex flex-col` 容器（見 NotePage），
    // 編輯器那個 `<div>` 是 `flex-1 overflow-y-auto`——沒有 `shrink-0`，展開後內容多
    // （上限 MAX_BACKLINKS=200 筆）會把 flex 容器撐大，逼編輯器被壓縮到接近 0 高。
    // `<ul>` 另外加 `max-h-48 overflow-y-auto`：篇數多時區塊本身可捲動，不會無限長高。
    <details className="shrink-0 border-t border-border px-6 py-3 text-sm">
      <summary className="cursor-pointer select-none font-medium text-muted-foreground">
        {t("note.backlinks.title", { count: backlinks.length })}
      </summary>
      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
        {backlinks.map((backlink) => (
          <li key={backlink.id}>
            <Link
              to={canonicalNotePath(backlink)}
              className="text-primary underline-offset-4 hover:underline"
            >
              {backlink.title}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
