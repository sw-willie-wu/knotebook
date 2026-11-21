import { describe, expect, it } from "vitest";
import { folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { groupDto, adminRole } from "@/test/fixtures";
import { indexFolders } from "./folder-index";
import { knowledgeScopes, NO_KNOWLEDGE_SCOPES } from "./knowledge-scopes";

const G = groupDto({ id: "G", name: "G" }, adminRole());
const groupIds = new Set(["G"]);

describe("knowledgeScopes", () => {
  it("a personal note with knowledge marks personal and every ancestor folder of its folder", () => {
    const index = indexFolders([folderDto({ id: "A", name: "A" }), folderDto({ id: "B", name: "B", parentId: "A" }), folderDto({ id: "C", name: "C" })]);
    const scopes = knowledgeScopes([personalNote({ id: "n1", title: "n", folderId: "B", hasKnowledge: true })], index, groupIds);
    expect(scopes.personal).toBe(true);
    expect([...scopes.folders].sort()).toEqual(["A", "B"]);
    expect(scopes.groups.size).toBe(0);
  });

  it("a group note marks its group and its group folders; a note in Shared with me marks nothing", () => {
    const index = indexFolders([groupFolder({ id: "GF", name: "GF", groupId: "G" }), sharedFolder({ id: "SF", name: "SF" })]);
    const scopes = knowledgeScopes(
      [
        groupNote({ id: "n1", title: "g", group: G, folderId: "GF", hasKnowledge: true }),
        sharedNote({ id: "n2", title: "s", folderId: "SF", hasKnowledge: true }),
      ],
      index,
      groupIds,
    );
    expect(scopes.personal).toBe(false);
    expect([...scopes.groups]).toEqual(["G"]);
    expect([...scopes.folders]).toEqual(["GF"]);
  });

  it("a note whose folderId points into another space marks no folder", () => {
    const index = indexFolders([groupFolder({ id: "GF", name: "GF", groupId: "G" })]);
    const scopes = knowledgeScopes([personalNote({ id: "n1", title: "p", folderId: "GF", hasKnowledge: true })], index, groupIds);
    expect(scopes.personal).toBe(true);
    expect(scopes.folders.size).toBe(0);
  });

  it("a folder cycle in bad data terminates", () => {
    const index = indexFolders([folderDto({ id: "A", name: "A", parentId: "B" }), folderDto({ id: "B", name: "B", parentId: "A" })]);
    const scopes = knowledgeScopes([personalNote({ id: "n1", title: "p", folderId: "A", hasKnowledge: true })], index, groupIds);
    expect(scopes.folders.has("A")).toBe(true);
  });

  it("notes without hasKnowledge, or with it undefined, mark nothing", () => {
    const index = indexFolders([folderDto({ id: "A", name: "A" })]);
    const scopes = knowledgeScopes(
      [personalNote({ id: "n1", title: "p", folderId: "A", hasKnowledge: false }), personalNote({ id: "n2", title: "q", folderId: "A" })],
      index,
      groupIds,
    );
    expect(scopes).toEqual(NO_KNOWLEDGE_SCOPES);
  });

  it("returns the shared empty value when nothing is marked", () => {
    expect(knowledgeScopes([], indexFolders([]), groupIds)).toBe(NO_KNOWLEDGE_SCOPES);
  });
});
