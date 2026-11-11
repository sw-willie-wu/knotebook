/**
 * 是否 Mac（決定快捷鍵顯示 ⌘ 還是 Ctrl）。
 *
 * `navigator.platform` 已棄用但仍是目前偵測平台最簡單可靠的方式，這裡只用來
 * 決定快捷鍵徽章的顯示文字（⌘K vs Ctrl K），不影響任何行為判斷。`?? ""`
 * 防呆：某些環境（如部分測試/嵌入式 WebView）這個欄位可能是空字串以外的
 * falsy 值，讓 `.toLowerCase()` 不會炸在 undefined 上。
 * iPhone／iPad 的 platform 不含 "mac"，所以顯示 Ctrl。
 */
export function isMacPlatform(): boolean {
  const p = typeof navigator !== "undefined" ? (navigator.platform ?? "") : "";
  return p.toLowerCase().includes("mac");
}
