import { Component, useEffect, type ReactNode } from "react";
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
 * 30–75 秒也一樣），不依賴時鐘。per-chunk 命名：將來第二條 lazy route 各自有額度。
 * 測試刻意寫字面 key（釘住 key 名不被改），這裡不匯出常數。
 */
const CHUNK_RELOAD_FLAG = "knotebook:chunk-reload:notepage";

/**
 * 三大瀏覽器對動態 import 失敗的訊息樣式（Chromium／Firefox／Safari）。訊息比對
 * 天生脆弱——措辭改變時退化成非 chunk 分支的手動重試，fail 到安全側（不會白屏），
 * 已記 docs/known-limitations.md。
 */
const CHUNK_ERROR_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
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

  static getDerivedStateFromError(): Partial<NoteRouteErrorBoundaryState> {
    return { status: "pending" };
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
      this.setState({ status: "reloading", isChunkError: true });
    } catch {
      // 實際沒 reload 成：旗標留著會偷走同分頁下次真失敗的救援額度，清回
      clearReloadFlag();
      this.setState({ status: "error", isChunkError: true });
    }
  }

  componentDidUpdate(prevProps: NoteRouteErrorBoundaryProps) {
    // 僅 error 態反應 resetKey（=使用者在錯誤畫面上導航去別的筆記）：reload 讓整頁
    // 重載落在新網址，chunk 與 runtime 崩潰一律救得回。不清旗標——落地若又失敗，
    // 新文件看到旗標直接進錯誤畫面（收斂）；旗標由成功路徑的 beacon 清。
    // `reloading`／`pending` 態一律不動作。
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
  return (
    <AppShell>
      <div role="alert" className="flex flex-col items-start gap-3 p-6">
        <p className="text-sm text-muted-foreground">{t(isChunkError ? "app.chunkLoadError" : "app.noteCrash")}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("app.retry")}
        </Button>
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
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div role="alert" className="flex flex-col items-center gap-4 rounded-lg border p-8 text-center">
        <p className="text-base font-medium text-foreground">{t("app.crashTitle")}</p>
        <Button type="button" variant="outline" onClick={onReload}>
          {t("app.reload")}
        </Button>
      </div>
    </div>
  );
}
