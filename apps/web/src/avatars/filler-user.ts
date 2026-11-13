/**
 * 背景補產看的「目前使用者」。留在首包（很小）：登出會讓 `AppShell` 卸載，換人時元件裡的 ref 看不到變化，
 * 所以最後一位使用者記在模組層。補產的本體（`display-filler`）是動態載入的；載入之後它登記一個「換人時清狀態」的處理函式，
 * 沒載入過就沒有東西可清。
 */

let lastUserId: string | undefined;
let onUserChange: (() => void) | null = null;

/** 補產本體載入時登記；換人時被呼叫一次。 */
export function setFillerUserChangeHandler(handler: (() => void) | null): void {
  onUserChange = handler;
}

/** 每次拿到使用者 id 就呼叫。還沒載入完（undefined）不算；跟上一位不同就清掉前一位留下的補產狀態。 */
export function syncFillerUser(id: string | undefined): void {
  if (id === undefined) return;
  if (lastUserId !== undefined && lastUserId !== id) onUserChange?.();
  lastUserId = id;
}

/** 測試用。 */
export function resetFillerUser(): void {
  lastUserId = undefined;
}
