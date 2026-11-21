import {
  orderIndexNotes,
  parseKnowledgeRef,
  type KnowledgeIndexDto,
  type KnowledgeIndexEntryDto,
  type KnowledgeIndexNoteDto,
  type KnowledgeIndexReplacementDto,
  type NoteTagDto,
} from "@knotebook/shared";
import { FOLDER_COLLATOR } from "@/components/sidebar/folder-index";

export type IndexReplacement = { state: "found"; target: KnowledgeIndexReplacementDto } | { state: "otherNote" | "missing" };

export interface IndexRowModel {
  entry: KnowledgeIndexEntryDto;
  note: KnowledgeIndexNoteDto;
  nested: IndexRowModel[];
  replacement: IndexReplacement | null;
}

export interface IndexSectionModel {
  key: string;
  title: string;
  /** Rows including nested ones. */
  count: number;
  rows: IndexRowModel[];
  /** Notes in this section that hold more knowledge than the index keeps. */
  cappedNotes: KnowledgeIndexNoteDto[];
  /** Set on a tag section so the title can show the tag's colour. */
  tag?: NoteTagDto;
}

const byIdOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function replacementOf(entry: KnowledgeIndexEntryDto, dto: KnowledgeIndexDto): IndexReplacement | null {
  if (entry.status !== "outdated" || entry.supersededBy === null) return null;
  const found = dto.replacements[entry.supersededBy];
  if (found) return { state: "found", target: found };
  const ref = parseKnowledgeRef(entry.supersededBy);
  if (ref === null) return { state: "missing" };
  return ref.noteId === null || ref.noteId === entry.noteId.toLowerCase() ? { state: "missing" } : { state: "otherNote" };
}

function noteRows(note: KnowledgeIndexNoteDto, entries: readonly KnowledgeIndexEntryDto[], dto: KnowledgeIndexDto): IndexRowModel[] {
  const rows = new Map<string, IndexRowModel>();
  for (const entry of entries) rows.set(entry.knowledgeId, { entry, note, nested: [], replacement: replacementOf(entry, dto) });
  const inCycle = (start: KnowledgeIndexEntryDto): boolean => {
    const seen = new Set([start.knowledgeId]);
    let parent = start.parentKnowledgeId;
    while (parent !== null) {
      if (seen.has(parent)) return true;
      seen.add(parent);
      parent = rows.get(parent)?.entry.parentKnowledgeId ?? null;
    }
    return false;
  };
  const top: IndexRowModel[] = [];
  for (const entry of entries) {
    const row = rows.get(entry.knowledgeId)!;
    const parent = entry.parentKnowledgeId === null ? undefined : rows.get(entry.parentKnowledgeId);
    // A level with no "when to read" of its own only makes sense under its parent; one with its own stands alone.
    if (entry.when === "" && parent !== undefined && !inCycle(entry)) parent.nested.push(row);
    else top.push(row);
  }
  return top;
}

// Done per section, not per note: the last row of the section is outdated, whichever note it came from. Nested rows follow their parent.
function sinkOutdated(rows: IndexRowModel[]): IndexRowModel[] {
  return [...rows.filter((r) => r.entry.icon !== "outdated"), ...rows.filter((r) => r.entry.icon === "outdated")];
}

function countRows(rows: readonly IndexRowModel[]): number {
  let n = 0;
  const stack = [...rows];
  while (stack.length > 0) {
    const row = stack.pop()!;
    n += 1;
    stack.push(...row.nested);
  }
  return n;
}

function section(key: string, title: string, rows: IndexRowModel[], cappedNotes: KnowledgeIndexNoteDto[], tag?: NoteTagDto): IndexSectionModel {
  return { key, title, count: countRows(rows), rows: sinkOutdated(rows), cappedNotes, ...(tag ? { tag } : {}) };
}

const byTitleThenId = (a: KnowledgeIndexNoteDto, b: KnowledgeIndexNoteDto): number =>
  FOLDER_COLLATOR.compare(a.title, b.title) || byIdOrder(a.id, b.id);

export function buildIndexSections(input: {
  dto: KnowledgeIndexDto;
  groupBy: "folder" | "tag";
  scopeTitle: string;
  untaggedTitle: string;
}): IndexSectionModel[] {
  const { dto, groupBy, scopeTitle, untaggedTitle } = input;
  const entriesByNote = new Map<string, KnowledgeIndexEntryDto[]>();
  for (const entry of dto.entries) {
    const list = entriesByNote.get(entry.noteId);
    if (list) list.push(entry);
    else entriesByNote.set(entry.noteId, [entry]);
  }
  for (const list of entriesByNote.values()) list.sort((a, b) => a.ord - b.ord);
  const rowsOf = (note: KnowledgeIndexNoteDto): IndexRowModel[] => noteRows(note, entriesByNote.get(note.id) ?? [], dto);

  if (groupBy === "tag") return buildTagSections(dto, rowsOf, untaggedTitle);

  const rootFolderId = dto.scope.folderId;
  const folderById = new Map(dto.folders.map((f) => [f.id, f]));
  const sectionKeyOf = (note: KnowledgeIndexNoteDto): string => {
    if (note.folderId === null || note.folderId === rootFolderId || !folderById.has(note.folderId)) return "";
    return note.folderId;
  };
  const relativePath = (folderId: string): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = folderId;
    while (cursor !== null && cursor !== rootFolderId && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = folderById.get(cursor);
      if (!folder) break;
      names.push(folder.name);
      cursor = folder.parentId;
    }
    return names.reverse().join(" / ");
  };

  const noteById = new Map(dto.notes.map((n) => [n.id, n]));
  const ordered = orderIndexNotes({ notes: dto.notes, folders: dto.folders, rootFolderId });
  const sections = new Map<string, IndexSectionModel>();
  for (const id of ordered) {
    const note = noteById.get(id);
    if (!note || !entriesByNote.has(id)) continue;
    const key = sectionKeyOf(note);
    let target = sections.get(key);
    if (!target) {
      target = { key: key === "" ? "root" : key, title: key === "" ? scopeTitle : relativePath(key), count: 0, rows: [], cappedNotes: [] };
      sections.set(key, target);
    }
    target.rows.push(...rowsOf(note));
    if (note.capped) target.cappedNotes.push(note);
  }
  return [...sections.values()].map((s) => section(s.key, s.title, s.rows, s.cappedNotes));
}

function buildTagSections(dto: KnowledgeIndexDto, rowsOf: (note: KnowledgeIndexNoteDto) => IndexRowModel[], untaggedTitle: string): IndexSectionModel[] {
  const withEntries = new Set(dto.entries.map((e) => e.noteId));
  const notes = dto.notes.filter((n) => withEntries.has(n.id)).sort(byTitleThenId);
  const byTag = new Map<string, { tag: NoteTagDto; rows: IndexRowModel[]; capped: KnowledgeIndexNoteDto[] }>();
  const untagged: IndexRowModel[] = [];
  const untaggedCapped: KnowledgeIndexNoteDto[] = [];
  for (const note of notes) {
    const rows = rowsOf(note);
    const capped = note.capped ? [note] : [];
    if (note.tags.length === 0) {
      untagged.push(...rows);
      untaggedCapped.push(...capped);
    }
    for (const tag of note.tags) {
      const bucket = byTag.get(tag.id);
      if (bucket) {
        bucket.rows.push(...rows);
        bucket.capped.push(...capped);
      } else byTag.set(tag.id, { tag, rows: [...rows], capped });
    }
  }
  const tagged = [...byTag.values()]
    .sort((a, b) => FOLDER_COLLATOR.compare(a.tag.name, b.tag.name) || byIdOrder(a.tag.id, b.tag.id))
    .map((b) => section(`tag:${b.tag.id}`, b.tag.name, b.rows, b.capped, b.tag));
  return untagged.length > 0 ? [...tagged, section("untagged", untaggedTitle, untagged, untaggedCapped)] : tagged;
}
