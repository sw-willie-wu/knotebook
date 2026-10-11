/** #247 §9.6：派生規則只有 shared 一份——server 必須重新匯出同一個函式與 regex（不是複製一份）。 */
import { describe, expect, it } from "vitest";
import * as shared from "@knotebook/shared";
import { AGENT_LABEL_RE, deriveAgentLabel } from "../../src/auth/agent-label.js";

describe("agent label 派生規則搬到 shared", () => {
  it("server 的 deriveAgentLabel／AGENT_LABEL_RE 與 shared 是同一個參考", () => {
    expect(typeof shared.deriveAgentLabel).toBe("function");
    expect(deriveAgentLabel).toBe(shared.deriveAgentLabel);
    expect(AGENT_LABEL_RE).toBe(shared.AGENT_LABEL_RE);
  });
});
