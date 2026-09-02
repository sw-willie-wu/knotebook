import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams, type Location } from "react-router";
import { ActiveNoteProvider } from "./lib/active-note";
import { ThemeProvider } from "./theme";
import { Toaster } from "./components/ui/toast";
import { ChangePasswordGate, RequireAdmin, RequireAuth } from "./auth/guards";
import { AppErrorBoundary, ChunkLoadBeacon, NoteRouteErrorBoundary } from "./components/ErrorBoundary";
import { NotePageFallback } from "./components/NotePageFallback";
import { PublicNoteErrorBoundary, PublicNoteFallback } from "./components/PublicNoteShell";
import LoginPage from "./pages/LoginPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";
import HomePage from "./pages/HomePage";
import { SettingsModal } from "./settings/SettingsModal";
import { SettingsAccountSection } from "./settings/SettingsAccountSection";
import { SettingsUsersSection } from "./settings/SettingsUsersSection";
import { SettingsAiSection } from "./settings/SettingsAiSection";

/**
 * NotePage 走 lazy（issue #19）：BlockNote＋共編整條相依鏈只有這一頁需要，同步 import
 * 會把 ~1.3MB 全塞進首包——登入頁、首頁、設定頁都陪葬。切出去後首包砍到約三分之一
 * （1,629→540 KB；gzip 496→167 KB）；`scripts/check-bundle-size.mjs`（CI 於 build 後
 * 執行）釘住「entry 尺寸上限＋NotePage chunk 確實存在」，防止未來一個不經意的靜態
 * import 把它又拉回首包。
 *
 * 只切這一頁、其餘 route 維持同步：Login/Home/ChangePassword 都很小，切它們只是
 * 多幾次網路往返；Settings 三區掛在 modal-over-background 機制上（見下方大註解），
 * lazy 會讓開 modal 閃 fallback，不值得。
 */
const NotePage = lazy(() => import("./pages/NotePage"));

/**
 * `/p/:token` 公開唯讀頁（#72）同樣走 lazy：它與 NotePage 共用 BlockNote 那條相依鏈
 * （Rollup 會切成無 facade 的共用 chunk），首包不因公開頁而變胖。
 */
const PublicNotePage = lazy(() => import("./pages/PublicNotePage"));

/**
 * 筆記頁的 route element（issue #66）——舊形 `/notes/:ref` 與新形 `/n/:handle/:slug`
 * （#122）兩條 route 共用：NoteRouteErrorBoundary 接住 chunk 載入失敗（離線/部署
 * 輪替 hash）與 NotePage 底下任何 render 錯誤——沒有它的話 React.lazy 的 reject
 * 會讓整棵樹被卸載成白屏。
 *
 * - resetKey 用路由參數（舊形＝ref、新形＝`${handle}/${slug}` 對）而非 location.key：
 *   關設定 modal 走 `navigate(backgroundLocation)` 會產生**新的** location key
 *   （實測），用 key 會把「關 modal」誤判成「換筆記」而觸發 reload；params 才是
 *   「換到另一篇筆記」的真正不變量。代價（已接受）：重新導航到同一組 params 不觸發
 *   重試。此選型由 `App.resetKey.test.tsx` 守著（issue #68＋control 3 的新形案）
 *   ——改回 location.key 那裡會紅。
 * - ChunkLoadBeacon **必須在 Suspense 內**（擺放不變量見 ErrorBoundary.tsx；
 *   App.errorBoundary.test.tsx 案 11 守著——錯放會變無限重整迴圈）。
 */
function NoteRoute() {
  // #122：兩條 route（舊形 /notes/:ref、新形 /n/:handle/:slug）共用本元件與 NotePage
  // ——resetKey 依形取（同一篇筆記的不變量：舊形是 ref、新形是 handle/slug 對）。
  const { ref, handle, slug } = useParams();
  const resetKey = handle !== undefined && slug !== undefined ? `${handle}/${slug}` : ref;
  return (
    <NoteRouteErrorBoundary resetKey={resetKey}>
      <Suspense fallback={<NotePageFallback />}>
        <NotePage />
        <ChunkLoadBeacon />
      </Suspense>
    </NoteRouteErrorBoundary>
  );
}

/**
 * `/p/:token` 的 route element（#72 Task 3）：**專屬** fallback／錯誤邊界——
 * NotePageFallback／NoteRouteErrorBoundary 都包 AppShell（打 `/api/auth/me`、露側欄），
 * 匿名頁不得重用（理由與零 fetch 守衛見 PublicNoteShell.tsx／App.publicRoute.test.tsx）。
 * 不掛 ChunkLoadBeacon／自動 reload 額度：那套旗標機制是 NotePage 專屬，公開頁用
 * 錯誤卡上的手動重試（整頁 reload）即可。
 */
function PublicNoteRoute() {
  return (
    <PublicNoteErrorBoundary>
      <Suspense fallback={<PublicNoteFallback />}>
        <PublicNotePage />
      </Suspense>
    </PublicNoteErrorBoundary>
  );
}

/**
 * 兩棵 `<Routes>` 並列（spec §13.4，逐字落地——改這段前先讀那節，尤其
 * modal-over-background 機制那段）：
 *
 * - **主樹**：render 背景頁，吃 `<Routes location={state?.backgroundLocation ?? location}>`
 *   ——帶 `location` prop 的 `<Routes>` 會覆寫 React Router 的 `LocationContext`；
 *   guards.tsx 本身不讀 location（只 import `Navigate`/`Outlet`），但主樹底下的
 *   route matching 與 `<Navigate>` 解析都是吃這個被覆寫後的 router context，
 *   因此仍然是**背景** location 生效，不是瀏覽器目前真實的 `/settings/*`
 *   網址——這個相依是「開設定時背景頁繼續照它本來的路徑渲染」成立的前提，
 *   **改動 guard 或這段 location 邏輯前務必先確認沒有破壞這個相依**。
 * - **第二棵樹**：只含 `/settings/*`，吃真實 location（不帶 `location` prop）；
 *   非 `/settings/*` 路徑下整棵 match 不到任何 route → render `null`，樹內的
 *   guard 元件根本不會執行，不會有幽靈重導。guard 元件在這裡
 *   直接複用同一份，以 pathless layout route 掛上——不是塞進主樹。
 *
 * `/settings/*` **絕不可加進主樹**：加進去背景頁就不會渲染，modal-over-background
 * 整個破功。既有 `/admin/users` route 改為 `<Navigate to="/settings/users" replace/>`
 * （書籤不斷；`RequireAdmin` 包裹保留不動）。
 *
 * 現行守衛集合（主樹）：<RequireAuth> 包住除 /login 外的其餘路由（未登入導
 * /login）；`/admin/users`（Task 15）再多包一層 <RequireAdmin>（非 admin 導 `/`）
 * ——巢狀在 <RequireAuth> 底下，即使 <RequireAdmin> 自己也有未登入判斷（見
 * guards.tsx），這裡是雙保險而非依賴它獨立生效。這條路由必須排在 `/*` catch-all
 * 之前，否則永遠會被 HomePage 吃掉。
 *
 * `/change-password`（spec rev 5.7）巢狀在 <RequireAuth> 底下、但刻意掛在
 * <ChangePasswordGate> **外面**（與它平行，不是它的 <Outlet/> 子路由）——這條路由本身
 * 就是 `mustChangePassword` 使用者被導去的目的地，若巢狀在 gate 裡面會造成「導向自己」
 * 的迴圈。<ChangePasswordGate> 包住其餘（除 /login、/change-password 外）的
 * 路由：`user.mustChangePassword === true` 時全部導向 `/change-password`——比照
 * <RequireAdmin> 的模式。
 */
export function AppRoutes() {
  const location = useLocation();
  const state = location.state as { backgroundLocation?: Location } | null;

  return (
    <>
      <Routes location={state?.backgroundLocation ?? location}>
        <Route path="/login" element={<LoginPage />} />
        {/* #72：公開分享頁與 /login 同層、排在 RequireAuth **之前**（D2 定案）——
            匿名訪客免登入直達；spa.ts 的 EXCLUDED_PREFIXES 不含 /p，SPA fallback
            照常服務這條路徑（noindex 標頭在 server 端，前綴比對天然涵蓋兩段形）。
            #122 PR3：別名雙段形與 token 單段形以**段數**區分，共用同一個 route
            element——形的判別在 PublicNotePage 的 useParams。 */}
        <Route path="/p/:token" element={<PublicNoteRoute />} />
        <Route path="/p/:handle/:slug" element={<PublicNoteRoute />} />
        <Route element={<RequireAuth />}>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route element={<ChangePasswordGate />}>
            {/* `/notes/:ref`（舊形，永久相容：legacy slug、`<vanity>-<uuid>`、純 uuid）
                與 `/n/:handle/:slug`（#122 新形）共用 NoteRoute/NotePage——兩條 route
                並存、明文不依賴 remount（react-router 依 specificity 排序，兩者都不會
                被 `/*` catch-all 吃掉；route 承接測試釘住）。 */}
            <Route path="/notes/:ref" element={<NoteRoute />} />
            <Route path="/n/:handle/:slug" element={<NoteRoute />} />
            <Route element={<RequireAdmin />}>
              <Route path="/admin/users" element={<Navigate to="/settings/users" replace />} />
            </Route>
            <Route path="/*" element={<HomePage />} />
          </Route>
        </Route>
      </Routes>
      {/* 第二棵樹：只含 /settings/*，吃真實 location；非 /settings/* 路徑下整棵
          match 不到 → render null，guard 不會跑（無幽靈重導）。guard 元件直接複用。 */}
      <Routes>
        <Route element={<RequireAuth />}>
          <Route element={<ChangePasswordGate />}>
            <Route element={<SettingsModal />}>
              {/* Dialog 外殼＝layout route，區塊切換不重掛 */}
              <Route path="/settings/account" element={<SettingsAccountSection />} />
              <Route element={<RequireAdmin />}>
                <Route path="/settings/users" element={<SettingsUsersSection />} />
                <Route path="/settings/ai" element={<SettingsAiSection />} />
              </Route>
            </Route>
          </Route>
        </Route>
        {/* 與上面那棵 pathless `<RequireAuth>` 平行（不是它的子路由）：純粹吸收
            react-router 對非 /settings/* 路徑的「No routes matched」warning——
            這棵樹本來就設計成那些路徑下什麼都不 render，這是預期行為，不是漏
            接的路由。element 固定 `null`，**絕不可**塞進任何 guard 底下：guard
            會在每個非 /settings/* 頁面都執行一次（session query、可能的
            <Navigate>），那就是貨真價實的幽靈重導，違反本樹「非
            /settings/* 時 guard 不跑」的設計前提。 */}
        <Route path="*" element={null} />
      </Routes>
    </>
  );
}

export default function App() {
  // AppErrorBoundary 在**最外層**（issue #66）：ThemeProvider／Toaster 自己丟錯也要
  // 接得住，任何 render 錯誤不再白屏。它的 fallback 零 context 相依，放 Router 外
  // 是安全的。App.appBoundary.test.tsx 案 12 守著這層接線。
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          {/* #122：ActiveNoteContext 包住 AppRoutes 全部（兩棵 Routes 樹之外一層）——
              設定 modal 的第二棵樹也在內，關 modal 回到筆記頁時高亮狀態不掉。
              公開頁（/p/…）在樹內但不消費不 set（明文，見 lib/active-note.tsx）。 */}
          <ActiveNoteProvider>
            <AppRoutes />
          </ActiveNoteProvider>
        </BrowserRouter>
        <Toaster />
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
