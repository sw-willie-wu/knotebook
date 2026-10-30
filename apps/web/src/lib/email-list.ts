/**
 * 多地址輸入框的分隔規則：群組加成員那一格（#331 批次加入的 `parseEmailList`）與它的「認識的人」建議
 * （`UserEmailCombobox` 的 `multiple` 模式，#332）共用這一份——拆地址與找游標所在的地址才不會各切各的。
 */

/** 分段：半形與全形的逗號、分號，頓號，換行（中文輸入法下很容易打成全形）。字元類別的內容，下面三條規則共用。 */
const SEGMENT_SEPARATORS = ",;，；、\\r\\n";
/** 段內再依空白（JS 的 `\s` 含全形空白）與 `<`、`>` 切（`名字 <地址>`）。 */
const PIECE_SEPARATORS = "\\s<>";

export const SEGMENT_SEPARATOR_RE = new RegExp(`[${SEGMENT_SEPARATORS}]+`);
/** 段內的片段：一個 `<…>` 整個算一片（括號內的就是地址），其餘依空白切。 */
export const PIECE_RE = new RegExp(`<([^<>]*)>|[^${PIECE_SEPARATORS}]+`, "g");
/** 地址的邊界字元＝分段字元＋段內切片的字元。 */
const BOUNDARY_RE = new RegExp(`[${SEGMENT_SEPARATORS}${PIECE_SEPARATORS}]`);
const BOUNDARIES_RE = new RegExp(`[${SEGMENT_SEPARATORS}${PIECE_SEPARATORS}]+`);
/** 緊接在地址後面、已經有的分段字元（前後可帶空白）。 */
const LEADING_SEPARATOR_RE = new RegExp(`^\\s*[${SEGMENT_SEPARATORS}]\\s*`);

export interface TokenSpan {
  start: number;
  end: number;
  token: string;
}

/** 游標 `caret` 所在（含緊貼在游標前面）的那一個地址片段 `[start, end)`；游標前後都是分隔字元時是空片段。 */
export function tokenAt(text: string, caret: number): TokenSpan {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && !BOUNDARY_RE.test(text[start - 1]!)) start -= 1;
  let end = at;
  while (end < text.length && !BOUNDARY_RE.test(text[end]!)) end += 1;
  return { start, end, token: text.slice(start, end) };
}

/** `[start, end)` 以外、框裡其他的地址片段（依邊界字元切開，不判斷像不像 email）。 */
export function otherTokens(text: string, start: number, end: number): string[] {
  return `${text.slice(0, start)} ${text.slice(end)}`.split(BOUNDARIES_RE).filter((token) => token.length > 0);
}

/**
 * 把 `[start, end)` 換成 `email`，其他地址原樣不動。後面還沒接分段字元就補 `, `（原本隔開下一個地址的空白收掉）；
 * 已經接著（改的是中間那個地址）就沿用，不再多補一個。`名字 <地址>` 括號裡的地址（後面緊接 `>`）不補，游標放到 `>`
 * （與其後的分隔）後面。回傳新字串與游標位置（落在分隔之後，可以接著打下一個）。
 */
export function replaceToken(text: string, start: number, end: number, email: string): { text: string; caret: number } {
  const before = text.slice(0, start) + email;
  const after = text.slice(end);
  if (after.startsWith(">")) {
    const separator = LEADING_SEPARATOR_RE.exec(after.slice(1));
    return { text: before + after, caret: before.length + 1 + (separator?.[0].length ?? 0) };
  }
  const existing = LEADING_SEPARATOR_RE.exec(after);
  if (existing) return { text: before + after, caret: before.length + existing[0].length };
  return { text: `${before}, ${after.replace(/^\s+/, "")}`, caret: before.length + 2 };
}
