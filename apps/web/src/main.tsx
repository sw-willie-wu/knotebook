import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { clearStaleOneTimeTokens } from "./auth/resetTokenStorage";
import { installCustomColors } from "./lib/custom-colors";
import { installPublicPageInstallPromptGuard } from "./lib/install-prompt";
import { installUpdateCheck, showUpdateAvailableToast } from "./lib/update-check";
import "./i18n";
import "./index.css";
// 側欄 logo 的 K 用 Playfair Display 700 italic；K 是拉丁字元，latin 子集即足，
// 不必連 cyrillic/vietnamese 等其餘 unicode-range 子集一起下載。
import "@fontsource/playfair-display/latin-700-italic.css";

// ⚠ 不要在這裡設預設 `staleTime`：ShareDialog 個人筆記的 latch 等的是 `isFetchedAfterMount`（#170），設了 staleTime
// 掛載就不重抓、面板永遠停在載入中，測試卻可能照樣全綠。
const queryClient = new QueryClient();

// #286：整頁離開一次性連結頁時 React cleanup 不會跑，暫存的 token 在下一次載入時清掉（見該模組）。
clearStaleOneTimeTokens(window.location.pathname);

// #378：筆記裡的自訂色碼沒有預先寫好的 CSS，要在 React 渲染出內容之前就開始觀察 DOM。
installCustomColors();

// 公開分享頁不提示安裝 app（見該模組）。要在瀏覽器送出 beforeinstallprompt 之前掛上。
installPublicPageInstallPromptGuard();

// 安裝成 app 的分頁可能在背景掛好幾天：回到前景時檢查有沒有新版，有就用 toast 提示重新整理（見該模組）。
installUpdateCheck({ onUpdate: () => showUpdateAvailableToast() });

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
