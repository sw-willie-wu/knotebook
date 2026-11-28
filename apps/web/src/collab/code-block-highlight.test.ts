import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { CODE_BLOCK_BASE_OPTIONS, createKnotebookCodeBlockSpec } from "@knotebook/shared";
import { withCaseInsensitiveCodeHighlight } from "./code-block-highlight";

type FakeHighlighter = {
  getLoadedLanguages: () => string[];
  getLoadedThemes: () => string[];
  loadLanguage: (lang: string) => Promise<void>;
  codeToTokens: (code: string, opts: { lang: string; theme: string }) => {
    tokens: Array<Array<{ content: string; color?: string }>>;
    fg?: string;
    bg?: string;
  };
};

function makeEditor(
  loadHighlighter: () => Promise<FakeHighlighter>,
  initialContent: Array<{ type: "codeBlock"; props: { language: string }; content: string }>,
) {
  const schema = BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      codeBlock: withCaseInsensitiveCodeHighlight(
        createKnotebookCodeBlockSpec(CODE_BLOCK_BASE_OPTIONS),
        loadHighlighter as never,
      ),
    },
  });
  const editor = BlockNoteEditor.create({ schema, initialContent });
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return {
    editor,
    container,
    destroy: () => {
      editor.unmount();
      container.remove();
    },
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("withCaseInsensitiveCodeHighlight", () => {
  const mounted: Array<{ destroy: () => void }> = [];
  afterEach(() => {
    for (const m of mounted.splice(0)) m.destroy();
    vi.restoreAllMocks();
  });

  it("never loads shiki for plain text or unknown languages", async () => {
    const loadHighlighter = vi.fn<() => Promise<FakeHighlighter>>();
    mounted.push(
      makeEditor(loadHighlighter, [
        { type: "codeBlock", props: { language: "text" }, content: "plain" },
        { type: "codeBlock", props: { language: "Plaintext" }, content: "plain alias" },
        { type: "codeBlock", props: { language: "notalang" }, content: "unknown" },
        { type: "codeBlock", props: { language: "TeX" }, content: "$x$" },
      ]),
    );
    await flushAsync();
    expect(loadHighlighter).not.toHaveBeenCalled();
  });

  it("catches synchronous shiki tokenization errors so subsequent editor transactions keep working", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake: FakeHighlighter = {
      getLoadedLanguages: () => ["python"],
      getLoadedThemes: () => ["knotebook-code"],
      loadLanguage: vi.fn(async () => {}),
      codeToTokens: vi.fn(() => {
        throw new Error("simulated regex failure");
      }),
    };
    const m = makeEditor(async () => fake, [
      { type: "codeBlock", props: { language: "Python" }, content: "x = 1" },
    ]);
    mounted.push(m);

    await flushAsync();
    expect(fake.codeToTokens).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    // Editor transactions must still succeed after a highlighting error.
    expect(() => {
      m.editor.insertBlocks([{ type: "paragraph", content: "still editable" }], m.editor.document[0]!, "after");
    }).not.toThrow();
    expect(m.editor.document).toHaveLength(2);
    expect(m.container.textContent).toContain("still editable");
  });

  it("recovers from a transient highlighter chunk-load failure on the next edit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const loaded = new Set<string>();
    const fake: FakeHighlighter = {
      getLoadedLanguages: () => [...loaded],
      getLoadedThemes: () => ["knotebook-code"],
      loadLanguage: async (lang: string) => {
        loaded.add(lang);
      },
      codeToTokens: (code: string) => ({
        tokens: [[{ content: code, color: "var(--code-token-keyword)" }]],
        fg: "var(--code-foreground)",
        bg: "var(--code-background)",
      }),
    };
    const loadHighlighter = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk load failed");
      return fake;
    });

    const m = makeEditor(loadHighlighter, [
      { type: "codeBlock", props: { language: "Python" }, content: "x = 1" },
    ]);
    mounted.push(m);

    await flushAsync();
    expect(attempts).toBe(1);
    expect(m.container.querySelector(".shiki")).toBeNull();

    // Next document change retries loading the highlighter instead of staying stuck on the rejected promise.
    m.editor.updateBlock(m.editor.document[0]!, { content: "x = 2" });
    const deadline = Date.now() + 5_000;
    while (m.container.querySelector(".shiki") === null) {
      if (Date.now() > deadline) throw new Error("highlight did not recover after transient load failure");
      await flushAsync();
    }
    expect(attempts).toBe(2);
    expect(m.container.querySelector(".shiki")?.textContent).toBe("x = 2");
  });
});
