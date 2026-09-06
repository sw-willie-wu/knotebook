import { describe, expect, it } from "vitest";
import { deriveAgentLabel } from "../../src/auth/agent-label.js";

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
  });
});
