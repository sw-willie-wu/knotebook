import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./i18n";
import "./index.css";
// 側欄 logo 的 K 用 Playfair Display 700 italic；K 是拉丁字元，latin 子集即足，
// 不必連 cyrillic/vietnamese 等其餘 unicode-range 子集一起下載。
import "@fontsource/playfair-display/latin-700-italic.css";

// ⚠ 不要在這裡設預設 `staleTime`：ShareDialog 個人筆記的 latch 等的是 `isFetchedAfterMount`（#170），設了 staleTime
// 掛載就不重抓、面板永遠停在載入中，測試卻可能照樣全綠。
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
