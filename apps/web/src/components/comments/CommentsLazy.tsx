/**
 * Sole lazy entry for the comments UI: reference only via `lazy(() => import(...))`; a static import moves the panel and its string pack
 * into the caller's chunk. The guard is `COMMENTSLAZY_RE` and `COMMENTS_I18N_MARKER` in `scripts/check-bundle-size.mjs`.
 */
export { CommentsPanel } from "./CommentsPanel";
export { CommentsSheet } from "./CommentsSheet";
