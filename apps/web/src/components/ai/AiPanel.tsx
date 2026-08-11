import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { useAiSession } from "./AiSession";

/**
 * 右側 AI 面板（brief B1 架構決策：整個收在 `NoteEditor` 裡，跟左欄的 `NoteEditorView`
 * 並排）。`editable===false`（viewer）或 `actions.length===0` 時整個不渲染——跟 toolbar
 * 那半條（`AiToolbar.tsx`）共用同一個 `useAiSession()` 來源判定，不會有「toolbar 藏了
 * 但側欄還在」這種不一致。
 *
 * 響應式：寬螢幕（`md:` 起）`w-80 shrink-0` 跟編輯器並排；窄螢幕展開時是 `fixed` 右側
 * 抽屜（`inset-y-0 right-0` 配合 `w-80`——**不是** `inset-0`：`inset-0` 會同時釘住
 * left/right 兩側，再疊上明確的 `w-80` 會 over-constrained，CSS 對「left/right/width
 * 三者都非 auto」的解法是忽略 `right`，實際渲染結果是貼左的一條直欄而不是右側抽屜，
 * fix round 1 Minor-2 的實測結論）。收合是預設狀態，`start()` 會自動展開（`AiSession.tsx`）。
 */
export function AiPanel() {
  const { t } = useTranslation();
  const { actions, editable, state, collapsed, setCollapsed, start, apply, revert, cancel, dismiss, retry, canRevert } =
    useAiSession();

  if (!editable || actions.length === 0) {
    return null;
  }

  if (collapsed) {
    return (
      <aside className="flex shrink-0 items-start border-l border-border">
        <button
          type="button"
          aria-label={t("ai.panel.expand")}
          onClick={() => setCollapsed(false)}
          className="px-2 py-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {t("ai.panel.title")}
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="ai-panel"
      className={cn(
        "z-30 flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-background p-3",
        "fixed inset-y-0 right-0 md:static md:inset-auto",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("ai.panel.title")}</h2>
        <button
          type="button"
          aria-label={t("ai.panel.collapse")}
          onClick={() => setCollapsed(true)}
          className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex-1 space-y-3 text-sm">
        {state.phase === "idle" && (
          <div className="space-y-2">
            <p className="text-muted-foreground">{t("ai.panel.idle")}</p>
            {/* fix round 1 M-1：這是「全文動作」在真實 UI 上唯一構得到的入口——
                `AiToolbar`（formatting toolbar）只在使用者有選取文字時才會顯示
                （BlockNote `FormattingToolbarExtension.shouldShow`：選取為空就不出現），
                spec §13.3「全文動作＝側欄面板頂部發起」指的就是這裡：不管使用者當下有沒有
                選取文字，都能從側欄直接點一個動作開始；`start()` 內部的
                `getSelection()?.blocks ?? []` 邏輯本來就會在「沒有選取」時自動退回全文。 */}
            <div className="flex flex-col gap-1.5">
              {actions.map((action) => (
                <Button key={action.id} type="button" variant="outline" size="sm" onClick={() => start(action.id)}>
                  {action.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {state.phase === "streaming" && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{state.actionName}</p>
            <p className="text-muted-foreground">{t("ai.panel.streaming")}</p>
            {state.partial && <p className="whitespace-pre-wrap">{state.partial}</p>}
            <Button type="button" variant="outline" size="sm" onClick={cancel}>
              {t("ai.panel.cancel")}
            </Button>
          </div>
        )}

        {state.phase === "done" && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{state.actionName}</p>
            <p className="whitespace-pre-wrap">{state.result}</p>
            <div className="flex flex-wrap gap-2">
              {state.pendingPreview && state.applied === null && (
                <Button type="button" size="sm" onClick={apply}>
                  {t("ai.panel.apply")}
                </Button>
              )}
              {state.applied !== null && (
                <Button type="button" variant="outline" size="sm" disabled={!canRevert()} onClick={revert}>
                  {t("ai.panel.revert")}
                </Button>
              )}
              {/* fix round 1 Minor-3：spec §13.3 明列 done 態含重試——重跑同一個
                  action（`retry()` 跟錯誤態共用同一支，重新讀 `lastActionIdRef`），
                  不特別區分 pendingPreview/applied，讓使用者隨時可以「重新生成一次」。 */}
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                {t("ai.panel.retry")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
                {t("ai.panel.dismiss")}
              </Button>
            </div>
          </div>
        )}

        {state.phase === "error" && (
          <div className="space-y-2">
            <p role="alert" className="text-destructive">
              {t(`errors.${state.code}`, { defaultValue: t("errors.fallback") })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={retry}>
                {t("ai.panel.retry")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
                {t("ai.panel.dismiss")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
