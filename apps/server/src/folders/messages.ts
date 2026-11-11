/**
 * 資料夾交易與服務層共用的錯誤訊息（HTTP 層英文，#372）。`folders/tx/*` 與 `folders/service.ts` 都從這裡 import，
 * 交易內與交易外快速路徑丟出的 404／403／409 逐位元組相同。純資料（S14：tx 檔可 import）。
 * 只有服務層會丟的訊息（名稱三句、撞名、節流、server_busy）留在 `service.ts` 檔頭。
 */
import { FOLDER_DEPTH_MAX } from "@knotebook/shared";

export const FOLDER_NOT_FOUND_MESSAGE = "No folder with that id.";
export const FOLDER_FORBIDDEN_MESSAGE = "You don't have permission to manage this folder.";
/** 群組根層（以群組 id 進來、沒有具體資料夾）角色不能編輯；句型同 `POST /api/notes {groupId}`。 */
export const FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE = "Your role in this group can't create folders.";
export const FOLDER_TOO_DEEP_MESSAGE = `Folders can be nested at most ${FOLDER_DEPTH_MAX} levels deep.`;
export const FOLDER_LIMIT_MESSAGE = "This space has reached its folder limit.";
/** 搬資料夾：兩者都看得到但不同空間。 */
export const FOLDER_CROSS_SPACE_MESSAGE = "A folder can't be moved to another space.";
export const FOLDER_CYCLE_MESSAGE = "A folder can't be moved into itself or one of its subfolders.";
/** 刪資料夾：子樹有活筆記、呼叫者沒有刪除權（交易外快速路徑與交易內 `trashNotesInTx` 的 forbidden 同一句）。 */
export const FOLDER_DELETE_BLOCKED_MESSAGE = "The folder contains notes you can't delete.";
/** 刪資料夾：子樹有沒開閘門的活筆記、或交易內重判 notFound。 */
export const FOLDER_CONTENT_CHANGED_MESSAGE = "The folder's contents just changed. Try again.";
/** 只刪空資料夾（`onlyIfEmpty`）：有子資料夾、活筆記或放置（交易外快速路徑與交易內同一句）。 */
export const FOLDER_NOT_EMPTY_MESSAGE = "The folder isn't empty, so it wasn't deleted.";
/** 放置：筆記不在、看不到、在垃圾桶、放置時被撤分享（23503）——與既有筆記路由的 404 同一句。 */
export const NOTE_NOT_FOUND_MESSAGE = "No note with that id.";
/** 放置：群組筆記沒有編輯權。 */
export const NOTE_PLACE_FORBIDDEN_MESSAGE = "You don't have permission to organize this note.";
/** 筆記放進／建立在／複製或移入到別空間的資料夾（附錄 C）。 */
export const NOTE_FOLDER_CROSS_SPACE_MESSAGE = "A note can't go into a folder in another space.";
/** 建立、複製、移入群組時指定群組資料夾，但角色不能編輯（三處同一句，附錄 C）。 */
export const NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE = "Your role in this group can't put notes in folders.";
