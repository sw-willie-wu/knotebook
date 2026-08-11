import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getFormattingToolbarItems, useComponentsContext } from "@blocknote/react";
import { useAiSession } from "./AiSession";

/**
 * 自訂 formatting toolbar：`getFormattingToolbarItems()` 的全部預設按鈕原樣復原，
 * 只在尾端追加一顆 AI 動作選單（spec §13.3 M3 契約）。
 *
 * 沒有用 `Components.FormattingToolbar.Select`（BlockNote 內建的「目前選取值」下拉選單，
 * `BlockTypeSelect` 用的那個）——它在 `items` 沒有任何一筆 `isSelected:true` 時直接回
 * `null`（`@blocknote/mantine` 的 `ToolbarSelect.tsx` 實測行為），而 AI 動作本來就沒有
 * 「目前選中哪一個」這回事，永遠不會有任何一筆 `isSelected`，用它會讓整顆選單永遠不
 * 出現。改用 `Components.FormattingToolbar.Button` 當觸發鈕、自己管一顆 `open` state
 * 畫下拉清單——不牽動 mantine `Menu`/`Popover` 的 portal 生命週期，也比較好測。
 *
 * `useAiSession()` 能在這裡直接呼叫：toolbar 是經 `editor.portalElement` 的 React portal
 * 渲染，但 React context 穿透 portal（同 §12.2 wikilink render 的既有論證），不必為此另拉
 * 一條 prop 通道。
 *
 * fix round 1 I-5（a11y）：下面這顆清單**刻意不**宣告 `role="menu"`/`role="menuitem"`——
 * 那組 ARIA role 帶著一整套瀏覽器/讀屏軟體預期的鍵盤行為（方向鍵在項目間漫遊、Home/End、
 * Esc 關閉並還焦點給觸發鈕……），這裡完全沒有實作，掛上那兩個 role 只會讓輔助工具以為
 * 支援了實際不存在的鍵盤互動，比不掛 role 更誤導。改成誠實描述現有行為：一顆會展開/收合
 * 的觸發鈕（`aria-expanded` 反映 `open`）＋展開後的一般按鈕清單（沒有 menu 語意，Tab 鍵
 * 序列走一般文件順序）。`isSelected`（會渲染成 `aria-pressed`）也拿掉——那是「切換態」
 * 語意（像 Bold 按鈕的按下/未按下），不是「這顆鈕控制的選單目前展不展開」，兩者不是同一
 * 件事，先前用 `isSelected={open}` 是誤用。
 */
export function AiToolbar() {
  const Components = useComponentsContext()!;
  const { t } = useTranslation();
  const { actions, editable, start } = useAiSession();
  const [open, setOpen] = useState(false);

  const showAi = editable && actions.length > 0;

  return (
    <Components.FormattingToolbar.Root className="bn-toolbar bn-formatting-toolbar">
      {getFormattingToolbarItems()}
      {showAi && (
        <div className="relative">
          <Components.FormattingToolbar.Button
            mainTooltip={t("ai.toolbar.trigger")}
            label={t("ai.toolbar.trigger")}
            onClick={() => setOpen((prev) => !prev)}
            // `Components.FormattingToolbar.Button` 的宣告型別沒有 `aria-expanded`，但
            // mantine 的 `ToolbarButton` 實作會把未列舉的 rest props 原樣轉送到底層真正
            // 的 `<button>`（見該檔頭「rest props can be added by mantine when button is
            // used as a trigger」）——這裡借道送一個誠實的 `aria-expanded`，不需要為此
            // 改動 `@blocknote/react` 的型別或另包一層。
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 見上，型別宣告沒有這個欄位，走 rest-prop 轉送
            {...({ "aria-expanded": open } as any)}
          >
            {t("ai.toolbar.trigger")}
          </Components.FormattingToolbar.Button>
          {open && (
            <div
              aria-label={t("ai.toolbar.menuLabel")}
              className="absolute right-0 top-full z-40 mt-1 min-w-40 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
            >
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    setOpen(false);
                    start(action.id);
                  }}
                >
                  {action.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Components.FormattingToolbar.Root>
  );
}
