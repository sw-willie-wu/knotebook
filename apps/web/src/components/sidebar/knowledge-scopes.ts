import type { NoteDto } from "@knotebook/shared";
import { spaceKeyOf, type FolderIndex } from "./folder-index";
import { noteSpaceKey } from "./tree";

export interface KnowledgeScopes {
  personal: boolean;
  groups: ReadonlySet<string>;
  folders: ReadonlySet<string>;
}

export const NO_KNOWLEDGE_SCOPES: KnowledgeScopes = { personal: false, groups: new Set(), folders: new Set() };

/** Notes in Shared with me are skipped: that space has no index. */
export function knowledgeScopes(notes: readonly NoteDto[], index: FolderIndex, groupIds: ReadonlySet<string>): KnowledgeScopes {
  let personal = false;
  const groups = new Set<string>();
  const folders = new Set<string>();
  for (const note of notes) {
    if (note.hasKnowledge !== true) continue;
    const space = noteSpaceKey(note, groupIds);
    if (space === "shared") continue;
    if (space === "personal") personal = true;
    else groups.add(space.slice("group:".length));
    let id = note.folderId;
    while (id !== null && !folders.has(id)) {
      const folder = index.byId.get(id);
      if (folder === undefined || spaceKeyOf(folder.space) !== space) break;
      folders.add(id);
      id = index.parentOf(id);
    }
  }
  return personal || groups.size > 0 ? { personal, groups, folders } : NO_KNOWLEDGE_SCOPES;
}
