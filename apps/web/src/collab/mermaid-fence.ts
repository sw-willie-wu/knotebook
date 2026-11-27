import { Extension } from "@tiptap/core";
import { requestMermaidEdit } from "@/components/mermaid/auto-edit";
import { createPmPlugin } from "./pm-plugin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EditorState/Transaction types can't be imported: prosemirror-state isn't an apps/web dependency
type Any = any;

/** What a typed fence turns into. `mermaid-fence.ts` and `math-fence.ts` each supply one. */
export interface TypedFence {
  /** The fence language, matched exactly and case-sensitively: ```latex and ```mathematica never match ```math. Must not contain regex special characters: it is put into a `RegExp` unescaped. */
  language: string;
  /** Name of the leaf block node the fence becomes. */
  nodeName: string;
  /** Asks the new block's view to open its source editor once it mounts. */
  requestEdit(blockId: string): void;
}

const MERMAID_FENCE: TypedFence = { language: "mermaid", nodeName: "mermaid", requestEdit: requestMermaidEdit };

/**
 * Turns the textblock at `$head` (resolved in the document `tr` is editing) into an empty leaf block and puts the caret somewhere typeable.
 * Only the content node is swapped, like BlockNote's own rule: the block id, nested children and column structure stay.
 * The caret must be a text selection: the leaf is not typeable, so a node selection would let typing replace it (or a following image or divider). It goes into the first child, else the next block when that is a textblock, else a new empty paragraph.
 */
function swapForLeafBlock(tr: Any, state: Any, $head: Any, nodeName: string): void {
  const containerDepth = $head.depth - 1;
  const container = $head.node(containerDepth);
  const leaf = state.schema.nodes[nodeName].create();
  tr.replaceWith($head.before(), $head.after(), leaf);

  const containerPos = $head.before(containerDepth);
  const containerEnd = containerPos + tr.doc.nodeAt(containerPos).nodeSize;
  const Selection = state.selection.constructor;
  const hasChildren = container.childCount > 1;
  let selection = hasChildren ? Selection.findFrom(tr.doc.resolve($head.before() + leaf.nodeSize), 1, true) : null;
  if (selection === null) {
    const found = Selection.findFrom(tr.doc.resolve(containerEnd), 1, true);
    const next = tr.doc.resolve(containerEnd).nodeAfter;
    if (found !== null && next !== null && found.from < containerEnd + next.nodeSize) {
      selection = found;
    } else {
      tr.insert(containerEnd, state.schema.nodes.blockContainer.createAndFill());
      selection = Selection.findFrom(tr.doc.resolve(containerEnd), 1, true);
    }
  }
  if (selection !== null) tr.setSelection(selection);
}

/**
 * BlockNote's own "```lang" input rule always makes a `codeBlock`; for `mermaid` the user means a diagram block (pasting already converts, see `mermaid-paste.ts`).
 * Done in `appendTransaction` so the conversion is part of the same dispatch as the input rule (one undo step), and only for a transaction whose
 * previous selection sat in a paragraph holding the fence: a remote update, or a code block switched to mermaid through the language dropdown, never matches.
 */
export function convertTypedFence(fence: TypedFence, trs: readonly Any[], oldState: Any, newState: Any): Any {
  if (!trs.some((tr) => tr.docChanged)) return null;
  // Best-effort: the y-sync origin marker of remote updates (a duplicated y-prosemirror copy uses another key, the paragraph check below still holds).
  if (trs.some((tr) => tr.getMeta("y-sync$")?.isChangeOrigin === true)) return null;

  const before = oldState.selection.$head;
  if (before.parent.type.name !== "paragraph" || !new RegExp(`^\`\`\`\\s*${fence.language}\\s$`).test(before.parent.textContent)) return null;

  const { $head } = newState.selection;
  if ($head.parent.type.name !== "codeBlock" || $head.parent.attrs.language !== fence.language || $head.parent.content.size !== 0) return null;
  const id = $head.node($head.depth - 1).attrs.id;
  if (typeof id !== "string") return null;

  const tr = newState.tr;
  swapForLeafBlock(tr, newState, $head, fence.nodeName);
  fence.requestEdit(id);
  return tr;
}

export function createMermaidFenceExtension(): Extension {
  return Extension.create({
    name: "knotebookMermaidFence",
    addProseMirrorPlugins() {
      return [createPmPlugin({ appendTransaction: (trs, oldState, newState) => convertTypedFence(MERMAID_FENCE, trs, oldState, newState) }) as never];
    },
  });
}
