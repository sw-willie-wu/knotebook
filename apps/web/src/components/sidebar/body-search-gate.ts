import { SEARCH_QUERY_MAX } from "@knotebook/shared";

/**
 * #93：側欄要不要搜內文（首包——1 個字或太長時連內文區的 lazy chunk 都不載）。
 * - trim 後空字串 → `off`（只打空白：只比對標題）。
 * - 不到 `BODY_SEARCH_MIN_CHARS` 個字（以 code point 計，中文一字＝1）→ `tooShort`。
 * - 超過 `SEARCH_QUERY_MAX` 個 UTF-16 code unit（server 的 zod `.max` 數的就是這個）→ `tooLong`，不發請求。
 */
export const BODY_SEARCH_MIN_CHARS = 2;
/** 打字停多久才搜內文（ms）。在首包的 `SearchResults` 用（放在 lazy 元件裡會每次掛載都立刻發）。 */
export const BODY_SEARCH_DEBOUNCE_MS = 300;

export type BodyGate = "off" | "tooShort" | "tooLong" | "search";

export function bodySearchGate(raw: string): BodyGate {
  const q = raw.trim();
  if (q === "") return "off";
  if (Array.from(q).length < BODY_SEARCH_MIN_CHARS) return "tooShort";
  if (q.length > SEARCH_QUERY_MAX) return "tooLong";
  return "search";
}
