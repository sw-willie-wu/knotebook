import { extractRefUuid, normalizeSlug, type NoteDto } from "@knotebook/shared";

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
export function matchesNoteRef(ref: string | undefined, note: Pick<NoteDto, "id" | "slug">): boolean {
  if (!ref) return false;
  if (note.slug !== null && normalizeSlug(ref) === normalizeSlug(note.slug)) return true;
  return extractRefUuid(ref) === note.id.toLowerCase();
}
