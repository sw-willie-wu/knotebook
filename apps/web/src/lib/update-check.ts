import i18n from "@/i18n";
import { toast } from "@/components/ui/toast";

/**
 * 從背景回來時檢查有沒有新版本。
 *
 * 安裝成 app（standalone）的 Knotebook 可能在背景掛好幾天，不會重新載入，所以一直跑舊版。冷啟動不需要這個：
 * `index.html` 是 `no-cache`，每次開都是新版。
 *
 * 做法：頁面回到前景（`visibilitychange` → visible），而且離上次檢查已經 30 分鐘以上，就抓一次 `/`，
 * 比對 HTML 裡入口 script 的檔名（vite build 的 `/assets/index-<hash>.js`）跟目前載入的是否相同。
 * 不同就呼叫 `onUpdate` 一次（之後不再檢查）。不自動重新載入，免得打斷正在打字的人。
 * 抓失敗、回來的不是 app 的 HTML（例如部署中反向代理的錯誤頁）都當作沒有新版，等下一次。
 *
 * 目前頁面找不到 hash 檔名的入口 script（vite dev server 直接載 `/src/main.tsx`）就不檢查。
 */

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const ENTRY_SCRIPT_PATH = /^\/assets\/index-[^/"]+\.js$/;
const ENTRY_SCRIPT_IN_HTML = /<script\b[^>]*\bsrc="(\/assets\/index-[^/"]+\.js)"/;

/** HTML 文字裡入口 script 的路徑；找不到回 `null`。 */
export function entryScriptFromHtml(html: string): string | null {
  return ENTRY_SCRIPT_IN_HTML.exec(html)?.[1] ?? null;
}

/** 目前頁面載入的入口 script 路徑（屬性原文，不是解析後的絕對網址）；找不到回 `null`。 */
export function currentEntryScript(doc: Document = document): string | null {
  for (const script of doc.querySelectorAll<HTMLScriptElement>("script[src]")) {
    const src = script.getAttribute("src");
    if (src !== null && ENTRY_SCRIPT_PATH.test(src)) return src;
  }
  return null;
}

async function fetchIndexHtml(): Promise<string> {
  const res = await fetch("/", { headers: { Accept: "text/html" }, cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`GET / ${res.status}`);
  return res.text();
}

export interface UpdateCheckOptions {
  onUpdate: () => void;
  fetchHtml?: () => Promise<string>;
  now?: () => number;
  intervalMs?: number;
  doc?: Document;
}

/** 掛上檢查；回傳拆掉監聽的函式。載入當下算第一次檢查，所以最早在載入 30 分鐘後才會真的去抓。 */
export function installUpdateCheck({
  onUpdate,
  fetchHtml = fetchIndexHtml,
  now = Date.now,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  doc = document,
}: UpdateCheckOptions): () => void {
  const current = currentEntryScript(doc);
  if (current === null) return () => {};

  let lastCheck = now();
  let checking = false;
  let notified = false;

  const onVisibilityChange = () => {
    if (doc.visibilityState !== "visible" || checking || notified) return;
    if (now() - lastCheck < intervalMs) return;
    lastCheck = now();
    checking = true;
    fetchHtml()
      .then((html) => {
        const latest = entryScriptFromHtml(html);
        if (latest !== null && latest !== current && !notified) {
          notified = true;
          onUpdate();
        }
      })
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  };

  doc.addEventListener("visibilitychange", onVisibilityChange);
  return () => doc.removeEventListener("visibilitychange", onVisibilityChange);
}

/** 「Knotebook 已更新」toast，帶「重新整理」鈕；不會自己消失。`reload` 只為可測（jsdom 的 `location.reload` 不可替換）。 */
export function showUpdateAvailableToast(reload: () => void = () => window.location.reload()): void {
  toast({
    title: i18n.t("app.updateAvailable"),
    durationMs: Infinity,
    action: { label: i18n.t("app.reload"), onClick: reload },
  });
}
