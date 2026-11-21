import { normalizeTagName, type SpaceTagDto } from "@knotebook/shared";

export type TagOption =
  | { kind: "existing"; tag: SpaceTagDto }
  | { kind: "create"; name: string }
  | { kind: "suggestion"; name: string };

export function tagOptions(input: {
  query: string;
  spaceTags: readonly SpaceTagDto[];
  noteTagIds: ReadonlySet<string>;
  suggestions: readonly string[];
}): TagOption[] {
  const query = input.query.trim().toLowerCase();
  const byName = (a: SpaceTagDto, b: SpaceTagDto) => a.name.localeCompare(b.name);
  const available = input.spaceTags.filter((tag) => !input.noteTagIds.has(tag.id));
  const prefix = available.filter((tag) => tag.name.toLowerCase().startsWith(query)).sort(byName);
  const inner = available.filter((tag) => !tag.name.toLowerCase().startsWith(query) && tag.name.toLowerCase().includes(query)).sort(byName);
  const options: TagOption[] = [...prefix, ...inner].map((tag) => ({ kind: "existing", tag }));
  if (query !== "") {
    const name = normalizeTagName(input.query);
    // A name already in the space (attached or not) is picked from the list, never created twice.
    if (name !== null && !input.spaceTags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) {
      options.push({ kind: "create", name });
    }
  }
  for (const name of input.suggestions) options.push({ kind: "suggestion", name });
  return options;
}
