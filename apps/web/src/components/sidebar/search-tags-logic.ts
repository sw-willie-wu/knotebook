import type { GroupDto, NoteDto, NoteTagDto } from "@knotebook/shared";
import type { CountedTag, FilterSpaceRef, SearchTagToken } from "./search-tags";
import { partitionNotes } from "./tree";

// Lazy: loaded with the completion list (see `TagSearchController`).

export interface FilterableTagSpace {
  space: FilterSpaceRef;
  tags: CountedTag[];
}

export interface HashOptionSection {
  space: FilterSpaceRef;
  tags: Array<CountedTag & { dimmed: boolean }>;
}

export function spaceKeyOf(space: FilterSpaceRef): string {
  return space.kind === "personal" ? "personal" : `group:${space.groupId}`;
}

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function countTags(notes: readonly NoteDto[]): CountedTag[] {
  const byId = new Map<string, CountedTag>();
  for (const note of notes) {
    for (const tag of note.tags ?? []) {
      const seen = byId.get(tag.id);
      if (seen === undefined) byId.set(tag.id, { ...tag, count: 1 });
      else seen.count += 1;
    }
  }
  return [...byId.values()].sort((a, b) => NAME_COLLATOR.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
}

/** Only notes in My notes and in groups the user belongs to count: notes shared with the user are never searchable by tag. */
export function filterableTagSpaces(notes: readonly NoteDto[], groups: readonly GroupDto[]): FilterableTagSpace[] {
  const parts = partitionNotes([...notes], [...groups]);
  const out: FilterableTagSpace[] = [];
  const personal = countTags(parts.myNotes);
  if (personal.length > 0) out.push({ space: { kind: "personal" }, tags: personal });
  for (const group of groups) {
    const tags = countTags(parts.byGroup.get(group.id) ?? []);
    if (tags.length > 0) out.push({ space: { kind: "group", groupId: group.id, groupName: group.name }, tags });
  }
  return out;
}

export { hashFragmentAt } from "./search-tags";

/** A tag already used as a token is not offered again; tags of other spaces stay but dimmed, because choosing one replaces the tokens. */
export function hashOptions(spaces: readonly FilterableTagSpace[], fragment: string, tokens: readonly SearchTagToken[]): HashOptionSection[] {
  const needle = fragment.normalize("NFC").toLowerCase();
  const tokenIds = new Set(tokens.map((token) => token.id));
  const tokenSpace = tokens[0] === undefined ? null : spaceKeyOf(tokens[0].space);
  const out: HashOptionSection[] = [];
  for (const { space, tags } of spaces) {
    const dimmed = tokenSpace !== null && tokenSpace !== spaceKeyOf(space);
    const hits = tags.filter((tag) => !tokenIds.has(tag.id) && tag.name.toLowerCase().includes(needle));
    if (hits.length === 0) continue;
    const prefix = hits.filter((tag) => tag.name.toLowerCase().startsWith(needle));
    const rest = hits.filter((tag) => !tag.name.toLowerCase().startsWith(needle));
    out.push({ space, tags: [...prefix, ...rest].map((tag) => ({ ...tag, dimmed })) });
  }
  return out;
}

export function tokenFromTag(tag: NoteTagDto, space: FilterSpaceRef): SearchTagToken {
  return { id: tag.id, name: tag.name, color: tag.color, space };
}

/** Choosing a tag of another space replaces the tokens, since one search covers one space. */
export function addToken(tokens: readonly SearchTagToken[], token: SearchTagToken): SearchTagToken[] {
  const first = tokens[0];
  if (first === undefined) return [token];
  if (spaceKeyOf(first.space) !== spaceKeyOf(token.space)) return [token];
  return tokens.some((t) => t.id === token.id) ? [...tokens] : [...tokens, token];
}

/** Drops tokens whose tag no longer sits on a visible note and refreshes names and colors after a rename. Returns the same array when nothing changed. */
export function reconcileTokens(tokens: readonly SearchTagToken[], spaces: readonly FilterableTagSpace[]): readonly SearchTagToken[] {
  const current = new Map<string, NoteTagDto>();
  for (const { tags } of spaces) for (const tag of tags) current.set(tag.id, tag);
  let changed = false;
  const next: SearchTagToken[] = [];
  for (const token of tokens) {
    const live = current.get(token.id);
    if (live === undefined) {
      changed = true;
      continue;
    }
    if (live.name !== token.name || live.color !== token.color) {
      changed = true;
      next.push({ ...token, name: live.name, color: live.color });
    } else next.push(token);
  }
  return changed ? next : tokens;
}

/** Removes the fragment and one of the two spaces that would otherwise meet where it was. */
export function removeFragment(text: string, range: { start: number; end: number }): { text: string; caret: number } {
  let before = text.slice(0, range.start);
  const after = text.slice(range.end);
  if (/\s$/u.test(before) && /^\s/u.test(after)) before = before.replace(/\s$/u, "");
  return { text: before + after, caret: before.length };
}
