import { describe, expect, it } from "vitest";
import { knowledgeIndexScopeFromParams } from "./scope-from-params";

describe("knowledgeIndexScopeFromParams", () => {
  it("scopeFromParams reads each pattern and returns null for other paths", () => {
    expect(knowledgeIndexScopeFromParams("/knowledge/me", {})).toEqual({ kind: "personal" });
    expect(knowledgeIndexScopeFromParams("/knowledge/g/g1", { groupId: "g1" })).toEqual({ kind: "group", groupId: "g1" });
    expect(knowledgeIndexScopeFromParams("/knowledge/f/f1", { folderId: "f1" })).toEqual({ kind: "folder", folderId: "f1" });
    expect(knowledgeIndexScopeFromParams("/knowledge", {})).toBeNull();
    expect(knowledgeIndexScopeFromParams("/n/alice/x", {})).toBeNull();
    expect(knowledgeIndexScopeFromParams("/knowledge/g/g1", {})).toBeNull();
  });
});
