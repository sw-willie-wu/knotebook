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

/** client 用 server 名替工具做 namespace；與 `docs/api-tokens.md` 教使用者填的設定鍵名同字。 */
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
 * 只描述**這一棒真的交付的東西**。英文——與 `docs/` 及工具 `.describe()` 同語言；
 * 它進的是模型脈絡不是 UI，不走 i18n。
 */
export const MCP_INSTRUCTIONS = `Knotebook notes over MCP. Reading is always sectioned: there is no tool that returns a whole
note. Call read_note_outline first to see a note's sections (id, heading, length), then
read_note_section for the text of one section, 4000 characters per call — page with \`offset\`
until \`truncated\` is false. Listings return at most 100 notes and 100 sections per call, and
headings and titles are cut at 200 characters. What is capped is the size of a single response,
not the total you can read. Notes you can see include ones other people shared with you: each
result carries \`ownerHandle\` and \`role\` so you can tell whose content you are reading.`;
