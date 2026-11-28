/**
 * Sole lazy entry for the upload indicator's list and the log-out prompt: reference only via `lazy(() => import(...))`; a static import moves them and
 * their string pack into the caller's chunk. The guard is `UPLOADSLAZY_RE` and `UPLOAD_LIST_I18N_MARKER` in `scripts/check-bundle-size.mjs`.
 */
export { UploadsPanel } from "./UploadsPanel";
export { SignOutUploadsDialog } from "./SignOutUploadsDialog";
