/**
 * 欄寬的純數學：像素寬 → 欄比例、分隔線夾值、圖片擴欄時其他欄怎麼讓、自動等高、加欄。
 *
 * 所有寫進文件的欄寬都經 `ratiosFromPixels`：每值在 `[0.1, 10]`、兩位小數、整列總和＝欄數。讀出／寫回 markdown 的正規形
 * （shared `canonicalColumnsLine`）只收兩位小數、範圍內的值，所以這裡回的值原樣寫回 MCP 也不會被拒。
 */
import { clampColumnWidth } from "@knotebook/shared";

/**
 * 像素寬 → 欄比例：`r_i = n × px_i / Σpx`，每值夾 `[0.1, 10]`、四捨五入兩位；捨入後總和與 `n` 的差，加到 `changed`
 * 裡（捨入後）值最大的那欄（同值取 index 小者）再夾一次。`changed` 省略＝全部欄。
 * 分隔線只該改到被拖的兩欄，捨入差若落到別欄，等於多改了一欄，所以由呼叫端指定能吸收捨入差的欄。
 * 總和不是正數（未排版）→ 各欄 1。
 */
export function ratiosFromPixels(px: readonly number[], changed?: readonly number[]): number[] {
  const n = px.length;
  const sum = px.reduce((a, b) => a + b, 0);
  if (n === 0) return [];
  if (!(sum > 0)) return px.map(() => 1);
  // 以「分」（×100 的整數）計算，避免浮點加總的誤差。
  const cents = px.map((p) => Math.round(clampColumnWidth((n * p) / sum) * 100));
  const diff = n * 100 - cents.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    const candidates = (changed ?? px.map((_, i) => i)).filter((i) => i >= 0 && i < n);
    let target = -1;
    for (const i of candidates) if (target < 0 || cents[i]! > cents[target]! || (cents[i] === cents[target] && i < target)) target = i;
    if (target >= 0) cents[target] = cents[target]! + diff;
  }
  return cents.map((c) => clampColumnWidth(c / 100));
}

/** 拖分隔線：左欄 `pL + delta` 夾在 `[mL, pL + pR − mR]`，右欄補成兩欄總和不變。 */
export function dividerResize(pL: number, pR: number, mL: number, mR: number, delta: number): [number, number] {
  const total = pL + pR;
  const left = Math.min(Math.max(pL + delta, mL), total - mR);
  return [left, total - left];
}

/**
 * 第 k 欄要多 `need` 像素：其他欄各自的餘裕 `s_j = max(0, p_j − m_j)`、`S = Σs_j`，實際給 `granted = min(need, S)`；
 * 第 k 欄加 `granted`，其他欄依餘裕比例扣 `granted × s_j / S`。`need ≤ 0` 不動。
 */
export function expandColumnPixels(
  px: readonly number[],
  mins: readonly number[],
  k: number,
  need: number,
): { px: number[]; granted: number } {
  if (!(need > 0)) return { px: [...px], granted: 0 };
  const slack = px.map((p, j) => (j === k ? 0 : Math.max(0, p - (mins[j] ?? 0))));
  const total = slack.reduce((a, b) => a + b, 0);
  const granted = Math.min(need, total);
  if (!(granted > 0)) return { px: [...px], granted: 0 };
  return { px: px.map((p, j) => (j === k ? p + granted : p - (granted * slack[j]!) / total)), granted };
}

/** 每欄一張圖、欄寬 ∝ 寬高比時各圖等高。任一張尺寸未知（null）或不是正數 → null（不做）。 */
export function equalHeightWidths(aspects: readonly (number | null)[]): number[] | null {
  if (aspects.length === 0 || aspects.some((a) => a === null || !(a > 0))) return null;
  return ratiosFromPixels(aspects as readonly number[]);
}

/** 在 `insertIndex` 插入一欄：新欄＝既有欄寬的平均，既有欄彼此的比例不變，再整列正規化。 */
export function addColumnWidths(existing: readonly number[], insertIndex: number): number[] {
  const mean = existing.length ? existing.reduce((a, b) => a + b, 0) / existing.length : 1;
  const next = [...existing];
  next.splice(insertIndex, 0, mean);
  return ratiosFromPixels(next);
}

/** 兩組欄寬中值不同的 index（寫入時只寫有變的欄）。 */
export function changedIndices(before: readonly number[], after: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) out.push(i);
  return out;
}
