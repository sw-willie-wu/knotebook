import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { MATH_LANGUAGE, MathExternalHTML, commitTex, mathBlockConfig } from "./spec";

describe("mathBlockConfig", () => {
  it("type and content shape are fixed (the schema mount side depends on these two values)", () => {
    expect(mathBlockConfig.type).toBe("math");
    // content:"none" => no BlockNote-managed inline content; the whole source lives in the `tex` prop.
    expect(mathBlockConfig.content).toBe("none");
  });

  it("the tex prop defaults to an empty string (the empty block created by /math takes this path)", () => {
    expect(mathBlockConfig.propSchema.tex.default).toBe("");
  });
});

describe("MathExternalHTML - export", () => {
  it("outputs the shape of a ```math code block, with the source as text", () => {
    const { container } = render(<MathExternalHTML tex={"\\frac{a}{b}"} />);
    const code = container.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code?.getAttribute("class")).toBe(`language-${MATH_LANGUAGE}`);
    expect(code?.textContent).toBe("\\frac{a}{b}");
  });

  it("HTML in the source is output as text and does not become real nodes", () => {
    const { container } = render(<MathExternalHTML tex={"x <img src=x onerror=1>"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre > code")?.textContent).toContain("<img src=x onerror=1>");
  });

  it("an empty source also outputs a valid structure", () => {
    const { container } = render(<MathExternalHTML tex="" />);
    expect(container.querySelector("pre > code")).not.toBeNull();
  });

  it("a tex that is not a string (a misbehaving client wrote an object or a number) exports an empty ```math fence instead of throwing", async () => {
    for (const tex of [{ a: 1 }, 42]) {
      const { container, unmount } = render(<MathExternalHTML tex={tex as unknown as string} />);
      expect(container.querySelector("pre > code")?.textContent).toBe("");
      unmount();
      const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: [{ type: "math", props: { tex: tex as unknown as string } }] });
      const html = await editor.blocksToHTMLLossy(editor.document);
      const markdown = await editor.blocksToMarkdownLossy(editor.document);
      // BlockNote itself copies every prop into a data-* attribute of the outer element (`data-tex="…"`); only the fence body is ours.
      const doc = new DOMParser().parseFromString(html, "text/html");
      expect(doc.querySelector(`pre > code.language-${MATH_LANGUAGE}`)?.textContent).toBe("");
      expect(markdown).toBe("```math\n```\n");
      expect(markdown).not.toContain("[object Object]");
      expect(markdown).not.toContain("42");
    }
  });
});

describe("in-app copy and paste: the block round-trips through BlockNote's own HTML", () => {
  it("a math block serialized to the internal HTML parses back into a math block with the same tex", async () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const tex = "\\frac{a}{b}";
    const html = editor.blocksToFullHTML([{ type: "math", props: { tex } }]);
    const blocks = await editor.tryParseHTMLToBlocks(html);

    expect(blocks[0]?.type).toBe("math");
    expect((blocks[0] as { props: { tex?: string } }).props.tex).toBe(tex);
  });
});

describe("paste (HTML path): where it really lands", () => {
  it('<pre><code class="language-math"> parses into a codeBlock, not a math block', async () => {
    // Pins that the conversion happens at the block level, and why this spec has no `parse` rule.
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const blocks = await editor.tryParseHTMLToBlocks('<pre><code class="language-math">x^2</code></pre>');

    expect(blocks[0]?.type).toBe("codeBlock");
    expect((blocks[0] as { props: { language?: string } }).props.language).toBe(MATH_LANGUAGE);
  });
});

describe("commitTex - writing the source back", () => {
  it("normally writes straight back to the tex prop", () => {
    const updateBlock = vi.fn();
    const block = { id: "b1" } as never;
    commitTex({ updateBlock } as never, block, "x^2");
    expect(updateBlock).toHaveBeenCalledWith(block, { props: { tex: "x^2" } });
  });

  it("a block already deleted remotely must not throw outward", () => {
    const updateBlock = vi.fn(() => {
      throw new Error("Block with ID b1 not found");
    });
    expect(() => commitTex({ updateBlock } as never, { id: "b1" } as never, "x")).not.toThrow();
  });
});
