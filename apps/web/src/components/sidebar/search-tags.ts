import type { NoteDto, NoteTagDto, TagColor } from "@knotebook/shared";

// The parts the first bundle needs: the token type, the note filter and the `#` pre-check. Everything that decides what to offer lives in `search-tags-logic.ts`, loaded with the completion list.

export type FilterSpaceRef = { kind: "personal" } | { kind: "group"; groupId: string; groupName: string };

export interface SearchTagToken {
  id: string;
  name: string;
  color: TagColor;
  space: FilterSpaceRef;
}

export type CountedTag = NoteTagDto & { count: number };

/** The word before the caret, when it starts with a half- or full-width `#`; a `#` inside a word (`C#`, a URL fragment) doesn't count. */
export function hashFragmentAt(text: string, caret: number): { start: number; end: number; fragment: string } | null {
  let start = caret;
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start -= 1;
  const first = text[start];
  if (start >= caret || (first !== "#" && first !== "＃")) return null;
  return { start, end: caret, fragment: text.slice(start + 1, caret) };
}

/** Cheap pre-check: only text that has a half- or full-width # can be a completion word. */
export function mayHaveHash(text: string): boolean {
  return text.includes("#") || text.includes("＃");
}

/** Keeps the token space's notes that carry every token; with no tokens the list is returned as is. */
export function notesMatchingTokens(notes: readonly NoteDto[], tokens: readonly SearchTagToken[], groupIds: ReadonlySet<string>): NoteDto[] {
  const first = tokens[0];
  if (first === undefined) return [...notes];
  const space = first.space;
  return notes.filter((note) => {
    const inSpace = space.kind === "personal" ? note.groupId === null && note.role === "owner" : note.group?.id === space.groupId && groupIds.has(space.groupId);
    if (!inSpace) return false;
    const have = new Set((note.tags ?? []).map((tag) => tag.id));
    return tokens.every((token) => have.has(token.id));
  });
}
