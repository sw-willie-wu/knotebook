import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema } from "@knotebook/shared";

/** The headless schema as it was before headings carried knowledge props: used to write the documents that exist in production. */
export function preUpgradeSchema() {
  const current = createHeadlessNoteSchema("http://localhost/");
  return BlockNoteSchema.create({
    blockSpecs: { ...current.blockSpecs, heading: defaultBlockSpecs.heading },
    inlineContentSpecs: current.inlineContentSpecs,
  });
}

/** Needs `EditingRuntime#installGlobals()` first (the editor mounts into a DOM). */
export function buildPreUpgradeDoc(blocks: unknown[]): Y.Doc {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    withCollaboration({ schema: preUpgradeSchema(), collaboration: { fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { name: "seed", color: "#000" } } } as any),
  );
  editor.mount(document.createElement("div"));
  try {
    editor.replaceBlocks(editor.document, blocks as never);
  } finally {
    editor.unmount();
  }
  return doc;
}

export const heading = (id: string, level: number, text: string, props: Record<string, unknown> = {}) => ({ id, type: "heading", props: { level, ...props }, content: text });
export const paragraph = (id: string, text: string) => ({ id, type: "paragraph", content: text });

/** Six sections plus a lead paragraph; hB and hC carry non-default heading props so those paths are covered too. */
export function preUpgradeBlocks(): unknown[] {
  return [
    paragraph("p0", "intro"),
    heading("hA", 1, "A"), paragraph("a1", "one"), paragraph("a2", "two"),
    heading("hB", 1, "B", { textColor: "red" }), paragraph("b1", "three"),
    heading("hC", 1, "C", { isToggleable: true }), paragraph("c1", "four"),
    heading("hD", 1, "D"), paragraph("d1", "five"), heading("hE", 2, "E"), paragraph("e1", "six"),
  ];
}
