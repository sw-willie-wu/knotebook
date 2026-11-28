/**
 * Sole lazy entry for the upload indicator's list: reference only via `lazy(() => import(...))`; a static import moves the list and its string pack
 * into the caller's chunk. The guard is `UPLOADSLAZY_RE` and `UPLOAD_LIST_I18N_MARKER` in `scripts/check-bundle-size.mjs`.
 */
export { UploadsPanel } from "./UploadsPanel";
