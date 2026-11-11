/**
 * #108：`McpServer` 宣告用的三個字串。
 *
 * `version` 執行期從 `apps/server/package.json` 讀（前例逐字相同：`db/migrate.ts` 的
 * `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle")`）——發版流程
 * 是「三份 package.json 手動同步」，寫死等於加第四個沒人守的同步點。
 * ⚠ 必須用 `fileURLToPath`，**不得**用 `new URL(...).pathname`（#130 踩過 `%7E`）。
 * 讀不到一律退成 `"0.0.0"`、**絕不 throw**：讓一個顯示字串把整個端點打掛是錯的交換；
 * 呼叫端看 `versionReadFailed` 決定要不要 `log.warn`（module 層沒有 logger）。
 *
 * `instructions` 每一次 `initialize` 都進模型脈絡，所以有長度上限，且**不得**出現
 * 「指紋＝讀過了嗎」那族句子（單元測試逐條守著）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** client 用 server 名替工具做 namespace；與 `docs/mcp.md` 教使用者填的設定鍵名同字。 */
export const MCP_SERVER_NAME = "knotebook";

function readPackageVersion(): { version: string; failed: boolean } {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return { version: parsed.version, failed: false };
    }
  } catch {
    // 落到下面的退場值。
  }
  return { version: "0.0.0", failed: true };
}

const pkg = readPackageVersion();

export const MCP_SERVER_VERSION = pkg.version;
/** 讀不到 `package.json` 時為真——由 `routes/mcp.ts` 在註冊時 `log.warn` 一次。 */
export const versionReadFailed = pkg.failed;

/**
 * 只描述**這個憑證真的用得到的東西**。英文——與 `docs/` 及工具 `.describe()` 同語言；
 * 它進的是模型脈絡不是 UI，不走 i18n。
 *
 * ⚠ **兩支尾巴是二選一，不是相加**（#108）。#417 起每支再依 `open_notes_as_files` 在不在清單上分兩形，共四形，實測：
 * 讀寫＋檔案 **997**（餘裕 **3**）、讀寫 **911**、唯讀＋檔案 **997**（餘裕 **3**）、唯讀 **923**。
 * （#417：BASE 刪「list_notes returns at most 100 notes per call, search_notes at most 50.」−72——兩個上限都在各自 `limit` 的
 * `.describe()`〔`1 to 100`／`1 to 50`〕，同 outline 上限句的處理；換出的空間給 FILES_HINT_*〔讀寫 +86、唯讀 +74〕。之前 983／995）
 * （#381：WRITE 刪 ` and rename` −11，只影響讀寫那支；之前 994／995）
 * （bulk transfer：第一句「Reading is always sectioned: no tool returns a whole note.」改成「Tools read notes in sections: none
 * returns a whole note.」−2——token＋collab 部署有 `open_notes_as_files`，模型照它的 curl 拿得到整篇檔，所以「讀取一律分段」對
 * 「讀筆記」這件事不再是全稱；新句只講工具，三種部署形〔token＋collab、session、無 collab〕都成立。之前 996／997）
 * （資料夾：刪 outline 上限句 −37、BASE 尾端補資料夾句（含換行）+58；之前 975／976。刪掉的上限仍在 `read_note_outline`
 * 的 description（`At most ${MCP_PAGE_MAX} sections per call`）。資料夾句只提 `list_folders`——它任何憑證都註冊，所以兩版共用、
 * 不依 canWrite 分版；資料夾寫入工具一個都不提）
 * （#181：縮 `there is no tool that returns` −14 與 `(id, heading, length)` −22 共換出 36 字元，BASE 尾端補垃圾桶一句
 * `Only list_trash lists notes in the trash.`（含換行）+42；之前讀寫 969、唯讀 970。這句只講「列出」：`restore_note`
 * 與 `delete_note` 的回應都不是列出，也沒宣稱所有垃圾桶筆記都在 list_trash——兩版共用，不依 notes:delete 分版）
 * （#177：`cut at 200 characters` 改成 `cut at 200 characters as written in JSON` +19，刪「; each tool's `limit`
 * describes its own ceiling」−47；之前是 987；#180：five ops → six ops; all but append and rename +10）
 * （上限 1000；唯讀那支 #181 之前 970／餘裕 30——#175：`owner` 比 `ownerHandle` 短 6、可見性句改寫又省 1，當時 867；#239：處置句改成
 * 「建一支勾了 Create and edit notes 的 token 並用它連線」+59，當時 926；#247：處置句改成「在設定 → 授權的 token 列上
 * 以鉛筆開啟 Create and edit notes、重新連線讓寫入工具出現」+44），追加第二段必破線；而唯讀憑證用不到寫入工具的說明，
 * 換成處置說明總長反而更短。⚠ **這個數字只有這裡一份**（#146：測試那邊原本也抄一份、已過期成
 * 「約 20」，現在改成指回本行）。餘裕從 40 掉到 17 是 #146 換掉最後一句的代價，同時把 BASE
 * 縮了 23 字元（`for one section's text`／刪 `Also,`／`a single response`）——**下次撞牆先縮字，
 * 不要調大上限**（它保護的是模型脈絡）。#103 再用掉 11 字元（可見性句涵蓋群組）；#175 還回 7 字元。
 * 量法：`mcpInstructions(canWrite, openNotesAsFiles).length`，四種組合各量一次。
 * ⚠ **對唯讀憑證不得描述它沒有的工具**——與「不宣告我們做不到的 capability」同一個原則；
 * 而且 `insufficient_scope` 在 HTTP 上是死碼（`write-scope.ts` 檔頭），**唯讀版這段處置字樣
 * 是這個意圖唯一到得了模型的落點**。守衛＝`mcp-edit-note.test.ts` ＋ 本檔的單元案。
 * ⚠ **改了一個字就要重量**（四形各自都有 ≤ 1000 的斷言，且各自都要過禁令詞正則）。
 */
const BASE_INSTRUCTIONS = `Knotebook notes over MCP. Tools read notes in sections: none returns a whole
note. Call read_note_outline first to see a note's sections, then
read_note_section for one section's text, 4000 characters per call — page with \`offset\`
until \`truncated\` is false.
Headings and titles are cut at 200 characters as written in JSON. What is capped is a single response,
not the total you can read. Notes you can see include ones shared with you and your groups' notes: each
result carries \`owner\` and \`role\` so you can tell whose content you are reading.
Only list_trash lists notes in the trash.
Notes can sit in folders; list_folders shows their paths.`;

/**
 * 讀寫憑證的尾段。
 *
 * ⚠ 最後一句的三個限定字都是**查證過的**（#146）：
 * (1) 「changes a note's content」——不帶 `content` 的 `create_note` 只建一列
 *     （`notes/create.ts`，#145 之後三條建立路徑共用的建列點；呼叫點是
 *     `tools/create-note.ts` 最後一段），不經 `applyEdit`／不留 `note_ai_edits` 列，
 *     **沒有東西撤得回**；原句「Every write…」把它也算進去了。
 *     ⚠ **不得寫回「puts content into a note」**：那個講法會把
 *     `delete_section` 也排除掉，而它**有紀錄、也撤得回**——`apply.ts:265` 的
 *     `insertEditRecord` 在五個 op 的**共同路徑**上，沒有逐 op 分支。
 * (2) 「successful」——內容合併與紀錄列不同交易（known-limitations「An API write can succeed
 *     and still not be recorded」），紀錄列寫不進去時回錯誤，那一發就沒有紀錄。
 * (3) 「usually」——撤回會失敗：`revert.ts` 的 `editRevertable` 要求寫進去的 block 還在且
 *     沒被動過，而 `apply.ts` 的 `RETENTION = 100` 每篇只留最近 100 列。**條件的全文放在
 *     `edit-note.ts` 的 `editId` `.describe()`**（那裡沒有長度預算），這裡只給不說謊的短版。
 *
 * #381：rename 也要 `if_match`（標題指紋）——「all but append and rename」→「all but append」；「the fingerprint of what you replace」
 * 對 rename 也成立（它換掉的是標題，給的是標題的指紋）。
 * #180：five → six ops（rename 不要 `if_match`）；末句不改——rename／move 不改內容，copy 把內容寫進一篇**新**筆記且不留紀錄，
 * 由 `COPY_NOTE_DESCRIPTION` 明說。
 */
const WRITE_INSTRUCTIONS =
  "Writing needs the notes:write scope. edit_note changes one note (six ops; all but append " +
  "need `if_match`, the fingerprint of what you replace) and create_note makes a new one. " +
  "A successful write that changes a note's content is recorded, and can usually be undone.";

/**
 * #417：`open_notes_as_files` 在清單上時才接的一句（`hasOpenNotesAsFiles`：token 路徑＋collab＋editing），依憑證二選一。
 * 讀寫版接在 WRITE 之後：工具簽的權杖 `access` 是 `write`（同一支 `canWriteNotes`），export／note 拿得到整篇檔、write 送回改過的檔，
 * 所以「改一篇的大量文字或很多篇」都走得通；個別筆記送不回去的情形（角色不能編輯、`tooLargeToSend`、`not_mergeable`）由工具的
 * `next` 逐條說明——這裡只給「什麼時候該用它」。
 * 唯讀版接在 READ_ONLY 之前：權杖 `access` 是 `read`，只講讀（整篇、很多篇）；寫回在這一版不存在，不得提。
 */
const FILES_HINT_WRITE = "If you have a shell, use open_notes_as_files to change much of a note, or many notes.";
const FILES_HINT_READ_ONLY = "If you have a shell, use open_notes_as_files to read many or whole notes.";

/**
 * 唯讀憑證的尾段——**刻意不提寫入工具的名字**，只講怎麼取得寫入權。
 * #247：處置是在「設定 → 授權」的 token 列上（鉛筆→行內編輯）開啟編輯權、再重新連線——`tools.listChanged` 是
 * `false`，client 不會自己重抓清單，升權後要重連才看得到寫入工具。引號內＝token 列與建立對話框上 toggle 的
 * 字樣（`settings.account.apiTokensScopeEdit`）。不提 `notes:move`（唯讀憑證沒有任何搬移相關工具）。
 * 字面 `notes:write`、`Settings` 刻意保留（測試斷這兩個字樣）。
 */
const READ_ONLY_INSTRUCTIONS =
  "This credential is read-only, so there are no tools here that change anything. To let it " +
  'write, ask the user to turn on "Create and edit notes" (notes:write) for this credential via the pencil on its row in Settings → Authorization, then reconnect so the writing tools appear.';

/**
 * 每發請求依憑證挑一支（`routes/mcp.ts` 用 `canWriteNotes(...)` 判 `canWrite`、`hasOpenNotesAsFiles(...)` 判 `openNotesAsFiles`，
 * 都與註冊時過濾同一份判準）。
 */
export function mcpInstructions(canWrite: boolean, openNotesAsFiles: boolean): string {
  const tail = canWrite
    ? openNotesAsFiles ? `${WRITE_INSTRUCTIONS} ${FILES_HINT_WRITE}` : WRITE_INSTRUCTIONS
    : openNotesAsFiles ? `${FILES_HINT_READ_ONLY} ${READ_ONLY_INSTRUCTIONS}` : READ_ONLY_INSTRUCTIONS;
  return `${BASE_INSTRUCTIONS} ${tail}`;
}
