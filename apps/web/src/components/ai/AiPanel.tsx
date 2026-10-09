import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { MessageCircle, X } from "@/components/ui/icons";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAiSession } from "./AiSession";

/**
 * AI 泡泡（#115 收合態）。版本歷史（spec §8.1）起與歷史泡泡一起收進 `CornerStack` 的右下容器——**定位與捲動淡出都在容器上**，
 * 這顆只剩外觀；`variant="brand"` 讓底色與 focus ring 單一出處（全 app 唯一的浮動主控件，缺 ring 鍵盤使用者看不到焦點）。
 */
export function AiBubble() {
  const { t } = useTranslation();
  const { setCollapsed } = useAiSession();
  return (
    <Button
      type="button"
      variant="brand"
      size="icon"
      data-testid="ai-bubble"
      aria-label={t("ai.panel.expand")}
      onClick={() => setCollapsed(false)}
      className="h-12 w-12 rounded-full border border-border shadow-lg"
    >
      <MessageCircle aria-hidden="true" className="h-5 w-5" />
    </Button>
  );
}

/**
 * AI 面板（brief B1 架構決策：整個收在 `NoteEditor` 裡）。`editable===false`（viewer）
 * 或 `actions.length===0` 時整個不渲染（含 bubble）——跟 toolbar 那半條
 * （`AiToolbar.tsx`）共用同一個 `useAiSession()` 來源判定，不會有「toolbar 藏了
 * 但入口還在」這種不一致。
 *
 * #115 起是**同一個開合狀態、兩種呈現**：
 * - **收合（預設）＝`AiBubble`**，由 `CornerStack`（`components/CornerStack.tsx`）放進右下容器；
 *   位置與捲動淡出在容器上。
 * - **展開 `md+`＝並排卡**：`md:static md:w-80`，高度回 auto 由父層 flex stretch
 *   拿滿高，跟編輯器並排；卡面沿用 `cardSurface`。
 * - **展開 `<md`＝滿寬底部浮層**：`fixed inset-x-3 bottom-5`（底緣與 bubble 同線）、
 *   高 `min(80dvh, 100dvh − 5rem)`。⚠ `w-80` 必須帶 `md:` 前綴：`inset-x-3` 已同時
 *   釘 left/right，再疊無前綴寬度就是 over-constrained——CSS 對「left/right/width
 *   三者都非 auto」的解法是忽略 `right`，會渲染成貼左直欄（早期版本實測踩過）。
 *   同理 `h-[80dvh]`/`max-h-*` 必須用 `md:h-auto md:max-h-none` 收回，否則寬螢幕的
 *   並排卡會變成 80dvh 的短卡、與內文卡不等高。
 *
 * 收合是預設狀態，`start()` 會自動展開（`AiSession.tsx`）——formatting toolbar 發起
 * 動作時面板自己打開，不用先點 bubble。
 */
export function AiPanel() {
  const { t } = useTranslation();
  const { actions, editable, state, collapsed, setCollapsed, start, apply, revert, cancel, dismiss, retry, canRevert } =
    useAiSession();

  if (!editable || actions.length === 0) {
    return null;
  }

  if (collapsed) return null;

  return (
    <aside
      data-testid="ai-panel"
      className={cn(
        cardSurface,
        "z-30 flex shrink-0 flex-col overflow-y-auto p-3",
        "fixed inset-x-3 bottom-5 h-[80dvh] max-h-[calc(100dvh-5rem)]",
        "md:static md:inset-auto md:bottom-auto md:h-auto md:max-h-none md:w-80",
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
                <Button type="button" variant="brandDeep" size="sm" onClick={apply}>
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
              <Button type="button" variant="brandDeep" size="sm" onClick={retry}>
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
