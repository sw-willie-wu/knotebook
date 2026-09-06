import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { apiTokens } from "../db/schema.js";

/** #106 D7（spec §8）：token 名稱 → agent label 的唯一派生規則。讀時派生，寫入時快照。
 * 現值＝`api_tokens.agent_label ?? deriveAgentLabel(name)`：`agentLabelOf` 是**純述詞**
 * （`listEdits` 一次 JOIN 撈最多 100 列，逐列查 DB 就是 N+1），`currentAgentLabel` 是它的查詢殼。
 * 派生表釘在 test/unit/agent-label.test.ts；AGENT_LABEL_RE 與 DB CHECK api_tokens_agent_label_chk 同形。 */
export function deriveAgentLabel(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const cleaned = first.normalize("NFKC").toLowerCase().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "agent";
}

export const AGENT_LABEL_RE = /^[A-Za-z0-9._-]{1,32}$/;

export function agentLabelOf(row: { agentLabel: string | null; name: string }): string {
  return row.agentLabel ?? deriveAgentLabel(row.name);
}

/** ⚠ 這裡**沒有**「沒人在線就跳過查詢」的最佳化，是刻意的，別加回去：這個回傳值會被
 * 寫進 `note_ai_edits.agent_label` / `notes.last_edited_agent_label`（`routes/notes.ts`
 * 的寫入與撤回三個呼叫點），短路會讓沒人在線時 AI 的修改紀錄落款靜默變成 `null`。
 * 讀路徑（`GET /:id/content`）不落地任何東西，短路才是安全的——但那條也還沒做（見該
 * 呼叫點旁的 m-5 註記），且與寫入/撤回共用同一個函式，不能只顧其中一邊改寫此函式本身。
 * 誠實記下：拿掉這句話、把短路加回三個寫入呼叫點，本檔與呼叫端現有斷言**不會有任何一個變紅**
 * （42 案全綠，唯一非空標籤的斷言用戶端是連著的，不會走到離線那條路）。 */
export async function currentAgentLabel(db: Db, tokenId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: apiTokens.name, agentLabel: apiTokens.agentLabel })
    .from(apiTokens)
    .where(eq(apiTokens.id, tokenId))
    .limit(1);
  return row ? agentLabelOf(row) : null;
}
