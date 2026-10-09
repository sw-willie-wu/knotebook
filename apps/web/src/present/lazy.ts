import { lazy } from "react";

/** #229：NotePage 與 PublicNotePage 共用同一個 lazy()——同一個模組、同一個 chunk `PresentationOverlay-<hash>.js`（spec §6.2）。 */
export const LazyPresentation = lazy(() => import("./PresentationOverlay"));
