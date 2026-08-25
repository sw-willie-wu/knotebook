import { Component, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppShell } from "./AppShell";
import { Button } from "./ui/button";
import { NotePageFallback } from "./NotePageFallback";

/**
 * Issue #66：NotePage 切成 lazy chunk（#19）之後，chunk fetch 失敗（離線、部署輪替
 * 讓舊 index.html 指向已不存在的 hash）會讓 import() reject——沒有 boundary 接的話
 * React 卸載整棵樹、白屏。這裡的 NoteRouteErrorBoundary 接住它：部署輪替情境自動
 * reload 一次（sessionStorage 旗標防迴圈），其餘落到「載入失敗＋重試」畫面。
 * AppErrorBoundary 則是 app 級兜底——任何 render 錯誤不再白屏。
 */

/**
 * 旗標語意（clear-on-success，構造性防迴圈）：componentDidCatch 在自動 reload 前設
 * 旗標，**只有 chunk 真的載入成功**（ChunkLoadBeacon commit）才清——所以「每次成功
 * 載入之後最多一次自動 reload」，不管兩次失敗隔多久（chunk 請求 stall 到瀏覽器逾時
 * 30–75 秒也一樣），不依賴時鐘。
 *
 * 精確地說額度是 **per-route-mount** 不是 per-chunk：清除點＝NotePage 這條 route
 * 成功 commit，涵蓋的卻是 boundary 接到的任何錯誤。若將來 NotePage 掛載成功後還有
 * 「render 期同步 throw 的巢狀 chunk」，會形成 失敗→reload→掛載成功清額度→再失敗
 * 的迴圈——加巢狀 lazy 前要重看這段。（現有的巢狀動態 import——語法高亮那兩個
 * chunk——失敗是 promise rejection 不經 render，boundary 接不到，不在此列，也因此
 * 不在本機制的涵蓋範圍內。）key 的 route 別名（:notepage）讓將來第二條 lazy route
 * 各自有額度。測試刻意寫字面 key（釘住 key 名不被改），這裡不匯出常數。
 */
const CHUNK_RELOAD_FLAG = "knotebook:chunk-reload:notepage";

/**
 * chunk 載入失敗的訊息樣式。前三條是三大瀏覽器對裸動態 import 失敗的措辭
 * （Chromium／Firefox／Safari）；後兩條**不可省**（PR #67 獨立審查抓到的 blocking）：
 * - `unable to preload css for`：NotePage chunk 帶 CSS dep，build 後走 Vite 的
 *   __vitePreload——CSS <link> 先被 await，一失敗就以 Vite 自己的這條訊息 reject，
 *   真正的 import() 根本不會執行。離線時 CSS 必炸，部署輪替時只要 CSS hash 變了
 *   也是這條——**issue #66 的兩個具名情境實際上多半走這裡**，漏掉它自動 reload
 *   等於不存在。
 * - `failed to load module script`：反代 try_files 型自架部署（nginx 把 404 的
 *   /assets/*.js 回成 200+text/html）產生的 MIME 錯誤。
 * 訊息比對天生脆弱——措辭改變時退化成非 chunk 分支的手動重試，fail 到安全側
 * （不會白屏），已記 docs/known-limitations.md。
 */
const CHUNK_ERROR_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "unable to preload css for",
  "failed to load module script",
];

function messageMatchesChunkError(value: unknown): boolean {
  const message = (value as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string") return false;
  const lower = message.toLowerCase();
  return CHUNK_ERROR_PATTERNS.some(pattern => lower.includes(pattern));
}

function isChunkLoadError(error: unknown): boolean {
  // cause 也查一層：包裝過的錯誤（例如上游 wrapper 把原錯誤降級成 cause）不漏接
  return (
    messageMatchesChunkError(error) ||
    messageMatchesChunkError((error as { cause?: unknown } | null | undefined)?.cause)
  );
}

/** 讀旗標；sessionStorage 不可用（隱私模式）時回 "unavailable"——呼叫端視同已 reload 過，絕不自動 reload（無旗標可寫＝防不了迴圈）。 */
function readReloadFlag(): boolean | "unavailable" {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_FLAG) !== null;
  } catch {
    return "unavailable";
  }
}

/** 設旗標；寫失敗回 false（呼叫端同上，不 reload）。 */
function setReloadFlag(): boolean {
  try {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1");
    return true;
  } catch {
    return false;
  }
}

function clearReloadFlag(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
  } catch {
    // 清不掉就算了：方向安全（少一次自動 reload，不會多）
  }
}

/**
 * chunk 成功載入的信標——**必須擺在 `<Suspense>` 內、`<NotePage>` 旁**：lazy reject
 * 時 Suspense 內子樹不 commit、這個 effect 不執行，旗標才不會在失敗發生前被清。
 * 錯放到 Suspense 外（哪怕仍在 boundary 內）effect 會在 lazy 還 pending 時就跑
 * → 旗標先被清 → 每次 reload 落地都重新武裝 → 無限重整迴圈（審查探針實測）。
 * App.tsx 的實際擺放由 App.errorBoundary.test.tsx 案 11 守。
 */
export function ChunkLoadBeacon() {
  useEffect(() => {
    clearReloadFlag();
  }, []);
  return null;
}

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * 兩個錯誤畫面的重試/重整鈕在離線時要 disabled：沒有 service worker，離線 reload
 * 不是重試而是把整個 SPA 換成瀏覽器的網路錯誤頁（連錯誤畫面與側欄都沒了）——
 * 而 chunk 分支文案正好在叫使用者「check your connection」，不能引導他去按一顆
 * 會炸掉 app 的鈕。恢復連線（online 事件）即重新啟用。
 */
function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine !== false);
}

type BoundaryStatus = "normal" | "pending" | "reloading" | "error";

interface NoteRouteErrorBoundaryProps {
  /** `/notes/:ref` 的 ref。刻意不用 location.key：關設定 modal 的 navigate(backgroundLocation) 會產生新 key，會把「關 modal」誤判成「換筆記」（實測）。 */
  resetKey: string | undefined;
  /** 測試 seam：jsdom 30 下 location.reload 是 non-configurable、spy 不進去，只能注入。 */
  reload?: () => void;
  children: ReactNode;
}

interface NoteRouteErrorBoundaryState {
  status: BoundaryStatus;
  isChunkError: boolean;
}

function defaultReload() {
  location.reload();
}

/**
 * NotePage 的崩潰處理器——接的不只 chunk 載入失敗：NotePage 底下任何 render 錯誤
 * （BlockNote／共編）都落進來，文案分 chunk／非 chunk 兩支。
 *
 * 三態時序：錯誤發生 → getDerivedStateFromError 設 `pending`（它是唯一動作——dev
 * 模式下一次錯誤會呼叫它**兩次**，副作用放這裡會翻倍）→ componentDidCatch（恰一次）
 * 做分類與副作用，轉 `reloading` 或 `error`。`pending` 必須 render fallback，
 * **絕不能**「先繼續 render children 等分類結果」——children 立刻再 throw → gDSFE
 * 無限 re-render，componentDidCatch 根本不會被呼叫（實測）。
 */
export class NoteRouteErrorBoundary extends Component<NoteRouteErrorBoundaryProps, NoteRouteErrorBoundaryState> {
  state: NoteRouteErrorBoundaryState = { status: "normal", isChunkError: false };

  static getDerivedStateFromError(): NoteRouteErrorBoundaryState {
    // isChunkError 一併歸零：雖然現行流程進 error/reloading 後 children 不再
    // render、二次錯誤理論上不可達，但不留一個靠「不可達」成立的殘值
    return { status: "pending", isChunkError: false };
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) {
      this.setState({ status: "error", isChunkError: false });
      return;
    }
    // 離線短路（在設旗標之前——離線看一次筆記不該燒掉之後線上的自動 reload 額度）。
    // navigator.onLine 只是廉價的負向訊號：false 必離線（reload 只會落到瀏覽器錯誤
    // 頁），true 不保證在線（captive portal 騙得過）——所以只拿它擋 reload，不拿它
    // 保證什麼。
    if (navigator.onLine === false) {
      this.setState({ status: "error", isChunkError: true });
      return;
    }
    const flag = readReloadFlag();
    if (flag === true || flag === "unavailable" || !setReloadFlag()) {
      this.setState({ status: "error", isChunkError: true });
      return;
    }
    try {
      this.doReload();
      // reloading 是終態（到頁面卸載為止都 render 載入畫面，無逾時逃生口）。目前
      // app 內沒有 beforeunload，reload 不會被使用者取消；若日後為「未儲存變更」
      // 加上 beforeunload，按「留在此頁」的使用者會永久卡在載入畫面——屆時這裡
      // 要補逃生口。
      this.setState({ status: "reloading", isChunkError: true });
    } catch {
      // 實際沒 reload 成：旗標留著會偷走同分頁下次真失敗的救援額度，清回
      clearReloadFlag();
      this.setState({ status: "error", isChunkError: true });
    }
  }

  componentDidUpdate(prevProps: NoteRouteErrorBoundaryProps) {
    // 僅 error 態反應 resetKey（=使用者在錯誤畫面上導航去別的筆記）：reload 讓整頁
    // 重載落在新網址，chunk 與 runtime 崩潰一律救得回。「落在新網址」成立的前提是
    // react-router 的 pushState 同步發生在 React 提交之前，componentDidUpdate 跑到
    // 時 location.href 已是新網址（v7 BrowserRouter 如此；改路由層時要重驗）。
    // 不清旗標——落地若又失敗，新文件看到旗標直接進錯誤畫面（收斂）；旗標由成功
    // 路徑的 beacon 清。`reloading`／`pending` 態一律不動作。
    if (this.state.status !== "error") return;
    if (prevProps.resetKey === this.props.resetKey) return;
    if (navigator.onLine === false) return; // 離線 reload 必死，留在錯誤畫面
    try {
      this.doReload();
    } catch {
      // lifecycle 丟的錯不會被自己接住、會冒到 AppErrorBoundary——把「換筆記」變成
      // 整個 app 的崩潰畫面。吞掉，維持 error 態。
    }
  }

  private doReload() {
    (this.props.reload ?? defaultReload)();
  }

  private handleRetry = () => {
    // 使用者明確要求全新開始：清旗標，讓落地後的自動 reload 額度回滿
    clearReloadFlag();
    this.doReload();
  };

  render() {
    const { status, isChunkError } = this.state;
    if (status === "normal") return this.props.children;
    if (status === "error") {
      return <NoteRouteErrorFallback isChunkError={isChunkError} onRetry={this.handleRetry} />;
    }
    // pending／reloading：與 chunk 載入中同一種畫面，不閃錯誤
    return <NotePageFallback />;
  }
}

function NoteRouteErrorFallback({ isChunkError, onRetry }: { isChunkError: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  const online = useOnline();
  return (
    <AppShell>
      {/* PR2（G 節，M5 第四個呼叫端）：跟 NotePage/HomePage/NotePageFallback 同一款
          內文卡——main 已無自身捲動，長錯誤內容改由卡自己捲（overflow-y-auto）。
          內容本身不動。 */}
      <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card">
        <div role="alert" className="flex flex-col items-start gap-3 p-6">
          <p className="text-sm text-muted-foreground">{t(isChunkError ? "app.chunkLoadError" : "app.noteCrash")}</p>
          <Button type="button" variant="outline" size="sm" disabled={!online} onClick={onRetry}>
            {t("app.retry")}
          </Button>
          {/* disabled 的按鈕不可聚焦、螢幕閱讀器拿不到原因——離線時要用文字說明它為何灰掉 */}
          {!online && <p className="text-sm text-muted-foreground">{t("app.offlineHint")}</p>}
        </div>
      </div>
    </AppShell>
  );
}

interface AppErrorBoundaryProps {
  reload?: () => void;
  children: ReactNode;
}

/**
 * app 級兜底：包在 App() 最外層（ThemeProvider／Toaster 都在內——它們自己丟錯也要
 * 接得住）。fallback 零 context 相依：不用 AppShell（相依 auth/query，錯誤可能正來
 * 自那裡）；主題靠 documentElement 的 class 套用非 context、i18n 是模組單例、Button
 * 無 context，都安全。不做自動 reload——非 chunk 錯誤自動 reload 會把持續性 render
 * bug 變成無限重整（chunk 錯誤到不了這裡：內層 NoteRouteErrorBoundary 先接走）。
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  private handleReload = () => {
    (this.props.reload ?? defaultReload)();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return <AppErrorFallback onReload={this.handleReload} />;
  }
}

function AppErrorFallback({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation();
  const online = useOnline();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div role="alert" className="flex flex-col items-center gap-4 rounded-lg border p-8 text-center">
        <p className="text-base font-medium text-foreground">{t("app.crashTitle")}</p>
        <Button type="button" variant="outline" disabled={!online} onClick={onReload}>
          {t("app.reload")}
        </Button>
        {!online && <p className="text-sm text-muted-foreground">{t("app.offlineHint")}</p>}
      </div>
    </div>
  );
}
