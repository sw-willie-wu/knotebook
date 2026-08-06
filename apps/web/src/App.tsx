import { BrowserRouter, Route, Routes } from "react-router";
import { ThemeProvider } from "./theme";
import { Toaster } from "./components/ui/toast";
import { RequireAdmin, RequireAuth, SetupGate } from "./auth/guards";
import LoginPage from "./pages/LoginPage";
import SetupPage from "./pages/SetupPage";
import HomePage from "./pages/HomePage";
import NotePage from "./pages/NotePage";
import AdminUsersPage from "./pages/AdminUsersPage";

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
 * /setup、/login 外的其餘路由（未登入導 /login）；`/admin/users`（Task 15）再多包一層
 * <RequireAdmin>（非 admin 導 `/`）——巢狀在 <RequireAuth> 底下，即使 <RequireAdmin>
 * 自己也有未登入判斷（見 guards.tsx），這裡是雙保險而非依賴它獨立生效。這條路由必須
 * 排在 `/*` catch-all 之前，否則永遠會被 HomePage 吃掉。
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<SetupGate />}>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          {/* `/notes/:ref` 排在 catch-all 之前：ref 可以是自訂 slug、
              `<vanity>-<uuid>` 或純 uuid，一律由 `GET /api/notes/:ref` 解析。 */}
          <Route path="/notes/:ref" element={<NotePage />} />
          <Route element={<RequireAdmin />}>
            <Route path="/admin/users" element={<AdminUsersPage />} />
          </Route>
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
