import { Suspense, type ReactNode } from "react";
import { ChunkLoadBeacon, LazyRouteErrorBoundary } from "@/components/ErrorBoundary";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Fixed, because the buttons that open these panels sit in a small slot of the sidebar footer or the phone top bar. The crash text is
// from the main pack (`errors.fallback`): the lazy string pack may be the thing that failed to load.
const ERROR_FRAME = cn(cardSurface, "fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] z-50 w-72 max-w-[calc(100vw-1.5rem)] p-3 shadow-lg");

/** Wraps a lazy sidebar panel's one mount point: a failed chunk shows an inline error with retry instead of using up a route's reload allowance. */
export function SidebarPanelLazyBoundary({ chunk, children }: { chunk: string; children: ReactNode }) {
  return (
    <LazyRouteErrorBoundary resetKey={undefined} chunk={chunk} frame="inline" crashMessageKey="errors.fallback" inlineErrorClassName={ERROR_FRAME}>
      <Suspense fallback={null}>
        <ChunkLoadBeacon chunk={chunk} />
        {children}
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}
