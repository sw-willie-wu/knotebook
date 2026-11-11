/**
 * bulk transfer：本文與行的正規化。**下載與寫回必須用同一組函式**——
 * 基底雜湊是在這裡的輸出上算的，兩邊各寫一份就會在某個邊界上分岔，寫回時每一行都「改了」。
 *
 * - `normalizeBody`：去 UTF-8 BOM、`\r\n` → `\n`、去開頭的空行（只含空白／tab 的行也算）、去結尾所有 `\n`。
 *   行尾空白**不**在這裡去（屬於行的內容；比對時才由 `lineKey` 處理）。
 * - `lineKey`：逐行比對與行雜湊的鍵＝`String.prototype.trimEnd()`。代價：比 `/[ \t]+$/` 多吃
 *   NBSP、U+3000 等 Unicode 空白——只改行尾空白的修改不會寫回（known-limitations ㉓）。
 * - `normalizeNumbered`：numbered 段的行（`line_kinds = 1`）比對前把行首（可縮排）的編號換成 `1.`，讓重新編號不算改。
 */

export function normalizeBody(s: string): string {
  return trimTrailingNewlines(
    s
      .replace(/^\ufeff/, "")
      .replace(/\r\n/g, "\n")
      .replace(/^(?:[ \t]*\n)+/, ""),
  );
}

/**
 * 去掉結尾所有 `\n`（線性）。#398：原本的 `/\n+$/` 沒錨定開頭，每個換行的位置都往後吃完整段換行再失敗——`"\n"`×26 萬
 * 接一個字實測 19.8 秒，而它在寫回（`PUT /api/transfer/notes`）的主執行緒上。
 */
export function trimTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 10) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** 已正規化的本文切成行：空字串 → `[]`（不是 `[""]`）。 */
export function bodyLines(normalized: string): string[] {
  return normalized === "" ? [] : normalized.split("\n");
}

export function lineKey(line: string): string {
  return line.trimEnd();
}

export function normalizeNumbered(line: string): string {
  return line.replace(/^(\s*)\d+\./, "$11.");
}
