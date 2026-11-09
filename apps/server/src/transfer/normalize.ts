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
  return trimTrailingNewlines(
    s
      .replace(/^\ufeff/, "")
      .replace(/\r\n/g, "\n")
      .replace(/^(?:[ \t]*\n)+/, ""),
  );
}

/**
 * \u53bb\u6389\u7d50\u5c3e\u6240\u6709 `\n`\uff08\u7dda\u6027\uff09\u3002#398 \u5be9\u67e5 I1\uff1a\u539f\u672c\u7684 `/\n+$/` \u6c92\u9328\u5b9a\u958b\u982d\uff0c\u6bcf\u500b\u63db\u884c\u7684\u4f4d\u7f6e\u90fd\u5f80\u5f8c\u5403\u5b8c\u6574\u6bb5\u63db\u884c\u518d\u5931\u6557\u2014\u2014`"\n"`\u00d726 \u842c
 * \u63a5\u4e00\u500b\u5b57\u5be6\u6e2c 19.8 \u79d2\uff0c\u800c\u5b83\u5728\u5beb\u56de\uff08`PUT /api/transfer/notes`\uff09\u7684\u4e3b\u57f7\u884c\u7dd2\u4e0a\u3002
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
