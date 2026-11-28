/**
 * #94: both paste paths first become `codeBlock(language="mermaid")` (markdown / plain text via `tryParseMarkdownToBlocks`; HTML because BlockNote's built-in `pre` rule outranks a custom block's `parse`,
 * which is why `spec.tsx` has no `parse` rule), so the conversion happens on blocks after BlockNote finishes inserting.
 * Only newly inserted blocks (ids not present before the paste) are converted: users can convert a diagram back to code and keep it, and scanning the whole document would override that.
 * It runs on the local paste path only: with a global change handler, two clients would convert the same block at once and fight over it in Yjs.
 */

import { replaceBlocksKeepColumns } from "./columns/keep-columns";

interface MinimalBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: MinimalBlock[];
}

export interface MermaidPasteEditor {
  document: MinimalBlock[];
  // `tr` is any: `paste.ts`'s `PasteTargetEditor` overrides `transact` with a narrow type, and writing BlockNote's Transaction would give TS2430 under strictFunctionTypes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  transact: <T>(callback: (tr: any) => T) => T;
}

export function collectBlockIds(blocks: MinimalBlock[]): Set<string> {
  const ids = new Set<string>();
  // Iterative: recursion would throw a RangeError on a very deeply nested list (same as the server's `collab/store.ts`).
  const stack = [...blocks];
  while (stack.length > 0) {
    const block = stack.pop()!;
    ids.add(block.id);
    if (Array.isArray(block.children)) stack.push(...block.children);
  }
  return ids;
}

function codeBlockText(block: MinimalBlock): string {
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((node) => (typeof (node as { text?: unknown }).text === "string" ? (node as { text: string }).text : ""))
    .join("");
}

export function findPastedMermaidCodeBlocks(
  document: MinimalBlock[],
  idsBeforePaste: Set<string>,
): { id: string; code: string }[] {
  const found: { id: string; code: string }[] = [];
  const stack = [...document];
  while (stack.length > 0) {
    const block = stack.pop()!;
    if (Array.isArray(block.children)) stack.push(...block.children);
    if (idsBeforePaste.has(block.id)) continue;
    if (block.type !== "codeBlock") continue;
    if (typeof block.props?.language !== "string" || block.props.language.trim().toLowerCase() !== "mermaid") continue;
    const code = codeBlockText(block);
    if (code.trim().length === 0) continue; // converting an empty code block to an empty diagram would be a downgrade for the user
    found.push({ id: block.id, code });
  }
  return found;
}

// ⚠ Never throws: it runs after the paste has completed, and throwing would make a successful paste look broken. Blocks are replaced one by one so one failure doesn't affect the others.
export function convertPastedMermaidBlocks(editor: MermaidPasteEditor, idsBeforePaste: Set<string>): number {
  let converted = 0;
  let targets: { id: string; code: string }[];
  try {
    targets = findPastedMermaidCodeBlocks(editor.document, idsBeforePaste);
  } catch {
    return 0;
  }
  for (const target of targets) {
    try {
      replaceBlocksKeepColumns(editor, [target.id], [{ type: "mermaid", props: { code: target.code } }]);
      converted += 1;
    } catch {
      /* this one can't be converted; carry on with the next */
    }
  }
  return converted;
}
