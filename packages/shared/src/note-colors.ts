/**
 * #222：MCP／REST 讀寫筆記的文字色／底色——色盤與寫入檢查（讀出在 `note-markdown-read.ts`）。
 *
 * **寫入**（{@link findDisallowedColor}）：markdown 解析出來的 block 裡，`textColor`／`backgroundColor`
 * 只收編輯器內建的 10 種色名（{@link PALETTE_COLORS}）。其他值（`#hex`、`rgb()`、CSS 合法但不在色盤的
 * 名稱、大小寫不符的 data-*）BlockNote 照樣存進 JSON，但編輯器畫面上不顯示——所以整筆拒絕，不靜默剝除。
 * ⚠ 走訪是**迭代**的（顯式堆疊）：巢狀深度由呼叫端的 markdown 決定，不能遞迴。
 */
export const PALETTE_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
const PALETTE: ReadonlySet<string> = new Set(PALETTE_COLORS);
const COLOR_KEYS = ["textColor", "backgroundColor"] as const;

/** 讀寫兩端共用的判準：值是色盤裡的名稱（`default` 也算）。 */
export const isPaletteColor = (v: unknown): v is string => typeof v === "string" && PALETTE.has(v);

function badColorIn(rec: unknown): string | null {
  if (rec === null || typeof rec !== "object") return null;
  for (const k of COLOR_KEYS) {
    const v = (rec as Record<string, unknown>)[k];
    if (v !== undefined && !isPaletteColor(v)) return String(v);
  }
  return null;
}

/**
 * 回傳 blocks 裡任一個不在色盤的色值（找不到回 `null`）。看三處：block 的 `props`、行內 text 的
 * `styles`（含連結內的 text）、表格儲存格的 `props` 與其行內內容。不保證回的是文件順序上的第一個。
 */
export function findDisallowedColor(blocks: readonly unknown[]): string | null {
  const stack: unknown[] = [];
  const pushAll = (xs: readonly unknown[]) => {
    for (const x of xs) stack.push(x); // 不用 push(...xs)：超大陣列展開成參數會爆堆疊
  };
  pushAll(blocks);
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      pushAll(n); // 舊形表格儲存格：直接是 inline 陣列
      continue;
    }
    const o = n as { props?: unknown; styles?: unknown; content?: unknown; children?: unknown };
    const hit = badColorIn(o.props) ?? badColorIn(o.styles);
    if (hit !== null) return hit;
    if (Array.isArray(o.content)) pushAll(o.content);
    else if (o.content !== null && typeof o.content === "object") {
      const rows = (o.content as { rows?: unknown }).rows;
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const cells = r !== null && typeof r === "object" ? (r as { cells?: unknown }).cells : undefined;
          if (Array.isArray(cells)) pushAll(cells);
        }
      }
    }
    if (Array.isArray(o.children)) pushAll(o.children);
  }
  return null;
}
