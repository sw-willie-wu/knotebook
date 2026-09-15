/**
 * #108 D-C：`McpServer` 宣告用的三個字串。
 *
 * `version` 執行期從 `apps/server/package.json` 讀（前例逐字相同：`db/migrate.ts` 的
 * `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle")`）——發版流程
 * 是「三份 package.json 手動同步」，寫死等於加第四個沒人守的同步點。
 * ⚠ 必須用 `fileURLToPath`，**不得**用 `new URL(...).pathname`（#130 踩過 `%7E`）。
 * 讀不到一律退成 `"0.0.0"`、**絕不 throw**：讓一個顯示字串把整個端點打掛是錯的交換；
 * 呼叫端看 `versionReadFailed` 決定要不要 `log.warn`（module 層沒有 logger）。
 *
 * `instructions` 每一次 `initialize` 都進模型脈絡，所以有長度上限，且**不得**出現規格 §15.3
 * 那族「指紋＝讀過了嗎」的句子（單元測試逐條守著）。
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
 * ⚠ **兩支尾巴是二選一，不是相加**（#108 D-Q）。讀寫那支實測 **983** 字元，只剩 **17** 字元餘裕
 * （上限 1000；唯讀那支 891／餘裕 109），追加第二段必破線；而唯讀憑證用不到寫入工具的說明，
 * 換成處置說明總長反而更短。⚠ **這個數字只有這裡一份**（#146：測試那邊原本也抄一份、已過期成
 * 「約 20」，現在改成指回本行）。餘裕從 40 掉到 17 是 #146 換掉最後一句的代價，同時把 BASE
 * 縮了 23 字元（`for one section's text`／刪 `Also,`／`a single response`）——**下次撞牆先縮字，
 * 不要調大上限**（它保護的是模型脈絡）。量法：`mcpInstructions(true).length`／`(false)`。
 * ⚠ **對唯讀憑證不得描述它沒有的工具**——與 D32「不宣告我們做不到的 capability」同一個原則；
 * 而且 `insufficient_scope` 在 HTTP 上是死碼（`write-scope.ts` 檔頭），**唯讀版這段處置字樣
 * 是 D7 的意圖唯一到得了模型的落點**。守衛＝`mcp-edit-note.test.ts` 的 S3 ＋ 本檔的單元案。
 * ⚠ **改了一個字就要重量**（兩支各自都有 ≤ 1000 的斷言，且各自都要過禁令詞正則）。
 */
const BASE_INSTRUCTIONS = `Knotebook notes over MCP. Reading is always sectioned: there is no tool that returns a whole
note. Call read_note_outline first to see a note's sections (id, heading, length), then
read_note_section for one section's text, 4000 characters per call — page with \`offset\`
until \`truncated\` is false. list_notes returns at most 100 notes per call, search_notes at most
50, and an outline at most 100 sections; each tool's \`limit\` describes its own ceiling.
Headings and titles are cut at 200 characters. What is capped is a single response,
not the total you can read. Notes you can see include ones other people shared with you: each
result carries \`ownerHandle\` and \`role\` so you can tell whose content you are reading.`;

/**
 * 讀寫憑證的尾段。
 *
 * ⚠ 最後一句的三個限定字都是**查證過的**（#146）：
 * (1) 「changes a note's content」——不帶 `content` 的 `create_note` 只建一列
 *     （`notes/create.ts`，#145 之後三條建立路徑共用的建列點；呼叫點是
 *     `tools/create-note.ts` 最後一段），不經 `applyEdit`／不留 `note_ai_edits` 列，
 *     **沒有東西撤得回**；原句「Every write…」把它也算進去了。
 *     ⚠ **不得寫回「puts content into a note」**（r2 審查抓到）：那個講法會把
 *     `delete_section` 也排除掉，而它**有紀錄、也撤得回**——`apply.ts:265` 的
 *     `insertEditRecord` 在五個 op 的**共同路徑**上，沒有逐 op 分支。
 * (2) 「successful」——內容合併與紀錄列不同交易（known-limitations「An API write can succeed
 *     and still not be recorded」），紀錄列寫不進去時回錯誤，那一發就沒有紀錄。
 * (3) 「usually」——撤回會失敗：`revert.ts` 的 `editRevertable` 要求寫進去的 block 還在且
 *     沒被動過，而 `apply.ts` 的 `RETENTION = 100` 每篇只留最近 100 列。**條件的全文放在
 *     `edit-note.ts` 的 `editId` `.describe()`**（那裡沒有長度預算），這裡只給不說謊的短版。
 */
const WRITE_INSTRUCTIONS =
  "Writing needs the notes:write scope. edit_note changes one note (five ops; all but append " +
  "need `if_match`, the fingerprint of what you replace) and create_note makes a new one. " +
  "A successful write that changes a note's content is recorded, and can usually be undone.";

/** 唯讀憑證的尾段——**刻意不提兩支寫入工具的名字**，只講怎麼取得寫入權。 */
const READ_ONLY_INSTRUCTIONS =
  "This credential is read-only, so there are no tools here that change anything. To let it " +
  "write, create a token with the notes:write scope in Settings → Account → API tokens.";

/** 每發請求依憑證挑一支（`routes/mcp.ts` 用 `canWriteNotes(...)` 判，與註冊時過濾同一份判準）。 */
export function mcpInstructions(canWrite: boolean): string {
  return `${BASE_INSTRUCTIONS} ${canWrite ? WRITE_INSTRUCTIONS : READ_ONLY_INSTRUCTIONS}`;
}
