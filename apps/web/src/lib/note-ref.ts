import { extractRefUuid, normalizeSlug } from "@knotebook/shared";

/**
 * 這個 `/notes/:ref` 路由參數指的是不是這一篇筆記。
 *
 * 為什麼不直接比對 `location.pathname === canonicalNotePath(note)`：標題存檔後我們用
 * `history.replaceState` 換掉網址（見 `TitleInput`），但 react-router 的 location／
 * params **不會**因此更新，兩邊會失準。改成拿路由參數本身比對就沒有這個問題——
 * 三種 ref 形式全部認得：
 * - 自訂 slug（經 `normalizeSlug` 後相等——存檔時正規化過，網址可能帶大寫或 NFD 變體）；
 * - `<vanity>-<uuid>` 或純 uuid（用 `extractRefUuid` 取尾碼 uuid 比對）。
 *
 * 供側欄的「目前開啟中」高亮與「刪除開啟中的筆記要導走」兩處共用。
 */
// 參數型別刻意不綁 NoteDto：#122 Task 3 把 NoteDto.slug 收緊為 string 後，`slug !== null`
// 分支對生產路徑（唯一消費端 NoteList 傳 NoteDto）已不可達，綁著會觸 TS2367 恆真比較——
// 放寬只是撐到本檔被刪（本檔＋matchesNoteRef＋其測試在 PR2 的 ActiveNoteContext task
// 整組退役；舊 vanity ref 的辨識本來就靠 extractRefUuid，與 slug 是否為 null 無關）。
export function matchesNoteRef(ref: string | undefined, note: { id: string; slug: string | null }): boolean {
  if (!ref) return false;
  if (note.slug !== null && normalizeSlug(ref) === normalizeSlug(note.slug)) return true;
  return extractRefUuid(ref) === note.id.toLowerCase();
}
