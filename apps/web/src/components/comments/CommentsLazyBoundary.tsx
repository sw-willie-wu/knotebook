import { Suspense, type ReactNode } from "react";
import { ChunkLoadBeacon, LazyRouteErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Wraps every `CommentsLazy` mount point, as `VersionsLazyBoundary` does for the version history: a failed chunk shows an inline error with
 * retry instead of using up NotePage's reload allowance. Its own allowance alias `comments`. The crash text comes from the main pack
 * (`errors.fallback`): the lazy string pack may be the thing that failed to load.
 */
export function CommentsLazyBoundary({ noteId, errorClassName, children }: { noteId: string | null; errorClassName?: string; children: ReactNode }) {
  return (
    <LazyRouteErrorBoundary
      resetKey={noteId ?? undefined}
      chunk="comments"
      frame="inline"
      crashMessageKey="errors.fallback"
      inlineErrorClassName={errorClassName}
    >
      <Suspense fallback={null}>
        <ChunkLoadBeacon chunk="comments" />
        {children}
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}
