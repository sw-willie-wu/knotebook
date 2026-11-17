type LightboxModule = typeof import("./MediaLightbox");

let pending: Promise<LightboxModule> | null = null;
let loaded: LightboxModule | null = null;

/**
 * 放大畫面的 chunk 載入點：Provider 與預取共用同一個 promise，瀏覽器只下載、只 `import()` 一次。
 * 失敗時清掉 promise，下次打開才有機會重試。
 */
export function loadMediaLightbox(): Promise<LightboxModule> {
  pending ??= import("./MediaLightbox").then(
    m => {
      loaded = m;
      return m;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

/** chunk 已載好就回模組（Provider 據此直接渲染、不經 Suspense 的最短等待），否則 `null`。 */
export function loadedMediaLightbox(): LightboxModule | null {
  return loaded;
}

/** 滑鼠移上或焦點進來時先把 chunk 抓好；已載或載入中都不重複觸發，失敗不處理（打開時會再試並顯示錯誤）。 */
export function prefetchMediaLightbox(): void {
  if (loaded !== null || pending !== null) return;
  void loadMediaLightbox().catch(() => undefined);
}
