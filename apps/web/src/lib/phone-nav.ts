/** 手機「回清單」的去向：沿 history 退回清單那一格（`go`，delta 為負），或找不到就把目前這格換成 `/`（`replace`）。 */
export type BackTarget = { kind: "go"; delta: number } | { kind: "replace" };

/**
 * 清單那一格的 history 序號嚴格小於目前這格才退得回去；不存在（深連結、重新整理後沒記錄）或不小於
 * （序號對不上＝記錄過期）就換掉目前這格，系統返回鍵之後才不會又回到同一篇筆記。
 */
export function backTarget({ listIdx, currentIdx }: { listIdx: number | null; currentIdx: number | null }): BackTarget {
  if (listIdx !== null && currentIdx !== null && listIdx < currentIdx) return { kind: "go", delta: listIdx - currentIdx };
  return { kind: "replace" };
}

const LIST_IDX_KEY = "nav.listIdx";

/** 目前這格 history 的序號（react-router 寫在 `history.state.idx`）；讀不到回 null。 */
export function historyIdx(): number | null {
  try {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    return typeof idx === "number" ? idx : null;
  } catch {
    return null;
  }
}

/** 把目前這格記成「清單所在的那一格」。sessionStorage 不可用時什麼都不做。 */
export function recordListIdx(): void {
  const idx = historyIdx();
  if (idx === null) return;
  try {
    sessionStorage.setItem(LIST_IDX_KEY, String(idx));
  } catch {
    /* 沒有記錄就走 replace */
  }
}

/** 清掉記錄的清單序號。 */
export function clearListIdx(): void {
  try {
    sessionStorage.removeItem(LIST_IDX_KEY);
  } catch {
    /* 沒有記錄就走 replace */
  }
}

/** 讀 `recordListIdx` 記的序號；沒有、不是整數或 sessionStorage 丟錯都回 null。 */
export function readListIdx(): number | null {
  try {
    const raw = sessionStorage.getItem(LIST_IDX_KEY);
    if (raw === null) return null;
    const idx = Number(raw);
    return Number.isInteger(idx) ? idx : null;
  } catch {
    return null;
  }
}
