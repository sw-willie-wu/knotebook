/**
 * 手機清單畫面底部兩種列（搜尋列 `PhoneListBar`、選取動作列 `SelectActionBar`）共用的外框 class：
 * 內距 6＋控制項 44＋6、上框線，加底部 safe area。兩列同高，進出選取模式時清單的可視高度不跳。
 * 螢幕鍵盤開著時鍵盤蓋住了底部 safe area，所以不留那段內距。
 */
export const PHONE_BAR_FRAME = "shrink-0 border-t border-border bg-card px-2 pt-1.5";

/** 控制項那一列的最小高度（44，觸控目標）。 */
export const PHONE_BAR_CONTROL_HEIGHT = "min-h-11";

export function phoneBarBottomPadding(keyboardOpen: boolean): string {
  return keyboardOpen ? "pb-1.5" : "pb-[calc(0.375rem+env(safe-area-inset-bottom))]";
}
