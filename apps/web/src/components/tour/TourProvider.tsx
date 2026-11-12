import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import i18n from "@/i18n";
import { toast } from "@/components/ui/toast";
import { TourContext, type TourApi, type TourStartOptions } from "@/lib/tour-context";
import type { TourLazyProps } from "./TourLazy";

/**
 * 功能導覽的首包外殼：只提供 `TourContext.start`，不打任何 API、不看路徑、不自動做任何事。
 * 第一次 `start` 才 `import()` 導覽的 chunk（`TourLazy`：遮罩、卡片、站點表、示範筆記、字串包）。
 * ⚠ 這個檔只准對 `./TourLazy` 做 `import type`；靜態 import 導覽的任何模組都會把整條鏈拉回首包
 * （scripts/check-bundle-size.mjs 會紅）。
 */

/** 從按下開始到第 1 站出現的上限；超過就中止（共編一直連不上之類）。 */
export const START_TIMEOUT_MS = 15_000;

type TourLazyComponent = ComponentType<TourLazyProps>;

let loadedTourLazy: TourLazyComponent | null = null;
let loadingTourLazy: Promise<TourLazyComponent> | null = null;

function loadTourLazy(): Promise<TourLazyComponent> {
  loadingTourLazy ??= import("./TourLazy").then(
    (m) => {
      loadedTourLazy = m.TourLazy;
      return m.TourLazy;
    },
    (err: unknown) => {
      // 下一次開始再重試下載。
      loadingTourLazy = null;
      throw err;
    },
  );
  return loadingTourLazy;
}

/**
 * 導覽元件 render 時拋錯：只收掉這一輪、跳一則提示，不讓錯誤傳到最外層 `AppErrorBoundary`（那會把整個 app 換成兜底畫面）。
 * 示範筆記照提早結束的規則保留。以 `session.id` 當 key，下一輪是全新的 boundary。
 */
class TourErrorBoundary extends Component<{ onCrash: () => void; children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
    toast({ title: i18n.t("tourGuide.crashed"), variant: "destructive" });
    this.props.onCrash();
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

interface Session extends TourStartOptions {
  id: number;
  timedOut: boolean;
}

/**
 * 一個時間只有一輪：進行中（含還在準備示範筆記）再呼叫 `start` 不動作，這一輪結束或中止後才能再開。
 * 15 秒上限從按下起算、第 1 站出現才停；逾時由 chunk 裡的流程收拾（提示、把空白的示範筆記移到垃圾桶）。
 * chunk 載入失敗、或逾時時 chunk 還沒到：導覽的字串包在 chunk 裡、拿不到導覽自己的提示，改用首包的載入失敗提示。
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [TourLazy, setTourLazy] = useState<TourLazyComponent | null>(() => loadedTourLazy);
  const activeRef = useRef<number | null>(null);
  const nextIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const end = useCallback((id: number) => {
    if (activeRef.current !== id) return;
    activeRef.current = null;
    clearTimeout(timerRef.current);
    setSession(null);
  }, []);

  const api = useMemo<TourApi>(() => {
    const chunkFailed = (id: number) => {
      if (activeRef.current !== id) return;
      toast({ title: i18n.t("app.chunkLoadError"), variant: "destructive" });
      end(id);
    };
    return {
      start: (options) => {
        if (activeRef.current !== null) return;
        nextIdRef.current += 1;
        const id = nextIdRef.current;
        activeRef.current = id;
        setSession({ returnTo: options.returnTo, returnFocus: options.returnFocus, id, timedOut: false });
        timerRef.current = setTimeout(() => {
          if (activeRef.current !== id) return;
          if (loadedTourLazy === null) {
            chunkFailed(id);
            return;
          }
          setSession((s) => (s !== null && s.id === id ? { ...s, timedOut: true } : s));
        }, START_TIMEOUT_MS);
        loadTourLazy().then(
          (component) => {
            if (activeRef.current === id) setTourLazy(() => component);
          },
          (err: unknown) => {
            console.error(err);
            chunkFailed(id);
          },
        );
      },
    };
  }, [end]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <TourContext.Provider value={api}>
      {children}
      {session !== null && TourLazy !== null && (
        <TourErrorBoundary key={session.id} onCrash={() => end(session.id)}>
          <TourLazy
            returnTo={session.returnTo}
            returnFocus={session.returnFocus}
            timedOut={session.timedOut}
            onStarted={() => {
              // 只是停掉計時器（清資源）：第 1 站出現之後不中止，由 TourLazy 依 `started` 判斷。
              if (activeRef.current === session.id) clearTimeout(timerRef.current);
            }}
            onDone={() => end(session.id)}
          />
        </TourErrorBoundary>
      )}
    </TourContext.Provider>
  );
}
