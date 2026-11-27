// The one table of code-fence languages that become a block of their own. Import, AI edits and paste all read it,
// so a language is added or removed in exactly one place. Keys are exact strings: `latex` is deliberately absent
// (a ```latex fence stays a code block) and a lookup never reaches Object.prototype.
// The names are literals, not MERMAID_LANGUAGE / MATH_LANGUAGE: note-schema-config -> site-link -> note-markdown
// -> this file would be an import cycle (fence-blocks.test.ts pins that they match the constants).
export const FENCE_BLOCKS: ReadonlyMap<string, { type: string; prop: string }> = new Map([
  ["mermaid", { type: "mermaid", prop: "code" }],
  ["math", { type: "math", prop: "tex" }],
]);

export function fenceBlockFor(language: unknown, source: string): { type: string; props: Record<string, string> } | null {
  if (typeof language !== "string") return null;
  const target = FENCE_BLOCKS.get(language);
  return target === undefined ? null : { type: target.type, props: { [target.prop]: source } };
}
