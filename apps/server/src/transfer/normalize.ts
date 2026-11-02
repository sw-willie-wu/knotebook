/**
 * bulk transfer spec 2026-11-02 §9.1、§9.3-1：本文與行的正規化。**下載（PR-1）與寫回（PR-2）必須用同一組函式**——
 * 基底雜湊是在這裡的輸出上算的，兩邊各寫一份就會在某個邊界上分岔，寫回時每一行都「改了」。
 *
 * - `normalizeBody`：去 UTF-8 BOM、`\r\n` → `\n`、去開頭的空行（只含空白／tab 的行也算）、去結尾所有 `\n`。
 *   行尾空白**不**在這裡去（屬於行的內容；比對時才由 `lineKey` 處理）。
 * - `lineKey`：逐行比對與行雜湊的鍵＝`String.prototype.trimEnd()`。代價（plan §0.1-7）：比 spike 的 `/[ \t]+$/` 多吃
 *   NBSP、U+3000 等 Unicode 空白——只改行尾空白的修改不會寫回（known-limitations ㉓）。
 * - `normalizeNumbered`：numbered 段的行（`line_kinds = 1`）比對前把行首（可縮排）的編號換成 `1.`，讓重新編號不算改。
 */

export function normalizeBody(s: string): string {
  return s
    .replace(/^\ufeff/, "")
    .replace(/\r\n/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\n+$/, "");
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
