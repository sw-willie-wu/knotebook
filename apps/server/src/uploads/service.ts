import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * 啟動期驗證 `uploadsDir` 實際可寫。**不用 `accessSync(dir, constants.W_OK)`**——
 * container 內以 root 執行時（或任何有 `CAP_DAC_OVERRIDE` 的情境）該檢查對任何
 * 路徑恆回傳「可寫」，完全繞過真正的檔案系統權限；也不用 `existsSync` 單獨判斷
 * 目錄存在——存在不代表可寫（唯讀掛載、父路徑其實是普通檔案等情況）。
 *
 * 改用「實際寫一個探針檔案再刪除」：寫入失敗必定代表真的不可寫，是唯一可靠的
 * 判斷方式。失敗時同步 throw，讓呼叫端（`buildApp`）fail-fast——與
 * `src/index.ts` 對 migration 失敗的 fail-fast 精神一致：啟動期就發現的環境
 * 問題，不該拖到第一次上傳請求才在 request handler 裡冒出來。
 */
export function assertUploadsDirWritable(uploadsDir: string): void {
  const probePath = path.join(uploadsDir, `.write-probe-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(probePath, "");
  } catch (err) {
    throw new Error(
      `uploads 目錄不可寫（${uploadsDir}）：請確認該路徑存在、是目錄（不是檔案）、且執行 process 的使用者有寫入權限`,
      { cause: err }
    );
  }
  try {
    unlinkSync(probePath);
  } catch {
    // 探針檔案寫入已成功，代表目錄確實可寫（結論已成立）；刪除失敗（例如寫入後
    // 瞬間檔案系統變唯讀這種極端情況）不影響此結論，不因此 fail-fast，避免誤判。
  }
}
