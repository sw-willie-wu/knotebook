import { writeFileSync, unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
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

/**
 * 上傳檔案在磁碟上的實際路徑——固定用 DB 主鍵 `id`（無副檔名）當檔名，`Content-Type`
 * 一律由 GET 端在回應時從 DB 的 `mime`（偵測值）欄位回填，不依賴檔名推斷。
 *
 * 原本是 `routes/uploads.ts` 內的私有函式，Task 11 移到這裡並 export：DELETE
 * note 交易（`routes/notes.ts`）也需要用同一套路徑組法算出要補刪的檔案位置，
 * 兩處各自維護一份會有漂移風險（同 `isForeignKeyViolation` 收斂到 `db/pg-errors.ts`
 * 的理由）。
 */
export function uploadFilePath(uploadsDir: string, id: string): string {
  return path.join(uploadsDir, id);
}

/** `deleteUploadFiles` 只需要 `error` 這一個 log 方法——不要求呼叫端傳整個 Fastify logger。 */
export interface UploadDeleteLogger {
  error(obj: unknown, msg?: string): void;
}

/**
 * DELETE note 交易 commit **之後**的 best-effort 補刪 blob 檔案（Task 11，spec 決策：
 * blob 刪除不能放進交易內——DB rollback 救不回已經被刪掉的檔案，只能反過來，先確定
 * DB 那邊的 `uploads` 列真的 commit 成功，才動磁碟）。
 *
 * 逐檔各自獨立 try/catch：任何單一檔案刪除失敗（含檔案本來就已經不存在——
 * `unlink` 對不存在的路徑一律拋 `ENOENT`，例如 volume 被清過、手動誤刪）都只記一筆
 * log，不影響其餘檔案繼續刪、也不讓呼叫端的 DELETE request 因此失敗——DB 端該刪的列
 * 已經確定刪乾淨，這才是使用者真正在意的結果；磁碟上殘留孤兒檔案是維運可事後排查、
 * 不影響資料正確性的次要問題（同 `routes/uploads.ts` GET 端「DB 有列但磁碟無檔」
 * 一律記 log、不讓請求整個炸掉的既有慣例）。
 *
 * 跨筆記引用同一個 blob 的情況（**intended**，非本函式範疇的疏漏）：`uploads` 目前的
 * schema 是「一列＝一個檔案＝歸屬單一來源 note（`noteId`）」，並沒有「多篇筆記共享
 * 同一個 upload 列」的資料模型——即使該圖片的 URL 被貼進其他筆記的內容裡顯示，刪除
 * 來源筆記時，這個檔案仍會隨著它唯一歸屬的 `uploads` 列一起被刪除；其他筆記裡因此
 * 失效的圖片連結會變成 404（`GET /api/uploads/:id` 對「DB 有列但磁碟無檔」既有的
 * 404 語意本來就一致；此處是「DB 列與磁碟檔案一起消失」，同樣落在同一個 404 分支）。
 */
export async function deleteUploadFiles(uploadsDir: string, ids: readonly string[], log: UploadDeleteLogger): Promise<void> {
  await Promise.all(
    ids.map(async id => {
      try {
        await unlink(uploadFilePath(uploadsDir, id));
      } catch (err) {
        log.error({ err, uploadId: id }, "刪除上傳檔案失敗（best-effort，DB 列已刪除，磁碟孤兒檔案需維運排查）");
      }
    })
  );
}
