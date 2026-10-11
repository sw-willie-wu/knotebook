import { describe, expect, it } from "vitest";
import { AGENT_LABEL_RE, deriveAgentLabel } from "./agent-label.js";

// 完整派生表釘在 apps/server/test/unit/agent-label.test.ts（照跑不改）；這裡只確認 shared 本身可用（web 也 import 它）。
describe("shared deriveAgentLabel", () => {
  it("第一個切詞 → NFKC → 小寫 → 濾字元 → 截 32 → 空則 agent；輸出通過 AGENT_LABEL_RE", () => {
    expect(deriveAgentLabel("Claude Code (knotebook)")).toBe("claude");
    expect(deriveAgentLabel("我的腳本")).toBe("agent");
    expect(deriveAgentLabel("Ｂｏｔ")).toBe("bot");
    expect(AGENT_LABEL_RE.test(deriveAgentLabel("a".repeat(40)))).toBe(true);
    expect(AGENT_LABEL_RE.source).toBe("^[A-Za-z0-9._-]{1,32}$");
  });
});
