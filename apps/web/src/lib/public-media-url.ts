import { safeMediaUrl } from "./media-url";

/**
 * 公開唯讀頁（`/p/:token`，#72）的 `resolveFileUrl` 映射：自家上傳的相對網址
 * `/api/uploads/:id` 改指到免登入的 `/api/public/notes/:token/uploads/:id`——
 * 匿名訪客沒有 session，原網址必 401；公開端點以 token 授權「這篇筆記自己的 blob」。
 *
 * **走 resolveFileUrl、不改寫 blocks**（spec A2 定案）：collab 模式下內容就是
 * Y.Doc，改 blocks＝對唯讀頁寫入。
 *
 * 判斷順序：先過 {@link safeMediaUrl}（#12 的渲染端守衛——映射不得成為它的繞道），
 * 再對「恰為 `/api/uploads/<單一段>`」的形狀做映射；其餘（外部 https、**同源絕對
 * 網址**、多段路徑、帶 query/fragment 的變體）一律原樣放行——自家上傳網址從不長
 * 那些樣子，寬鬆比對只會把不明形狀的 URL 也導進公開端點。同源絕對網址因此在匿名
 * 端破圖，已記 docs/known-limitations.md（Task 4），刻意不猜 origin 去救。
 */
export function publicMediaUrl(token: string): (url: string) => string {
  return (raw: string): string => {
    const safe = safeMediaUrl(raw);
    if (safe !== raw) return safe;
    const match = /^\/api\/uploads\/([^/?#]+)$/.exec(raw);
    if (!match) return raw;
    return `/api/public/notes/${encodeURIComponent(token)}/uploads/${match[1]}`;
  };
}
