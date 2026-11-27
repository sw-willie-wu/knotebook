import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { presentationSchema } from "./schema";

describe("presentationSchema parity", () => {
  it("block type set equals noteSchema's", () => {
    expect(Object.keys(presentationSchema.blockSchema).sort()).toEqual(Object.keys(noteSchema.blockSchema).sort());
  });

  it("every block's propSchema is the same (including codeBlock's language and mermaid's code)", () => {
    for (const type of Object.keys(noteSchema.blockSchema)) {
      const a = (noteSchema.blockSchema as Record<string, { propSchema: unknown }>)[type].propSchema;
      const b = (presentationSchema.blockSchema as Record<string, { propSchema: unknown }>)[type].propSchema;
      expect(b, type).toEqual(a);
    }
  });

  it("math block exports a div[data-kn-math] whose tex is text, never markup", () => {
    const editor = BlockNoteEditor.create({ schema: presentationSchema });
    const tex = "<img src=x onerror=alert(1)>";
    const html = editor.blocksToHTMLLossy([{ id: "m", type: "math", props: { tex } }] as never);
    const host = document.createElement("div");
    host.innerHTML = html;
    const el = host.querySelector("div[data-kn-math]")!;
    expect(el.textContent).toBe(tex);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("pre")).toBeNull();
  });

  it("has the two column types columnList / column; column's propSchema has only width", () => {
    const blocks = presentationSchema.blockSchema as Record<string, { propSchema: unknown }>;
    expect(blocks.columnList).toBeDefined();
    expect(blocks.column).toBeDefined();
    expect(blocks.column!.propSchema).toEqual({ width: { default: 1 } });
  });

  it("inline content and style type sets are the same", () => {
    expect(Object.keys(presentationSchema.inlineContentSchema).sort()).toEqual(Object.keys(noteSchema.inlineContentSchema).sort());
    expect(Object.keys(presentationSchema.styleSchema).sort()).toEqual(Object.keys(noteSchema.styleSchema).sort());
  });
});
