/**
 * Sole lazy entry for the bell's notification list: reference only via `lazy(() => import(...))`; a static import moves the list and its string pack
 * into the caller's chunk. The guard is `NOTIFICATIONSLAZY_RE` and `NOTIFICATIONS_I18N_MARKER` in `scripts/check-bundle-size.mjs`.
 */
export { NotificationsPanel } from "./NotificationsPanel";
