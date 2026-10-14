/**
 * #269：筆記 id 比對一律不分大小寫。server 回的 id 與 `["notes"]` 快取是 PG 正規化過的小寫 uuid，
 * 但舊文件的 wikilink `targetNoteId` 可能存大寫（migration 0020 要把 `link_target_ids` 轉小寫即為此）——
 * 用 `===` 比會把活連結誤判成斷鏈。
 */
export function sameNoteId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
