import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";

/**
 * 內文卡頁首的「最後編輯」標籤（#106 spec §10）。
 *
 * 兩形：`agentLabel` 為 null＝真人改的，純文字（不可按）；非 null＝AI／API 經 token
 * 改的，顯示 `handle (label)` 並且是**按鈕**，按下去開 AI 修改紀錄 dialog（那個 dialog
 * 的狀態住在 `NotePage`，它還有 ⋮ 選單這第二個觸發點）。
 *
 * 時間用**絕對格式**（`toLocaleDateString`，`title` 給完整 `toLocaleString`）——repo 裡
 * 沒有相對時間 helper，`ApiTokensSection` 的 `formatDate` 就是這一套。
 *
 * 窄視窗：`max-md:sr-only`（不是 `hidden`），斷點跟同一個 header 裡的 `ConnectionBadge`
 * 一致——`<md` 收成螢幕閱讀器讀得到、視覺隱藏，不是 `display:none` 整個從無障礙樹消失。
 * `sm:inline`/`hidden` 那組不同斷點是這裡原本的雷：窄視窗使用者連文字帶按鈕一起看不到。
 *
 * 分隔線：標籤前面多一條 `aria-hidden` 的 1px 直線，與 `ConnectionBadge`（「已連線 · 擁有者」）
 * 隔開，免得頁首讀成「擁有者 <who>」。放在這裡（而不是 NotePage）是為了與標籤共用同一個
 * null 條件；`<md` 標籤收成 sr-only、badge 只剩狀態點，線也一起 `max-md:hidden`。
 *
 * 標籤是頁首收縮順序裡最後才縮、且能縮到 0 的那一個（`min-w-0 truncate`）；標題（`TitleInput`）
 * 最多讓到 `min-w-16`（64px），唯讀形 `<h1>` 到 64px 後同樣 `truncate`。收縮順序見 `TitleInput` 的
 * `min-w-16`、ShareDialog／NoteMenu 觸發鈕的 `shrink-0`：三處是一組（標題先讓到 64px → 標籤截斷 → 其餘不縮）。
 */
export function LastEditedLabel({ note, onOpenEdits }: { note: NoteDto; onOpenEdits: () => void }) {
  const { t, i18n } = useTranslation();
  const last = note.lastEdited;
  if (!last) return null;

  const handle = last.byHandle === "" ? t("note.lastEditedDeletedUser") : last.byHandle;
  const who = last.agentLabel === null ? handle : `${handle} (${last.agentLabel})`;
  const at = new Date(last.at);
  const text = t("note.lastEdited", { who, when: at.toLocaleDateString(i18n.language) });
  const full = at.toLocaleString(i18n.language);

  const separator = <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border max-md:hidden" />;

  if (last.agentLabel === null) {
    return (
      <>
        {separator}
        <span
          data-testid="last-edited"
          title={t("note.lastEditedAt", { who, when: full })}
          className="max-md:sr-only min-w-0 truncate text-xs text-muted-foreground"
        >
          {text}
        </span>
      </>
    );
  }

  return (
    <>
      {separator}
      <button
        type="button"
        data-testid="last-edited"
        title={t("note.lastEditedTitle", { who, when: full })}
        onClick={onOpenEdits}
        className="max-md:sr-only min-w-0 truncate rounded text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {text}
      </button>
    </>
  );
}
