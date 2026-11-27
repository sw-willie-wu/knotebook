import { describe, expect, it } from "vitest";
import { FENCE_BLOCKS, fenceBlockFor } from "./fence-blocks.js";
import { MATH_LANGUAGE, MERMAID_LANGUAGE, mathBlockConfig, mermaidBlockConfig } from "./note-schema-config.js";

describe("fenceBlockFor", () => {
  it("maps the mermaid and math fences to their block types", () => {
    expect(fenceBlockFor("mermaid", "graph TD")).toEqual({ type: "mermaid", props: { code: "graph TD" } });
    expect(fenceBlockFor("math", "E=mc^2")).toEqual({ type: "math", props: { tex: "E=mc^2" } });
  });

  it.each(["latex", "tex", "LaTeX", "Math", "MATH", "Mermaid", "mathematica", "", "constructor", "__proto__", "toString", "hasOwnProperty"])(
    "the language %j is not a fence block",
    (language) => {
      expect(fenceBlockFor(language, "x")).toBeNull();
    },
  );

  it.each([undefined, null, 0, {}, ["math"]])("a non-string language %j is not a fence block", (language) => {
    expect(fenceBlockFor(language, "x")).toBeNull();
  });

  it("is a table of exactly the two fence languages", () => {
    expect([...FENCE_BLOCKS.keys()].sort()).toEqual(["math", "mermaid"]);
  });
});

describe("FENCE_BLOCKS vs the block configs", () => {
  it("the languages and prop names match the schema constants", () => {
    expect(FENCE_BLOCKS.get(MERMAID_LANGUAGE)).toEqual({ type: mermaidBlockConfig.type, prop: Object.keys(mermaidBlockConfig.propSchema)[0] });
    expect(FENCE_BLOCKS.get(MATH_LANGUAGE)).toEqual({ type: mathBlockConfig.type, prop: Object.keys(mathBlockConfig.propSchema)[0] });
  });
});
