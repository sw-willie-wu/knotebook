/**
 * 「注入的短 lock_timeout 真的生效」這一族斷言的共用常數（不 import 任何東西：`vi.mock` 的 factory 會動態載入本檔，
 * 不能因此把被 mock 的模組又拉進來）。
 *
 * 做法：用到的檔在檔頂 `vi.mock("../src/storage/tx/quota.js", …)`，把預設 `DEFAULT_STORAGE_LOCK_TIMEOUT_MS`（產品值 5000）
 * 換成 `SLOW_DEFAULT_LOCK_TIMEOUT_MS`；函式層的案則在交易內先 `set local lock_timeout` 成同一個值。注入值（200／300 ms）
 * 與「沒生效、落回預設」（60 s）差兩百倍，牆鐘界線 `INJECTED_LOCK_TIMEOUT_BOUND_MS` 放在 20 s——離兩邊都遠：
 * 機器再忙，一個被鎖擋 300 ms 的請求也不會多花將近 20 s；沒生效就得等滿 60 s 才 409 → 這條斷言紅
 * （60 s 仍在全域 120 s testTimeout 內，紅的是斷言，不是逾時）。以前是 300 ms 對 5000 ms、界線 3 s，慢機器只剩 2.7 s 餘裕。
 */
export const SLOW_DEFAULT_LOCK_TIMEOUT_MS = 60_000;
export const INJECTED_LOCK_TIMEOUT_BOUND_MS = 20_000;
