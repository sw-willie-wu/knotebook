/** 開確認框當下記下的焦點退路：最愛 tab 裡那一列在移出成功後會卸載，卸載後就找不到它的鄰居了。 */
export interface RemoveContext {
  trigger: HTMLElement | null;
  /** 開框的那份側欄實例（靜態卡或抽屜）；頁首沒有。 */
  instance: Element | null;
  nextId: string | null;
  prevId: string | null;
}

function noteIdOf(el: Element | null): string | null {
  return el !== null && el.getAttribute("data-node-kind") === "note" ? el.getAttribute("data-node-id") : null;
}

export function captureRemoveContext(trigger: HTMLElement | null): RemoveContext {
  const row = trigger?.closest('[data-node-kind="note"]') ?? null;
  return {
    trigger,
    instance: trigger?.closest("[data-sidebar-instance]") ?? null,
    nextId: noteIdOf(row?.nextElementSibling ?? null),
    prevId: noteIdOf(row?.previousElementSibling ?? null),
  };
}

/** 觸發鈕還在就回它；列已卸載 → 下一列的連結 → 上一列的連結 → tabpanel。只在開框的那份側欄實例裡找。 */
export function focusAfterRemove({ trigger, instance, nextId, prevId }: RemoveContext): void {
  if (trigger !== null && trigger.isConnected) {
    trigger.focus();
    return;
  }
  const root: ParentNode = instance ?? document;
  const rows = Array.from(root.querySelectorAll('[data-node-kind="note"]'));
  for (const id of [nextId, prevId]) {
    if (id === null) continue;
    const link = rows.find((row) => row.getAttribute("data-node-id") === id)?.querySelector("a");
    if (link) {
      link.focus();
      return;
    }
  }
  root.querySelector<HTMLElement>('[role="tabpanel"]')?.focus();
}

/**
 * 等 React 把已卸載的列清掉再決定焦點，才不會把焦點給一顆即將消失的鈕。
 * 前提：TanStack Query 以 setTimeout(0) 通知 observer，且在 `onSuccess` 的 setQueryData 時就排入，早於 mutateAsync resolve；
 * React 在 microtask 裡重繪，所以延後一個 macrotask 時那一列已卸載。
 */
export function focusAfterRemoveLater(ctx: RemoveContext): void {
  window.setTimeout(() => focusAfterRemove(ctx), 0);
}
