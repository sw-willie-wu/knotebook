/** The only place that knows how a note's tags are written in a file's front matter. */
export const TAGS_FRONT_MATTER_MESSAGE = "The front matter's `tags` must be a JSON array of strings, like [\"a\", \"b\"].";

/** `JSON.stringify` that also escapes the characters other line-splitting tools treat as line breaks (U+0080–U+009F, U+2028, U+2029). */
export function frontMatterJson(value: string): string {
  return JSON.stringify(value).replace(/[\u0080-\u009f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** `frontMatterValue`: the raw text after `tags:`, undefined when the key is absent. */
export function parseNoteTags(frontMatterValue: string | undefined): { ok: true; tags: string[] | undefined } | { ok: false; message: string } {
  if (frontMatterValue === undefined) return { ok: true, tags: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(frontMatterValue);
  } catch {
    return { ok: false, message: TAGS_FRONT_MATTER_MESSAGE };
  }
  if (!Array.isArray(parsed) || !parsed.every((x): x is string => typeof x === "string")) return { ok: false, message: TAGS_FRONT_MATTER_MESSAGE };
  return { ok: true, tags: parsed };
}

/** The whole front matter line. */
export function serializeNoteTags(names: readonly string[]): string {
  return `tags: [${names.map(frontMatterJson).join(", ")}]`;
}

/** Order, case and duplicates don't count as a change; `names` are already valid tag names. */
export function tagsKeyOf(names: readonly string[]): string {
  return JSON.stringify([...new Set(names.map(n => n.toLowerCase()))].sort());
}
