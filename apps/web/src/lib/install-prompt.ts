import { isPublicSharePath } from "@knotebook/shared";

/**
 * 公開分享頁（`/p/*`）不提示安裝 app。
 *
 * manifest 連結寫在 `index.html`，公開頁也是同一份 HTML，所以 Chromium 會對匿名讀者提示「安裝 Knotebook」；
 * 裝了只會開到登入頁。這裡攔下 `beforeinstallprompt`，當下的路徑是公開頁就 `preventDefault()`，
 * 瀏覽器就不會自己跳出安裝提示（mini-infobar）。其他頁面不攔，照瀏覽器預設。
 *
 * 不改成「公開頁不放 manifest 連結」：iOS 讀的是加入主畫面當下的 DOM，動態插拔 `<link rel="manifest">` 太脆弱。
 * 判定在事件發生時才看路徑：SPA 內換頁不會重新載入，載入時的路徑不一定是現在的路徑。
 *
 * 回傳拆掉監聽的函式（給測試用）。
 */
export function installPublicPageInstallPromptGuard(target: Window = window): () => void {
  const onBeforeInstallPrompt = (event: Event) => {
    if (isPublicSharePath(target.location.pathname)) event.preventDefault();
  };
  target.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  return () => target.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
}
