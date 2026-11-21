/**
 * The block-tree reader and the Y.XmlFragment reader must agree on a document written by the real editor,
 * because the web (block tree) and the server (Yjs) both derive the index from the same note.
 */
import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema, listKnowledgeInBlocks, listKnowledgeInFragment } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const NOTE = "11111111-1111-4111-8111-111111111111";
const text = (t: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: t, styles });
const wikilink = (label: string) => ({ type: "wikilink", props: { targetNoteId: NOTE, snapshotTitle: "Snap", label, anchorBlockId: "" } });
const K = (id: string, over: Record<string, unknown> = {}) => ({ knowledgeId: id, ...over });
const head = (id: string, level: number, content: unknown, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  id, type: "heading", props: { level, ...props }, content, children,
});

function write(blocks: unknown[]): { editor: BlockNoteEditor<never, never, never>; doc: Y.Doc } {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    withCollaboration({ schema: createHeadlessNoteSchema("http://localhost/"), collaboration: { fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { name: "seed", color: "#000" } } } as any),
  ) as unknown as BlockNoteEditor<never, never, never>;
  editor.mount(document.createElement("div"));
  editor.replaceBlocks(editor.document, blocks as never);
  return { editor, doc };
}

describe("knowledge listing on a document written by the real editor", () => {
  it("reads the same entries from the block tree and from the Y.XmlFragment", () => {
    const { editor, doc } = write([
      { id: "p0", type: "paragraph", content: "intro" },
      head("hA", 1, [text("Alpha ", { bold: true }), wikilink(""), text(" mid "), wikilink("Lbl"), { type: "link", href: "https://example.com", content: [text("Ln", { italic: true })] }], K("k_0000000a", { knowledgeVerified: "2026-01-01" })),
      { id: "a1", type: "paragraph", content: "one" },
      head("hB", 2, "Beta", K("k_0000000b", { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_0000000f" })),
      head("plain", 3, "plain"),
      head("hC", 4, "Gamma 字😀", K("k_0000000c")),
      {
        id: "cols", type: "columnList", children: [
          { id: "c1", type: "column", props: { width: 1 }, children: [head("inCol", 1, "in column", K("k_00000020"))] },
          { id: "c2", type: "column", props: { width: 1 }, children: [{ id: "cp", type: "paragraph", content: "x" }] },
        ],
      },
      { id: "li", type: "bulletListItem", content: "item", children: [head("inList", 1, "in list", K("k_00000021"))] },
      { id: "q", type: "quote", content: "quote", children: [head("inQuote", 1, "in quote", K("k_00000022"))] },
      head("hT", 2, "Toggle", K("k_00000010", { knowledgeVerified: "2026-02-02" }), [head("tH", 3, "child heading", K("k_00000011"))]),
      head("hBr", 2, [text("line1\nline2")], K("k_00000012")),
      head("empty", 3, [], K("k_00000013")),
    ]);
    try {
      const fromBlocks = listKnowledgeInBlocks(editor.document as never);
      const fromYjs = listKnowledgeInFragment(doc.getXmlFragment(YDOC_FRAGMENT));
      expect(fromBlocks.map((e) => e.blockId)).toEqual(["hA", "hB", "hC", "hT", "hBr", "empty"]);
      expect(fromYjs).toEqual(fromBlocks);
      const by = Object.fromEntries(fromYjs.map((e) => [e.blockId, e]));
      expect(by.hA!.heading).toBe("Alpha Snap mid LblLn");
      expect(by.hBr!.heading).toBe("line1 line2");
      expect(by.empty!.heading).toBe("");
      expect(by.hB!.icon).toBe("outdated");
      expect(by.hC!.icon).toBe("outdated");
      expect(by.hC!.ancestorBlockIds).toEqual(["hA", "hB"]);
      expect(by.hBr!.parentBlockId).toBe("hA");
    } finally {
      editor.unmount();
    }
  });
});
