/**
 * #93 PR2：搜尋命中的**唯一**比對規則——片段／標題標亮（`highlightTitle`、`displaySnippet`）與「點片段跳到命中的 block」
 * （`hooks/block-find.ts`）都走 `foldedIndexOf`，所以「片段上標亮的字」與「實際跳到的 block」不會分家。
 *
 * 規則＝server 的規則：server 比對是 `position(lower(q) in lower(body))`（`notes/search-sql.ts`），沒有 NFKC／全半形折疊；
 * 這裡的 `toLowerCase()` 對應它（全形大寫 `Ａ` 會折成全形小寫 `ａ`，但全形 `ａ` 與半形 `a` 不同——server 也不同，所以不折）。
 * 若這裡多做 NFKC，會跳到 server 不認為命中的 block。
 *
 * 呼叫端把查詢字自己 `toLowerCase()` 後傳進來（`lowerQuery`）。`toLowerCase()` 會改變長度的字串（如 `İ`→`i̇`）位置對不回原字串 → -1
 * （標亮不標、跳轉退回段落標題），兩邊一致。
 */
export function foldedIndexOf(text: string, lowerQuery: string): number {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return -1;
  return lower.indexOf(lowerQuery);
}
