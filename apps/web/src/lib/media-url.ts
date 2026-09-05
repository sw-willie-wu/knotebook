/**
 * 檔案／媒體 block（image・video・audio・file）的 URL 安全判定——判斷規則本身（只認
 * http(s)、相對網址放行、空字串交給 BlockNote placeholder、危險 scheme 一律擋）住
 * `@knotebook/shared` 的 `note-schema-config.ts`（server 端 headless schema 共用同一份
 * 規則）。本檔只剩 web 端的差異：帶 `window.location.href` 當預設 `base`。
 *
 * `isAllowedEmbedUrl`（FilePanel 的 Embed tab 輸入端守衛，嚴格、無 base）原樣 re-export；
 * `isSafeMediaUrl`／`safeMediaUrl`（渲染端／`toExternalHTML` 守衛）包一層預設 base，六個
 * 既有消費者的呼叫方式不必改。
 *
 * issue #12／#43 的分工、以及「為什麼渲染端也要驗」的理由，見 `apps/web/src/collab/schema.ts`
 * 的 #43 註解區塊與 `apps/web/src/components/NoteEditor.tsx` 的 `resolveFileUrl` 接線
 * （web 端事實：editor schema、`noteSchema` 本尊、ProseMirror 剪貼簿，家在 web 不在
 * shared）；判斷規則本身見 `@knotebook/shared` 的 `note-schema-config.ts` 檔頭。
 */
import { BLOCKED_MEDIA_URL, isAllowedEmbedUrl, isSafeMediaUrl as sharedIsSafeMediaUrl, safeMediaUrl as sharedSafeMediaUrl } from "@knotebook/shared";

export { BLOCKED_MEDIA_URL, isAllowedEmbedUrl }; // isAllowedEmbedUrl 原樣：嚴格、無 base（media-url.test.ts:21-23）

export function isSafeMediaUrl(raw: string, base: string = window.location.href): boolean {
  return sharedIsSafeMediaUrl(raw, base);
}

export function safeMediaUrl(raw: string, base: string = window.location.href): string {
  return sharedSafeMediaUrl(raw, base);
}
