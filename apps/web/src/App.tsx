import { BrowserRouter, Route, Routes } from "react-router";
import { useTranslation } from "react-i18next";
import { ThemeProvider } from "./theme";
import { Toaster } from "./components/ui/toast";
import { RequireAuth, SetupGate } from "./auth/guards";
import { UserMenu } from "./components/UserMenu";
import LoginPage from "./pages/LoginPage";
import SetupPage from "./pages/SetupPage";

// 佔位首頁：Task 12+ 換成真正的筆記列表/編輯器頁面，這裡先確保 router、
// i18n、theme、query client、toast container、路由守衛、UserMenu 全部串起來且能渲染。
function HomePage() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8">
      <div className="absolute right-4 top-4">
        <UserMenu />
      </div>
      <h1 className="text-2xl font-semibold">{t("app.title")}</h1>
      <p className="text-muted-foreground">{t("home.title")}</p>
    </main>
  );
}

/**
 * 整棵 app 的 route 樹——唯一真相，`App`（production，包在 `<BrowserRouter>`）
 * 與 `App.test.tsx`（包在 `<MemoryRouter>`）都吃這同一個匯出，不各自重建一份
 * 容易漂移的等價樹。用宣告式 `<Routes>/<Route>`（而非 `createBrowserRouter`
 * data router）：後者在 jsdom 測試環境下，navigate 時內部會建構一個帶
 * `AbortSignal` 的 Fetch `Request`（給 loader/action 用，即便這棵樹完全沒有
 * loader/action），jsdom 的 `AbortController` 與 Node/undici 的不同 realm，
 * `new Request(..., {signal})` 的 `instanceof AbortSignal` 檢查必炸——宣告式
 * router 沒有這條內部機制，production 瀏覽器環境兩種 router 行為對這棵樹
 * 而言等價。
 *
 * §11.3 逐字守衛規則：<SetupGate> 包住整棵樹（needed:true 全導 /setup；
 * needed:false 時 /setup 依登入狀態導 /login 或 /）；<RequireAuth> 包住除
 * /setup、/login 外的其餘路由（未登入導 /login）。
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<SetupGate />}>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/*" element={<HomePage />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
      <Toaster />
    </ThemeProvider>
  );
}
