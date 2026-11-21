import type { TFunction } from "i18next";

const SUGGESTION_KEYS = ["todo", "reference", "meeting", "decision", "idea", "draft", "important", "archive"] as const;

/** `existingKeys` holds lower-cased names, the same comparison the server uses for "same tag". */
export function tagSuggestions(t: TFunction, opts: { query: string; existingKeys: ReadonlySet<string> }): string[] {
  const query = opts.query.trim().toLowerCase();
  return SUGGESTION_KEYS.map((key) => t(`tags.suggestions.${key}`)).filter((name) => {
    const lower = name.toLowerCase();
    return !opts.existingKeys.has(lower) && (query === "" || lower.includes(query));
  });
}
