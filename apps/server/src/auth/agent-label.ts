/** #106 D7（spec §8）：token 名稱 → agent label 的唯一派生規則。讀時派生，寫入時快照。
 * #138 在本檔補 `currentAgentLabel(db, tokenId)`＝`api_tokens.agent_label ?? deriveAgentLabel(name)`，
 * 屆時本函式不動。派生表釘在 test/unit/agent-label.test.ts。 */
export function deriveAgentLabel(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const cleaned = first.normalize("NFKC").toLowerCase().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "agent";
}
