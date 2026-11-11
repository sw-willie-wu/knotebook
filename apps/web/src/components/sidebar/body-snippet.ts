import { foldedIndexOf } from "@/lib/search-match";

/** 命中前最多保留幾個 code point（側欄預設寬一行約 18 個中文字；server 的前文最多約 50 字，命中常被截到看不見）。 */
export const SNIPPET_LEAD_MAX = 12;

/**
 * 側欄顯示用的片段：在 `snippet.toLowerCase()` 裡找 `lowerQuery`，命中前超過 `leadMax` 個 code point 就從命中前第 `leadMax`
 * 個 code point 起、前面補 `…`（以 code point 計，不切半個代理對）。`toLowerCase()` 會改變長度的片段（如 `İ`）位置對不回原字串、
 * 找不到命中 → 原樣（規則同 `highlightTitle`）。server 截過前文的片段本來就以 `…` 開頭：裁切時那個 `…` 一定在被裁掉的那段裡，
 * 不會變成 `……`。`lowerQuery` 由呼叫端用產出這批結果的字（`forQuery`）算，不用當下的字。
 */
export function displaySnippet(snippet: string, lowerQuery: string, leadMax: number = SNIPPET_LEAD_MAX): string {
  if (lowerQuery === "") return snippet;
  const index = foldedIndexOf(snippet, lowerQuery);
  if (index < 0) return snippet;
  const before = Array.from(snippet.slice(0, index));
  if (before.length <= leadMax) return snippet;
  return `…${before.slice(before.length - leadMax).join("")}${snippet.slice(index)}`;
}
