import { createBrowserRouter, RouterProvider } from "react-router";
import { useTranslation } from "react-i18next";
import { ThemeProvider } from "./theme";
import { Toaster } from "./components/ui/toast";

// 佔位首頁：Task 11+ 換成真正的筆記列表/編輯器頁面，這裡先確保 router、
// i18n、theme、query client、toast container 全部串起來且能渲染。
function HomePage() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-2xl font-semibold">{t("app.title")}</h1>
      <p className="text-muted-foreground">{t("home.title")}</p>
    </main>
  );
}

const router = createBrowserRouter([{ path: "/*", element: <HomePage /> }]);

export default function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} />
      <Toaster />
    </ThemeProvider>
  );
}
