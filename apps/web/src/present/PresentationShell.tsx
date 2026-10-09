import {
  Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type MouseEvent as ReactMouseEvent, type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useOnline } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { Maximize, Minimize, X } from "@/components/ui/icons";
import { useHistoryLocationKey, useRealLocation } from "@/lib/real-location";
import { cn } from "@/lib/utils";
import {
  enterPresentationFullscreen, exitOwnedFullscreen, isOwnedFullscreen, msSinceFullscreenExit, subscribeFullscreen,
} from "./fullscreen";
import {
  exitFullscreenIfLeftPresentation, isPresentingSearch, PRESENT_SEARCH, searchWithoutPresent, wasPresentPushed,
} from "./present-url";

/**
 * #229 簡報外殼（spec §6.1）——入口側、全頁唯一一個、**不** import reveal。
 * - 全視窗 `role="dialog" aria-modal`、`z-[60]`（高於抽屜與 dialog 的 z-50、低於 toast 的 z-[100]，§6.6-8）；
 *   存在時 AppShell 的 Ctrl+K 放棄（`[role="dialog"]` 判斷，§2.4-1）。
 * - 載入、錯誤、chunk 失敗、config 拒絕都是外殼的內容；任何狀態下 × 與 Esc 都能離開（§17-8）。
 * - 任何時刻只有一個 Esc 入口：reveal 宣告就緒（onRevealReady(true)）之前由外殼的 document 監聽處理，
 *   之後由 reveal 的 keyboard[27] 呼叫同一個 onEsc；離開冪等（leftRef）。
 * - 掛上後正規化查詢字串成恰好 `?present`（§6.4-1、F14），導覽在途時延後（同 NotePage 收斂的守衛）。
 * - 卸載時走卸載型全螢幕呼叫點（讀真實網址，§6.5）。
 */
export const ESC_AFTER_FULLSCREEN_EXIT_MS = 300;
const TOOLBAR_IDLE_MS = 2000;

export interface PresentationShellContextValue {
  /** overlay 在 initialize resolve 且未拆時送 true、拆除時（只有送過 true 的那份）送 false（§6.9）。 */
  onRevealReady(ready: boolean): void;
  /** reveal 的 keyboard[27]（總覽開著時 overlay 自己先關總覽）。 */
  onEsc(): void;
  /** 無法播放（§6.4-1 查詢字串斷言、§6.4-3 config 核對）：外殼切錯誤態、卸載 overlay。 */
  onFatal(messageKey: string): void;
  /** F 鍵與全螢幕鈕（§6.6-2）。 */
  toggleFullscreen(): void;
}

const PresentationShellContext = createContext<PresentationShellContextValue | null>(null);

export function usePresentationShell(): PresentationShellContextValue {
  const value = useContext(PresentationShellContext);
  if (!value) throw new Error("PresentationOverlay must be rendered inside PresentationShell");
  return value;
}

export type PresentationShellStatus = "loading" | "error" | "ready";

export interface PresentationShellProps {
  title: string;
  status: PresentationShellStatus;
  errorMessage?: string;
  /** 工具列左側插槽（已登入：連線徽章，A9）。 */
  toolbarExtra?: ReactNode;
  /** 只在 status === "ready" 且沒有 fatal 時渲染（播放態：lazy 的 PresentationOverlay）。 */
  children?: ReactNode;
}

export function PresentationShell({ title, status, errorMessage, toolbarExtra, children }: PresentationShellProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const realLocation = useRealLocation();
  const navigate = useNavigate();
  const readHistoryKey = useHistoryLocationKey();
  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef(false);
  const [revealReady, setRevealReady] = useState(false);
  const [fatalKey, setFatalKey] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);

  // 每次 render 同步寫入（離開時要讀**最新**的 location 與 navigate，不是 callback 建立當下的）。
  const latestRef = useRef({ location, navigate });
  latestRef.current = { location, navigate };

  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    exitOwnedFullscreen(); // §6.5 呼叫點 1：導頁之前
    const { location: latest, navigate: go } = latestRef.current;
    if (wasPresentPushed(latest.state)) void go(-1);
    else void go({ pathname: latest.pathname, search: searchWithoutPresent(latest.search), hash: "" }, { replace: true });
  }, []);

  const onEsc = useCallback(() => {
    if (document.fullscreenElement) return; // 瀏覽器正在用這一下 Esc 退全螢幕
    if (msSinceFullscreenExit() < ESC_AFTER_FULLSCREEN_EXIT_MS) return; // 兩種事件順序都只退一段（§6.6-1）
    leave();
  }, [leave]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenEnabled) return;
    if (isOwnedFullscreen()) exitOwnedFullscreen();
    else enterPresentationFullscreen();
  }, []);

  const context = useMemo<PresentationShellContextValue>(
    () => ({ onRevealReady: setRevealReady, onEsc, onFatal: setFatalKey, toggleFullscreen }),
    [onEsc, toggleFullscreen],
  );

  useEffect(() => {
    if (revealReady) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEsc();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [revealReady, onEsc]);

  const lastNormalizeRef = useRef<string | null>(null);
  useEffect(() => {
    if (leftRef.current) return;
    if (!isPresentingSearch(location.search) || location.search === PRESENT_SEARCH) return;
    const historyKey = readHistoryKey();
    if (historyKey !== undefined && historyKey !== (realLocation ?? location).key) return; // 導覽在途，等下一次 render
    const write = `${location.key}\n${location.pathname}`;
    if (lastNormalizeRef.current === write) return;
    lastNormalizeRef.current = write;
    void navigate(
      { pathname: location.pathname, search: PRESENT_SEARCH, hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location, navigate, readHistoryKey, realLocation]);

  useEffect(() => () => exitFullscreenIfLeftPresentation(), []);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIdle(true), TOOLBAR_IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(idleTimerRef.current);
  }, [wake]);

  const ownedFullscreen = useSyncExternalStore(subscribeFullscreen, isOwnedFullscreen, () => false);
  const fullscreenEnabled = document.fullscreenEnabled === true;
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault(); // §6.7：滑鼠點擊不移動焦點
  const label = title.trim() === "" ? t("note.titlePlaceholder") : title;
  const errorText = fatalKey !== null ? t(fatalKey) : status === "error" ? errorMessage : undefined;

  return (
    <PresentationShellContext.Provider value={context}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("present.dialogLabel", { title: label })}
        tabIndex={-1}
        onMouseMove={wake}
        className="fixed inset-0 z-[60] flex flex-col bg-card text-foreground outline-none"
      >
        {/* 閒置淡出（§6.7）：spec 寫 focus-visible 浮現；這裡用 focus-within——鍵盤焦點在任一顆按鈕上時整列都浮現，範圍較寬、符合意圖。 */}
        <div
          className={cn(
            "absolute right-3 top-3 z-10 flex items-center gap-2 transition-opacity hover:opacity-100 focus-within:opacity-100",
            idle ? "opacity-0" : "opacity-100",
          )}
        >
          {toolbarExtra}
          {fullscreenEnabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={ownedFullscreen ? t("present.exitFullscreen") : t("present.enterFullscreen")}
              onMouseDown={keepFocus}
              onClick={() => {
                toggleFullscreen();
                rootRef.current?.focus();
              }}
            >
              {ownedFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" aria-label={t("present.close")} onMouseDown={keepFocus} onClick={leave}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
        {errorText !== undefined ? (
          <p role="alert" className="m-auto px-6 text-sm text-destructive">
            {errorText}
          </p>
        ) : status === "loading" ? (
          <p className="m-auto text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : (
          <div className="relative min-h-0 flex-1">{children}</div>
        )}
      </div>
    </PresentationShellContext.Provider>
  );
}

interface PresentationErrorBoundaryProps {
  /** 測試 seam（比照 PublicNoteErrorBoundary）：jsdom 的 location.reload 不可 spy。 */
  reload?: () => void;
  children: ReactNode;
}

/**
 * 公開頁簡報的錯誤邊界（spec §6.2 末段）：公開頁不用 chunk 自動 reload 額度，錯誤文字＋手動重試（整頁 reload）。
 * 離開由外殼的 × 與 Esc 提供。文案沿用 public.loadError／app.retry（起草裁定 5）。
 */
export class PresentationErrorBoundary extends Component<PresentationErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  private handleRetry = () => {
    (this.props.reload ?? (() => window.location.reload()))();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return <PresentationErrorFallback onRetry={this.handleRetry} />;
  }
}

function PresentationErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  // 離線時 reload 只會把頁面換成瀏覽器的網路錯誤頁——比照 PublicNoteErrorFallback 與 ErrorBoundary 的
  // 錯誤畫面，按鈕灰掉並以文字說明，恢復連線（online 事件）即重新啟用。
  const online = useOnline();
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <p className="text-sm text-muted-foreground">{t("public.loadError")}</p>
      <Button type="button" variant="outline" disabled={!online} onClick={onRetry}>
        {t("app.retry")}
      </Button>
      {!online && <p className="text-sm text-muted-foreground">{t("app.offlineHint")}</p>}
    </div>
  );
}
