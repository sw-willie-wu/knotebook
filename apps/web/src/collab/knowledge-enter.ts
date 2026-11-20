import { Extension } from "@tiptap/core";
import type { EditorRef } from "@/components/wikilink/menu";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node/EditorState types can't be imported: prosemirror-model/-state aren't apps/web dependencies
type Any = any;

// Depth of a top-level heading: doc > blockGroup > blockContainer > heading.
const TOP_LEVEL_HEADING_DEPTH = 3;

/**
 * Enter with the selection starting at the very start of a knowledge heading that has text and ending inside the same heading (a bare caret included).
 * The default split would leave the (now empty) upper heading with the block id and all knowledge props and make the text another knowledge; instead the selected text is deleted and an empty paragraph goes above, in one transaction, and the heading stays.
 * Anything else (middle or end of the heading, selection reaching another block, empty heading, composition, non-knowledge heading) is left to the editor.
 */
export function createKnowledgeEnterExtension(opts: { editorRef: EditorRef }): Extension {
  return Extension.create({
    name: "knotebookKnowledgeEnter",
    // Above BlockNote's own Enter handling.
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor: tiptap }) => {
          const editor = opts.editorRef.current;
          if (!editor || !editor.isEditable) return false;
          if ((tiptap.view as Any).composing) return false;
          const { selection } = tiptap.state as Any;
          const { $from, $to } = selection;
          if (!$from || !$to || !$from.sameParent($to)) return false;
          if ($from.parentOffset !== 0 || $from.depth !== TOP_LEVEL_HEADING_DEPTH) return false;
          const heading = $from.parent;
          const knowledgeId = heading.attrs.knowledgeId;
          if (heading.type.name !== "heading" || typeof knowledgeId !== "string" || knowledgeId === "" || heading.content.size === 0) return false;
          editor.transact((tr: Any) => {
            if (selection.from !== selection.to) tr.delete(selection.from, selection.to);
            const container = tr.doc.type.schema.nodes.blockContainer.createAndFill();
            // Inserted last, in front of everything the deletion touched, so the caret maps to the start of the unchanged heading.
            tr.insert($from.before(TOP_LEVEL_HEADING_DEPTH - 1), container);
          });
          return true;
        },
      };
    },
  });
}
