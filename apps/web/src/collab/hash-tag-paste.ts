import { TAGS_PER_NOTE_MAX } from "@knotebook/shared";
import { removeBlocksKeepColumns } from "./columns/keep-columns";
import { asUndoStep } from "./columns/undo-step";
import { parseHashTagLine, restoreFirstLine, type HashTagHooksRef } from "./hash-tag-input";
import { collectBlockIds } from "./mermaid-paste";
import type { PasteConversionHook } from "./paste";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor has three generic parameters; repo convention is any
type AnyEditor = any;

interface Snapshot {
  ids: Set<string>;
  firstId: string | undefined;
  firstWasEmptyParagraph: boolean;
}

interface InlineNode {
  type?: string;
  text?: string;
  styles?: Record<string, unknown>;
}

/** The text of a block that holds only plain text (no styles, no links, no other inline nodes); null otherwise. */
function plainText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  let out = "";
  for (const node of content as InlineNode[]) {
    if (node.type !== "text" || typeof node.text !== "string" || Object.keys(node.styles ?? {}).length > 0) return null;
    out += node.text;
  }
  return out;
}

/**
 * Runs after the paste has landed, so it judges the pasted block rather than the clipboard text: markdown and HTML pastes are covered alike.
 * The first block counts only if this paste made it: a new id, or the first paragraph that was empty (BlockNote keeps the id when pasting into it).
 */
export function createHashTagPasteHook(hooks: HashTagHooksRef): PasteConversionHook {
  return {
    before(editor) {
      if (!hooks.current) return undefined;
      const document = (editor as AnyEditor).document as Array<{ id: string; type: string; content?: unknown }>;
      const first = document[0];
      return {
        ids: collectBlockIds(document as never),
        firstId: first?.id,
        firstWasEmptyParagraph: first?.type === "paragraph" && Array.isArray(first.content) && first.content.length === 0,
      } satisfies Snapshot;
    },
    after(editor, snapshot) {
      const h = hooks.current;
      if (!h) return;
      const { ids, firstId, firstWasEmptyParagraph } = snapshot as Snapshot;
      const e = editor as AnyEditor;
      const block = e.document[0] as { id: string; type: string; content?: unknown } | undefined;
      if (!block || block.type !== "paragraph") return;
      if (ids.has(block.id) && !(block.id === firstId && firstWasEmptyParagraph)) return;
      const text = plainText(block.content);
      if (text === null) return;
      const names = parseHashTagLine(text);
      if (names === null) return;

      const seen = new Set<string>();
      const unique = names.filter((name) => {
        const key = name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const have = new Set(h.currentTagNames().map((name) => name.toLowerCase()));
      const fresh = unique.filter((name) => !have.has(name.toLowerCase()));
      if (have.size + fresh.length > TAGS_PER_NOTE_MAX) {
        h.notify("over_limit", { max: TAGS_PER_NOTE_MAX });
        return;
      }

      asUndoStep(e, () => removeBlocksKeepColumns(e, [block.id]));
      h.applyHash({ names: unique, restore: () => restoreFirstLine(hooks, e, text) });
    },
  };
}
