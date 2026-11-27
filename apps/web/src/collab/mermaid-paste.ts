/**
 * #94: both paste paths first become `codeBlock(language="mermaid" | "math")` (markdown / plain text via `tryParseMarkdownToBlocks`; HTML because BlockNote's built-in `pre` rule outranks a custom block's `parse`,
 * which is why the mermaid and math specs have no `parse` rule), so the conversion happens on blocks after BlockNote finishes inserting.
 * Only newly inserted blocks (ids not present before the paste) are converted: users can convert a diagram or formula back to code and keep it, and scanning the whole document would override that.
 * It runs on the local paste path only: with a global change handler, two clients would convert the same block at once and fight over it in Yjs.
 */

import { fenceBlockFor } from "@knotebook/shared";
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

export interface PastedFenceTarget {
  id: string;
  block: { type: string; props: Record<string, string> };
}

// The language -> block table lives in shared (`fenceBlockFor`), the same one import and AI edits read.
export function findPastedFenceBlocks(document: MinimalBlock[], idsBeforePaste: Set<string>): PastedFenceTarget[] {
  const found: PastedFenceTarget[] = [];
  const stack = [...document];
  while (stack.length > 0) {
    const block = stack.pop()!;
    if (Array.isArray(block.children)) stack.push(...block.children);
    if (idsBeforePaste.has(block.id)) continue;
    if (block.type !== "codeBlock") continue;
    const source = codeBlockText(block);
    if (source.trim().length === 0) continue; // converting an empty code block to an empty diagram or formula would be a downgrade for the user
    const target = fenceBlockFor(block.props?.language, source);
    if (target !== null) found.push({ id: block.id, block: target });
  }
  return found;
}

// Keeps its original name (it now converts math fences too) so existing callers and tests stay untouched.
// ⚠ Never throws: it runs after the paste has completed, and throwing would make a successful paste look broken. Blocks are replaced one by one so one failure doesn't affect the others.
export function convertPastedMermaidBlocks(editor: MermaidPasteEditor, idsBeforePaste: Set<string>): number {
  let converted = 0;
  let targets: PastedFenceTarget[];
  try {
    targets = findPastedFenceBlocks(editor.document, idsBeforePaste);
  } catch {
    return 0;
  }
  for (const target of targets) {
    try {
      replaceBlocksKeepColumns(editor, [target.id], [target.block]);
      converted += 1;
    } catch {
      /* this one can't be converted; carry on with the next */
    }
  }
  return converted;
}
