/**
 * #229 全螢幕擁有權（spec §6.5）。入口側小模組（首包），**不得** import reveal。
 *
 * 只處理「我們自己要求的、整份文件」的全螢幕：記 owned／pending／exitWanted；pending 中要退出就記
 * exitWanted，由 resolve 或 fullscreenchange（先到者）負責退出；每個收尾點都清 exitWanted。
 * 一律經 safeExit() 退出（已不在全螢幕就不呼叫、reject 吞掉）。
 * 本段程式碼由 spec gate 以假 document 實跑 23 案（含 StrictMode 假卸載）全數通過——照抄，不改寫。
 *
 * 呼叫點（全部在 navigate 之前）：明確離開（NotePage 的 401／linkInvalid／noteGone／終態四個出口、
 * PublicNotePage 的 notFound、外殼的 Esc／×）直接呼叫 exitOwnedFullscreen()；卸載型（外殼卸載、
 * NotePage／PublicNotePage 卸載）走 present-url.ts 的 exitFullscreenIfLeftPresentation()。
 */
let owned = false;
let pending: Promise<void> | null = null;
let exitWanted = false;
let lastExitAt = 0;

function safeExit() {
  // 已不在全螢幕就不呼叫；exitFullscreen() 的 reject 一律吞掉，不留 unhandled rejection。
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

export function enterPresentationFullscreen(): void {   // 在使用者事件 handler 內同步呼叫
  if (!document.fullscreenEnabled || document.fullscreenElement || pending) return;
  owned = true; exitWanted = false;
  pending = document.documentElement.requestFullscreen()
    .then(() => { if (exitWanted && document.fullscreenElement === document.documentElement) { exitWanted = false; safeExit(); } })
    .catch(() => { owned = false; exitWanted = false; })
    .finally(() => { pending = null; });
}

export function exitOwnedFullscreen(): void {
  if (pending) { exitWanted = true; return; }             // resolve 或 fullscreenchange（先到者）負責退出
  if (owned && document.fullscreenElement === document.documentElement) safeExit();
  owned = false;
}

const subscribers = new Set<() => void>();

document.addEventListener("fullscreenchange", () => {     // 模組載入時掛一次
  if (document.fullscreenElement) {
    // 進入：只處理「我們自己要求的、整份文件」的那一種
    if (document.fullscreenElement === document.documentElement && exitWanted) { exitWanted = false; safeExit(); }
  } else {
    owned = false; exitWanted = false; lastExitAt = performance.now();   // 給 §6.6 的 300 ms 判斷
  }
  for (const cb of subscribers) cb();                      // 狀態更新之後才通知
});

/** §6.6-2：F 鍵與全螢幕鈕判斷「現在是不是我們要的全螢幕」。 */
export function isOwnedFullscreen(): boolean {
  return owned && document.fullscreenElement === document.documentElement;
}
/** §6.6-1：Esc 的 300 ms 防連退判斷；從未離開過回 Infinity。 */
export function msSinceFullscreenExit(): number {
  return lastExitAt === 0 ? Infinity : performance.now() - lastExitAt;
}
/** 全螢幕狀態變動時通知（外殼用來重繪全螢幕鈕的圖示／標籤）；回傳取消訂閱函式。 */
export function subscribeFullscreen(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
