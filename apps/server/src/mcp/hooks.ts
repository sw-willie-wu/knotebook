/**
 * #108：`/api/mcp` 的測試注入縫（形狀比照 `notes/editing/apply.ts` 的 `EditingTestHooks`）。
 * 未注入時三個 hook 都是 `?.()`，生產零成本。
 */
export interface McpTestHooks {
  /** 計數 seam（M1(a)）：`finally` 裡 `await server.close()` **之後**呼叫，每發請求恰一次。 */
  afterClose?: () => void;
  /**
   * 故障注入 seam（M1(a)）：`Response` 已具現成 status／headers／text **之後**、`reply.send`
   * **之前**呼叫。丟出去的例外走我們自己的 `finally`，SDK 攔不到。
   *
   * ⚠ 它是 **app 級的單一函式，每一發請求都會被呼叫**——要「只在第 N 發丟」是**測試自己**
   * 在 hook 裡數第幾發，不是 handler 的責任。
   */
  beforeReply?: () => void;
  /** 故障注入 seam（M15／案 29d）：每支工具 handler 進入時、在 `runTool()` 的 try 內呼叫，帶工具名。 */
  beforeTool?: (name: string) => void;
}
