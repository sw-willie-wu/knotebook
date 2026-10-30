/**
 * 側欄選取模式的狀態（spec §6.10.2、§9-4）。垃圾桶 tab 先用；PR-2c 一般 tab 共用同一份。
 * 鍵是 `{ kind, id }` 組成的字串，含 kind 是為資料夾（`"folder"`）與筆記同列選取。
 */

/** spec §9-4：選取以 { kind, id } 為鍵；"folder" 已加。 */
export type SelectionNodeKind = "note" | "folder";
export interface SelectionNode {
  kind: SelectionNodeKind;
  id: string;
}

export function selectionKey(node: SelectionNode): string {
  return `${node.kind}:${node.id}`;
}

/** 一份側欄實例（靜態卡或抽屜）標題列的「選取」鈕。垃圾桶 tab 與一般 tab 共用：離開選取模式後焦點交給它
 *（`AppShell` 抽屜 Esc、`TrashFooter`／`SelectHeader`／`SelectActionBar` 的離開路徑）。 */
export const SIDEBAR_SELECT_BUTTON = "[data-sidebar-header] button[data-sidebar-select]";

export interface SidebarSelection {
  active: boolean;
  keys: ReadonlySet<string>;
  /** Shift＋點選的錨點：最後一次單列切換的鍵。 */
  anchor: string | null;
}

export const EMPTY_SELECTION: SidebarSelection = { active: false, keys: new Set(), anchor: null };

export type SelectionOp =
  | { type: "start" }
  | { type: "end" }
  | { type: "toggle"; key: string }
  | { type: "range"; key: string; order: readonly string[] }
  | { type: "setAll"; keys: readonly string[] }
  | { type: "clear" };

function toggle(state: SidebarSelection, key: string): SidebarSelection {
  const keys = new Set(state.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { ...state, keys, anchor: key };
}

/** 不在選取模式時除了 `start` 一律回原 state（不累積鍵、不換物件）。 */
export function reduceSelection(state: SidebarSelection, op: SelectionOp): SidebarSelection {
  if (op.type === "start") return { active: true, keys: new Set(), anchor: null };
  if (!state.active) return state;
  switch (op.type) {
    case "end":
      return EMPTY_SELECTION;
    case "toggle":
      return toggle(state, op.key);
    case "range": {
      // 錨點到 key（含兩端）加入已選、錨點不動；錨點或 key 不在清單（重抓後消失）就退化成單列切換。
      const from = state.anchor === null ? -1 : op.order.indexOf(state.anchor);
      const to = op.order.indexOf(op.key);
      if (from === -1 || to === -1) return toggle(state, op.key);
      const keys = new Set(state.keys);
      for (const key of op.order.slice(Math.min(from, to), Math.max(from, to) + 1)) keys.add(key);
      return { ...state, keys };
    }
    case "setAll":
      return { ...state, keys: new Set(op.keys) };
    case "clear":
      return { ...state, keys: new Set(), anchor: null };
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}
