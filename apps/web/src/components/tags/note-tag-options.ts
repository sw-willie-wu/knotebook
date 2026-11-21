import type { NoteDto, NoteTagDto } from "@knotebook/shared";

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function byName(a: NoteTagDto, b: NoteTagDto): number {
  return NAME_COLLATOR.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Tags that appear on the given notes, with how many of those notes carry each. */
export function countedTagOptionsForNotes(notes: readonly NoteDto[]): Array<NoteTagDto & { count: number }> {
  const byId = new Map<string, NoteTagDto & { count: number }>();
  for (const note of notes) {
    for (const tag of note.tags ?? []) {
      const seen = byId.get(tag.id);
      if (seen === undefined) byId.set(tag.id, { ...tag, count: 1 });
      else seen.count += 1;
    }
  }
  return [...byId.values()].sort(byName);
}

export function tagOptionsForNotes(notes: readonly NoteDto[]): NoteTagDto[] {
  return countedTagOptionsForNotes(notes).map((tag) => ({ id: tag.id, name: tag.name, color: tag.color }));
}
