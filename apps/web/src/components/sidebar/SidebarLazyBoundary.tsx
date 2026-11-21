import { Suspense, type ReactNode } from "react";
import { ChunkLoadBeacon, LazyRouteErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Every sidebar lazy chunk mount point is wrapped in this: there is no route boundary above it (home has none; AppShell sits in a layout route, outside the note page's boundary), so a chunk error would otherwise crash the whole app.
 * `frame="inline"` shows the error and retry in place. Mount points of one chunk `import()` the same module, so once one succeeds the rest can't fail with a chunk error (the convergence precondition of `ErrorBoundary.tsx`).
 * `ChunkLoadBeacon` must be inside `<Suspense>` (see its comment in `ErrorBoundary.tsx`).
 */
export function SidebarLazyBoundary({
  chunk,
  fallback,
  errorClassName,
  children,
}: {
  chunk: "trash" | "select" | "folder" | "bodySearch" | "groupDialog" | "transferDialog" | "mediaZoom" | "tagFilter" | "tagResults";
  fallback: ReactNode;
  errorClassName?: string;
  children: ReactNode;
}) {
  return (
    <LazyRouteErrorBoundary resetKey={undefined} chunk={chunk} frame="inline" inlineErrorClassName={errorClassName}>
      <Suspense fallback={fallback}>
        <ChunkLoadBeacon chunk={chunk} />
        {children}
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}
