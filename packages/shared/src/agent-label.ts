/**
 * #106 D7（spec §8）：token 名稱 → agent label 的唯一派生規則（#247 §9.6 起放在 shared：server 讀寫與 web 的灰字判定共用）。
 * 讀時派生、寫入時快照；server 的現值運算式是 `apps/server/src/auth/agent-label.ts` 的 `agentLabelOf`。
 * 派生表釘在 apps/server/test/unit/agent-label.test.ts；AGENT_LABEL_RE 與 DB CHECK api_tokens_agent_label_chk 同形。
 * 只用 `String.prototype.normalize`／`toLowerCase`／regex，瀏覽器可用。
 */
export function deriveAgentLabel(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const cleaned = first.normalize("NFKC").toLowerCase().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "agent";
}

export const AGENT_LABEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
