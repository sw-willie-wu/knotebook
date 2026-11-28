import { Extension } from "@tiptap/core";
import { requestMermaidEdit } from "@/components/mermaid/auto-edit";
import { createPmPlugin } from "./pm-plugin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EditorState/Transaction types can't be imported: prosemirror-state isn't an apps/web dependency
type Any = any;

/**
 * BlockNote's own "```lang" input rule always makes a `codeBlock`; for `mermaid` the user means a diagram block (pasting already converts, see `mermaid-paste.ts`).
 * Done in `appendTransaction` so the conversion is part of the same dispatch as the input rule (one undo step), and only for a transaction whose
 * previous selection sat in a paragraph holding the fence: a remote update, or a code block switched to mermaid through the language dropdown, never matches.
 */
function convertTypedMermaidFence(trs: readonly Any[], oldState: Any, newState: Any): Any {
  if (!trs.some((tr) => tr.docChanged)) return null;
  // Best-effort: the y-sync origin marker of remote updates (a duplicated y-prosemirror copy uses another key, the paragraph check below still holds).
  if (trs.some((tr) => tr.getMeta("y-sync$")?.isChangeOrigin === true)) return null;

  const before = oldState.selection.$head;
  if (before.parent.type.name !== "paragraph" || !/^```\s*mermaid\s$/i.test(before.parent.textContent)) return null;

  const { $head } = newState.selection;
  if ($head.parent.type.name !== "codeBlock" || $head.parent.attrs.language !== "mermaid" || $head.parent.content.size !== 0) return null;
  const containerDepth = $head.depth - 1;
  const container = $head.node(containerDepth);
  const id = container.attrs.id;
  if (typeof id !== "string") return null;

  // Only the content node is swapped, like BlockNote's own rule: the block id, nested children and column structure stay.
  const tr = newState.tr;
  const mermaid = newState.schema.nodes.mermaid.create();
  tr.replaceWith($head.before(), $head.after(), mermaid);
  requestMermaidEdit(id);

  // The caret must be a text selection: the diagram is a leaf, so a node selection would let typing replace it (or a following image or divider). It goes into the first child, else the next block when that is a textblock, else a new empty paragraph.
  const containerPos = $head.before(containerDepth);
  const containerEnd = containerPos + tr.doc.nodeAt(containerPos).nodeSize;
  const Selection = oldState.selection.constructor;
  const hasChildren = container.childCount > 1;
  let selection = hasChildren ? Selection.findFrom(tr.doc.resolve($head.before() + mermaid.nodeSize), 1, true) : null;
  if (selection === null) {
    const found = Selection.findFrom(tr.doc.resolve(containerEnd), 1, true);
    const next = tr.doc.resolve(containerEnd).nodeAfter;
    if (found !== null && next !== null && found.from < containerEnd + next.nodeSize) {
      selection = found;
    } else {
      tr.insert(containerEnd, newState.schema.nodes.blockContainer.createAndFill());
      selection = Selection.findFrom(tr.doc.resolve(containerEnd), 1, true);
    }
  }
  if (selection !== null) tr.setSelection(selection);
  return tr;
}

export function createMermaidFenceExtension(): Extension {
  return Extension.create({
    name: "knotebookMermaidFence",
    addProseMirrorPlugins() {
      return [createPmPlugin({ appendTransaction: convertTypedMermaidFence }) as never];
    },
  });
}
