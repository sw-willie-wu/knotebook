import type { RevealConfig } from "reveal.js";

/**
 * #229 reveal 設定（A3）與初始化後核對（§6.4-3）。
 * reveal 會把網址查詢字串併進 config（`reveal.js:151` 的 `Util.getQueryHash()`，優先於我們傳的值）——
 * 外殼先把 search 正規化成恰好 `?present`、controller 在 new Reveal 之前斷言 `window.location.search === "?present"`，
 * 初始化後再以 getConfig() 逐鍵比對這裡的**全部**鍵（keyboard／keyboardCondition 比身分）。
 * reveal 不管網址（A1）：hash／history／respondToHashChanges 全關，hash 由我們經 router 寫（hash-writer.ts）。
 */
export interface RevealKeyHandlers {
  onEsc: (event: KeyboardEvent) => void;
  onF: (event: KeyboardEvent) => void;
  onO: (event: KeyboardEvent) => void;
}

export function buildRevealConfig(handlers: RevealKeyHandlers): RevealConfig {
  return {
    embedded: true,
    disableLayout: true,
    hash: false,
    history: false,
    respondToHashChanges: false,
    postMessage: false,
    postMessageEvents: false,
    previewLinks: false,
    view: null,
    parallaxBackgroundImage: "",
    autoSlide: 0,
    pause: false,
    help: false,
    jumpToSlide: false,
    focusBodyOnPageVisibilityChange: false,
    controls: true,
    progress: true,
    overview: true,
    keyboard: { 27: handlers.onEsc, 70: handlers.onF, 79: handlers.onO },
    keyboardCondition: (event: KeyboardEvent) => !(event.altKey || event.ctrlKey || event.metaKey),
  };
}

export const LOCKED_CONFIG_KEYS = [
  "embedded", "disableLayout", "hash", "history", "respondToHashChanges", "postMessage", "postMessageEvents",
  "previewLinks", "view", "parallaxBackgroundImage", "autoSlide", "pause", "help", "jumpToSlide",
  "focusBodyOnPageVisibilityChange", "controls", "progress", "overview", "keyboard", "keyboardCondition",
] as const;

export function configMatches(actual: object, expected: object): boolean {
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  return LOCKED_CONFIG_KEYS.every((key) => Object.is(a[key], e[key]));
}

/** print view 在 rAF 之後才加、destroy 也不移除這些 class（§2.11-14）——以 view === null 為準，這是後備檢查。 */
export function htmlHasPrintClasses(): boolean {
  const classes = document.documentElement.classList;
  return classes.contains("reveal-print") || classes.contains("print-pdf") || classes.contains("reveal-full-page");
}
