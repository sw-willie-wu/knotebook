import { lazy, useCallback, useMemo, useState, type JSX, type ReactNode } from "react";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { MediaZoomContext, type MediaZoomApi, type ZoomOrigin, type ZoomSource } from "./context";
import { focusReturnTarget } from "./focus-return";
import { LightboxFallback } from "./LightboxFallback";
import { loadedMediaLightbox, loadMediaLightbox } from "./lightbox-chunk";

// 放大畫面只在第一次打開時才下載（`scripts/check-bundle-size.mjs` 守著它是自己的 chunk）。
// 載入只經 `lightbox-chunk.ts`（滑鼠移上放大鈕時也會預取），別處不得靜態 import。
const LazyMediaLightbox = lazy(() => loadMediaLightbox().then(m => ({ default: m.MediaLightbox })));

interface OpenState {
  source: ZoomSource;
  origin: ZoomOrigin;
  /** 打開當下 chunk 已經載好：直接渲染，不經 `lazy()`／Suspense（它第一次渲染至少會停在 fallback 一小段時間）。 */
  ready: boolean;
}

/** 持有放大畫面的開關狀態；子樹裡的放大鈕經 `useMediaZoom()` 打開它。 */
export function MediaZoomProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<OpenState | null>(null);

  const open = useCallback((source: ZoomSource, origin: ZoomOrigin) => {
    setState({ source, origin, ready: loadedMediaLightbox() !== null });
  }, []);
  const close = useCallback(() => setState(null), []);

  const api = useMemo<MediaZoomApi>(() => ({ open, isOpen: state !== null }), [open, state]);

  const Lightbox = state?.ready ? (loadedMediaLightbox()?.MediaLightbox ?? LazyMediaLightbox) : LazyMediaLightbox;

  return (
    <MediaZoomContext.Provider value={api}>
      {children}
      {state !== null && (
        <SidebarLazyBoundary
          chunk="mediaZoom"
          fallback={
            <LightboxFallback
              source={state.source}
              onClose={() => {
                close();
                focusReturnTarget(state.origin.button, state.origin.media)?.focus();
              }}
            />
          }
          errorClassName="p-2"
        >
          <Lightbox
            source={state.source}
            onClose={close}
            restoreFocus={() => focusReturnTarget(state.origin.button, state.origin.media)?.focus()}
          />
        </SidebarLazyBoundary>
      )}
    </MediaZoomContext.Provider>
  );
}
