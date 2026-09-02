/**
 * 公開頁的網址把手（#122 PR3 Task 4）：`/p/:token`（#72 單段）與
 * `/p/:handle/:slug`（別名雙段）兩形共用同一組頁面/編輯器/圖源映射，元件間傳遞
 * 的是這個判別聯集，**不是**裸 token 字串——依形組 API 網址收斂在
 * {@link publicNoteApiPath}（意圖：頁面 query 與 publicMediaUrl 都吃它；「只有
 * 一處」是設計意圖非結構保證——各自拼字串＝兩處漂移出打不開的圖）。
 * `/p/` **頁面**網址的組字點是 shared 的 `publicAliasPath`（輸入已驗證、不編碼）
 * ——兩個組字點編碼政策不同、刻意不共用。
 */
export type PublicNoteRef =
  | { kind: "token"; token: string }
  | { kind: "path"; handle: string; slug: string };

/**
 * 依形組公開內容端點路徑。兩段都 encodeURIComponent——**防禦性編碼**：這裡拿到
 * 的是 URL 原始參數（未驗證，可能是 `Alice`、`a%20b`、NFD 拼形），不是已驗證的
 * 值。client 端**不做正規化**：NFD/大小寫的收斂由 server 端的
 * `normalizeHandle`/`normalizeSlug` 負責（fastify decode → normalize → 與 DB 的
 * NFC 值比對）——所以各種拼形變體打過去都命中，代價只是各占一格 query key。
 */
export function publicNoteApiPath(ref: PublicNoteRef): string {
  if (ref.kind === "token") {
    return `/api/public/notes/${encodeURIComponent(ref.token)}`;
  }
  return `/api/public/notes/${encodeURIComponent(ref.handle)}/${encodeURIComponent(ref.slug)}`;
}

/**
 * 依形分岔的 react-query key（plan gate m6）：兩形**不得共 key**——共了的話從
 * token 頁導去別名頁會拿到殘留快取（不同權限判定路徑的內容彼此冒充）。段落逐值
 * 展開（不塞整個 ref 物件——物件識別不穩定會讓快取永遠 miss）。
 */
export function publicNoteQueryKey(ref: PublicNoteRef): readonly string[] {
  if (ref.kind === "token") {
    return ["public-note", ref.token];
  }
  return ["public-note-by-path", ref.handle, ref.slug];
}
