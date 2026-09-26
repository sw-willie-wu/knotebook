import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./i18n";
import "./index.css";
// 側欄 logo 的 K 用 Playfair Display 700 italic；K 是拉丁字元，latin 子集即足，
// 不必連 cyrillic/vietnamese 等其餘 unicode-range 子集一起下載。
import "@fontsource/playfair-display/latin-700-italic.css";

// ⚠ 不要在這裡設預設 `staleTime`：ShareDialog 群組筆記的 latch（`freshEnough`）依賴
// `['public-link']`／`['shares']` 掛載時重抓；加了 staleTime 群組筆記會永遠 latch 不了，測試卻照樣全綠。
const queryClient = new QueryClient();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
