/**
 * #201：站台管理、設定 modal 各區塊、登入流程四頁改成 lazy chunk 之後，透過 `AppRoutes`
 * render 的測試檔裡，**第一次**觸發某個 lazy 的案子要等真實的動態 import（React.lazy 是
 * 模組級單例，之後的案子拿快取）。預設 1s 的 waitFor／findBy 在全 suite 冷啟高負載下
 * 實測間歇紅（同 #69 對 SettingsModal.test 的硬化），所以只在「冷 lazy 之後的第一個
 * 等待」放寬到 3s——守門力在斷言內容，不在等待長度。
 *
 * 用法：`await waitFor(() => …, FIRST_LAZY_LOAD)`、`await screen.findByRole(role, opts, FIRST_LAZY_LOAD)`。
 */
export const FIRST_LAZY_LOAD = { timeout: 3_000 } as const;
