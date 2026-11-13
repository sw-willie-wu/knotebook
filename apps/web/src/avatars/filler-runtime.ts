import type { QueryClient } from "@tanstack/react-query";
import { fetchAvatarOriginal, invalidateAvatarQueries, putAvatarDisplay } from "@/api/avatars";
import { configureFiller, enqueueFill, type FillTarget } from "./display-filler";

/**
 * 背景補產的接線：把讀原圖、送回顯示圖、失效快取接到頭貼 API 與目前的 QueryClient。
 * 這支與 `display-filler` 都只經動態 `import()`（首包的 `AvatarDisplayFiller`）或設定頁（本來就是 lazy chunk）載入；
 * `display-filler` 自己不 import `api/avatars`（那邊在寫入成功時反過來通知它，會成環）。
 */
export function configureForClient(queryClient: QueryClient): void {
  configureFiller({
    fetchOriginal: fetchAvatarOriginal,
    putDisplay: putAvatarDisplay,
    invalidate: () => void invalidateAvatarQueries(queryClient),
  });
}

export function startFill(target: FillTarget, queryClient: QueryClient): void {
  configureForClient(queryClient);
  enqueueFill(target);
}
