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
 */
export function LastEditedLabel({ note, onOpenEdits }: { note: NoteDto; onOpenEdits: () => void }) {
  const { t, i18n } = useTranslation();
  const last = note.lastEdited;
  if (!last) return null;

  const who = last.agentLabel === null ? last.byHandle : `${last.byHandle} (${last.agentLabel})`;
  const at = new Date(last.at);
  const text = t("note.lastEdited", { who, when: at.toLocaleDateString(i18n.language) });
  const full = at.toLocaleString(i18n.language);

  if (last.agentLabel === null) {
    return (
      <span data-testid="last-edited" title={full} className="max-md:sr-only shrink-0 text-xs text-muted-foreground">
        {text}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="last-edited"
      title={t("note.lastEditedTitle", { when: full })}
      onClick={onOpenEdits}
      className="max-md:sr-only shrink-0 rounded text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {text}
    </button>
  );
}
