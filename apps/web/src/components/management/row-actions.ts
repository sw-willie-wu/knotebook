/**
 * 列內 icon 動作鈕的 class（#247 §4.9）。唯一使用者是 `components/ui/row-icon-button.tsx` 的 `RowIconButton`
 * （套在 `<Button variant="ghost" size="icon">` 上，並帶 title／aria-label，圖示 `h-4 w-4`）：
 * - 中性（鉛筆＝編輯、插頭＝測試連線）：`ROW_ICON_BUTTON`，hover 沿用 ghost 的 `bg-accent`。
 * - 危險（垃圾桶：解除連結、移除成員、撤銷 token、刪除角色／方案／AI 動作）：`ROW_ICON_DANGER`，
 *   會跳確認框的也一樣紅；不可用時 `disabled` 或 `aria-disabled` 都是 `opacity-40`。
 * twMerge 讓這裡的 `hover:bg-destructive/10` 蓋掉 ghost 的 `hover:bg-accent`。
 */
export const ROW_ICON_BUTTON = "h-8 w-8 text-muted-foreground";
export const ROW_ICON_DANGER =
  "h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 aria-disabled:opacity-40";
