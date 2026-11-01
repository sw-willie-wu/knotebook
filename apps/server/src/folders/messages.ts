/**
 * 資料夾交易與服務層共用的錯誤訊息（plan 附錄 C；HTTP 層中文）。`folders/tx/*` 與 `folders/service.ts` 都從這裡 import，
 * 交易內與交易外快速路徑丟出的 404／403／409 逐位元組相同。純資料（S14：tx 檔可 import）。
 * 只有服務層會丟的訊息（名稱三句、撞名、節流、server_busy）留在 `service.ts` 檔頭。
 */
import { FOLDER_DEPTH_MAX } from "@knotebook/shared";

export const FOLDER_NOT_FOUND_MESSAGE = "找不到此資料夾";
export const FOLDER_FORBIDDEN_MESSAGE = "沒有管理這個資料夾的權限";
/** 群組根層（以群組 id 進來、沒有具體資料夾）角色不能編輯；句型同 `POST /api/notes {groupId}`。 */
export const FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE = "你在這個群組的角色不能建立資料夾";
export const FOLDER_TOO_DEEP_MESSAGE = `資料夾最多 ${FOLDER_DEPTH_MAX} 層`;
export const FOLDER_LIMIT_MESSAGE = "資料夾數量已達上限";
/** 搬資料夾：兩者都看得到但不同空間（§5.7.3）。 */
export const FOLDER_CROSS_SPACE_MESSAGE = "資料夾不能移到其他空間";
export const FOLDER_CYCLE_MESSAGE = "不能把資料夾移到它自己裡面";
/** 刪資料夾：子樹有活筆記、呼叫者沒有刪除權（交易外快速路徑與交易內 `trashNotesInTx` 的 forbidden 同一句）。 */
export const FOLDER_DELETE_BLOCKED_MESSAGE = "資料夾裡有你不能刪除的筆記";
/** 刪資料夾：子樹有沒開閘門的活筆記、或交易內重判 notFound（§5.7.4 M2）。 */
export const FOLDER_CONTENT_CHANGED_MESSAGE = "資料夾內容剛變動，請再試一次";
/** 只刪空資料夾（§5.7.4 `onlyIfEmpty`）：有子資料夾、活筆記或放置（交易外快速路徑與交易內同一句）。 */
export const FOLDER_NOT_EMPTY_MESSAGE = "資料夾裡還有其他內容，沒有刪除";
/** 放置（§5.7.5）：筆記不在、看不到、在垃圾桶、放置時被撤分享（23503）——與既有筆記路由的 404 同一句。 */
export const NOTE_NOT_FOUND_MESSAGE = "找不到此筆記";
/** 放置：群組筆記沒有編輯權（§5.6）。 */
export const NOTE_PLACE_FORBIDDEN_MESSAGE = "沒有整理這篇筆記的權限";
/** 筆記放進／建立在／複製或移入到別空間的資料夾（附錄 C）。 */
export const NOTE_FOLDER_CROSS_SPACE_MESSAGE = "筆記不能放進其他空間的資料夾";
/** 建立、複製、移入群組時指定群組資料夾，但角色不能編輯（D13；三處同一句，附錄 C）。 */
export const NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE = "你在這個群組的角色不能把筆記放進資料夾";
