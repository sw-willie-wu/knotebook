import { describe, expect, it } from "vitest";
import { AGENT_LABEL_RE, agentLabelOf, deriveAgentLabel } from "../../src/auth/agent-label.js";

describe("deriveAgentLabel", () => {
  it("spec §8 的派生表：第一個切詞 → NFKC → 小寫 → 濾字元 → 截 32 → 空則 agent", () => {
    expect(deriveAgentLabel("Claude Code (knotebook)")).toBe("claude");
    expect(deriveAgentLabel("MCP CLI Proxy")).toBe("mcp");
    expect(deriveAgentLabel("我的腳本")).toBe("agent");           // 全被濾掉 → fallback
    expect(deriveAgentLabel("  spaced-out  name ")).toBe("spaced-out");
    expect(deriveAgentLabel("Ｂｏｔ")).toBe("bot");                 // NFKC 全形 → 半形
    expect(deriveAgentLabel("a".repeat(40))).toBe("a".repeat(32)); // 截 32
    expect(deriveAgentLabel("")).toBe("agent");
    expect(deriveAgentLabel("!!!")).toBe("agent");
    expect(deriveAgentLabel("my-script.v2")).toBe("my-script.v2"); // . _ - 是合法字元
    expect(deriveAgentLabel("cursor@2")).toBe("cursor2");          // @ 被濾掉
    expect(deriveAgentLabel("  Ｃｌａｕｄｅ  ")).toBe("claude");    // trim + NFKC 全形
  });

  it("派生值一律通過 AGENT_LABEL_RE，且 RE 與 DB CHECK api_tokens_agent_label_chk 逐字同形", () => {
    for (const n of ["Claude Code (knotebook)", "我的腳本", "a".repeat(40), "", "!!!", "cursor@2", "my-script.v2"]) {
      expect(AGENT_LABEL_RE.test(deriveAgentLabel(n)), n).toBe(true);
    }
    // db/schema.ts 的 CHECK 是 `~ '^[A-Za-z0-9._-]{1,32}$'`。兩處分岔的症狀是 PATCH 過了應用層
    // 卻在 DB 端炸成 500，沒有任何測試會提前告訴你。
    expect(AGENT_LABEL_RE.source).toBe("^[A-Za-z0-9._-]{1,32}$");
  });

  it("agentLabelOf：欄位有值時覆寫優先，NULL 時回派生值（純函式，不查 DB）", () => {
    expect(agentLabelOf({ agentLabel: "bot-1", name: "Claude Code" })).toBe("bot-1");
    expect(agentLabelOf({ agentLabel: null, name: "Claude Code" })).toBe("claude");
    expect(agentLabelOf({ agentLabel: null, name: "" })).toBe("agent");
  });
});
