// 圖片寬度（`previewWidth`）與表格欄寬（`colwidth`）的合法範圍（spec 2026-10-21 columns-layout §11.1 I6）：
// 讀出端用 clampSizePx 夾回（I5），寫入端用 isSizePx 檢查字面。

export const SIZE_PX_MIN = 32;
export const SIZE_PX_MAX = 4000;

/** 非有限數或 ≤ 0 → null；否則四捨五入後夾 [32, 4000]。 */
export function clampSizePx(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(SIZE_PX_MAX, Math.max(SIZE_PX_MIN, Math.round(n)));
}

const SIZE_RE = /^[1-9][0-9]*$/;
/** 字串是否為 [32, 4000] 的十進位整數、無前導 0、無空白。 */
export function isSizePx(s: string): boolean {
  if (!SIZE_RE.test(s)) return false;
  const n = Number(s);
  return n >= SIZE_PX_MIN && n <= SIZE_PX_MAX;
}
