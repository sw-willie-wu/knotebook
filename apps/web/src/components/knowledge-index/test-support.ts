import type { KnowledgeIndexDto, KnowledgeIndexEntryDto, KnowledgeIndexNoteDto, NoteTagDto } from "@knotebook/shared";

export function indexNote(over: Partial<KnowledgeIndexNoteDto> & { id: string }): KnowledgeIndexNoteDto {
  return { title: over.id, path: `/n/alice/${over.id}`, folderId: null, tags: [], ...over };
}

export function indexEntry(over: Partial<KnowledgeIndexEntryDto> & { noteId: string; knowledgeId: string }): KnowledgeIndexEntryDto {
  return {
    blockId: `b_${over.knowledgeId}`,
    ord: 0,
    level: 2,
    heading: over.knowledgeId,
    when: "",
    conclusion: "",
    evidence: "",
    verified: "2026-01-01",
    status: "",
    icon: "verified",
    parentKnowledgeId: null,
    supersededBy: null,
    summary: null,
    ...over,
  };
}

export function indexDto(over: Partial<KnowledgeIndexDto> = {}): KnowledgeIndexDto {
  return {
    scope: { kind: "personal", groupId: null, groupName: null, folderId: null, folderPath: [] },
    folders: [],
    notes: [],
    entries: [],
    replacements: {},
    tagOptions: [],
    truncated: false,
    backfillPending: false,
    ...over,
  };
}

export const tag = (id: string, name: string, color: NoteTagDto["color"] = "blue"): NoteTagDto => ({ id, name, color });
