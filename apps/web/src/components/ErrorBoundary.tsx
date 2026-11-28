import { SAFE_PAGE_PADDING, SAFE_PAGE_PADDING_COMPACT } from "@/components/ui/safe-area";
import { Component, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { cardSurface } from "./ui/card";
import { cn } from "@/lib/utils";
import { NotePageFallback } from "./NotePageFallback";
import { NarrowTopBar } from "./NarrowTopBar";


/**
 * Flag is cleared only when the chunk really loaded (ChunkLoadBeacon commit), so there is at most one automatic reload after each successful load regardless of timing (no clock).
 * The quota is per route mount, not per chunk: a nested chunk that throws synchronously during render after mount would loop (fail, reload, mount clears quota, fail). Check this before adding nested lazy.
 * Precondition (#201): no lazy that renders only after another lazy mounted may share a quota. The `chunk` alias gives each lazy route its own quota. Settings (`chunk="settings"`) and admin (`chunk="admin"`, #247) each have one quota shared across their sibling sections (admin's sections are one `AdminSections` chunk), because the sections are sibling route elements: after the beacon clears, a failing sibling reloads onto the failing URL and a second failure sees the flag. Multi-mount aliases (`versions` is nested under NotePage, so it uses its own alias; also `trash`, `select`, `bodySearch`) `import()` one module from every mount point, so once one succeeds the others cannot fail. Nested dynamic imports (syntax highlighting) fail as promise rejections, not render errors, and are out of scope.
 * Tests use literal chunk keys (pinning the names), so no constants are exported.
 */
const DEFAULT_CHUNK = "notepage";

function chunkReloadFlag(chunk: string): string {
  return `knotebook:chunk-reload:${chunk}`;
}

/** The last two patterns are required (PR #67): `unable to preload css for` is Vite `__vitePreload` rejecting on a CSS dependency before the import runs (most offline and deploy-rotation cases, #66); `failed to load module script` is nginx try_files serving 404 as text/html. Wording changes degrade to the manual-retry branch (docs/known-limitations.md). */
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
  return (
    messageMatchesChunkError(error) ||
    messageMatchesChunkError((error as { cause?: unknown } | null | undefined)?.cause)
  );
}

/** "unavailable" (private mode) is treated as already reloaded: with no flag there is no loop protection. */
function readReloadFlag(chunk: string): boolean | "unavailable" {
  try {
    return sessionStorage.getItem(chunkReloadFlag(chunk)) !== null;
  } catch {
    return "unavailable";
  }
}

function setReloadFlag(chunk: string): boolean {
  try {
    sessionStorage.setItem(chunkReloadFlag(chunk), "1");
    return true;
  } catch {
    return false;
  }
}

function clearReloadFlag(chunk: string): void {
  try {
    sessionStorage.removeItem(chunkReloadFlag(chunk));
  } catch {
    // Safe direction: at worst one fewer automatic reload.
  }
}

/** Must sit inside `<Suspense>` next to `<NotePage>`: outside it (even if still inside the error boundary) the effect runs while lazy is pending, clears the flag, and every reload re-arms it (endless loop). Pinned in App.errorBoundary.test.tsx. `chunk` must match the route boundary. */
export function ChunkLoadBeacon({ chunk = DEFAULT_CHUNK }: { chunk?: string }) {
  useEffect(() => {
    clearReloadFlag(chunk);
  }, [chunk]);
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

/** Offline, a reload replaces the SPA with the browser error page (no service worker), so the button stays disabled until the online event. The chunk-error text tells the user to check the connection, so it must not lead to a button that destroys the app. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine !== false);
}

type BoundaryStatus = "normal" | "pending" | "reloading" | "error";

/** `app` is the content card only: the page already sits inside AppShellLayout's AppShell, so the frame must not add another. `page` frame must not wrap AppShell (it calls `/api/auth/me` and exposes the sidebar; login pages are reachable signed out). */
export type LazyRouteFrame = "app" | "page" | "inline";

interface LazyRouteErrorBoundaryProps {
  /** Identifies the destination (for NotePage see NoteRoute in App.tsx); reload happens only while in the error state (see componentDidUpdate). Not `location.key`: closing the settings modal creates a new key and would read as "switching notes". */
  resetKey: string | undefined;
  /** Same value as the route `ChunkLoadBeacon`. */
  chunk?: string;
  frame?: LazyRouteFrame;
  /** jsdom `location.reload` is non-configurable, so inject it. */
  reload?: () => void;
  crashMessageKey?: string;
  inlineErrorClassName?: string;
  children: ReactNode;
}

interface LazyRouteErrorBoundaryState {
  status: BoundaryStatus;
  isChunkError: boolean;
}

function defaultReload() {
  location.reload();
}

/**
 * A `beforeunload` prompt (running uploads) can cancel the reload and leave this page alive; the loading screen would
 * then stay forever. The reload flag is left set: a reload that is only slow would otherwise earn another automatic one.
 */
const RELOAD_ESCAPE_MS = 5_000;

/** Catches any render error below, not only chunk load failures. `pending` must render the fallback, never children: they would throw again and gDSFE would loop without componentDidCatch running. getDerivedStateFromError only sets `pending` (dev calls it twice). */
export class LazyRouteErrorBoundary extends Component<LazyRouteErrorBoundaryProps, LazyRouteErrorBoundaryState> {
  state: LazyRouteErrorBoundaryState = { status: "normal", isChunkError: false };
  private reloadEscape: ReturnType<typeof setTimeout> | undefined;

  private get chunk(): string {
    return this.props.chunk ?? DEFAULT_CHUNK;
  }

  static getDerivedStateFromError(): LazyRouteErrorBoundaryState {
    return { status: "pending", isChunkError: false };
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) {
      this.setState({ status: "error", isChunkError: false });
      return;
    }
    // Offline check comes before setting the flag so an offline view does not burn the quota. `navigator.onLine` is only a negative signal (true can be a captive portal).
    if (navigator.onLine === false) {
      this.setState({ status: "error", isChunkError: true });
      return;
    }
    const flag = readReloadFlag(this.chunk);
    if (flag === true || flag === "unavailable" || !setReloadFlag(this.chunk)) {
      this.setState({ status: "error", isChunkError: true });
      return;
    }
    try {
      this.doReload();
      this.setState({ status: "reloading", isChunkError: true });
      this.reloadEscape = setTimeout(() => {
        this.reloadEscape = undefined;
        if (this.state.status === "reloading") this.setState({ status: "error", isChunkError: true });
      }, RELOAD_ESCAPE_MS);
    } catch {
      // Clear the flag if the reload did not happen, otherwise it steals the next failure rescue.
      clearReloadFlag(this.chunk);
      this.setState({ status: "error", isChunkError: true });
    }
  }

  componentWillUnmount() {
    clearTimeout(this.reloadEscape);
  }

  componentDidUpdate(prevProps: LazyRouteErrorBoundaryProps) {
    // A reload lands on the new URL because react-router pushes state before React commits (v7 BrowserRouter; recheck if the router layer changes). The flag is intentionally not cleared: a failing landing goes straight to the error screen.
    if (this.state.status !== "error") return;
    if (prevProps.resetKey === this.props.resetKey) return;
    if (navigator.onLine === false) return; // an offline reload is sure to fail: stay on the error screen
    try {
      this.doReload();
    } catch {
      // Lifecycle errors are not caught by this boundary and would crash the whole app: swallow and stay in error.
    }
  }

  private doReload() {
    (this.props.reload ?? defaultReload)();
  }

  // An explicit retry refills the automatic-reload quota.
  private handleRetry = () => {
    clearReloadFlag(this.chunk);
    this.doReload();
  };

  render() {
    const { status, isChunkError } = this.state;
    const frame = this.props.frame ?? "app";
    if (status === "normal") return this.props.children;
    if (status === "error") {
      return (
        <LazyRouteErrorFallback
          frame={frame}
          isChunkError={isChunkError}
          onRetry={this.handleRetry}
          crashMessageKey={this.props.crashMessageKey}
          inlineErrorClassName={this.props.inlineErrorClassName}
        />
      );
    }
    return <LazyRouteLoading frame={frame} />;
  }
}

export const NoteRouteErrorBoundary = LazyRouteErrorBoundary;

function PageFrame({ children }: { children: ReactNode }) {
  return <main className={`flex min-h-screen items-center justify-center ${SAFE_PAGE_PADDING}`}>{children}</main>;
}

export function LazyRouteLoading({ frame = "app" }: { frame?: LazyRouteFrame }) {
  const { t } = useTranslation();
  if (frame === "app") return <NotePageFallback />;
  const text = <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  return frame === "page" ? <PageFrame>{text}</PageFrame> : text;
}

function LazyRouteErrorFallback({
  frame,
  isChunkError,
  onRetry,
  crashMessageKey,
  inlineErrorClassName,
}: {
  frame: LazyRouteFrame;
  isChunkError: boolean;
  onRetry: () => void;
  crashMessageKey?: string;
  inlineErrorClassName?: string;
}) {
  const { t } = useTranslation();
  const online = useOnline();
  const content = (
    <div role="alert" className={cn("flex flex-col items-start gap-3", frame === "app" && "p-6")}>
      <p className="text-sm text-muted-foreground">{t(isChunkError ? "app.chunkLoadError" : (crashMessageKey ?? "app.noteCrash"))}</p>
      <Button type="button" variant="outline" disabled={!online} onClick={onRetry}>
        {t("app.retry")}
      </Button>
      {/* disabled buttons are not focusable, so state the reason as text */}
      {!online && <p className="text-sm text-muted-foreground">{t("app.offlineHint")}</p>}
    </div>
  );
  if (frame === "page") return <PageFrame>{content}</PageFrame>;
  if (frame === "inline") return inlineErrorClassName ? <div className={inlineErrorClassName}>{content}</div> : content;
  return (
    // main no longer scrolls, so long errors scroll in the card
    <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]")}>
      {/* AppErrorFallback omits this on purpose (zero context dependency) */}
      <NarrowTopBar />
      {content}
    </div>
  );
}

interface AppErrorBoundaryProps {
  reload?: () => void;
  children: ReactNode;
}

/** Must wrap ThemeProvider and Toaster so errors thrown by them are caught too. No automatic reload here: it would turn a persistent render bug into an endless reload. The fallback has zero context dependency (no AppShell: auth/query may be the source of the error); theme is applied via a class on documentElement, i18n is a module singleton and Button uses no context, so all are safe. */
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
    <div className={`flex min-h-screen items-center justify-center bg-background ${SAFE_PAGE_PADDING_COMPACT}`}>
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
