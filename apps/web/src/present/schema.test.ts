import { describe, expect, it } from "vitest";
import { noteSchema } from "@/collab/schema";
import { presentationSchema } from "./schema";

describe("presentationSchema parity", () => {
  it("block 型別集合與 noteSchema 相同", () => {
    expect(Object.keys(presentationSchema.blockSchema).sort()).toEqual(Object.keys(noteSchema.blockSchema).sort());
  });

  it("每個 block 的 propSchema 相同（含 codeBlock 的 language 與 mermaid 的 code）", () => {
    for (const type of Object.keys(noteSchema.blockSchema)) {
      const a = (noteSchema.blockSchema as Record<string, { propSchema: unknown }>)[type].propSchema;
      const b = (presentationSchema.blockSchema as Record<string, { propSchema: unknown }>)[type].propSchema;
      expect(b, type).toEqual(a);
    }
  });

  it("有並排兩型 columnList／column，column 的 propSchema 只有 width", () => {
    const blocks = presentationSchema.blockSchema as Record<string, { propSchema: unknown }>;
    expect(blocks.columnList).toBeDefined();
    expect(blocks.column).toBeDefined();
    expect(blocks.column!.propSchema).toEqual({ width: { default: 1 } });
  });

  it("inline content 與 style 型別集合相同", () => {
    expect(Object.keys(presentationSchema.inlineContentSchema).sort()).toEqual(Object.keys(noteSchema.inlineContentSchema).sort());
    expect(Object.keys(presentationSchema.styleSchema).sort()).toEqual(Object.keys(noteSchema.styleSchema).sort());
  });
});
