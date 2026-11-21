import { describe, expect, it } from "vitest";
import { knowledgeIndexPath, knowledgeIndexScopeKey } from "./knowledge-index-path";

describe("knowledge index paths", () => {
  it("builds /knowledge/me, /knowledge/g/<id> and /knowledge/f/<id>, encoding ids", () => {
    expect(knowledgeIndexPath({ kind: "personal" })).toBe("/knowledge/me");
    expect(knowledgeIndexPath({ kind: "group", groupId: "g1" })).toBe("/knowledge/g/g1");
    expect(knowledgeIndexPath({ kind: "folder", folderId: "a/b c" })).toBe("/knowledge/f/a%2Fb%20c");
  });

  it("knowledgeIndexScopeKey is me, g:<id> and f:<id>", () => {
    expect(knowledgeIndexScopeKey({ kind: "personal" })).toBe("me");
    expect(knowledgeIndexScopeKey({ kind: "group", groupId: "g1" })).toBe("g:g1");
    expect(knowledgeIndexScopeKey({ kind: "folder", folderId: "f1" })).toBe("f:f1");
  });
});
