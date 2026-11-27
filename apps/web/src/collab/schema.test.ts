import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor, defaultBlockSpecs, defaultInlineContentSpecs, type PartialBlock } from "@blocknote/core";
import { createHeadlessNoteSchema } from "@knotebook/shared";
import { classifyMediaTransfer, containsMediaDataUrl, noteSchema } from "./schema";
import { integrity, mountEditor, P, row, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

/**
 * Minimal DataTransfer stand-in: jsdom has no constructible DataTransfer.
 *
 * `types` is stated by the caller independently of `html`/`text`/`markdown`/`blocknoteHtml`: the File + text-type rule only looks at whether `dataTransfer.types` lists a format's name, which is separate from whether `getData` returns content for it (e.g. `vscode-editor-data` only needs to appear in `types`; `classifyMediaTransfer` never calls `getData` on it).
 *
 * `files` use the real `File` shape (`new File([bytes], name, { type })`): the image-file rules of `classifyMediaTransfer` read `File.type`, which a fake carrying only `{ length }` can't support.
 */
function transfer(options: {
  files?: File[];
  types?: string[];
  html?: string;
  text?: string;
  markdown?: string;
  blocknoteHtml?: string;
  /** Raw content of `vscode-editor-data`: the data-URL rule deliberately doesn't scan this format, and tests need that. */
  vscodeEditorData?: string;
}): DataTransfer {
  const map: Record<string, string> = {};
  if (options.html !== undefined) map["text/html"] = options.html;
  if (options.text !== undefined) map["text/plain"] = options.text;
  if (options.markdown !== undefined) map["text/markdown"] = options.markdown;
  if (options.blocknoteHtml !== undefined) map["blocknote/html"] = options.blocknoteHtml;
  if (options.vscodeEditorData !== undefined) map["vscode-editor-data"] = options.vscodeEditorData;
  const files = options.files ?? [];
  return {
    files: files as unknown as FileList,
    types: options.types ?? [],
    getData: (type: string) => map[type] ?? "",
  } as unknown as DataTransfer;
}

/** A real `File` for tests; one byte is enough since `classifyMediaTransfer` only reads `.type`. */
function file(name: string, type: string): File {
  return new File([new Uint8Array([1])], name, { type });
}

describe("noteSchema (image block enabled)", () => {
  it("has the image block", () => {
    expect(Object.keys(noteSchema.blockSpecs)).toContain("image");
    expect("image" in noteSchema.blockSchema).toBe(true);
  });

  it("all default blocks are kept (image included)", () => {
    // Guards that default blocks aren't dropped: `BlockNoteSchema.create`'s `blockSpecs` overrides the whole set, so forgetting the `...defaultBlockSpecs` spread silently removes half the editor. The check is "contains" rather than equality since the schema adds custom blocks (e.g. `mermaid`); it still fails if any default block is lost, and the next test pins that the custom blocks are attached.
    expect(Object.keys(noteSchema.blockSpecs)).toEqual(expect.arrayContaining(Object.keys(defaultBlockSpecs)));
  });

  it("custom blocks are attached, and only the deliberately added ones", () => {
    const custom = Object.keys(noteSchema.blockSpecs).filter((type) => !(type in defaultBlockSpecs));
    expect(custom.sort()).toEqual(["column", "columnList", "math", "mermaid"]);
  });

  it("noteSchema's heading propSchema equals the headless schema's heading propSchema", () => {
    const pick = (props: Record<string, { default: unknown }>) => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.default]));
    const web = noteSchema.blockSchema.heading.propSchema as unknown as Record<string, { default: unknown }>;
    const headless = createHeadlessNoteSchema("http://localhost/").blockSchema.heading.propSchema as unknown as Record<string, { default: unknown }>;
    expect(Object.keys(web).sort()).toEqual(Object.keys(headless).sort());
    expect(pick(web)).toEqual(pick(headless));
  });

  it("basic blocks such as paragraph and heading are still there (guards against a wrongly built schema)", () => {
    expect(Object.keys(noteSchema.blockSpecs)).toEqual(expect.arrayContaining(["paragraph", "heading", "table"]));
  });
});

// The `wikilink` inline content spec is attached: this guards the trap of passing `inlineContentSpecs` without spreading `defaultInlineContentSpecs` (see the comment at the top of schema.ts); if it's forgotten, `text`/`link` silently vanish from `noteSchema.inlineContentSpecs` with no type or runtime error, and only a test that lists the keys explicitly catches it.
describe("noteSchema (wikilink inline content attached)", () => {
  it("default inline content (text/link) is kept and wikilink is added", () => {
    expect(Object.keys(noteSchema.inlineContentSpecs).sort()).toEqual(
      [...Object.keys(defaultInlineContentSpecs), "wikilink"].sort(),
    );
  });
});

describe("containsMediaDataUrl", () => {
  it("recognizes a base64 data URL in img src", () => {
    expect(containsMediaDataUrl('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(true);
  });

  it("recognizes a data URL pasted as plain text (at line start)", () => {
    expect(containsMediaDataUrl("data:image/gif;base64,R0lGOD")).toBe(true);
  });

  it("recognizes a non-base64 data URL (parameter segment ending at the comma)", () => {
    expect(containsMediaDataUrl('<img src="data:image/svg+xml,%3Csvg/%3E">')).toBe(true);
  });

  it("recognizes video/audio", () => {
    expect(containsMediaDataUrl("data:video/mp4;base64,AAA")).toBe(true);
    expect(containsMediaDataUrl("data:audio/mpeg;base64,AAA")).toBe(true);
  });

  it("doesn't wrongly block the text data: in ordinary text or non-media data URLs", () => {
    expect(containsMediaDataUrl("請參考 data structures 這一章")).toBe(false);
    expect(containsMediaDataUrl("data:text/plain;base64,aGk=")).toBe(false);
    expect(containsMediaDataUrl("mydata:image/png;base64,x")).toBe(false);
    expect(containsMediaDataUrl("")).toBe(false);
    expect(containsMediaDataUrl(null)).toBe(false);
  });
});

describe("classifyMediaTransfer (four rules)", () => {
  describe("data URL -> \"dataUrl\"", () => {
    it("text/html fragment carrying a data URL (the common shape when copying an image from a web page)", () => {
      expect(classifyMediaTransfer(transfer({ html: '<img src="data:image/png;base64,AAA">' }))).toBe("dataUrl");
    });

    it("text/plain carrying a data URL", () => {
      expect(classifyMediaTransfer(transfer({ text: "data:image/png;base64,AAA" }))).toBe("dataUrl");
    });

    it("text/markdown carrying a data URL (markdown only: no other format has content)", () => {
      expect(classifyMediaTransfer(transfer({ markdown: "![alt](data:image/png;base64,AAA)" }))).toBe("dataUrl");
    });

    it("blocknote/html carrying a data URL", () => {
      expect(
        classifyMediaTransfer(transfer({ blocknoteHtml: '<img src="data:image/png;base64,AAA">' })),
      ).toBe("dataUrl");
    });

    it("a data URL still takes priority even with an image file attached", () => {
      expect(
        classifyMediaTransfer(
          transfer({ files: [file("a.png", "image/png")], html: '<img src="data:image/png;base64,AAA">' }),
        ),
      ).toBe("dataUrl");
    });

    // The previous case's `types` is an empty array, so the `hasFiles && types.some(...)` branch of the File + text-type rule is never evaluated: it shows the data-URL rule precedes the image-file rule but not the File + text-type rule. This case also puts `types` in the shape that rule would match (`text/html` listed), so both rules have a chance to match and the order is pinned: if an implementation moved the other rule's check ahead, the result would change from "dataUrl" to "textRepresentation" and this would go red.
    it("files + types containing text/html + html carrying a data URL -> dataUrl (data URL takes priority over the text-type rule)", () => {
      expect(
        classifyMediaTransfer(
          transfer({
            files: [file("a.png", "image/png")],
            types: ["text/html", "Files"],
            html: '<img src="data:image/png;base64,AAA">',
          }),
        ),
      ).toBe("dataUrl");
    });

    it("vscode-editor-data is deliberately not scanned for data URLs: even a data URL inside it doesn't count as dataUrl", () => {
      expect(
        classifyMediaTransfer(
          transfer({ types: ["vscode-editor-data"], vscodeEditorData: "data:image/png;base64,AAA" }),
        ),
      ).toBeNull();
    });
  });

  describe("File present and types contain any of the first five acceptedMIMETypes -> \"textRepresentation\"", () => {
    const image = () => [file("a.png", "image/png")];

    it("vscode-editor-data", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["vscode-editor-data"] }))).toBe(
        "textRepresentation",
      );
    });

    it("blocknote/html", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["blocknote/html"] }))).toBe(
        "textRepresentation",
      );
    });

    it("text/markdown", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["text/markdown"] }))).toBe(
        "textRepresentation",
      );
    });

    it("text/html", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["text/html"] }))).toBe("textRepresentation");
    });

    it("text/plain", () => {
      expect(classifyMediaTransfer(transfer({ files: image(), types: ["text/plain"] }))).toBe("textRepresentation");
    });

    it("all-image files + text/html with an ordinary https src (not a data URL) -> still textRepresentation (this rule takes priority over the image-file rule)", () => {
      expect(
        classifyMediaTransfer(
          transfer({
            files: image(),
            types: ["text/html"],
            html: '<img src="https://example.com/photo.png">',
          }),
        ),
      ).toBe("textRepresentation");
    });

    it("without a File it doesn't count even if types contain these formats: a File is required first", () => {
      expect(classifyMediaTransfer(transfer({ types: ["text/html"], html: "<p>hello</p>" }))).toBeNull();
    });
  });

  describe("non-empty files that all have File.type starting with image/ -> pass", () => {
    it("a single image file, types is only Files", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("a.png", "image/png")], types: ["Files"] }))).toBeNull();
    });

    it("an SVG image file (image/svg+xml) passes through to uploadFile (#389)", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("diagram.svg", "image/svg+xml")], types: ["Files"] }))).toBeNull();
    });

    it("several image files", () => {
      expect(
        classifyMediaTransfer(
          transfer({ files: [file("a.png", "image/png"), file("b.gif", "image/gif")], types: ["Files"] }),
        ),
      ).toBeNull();
    });

    it("an empty-string type doesn't count as image (it isn't let through as anything other than nonImageFile)", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("a", "")], types: ["Files"] }))).toBe("nonImageFile");
    });
  });

  describe("any non-image file -> \"nonImageFile\"", () => {
    it("a single video file", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("a.mp4", "video/mp4")], types: ["Files"] }))).toBe(
        "nonImageFile",
      );
    });

    it("a single audio file", () => {
      expect(classifyMediaTransfer(transfer({ files: [file("a.mp3", "audio/mpeg")], types: ["Files"] }))).toBe(
        "nonImageFile",
      );
    });

    it("mixed image and non-image files", () => {
      expect(
        classifyMediaTransfer(
          transfer({ files: [file("a.png", "image/png"), file("b.pdf", "application/pdf")], types: ["Files"] }),
        ),
      ).toBe("nonImageFile");
    });
  });

  describe("default pass (none of the four rules matches)", () => {
    it("plain text and ordinary HTML pass", () => {
      expect(classifyMediaTransfer(transfer({ text: "hello", html: "<p>hello</p>" }))).toBeNull();
      expect(classifyMediaTransfer(transfer({}))).toBeNull();
    });

    it("passes when there is no dataTransfer", () => {
      expect(classifyMediaTransfer(null)).toBeNull();
      expect(classifyMediaTransfer(undefined)).toBeNull();
    });
  });
});

/**
 * #43: `toExternalHTML` (the `text/html` copied to the clipboard and the markdown export of `blocksToMarkdownLossy`) takes the raw `props.url` and doesn't go through the render-side guard hung on `resolveFileUrl` by #12, so copying a tainted block into another app would carry `<a href="javascript:...">` / `<img src="javascript:...">`. The `toExternalHTML` of the four file-type block specs must apply the same `safeMediaUrl`.
 *
 * Tested like the render-guard test for `defaultBlockSpecs.image` in `NoteEditor.test.ts`: calls the spec implementation directly (jsdom has document.createElement) without mounting a whole editor.
 */
describe("toExternalHTML of file-type blocks goes through the media URL guard (#43)", () => {
  type FileSpecLike = {
    implementation: {
      meta?: { fileBlockAccept?: unknown };
      toExternalHTML: (block: Record<string, unknown>, editor: unknown) => { dom: HTMLElement };
    };
  };
  const specs = noteSchema.blockSpecs as unknown as Record<string, FileSpecLike>;
  const FILE_BLOCK_TYPES = ["audio", "file", "image", "video"] as const;

  /** The fake block carries `type`/`id`/`children`: the delegated original (the `createBlockSpec` toExternalHTML, which includes `wrapInBlockStructure`) reads `block.type` to emit `data-content-type`, and with only props the DOM wouldn't match production's shape. */
  function block(type: string, url: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type,
      id: "b1",
      children: [],
      props: {
        url,
        name: "n",
        caption: "",
        showPreview: true,
        previewWidth: undefined,
        backgroundColor: "default",
        textAlignment: "left",
        ...overrides,
      },
    };
  }

  function carriedUrl(dom: HTMLElement): string | null {
    const el = dom.matches("[src],[href]") ? dom : dom.querySelector("[src],[href]");
    return el ? (el.getAttribute("src") ?? el.getAttribute("href")) : null;
  }

  for (const type of FILE_BLOCK_TYPES) {
    it(`${type}: dangerous scheme -> about:blank, javascript: doesn't appear (data URLs too)`, () => {
      const { dom } = specs[type].implementation.toExternalHTML(block(type, "javascript:alert(1)"), {});
      expect(dom.outerHTML).not.toContain("javascript:");
      expect(carriedUrl(dom)).toBe("about:blank");
    });

    it(`${type}: own-upload relative URL passes unchanged`, () => {
      const { dom } = specs[type].implementation.toExternalHTML(block(type, "/api/uploads/u1"), {});
      expect(carriedUrl(dom)).toBe("/api/uploads/u1");
    });

    it(`${type}: external https passes unchanged`, () => {
      const { dom } = specs[type].implementation.toExternalHTML(block(type, "https://example.com/a.png"), {});
      expect(carriedUrl(dom)).toBe("https://example.com/a.png");
    });
  }

  it("data: URLs are blocked too (same allow-list as #12: only http/https pass)", () => {
    const { dom } = specs.image.implementation.toExternalHTML(block("image", "data:text/html;base64,PHNjcmlwdD4="), {});
    expect(carriedUrl(dom)).toBe("about:blank");
  });

  it("empty url (block has no file yet) takes BlockNote's own placeholder path without breaking", () => {
    const { dom } = specs.file.implementation.toExternalHTML(block("file", ""), {});
    expect(dom).toBeInstanceOf(HTMLElement);
  });

  it("showPreview:false (the <a href> branch) is guarded too (the guard sits before the branch, so both exits are pinned)", () => {
    const { dom } = specs.video.implementation.toExternalHTML(
      block("video", "javascript:alert(1)", { showPreview: false }),
      {},
    );
    expect(dom.outerHTML).not.toContain("javascript:");
    expect(carriedUrl(dom)).toBe("about:blank");
  });

  it("with a caption (figure/figcaption branch) is guarded too", () => {
    const { dom } = specs.image.implementation.toExternalHTML(
      block("image", "javascript:alert(1)", { caption: "cap" }),
      {},
    );
    expect(dom.outerHTML).not.toContain("javascript:");
  });

  it("guard coverage equals the full set of upstream file-type blocks (per meta.fileBlockAccept): goes red when upstream adds another file-type block, as a reminder to add it to withGuardedExternalHTML", () => {
    const fileBlocks = Object.entries(defaultBlockSpecs)
      .filter(([, spec]) => {
        const impl = (spec as unknown as FileSpecLike).implementation;
        return impl?.meta && "fileBlockAccept" in (impl.meta as object);
      })
      .map(([type]) => type)
      .sort();
    expect(fileBlocks).toEqual([...FILE_BLOCK_TYPES]);
  });
});

/**
 * #43 export-chain pin (the group above only pins the spec itself; if the upstream exporter began reading some other registry than the editor schema's blockSpecs, that group would stay green and the hole would silently return). Uses a real editor + the real export chain (`blocksToMarkdownLossy`, since markdown copied outside also goes through external HTML). The path that sends content to AI uses `ai/note-markdown.ts`'s headless serialization, whose guard is pinned by `ai/note-markdown.test.ts`.
 *
 * This pins the half "the exporter reads the editor's schema"; the other half, "`buildNoteEditorOptions` hands over `noteSchema` itself", is pinned by the wiring tests in `NoteEditor.test.ts` (this test hardcodes `schema: noteSchema` and can't cover that).
 */
describe("#43 end to end: the real editor's export chain gets the guard", () => {
  it("blocksToMarkdownLossy exports about:blank for a tainted image", async () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "image", props: { url: "javascript:alert(1)", name: "x" } }],
    });
    const markdown = await editor.blocksToMarkdownLossy(editor.document);
    expect(markdown).not.toContain("javascript:");
    expect(markdown).toContain("about:blank");
  });
});

/**
 * #96: is the codeBlock syntax-highlighting option really wired into the schema.
 *
 * `createCodeBlockSpec(options)` closes over options inside the spec, so they can't be read back from the schema object; the only honest observation surface is the **rendered result**: the spec's `render` draws the language dropdown only when `supportedLanguages` is non-empty (BlockNote's built-in default is `{}`, with no dropdown at all). So a real editor with a codeBlock is mounted and the dropdown must exist with the languages from our list; red means someone removed `codeBlock: createCodeBlockSpec(CODE_BLOCK_OPTIONS)` from `noteSchema` (falling back to the built-in path with no highlighting and an empty dropdown).
 */
describe("#96: codeBlock language dropdown wiring", () => {
  it("noteSchema's codeBlock renders a language dropdown, and the list comes from SUPPORTED_LANGUAGES", () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "codeBlock", props: { language: "typescript" }, content: "const x = 1;" }],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    try {
      editor.mount(container);
      const select = container.querySelector<HTMLSelectElement>('[data-content-type="codeBlock"] select');
      expect(select, "沒有語言下拉＝schema 沒接 CODE_BLOCK_OPTIONS（內建 supportedLanguages 是空物件）").not.toBeNull();
      const labels = [...select!.options].map((option) => option.text);
      expect(labels).toContain("TypeScript");
      expect(labels).toContain("Plain text");
      expect(select!.value).toBe("typescript");
    } finally {
      editor.unmount();
      container.remove();
    }
  });
});

/**
 * #96 export invariant: highlighting is a ProseMirror decoration (editor layer) that never enters the document or the export. It is green as implemented (the decoration mechanism works that way); the test pins it against a future implementation that writes spans into content (e.g. to carry colour in SSR or export), which would flood the collab document with presentation details and make every collaborator's export differ.
 */
describe("#96: export carries no highlighting residue", () => {
  it("codeBlock's HTML export is a clean pre>code (no shiki span, no inline style)", async () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "codeBlock", props: { language: "typescript" }, content: 'const x = "hi";' }],
    });
    const html = await editor.blocksToHTMLLossy(editor.document);
    expect(html).toContain('const x = "hi";');
    expect(html).not.toContain("shiki");
    expect(html).not.toContain("--code-");
    expect(html).not.toContain("style=");
  });
});

/**
 * #96: the graceful skip for unknown languages is a **load-bearing path**, not just a defence against a malicious collaborator: BlockNote 0.52.1's ``` fence input rule is `getLanguageId(...) ?? original string`, so any user typing ```foo produces a language prop not in the list, while shiki's `loadLanguage()` **throws** for ids outside the bundle. That path must be stopped by getLanguageId's undefined before `loadLanguage` is called; when it breaks the symptoms are an unhandled rejection and highlighting silently dying everywhere.
 *
 * In the control (typescript is highlighted) the test first waits for a `.shiki` decoration to appear before asserting the unknown-language block has none; otherwise "neither block has started highlighting yet" would pass vacuously.
 */
describe("#96: unknown language graceful skip", () => {
  it("language not in the list -> no crash, no unhandled rejection, that block isn't highlighted (other blocks still are)", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [
        { type: "codeBlock", props: { language: "typescript" }, content: 'const x = "hi";' },
        { type: "codeBlock", props: { language: "notalang" }, content: "some code" },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    try {
      editor.mount(container);
      // The highlighter is lazy (shiki is imported, the grammar loaded and decorations redrawn only when a codeBlock first renders): poll until the control shows `.shiki` and fail on timeout, no fixed sleeps.
      const deadline = Date.now() + 10_000;
      while (container.querySelector('[data-content-type="codeBlock"] .shiki') === null) {
        if (Date.now() > deadline) throw new Error("對照組（typescript）10s 內沒出現 .shiki decoration");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const blocks = [...container.querySelectorAll<HTMLElement>('[data-content-type="codeBlock"]')];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]!.querySelectorAll(".shiki").length, "對照組 typescript 應該有上色").toBeGreaterThan(0);
      expect(blocks[1]!.querySelectorAll(".shiki")).toHaveLength(0);
      expect(blocks[1]!.textContent).toContain("some code");
      // One more macrotask so a possible rejection surfaces before the check.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections, "graceful-skip 破掉的第一個症狀就是 unhandled rejection").toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
      editor.unmount();
      container.remove();
    }
  });
});

/** Built from blocks, not markdown: markdown can't produce a mermaid block or a wikilink inline. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, any by repo convention
const FIXTURE: PartialBlock<any, any, any>[] = [
  { type: "paragraph", content: "第一段純文字" },
  { type: "heading", props: { level: 2 }, content: "標題二" },
  { type: "paragraph", content: [{ type: "text", text: "前面 ", styles: {} }, { type: "wikilink", props: { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "目標筆記" } }, { type: "text", text: " 後面 ", styles: {} }, { type: "text", text: "粗體", styles: { bold: true } }] },
  { type: "mermaid", props: { code: "graph TD\n  A-->B" } },
  // No props given, so both schemas' propSchema defaults are exercised: the entry above supplies `code`, which would mask a divergence between the two schemas' defaults and let parity pass falsely.
  { type: "mermaid" },
  // Same reason as the empty mermaid block above: only the default `tex` exercises both schemas' defaults.
  { type: "math", props: { tex: "E=mc^2" } },
  { type: "math" },
  { type: "math", props: { tex: "x <img src=x onerror=1></code></pre><script>1</script>" } },
  { type: "codeBlock", props: { language: "typescript" }, content: "const a = 1;" },
  { type: "image", props: { url: "/api/uploads/abc123", name: "pic" } },
];

describe("#269: new wikilink props", () => {
  it("the wikilink propSchema of both the web noteSchema and the headless schema contains label and anchorBlockId (default empty string)", () => {
    const headless = createHeadlessNoteSchema("http://localhost/");
    for (const schema of [noteSchema, headless]) {
      const keys = Object.keys(schema.inlineContentSchema.wikilink.propSchema).sort();
      expect(keys).toEqual(["anchorBlockId", "label", "snapshotTitle", "targetNoteId"]);
      expect(schema.inlineContentSchema.wikilink.propSchema).toMatchObject({ label: { default: "" }, anchorBlockId: { default: "" } });
    }
  });

  it("fact: non-default values are output as data-label / data-anchor-block-id, defaults aren't output, and the same attributes are read back from HTML", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const id = "11111111-1111-4111-8111-111111111111";
    const html = editor.blocksToHTMLLossy([
      {
        type: "paragraph",
        content: [
          { type: "wikilink", props: { targetNoteId: id, snapshotTitle: "S", label: "L", anchorBlockId: "b1" } },
          { type: "wikilink", props: { targetNoteId: id, snapshotTitle: "S2", label: "", anchorBlockId: "" } },
        ],
      },
    ]);
    expect(html).toContain('data-label="L"');
    expect(html).toContain('data-anchor-block-id="b1"');
    expect(html.match(/data-label=/g)).toHaveLength(1);
    expect(html.match(/data-anchor-block-id=/g)).toHaveLength(1);
    const parsed = editor.tryParseHTMLToBlocks(
      `<p><span data-inline-content-type="wikilink" data-target-note-id="${id}" data-snapshot-title="S" data-label="L" data-anchor-block-id="b1"></span></p>`,
    );
    const node = (parsed[0]!.content as Array<{ type: string; props: Record<string, string> }>)[0]!;
    expect(node.type).toBe("wikilink");
    expect(node.props).toEqual({ targetNoteId: id, snapshotTitle: "S", label: "L", anchorBlockId: "b1" });
  });
});

describe("#106 parity: headless schema and noteSchema exports are byte-identical", () => {
  it("same fixture -> blocks identical field by field (ids removed), blocksToMarkdownLossy identical character by character", async () => {
    const web = BlockNoteEditor.create({ schema: noteSchema, initialContent: FIXTURE });
    const headless = BlockNoteEditor.create({ schema: createHeadlessNoteSchema(window.location.href), initialContent: FIXTURE });
    const strip = (bs: unknown[]) => JSON.parse(JSON.stringify(bs, (k, v) => (k === "id" ? undefined : v)));
    expect(strip(headless.document)).toEqual(strip(web.document));
    const [a, b] = await Promise.all([web.blocksToMarkdownLossy(web.document), headless.blocksToMarkdownLossy(headless.document)]);
    expect(b).toBe(a);
    expect(a).toContain("[目標筆記](/notes/11111111-1111-4111-8111-111111111111)");
    expect(a).toContain("```mermaid");
    expect(a).toContain("```math\nE=mc^2\n```");
    expect(a).toContain("```math\nx <img src=x onerror=1></code></pre><script>1</script>\n```");
    expect(a).toMatch(/```math\n?\n```/);
  });

  it("a javascript: image url is sanitized in the headless schema export", async () => {
    const headless = BlockNoteEditor.create({ schema: createHeadlessNoteSchema("http://localhost/"), initialContent: [{ type: "image", props: { url: "javascript:alert(1)", name: "x" } }] });
    const md = await headless.blocksToMarkdownLossy(headless.document);
    expect(md).not.toContain("javascript:");
    expect(md).toContain("about:blank");
  });

  it("a relative /api/uploads/<id> is kept as is by the headless schema export (passes when the base is right)", async () => {
    const headless = BlockNoteEditor.create({ schema: createHeadlessNoteSchema("http://localhost/"), initialContent: [{ type: "image", props: { url: "/api/uploads/abc123", name: "x" } }] });
    expect(await headless.blocksToMarkdownLossy(headless.document)).toContain("/api/uploads/abc123");
  });
});

describe("columns nodes", () => {
  type Blk = { id: string; type: string; props: Record<string, unknown>; content?: unknown; children: Blk[] };
  const allTypes = (bs: Blk[]): string[] => bs.flatMap((b) => [b.type, ...allTypes(b.children)]);
  const textOf = (b: Blk) => (Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text).join("") : "");
  const parse = (html: string) => (BlockNoteEditor.create({ schema: noteSchema }) as AnyEditor).tryParseHTMLToBlocks(html) as Blk[];
  const mounted: { destroy(): void }[] = [];
  const mount = (content: PartialBlockLike[]) => {
    const m = mountEditor(content);
    mounted.push(m);
    return m;
  };
  afterEach(() => {
    for (const m of mounted.splice(0)) m.destroy();
  });

  it("noteSchema and the headless schema both have columnList/column, and column's propSchema is exactly { width } (default 1)", () => {
    for (const schema of [noteSchema, createHeadlessNoteSchema(window.location.href)]) {
      const blocks = schema.blockSchema as Record<string, { propSchema: unknown }>;
      expect(blocks.columnList).toBeDefined();
      expect(blocks.column).toBeDefined();
      expect(blocks.column!.propSchema).toEqual({ width: { default: 1 } });
    }
  });

  it("editor DOM: classes, data-id and the column width style (flex:N 1 0) of rows and columns", () => {
    const { container } = mount([P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r", [1.5, 1]), P("z", "z9")]);
    const list = container.querySelector('[data-node-type="columnList"]');
    expect(list).not.toBeNull();
    expect(list!.classList.contains("bn-block-column-list")).toBe(true);
    expect(list!.getAttribute("data-id")).toBe("r");
    const cols = [...container.querySelectorAll('[data-node-type="column"]')];
    expect(cols.map((c) => c.getAttribute("style"))).toEqual(["flex:1.5 1 0", "flex:1 1 0"]);
    expect(cols.map((c) => c.getAttribute("data-id"))).toEqual(["rc0", "rc1"]);
  });

  it("external HTML: web and headless are the same; rows and columns carry the attributes of the canonical read-out form, in order", () => {
    const ROW = row([[P("a", "a1")], [P("b", "b1")]], "r", [1.5, 1]);
    const web = BlockNoteEditor.create({ schema: noteSchema }) as AnyEditor;
    const headless = BlockNoteEditor.create({ schema: createHeadlessNoteSchema(window.location.href) }) as AnyEditor;
    const html = web.blocksToHTMLLossy([ROW]);
    expect(headless.blocksToHTMLLossy([ROW])).toBe(html);
    const attrs = (el: Element) => [...el.attributes].filter((a) => a.name !== "data-nesting-level").map((a) => [a.name, a.value]);
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const outer = tpl.content.firstElementChild!;
    expect(attrs(outer)).toEqual([["data-kb-columns", ""], ["style", "display:flex;gap:16px"]]);
    const cols = [...outer.children];
    expect(cols.map(attrs)).toEqual([
      [["data-kb-column", ""], ["style", "flex:1.5"]],
      [["data-kb-column", ""], ["style", "flex:1"]],
    ]);
    for (const banned of ["bn-block-column", "data-node-type", "data-id"]) expect(html).not.toContain(banned);
  });

  describe("parse", () => {
    it("two-column external form -> one row, widths taken from flex", () => {
      const bs = parse('<div data-kb-columns style="display:flex;gap:16px"><div data-kb-column style="flex:2"><p>A</p></div><div data-kb-column style="flex:0.5"><p>B</p></div></div>');
      expect(bs.map((b) => b.type)).toEqual(["columnList"]);
      expect(bs[0]!.children.map((c) => c.props.width)).toEqual([2, 0.5]);
      expect(bs[0]!.children.map((c) => c.children.map(textOf))).toEqual([["A"], ["B"]]);
    });

    it("flex:20 is clamped to 10, no style gives 1", () => {
      const bs = parse('<div data-kb-columns style="display:flex;gap:16px"><div data-kb-column style="flex:20"><p>A</p></div><div data-kb-column><p>B</p></div></div>');
      expect(bs[0]!.children.map((c) => c.props.width)).toEqual([10, 1]);
    });

    it.each([
      ["single-column external form", '<div data-kb-columns style="display:flex;gap:16px"><div data-kb-column style="flex:1"><p>X</p></div></div>'],
      ["orphan column", '<div data-kb-column style="flex:1"><p>X</p></div>'],
    ])("%s -> ordinary paragraph, no row grows", (_name, html) => {
      const bs = parse(html);
      expect(allTypes(bs)).not.toContain("columnList");
      expect(allTypes(bs)).not.toContain("column");
      expect(bs.filter((b) => b.type === "paragraph" && textOf(b) === "X")).toHaveLength(1);
    });

    it("a div with only display:flex isn't a row", () => {
      expect(allTypes(parse('<div style="display:flex"><div><p>A</p></div><div><p>B</p></div></div>'))).not.toContain("columnList");
    });

    it("in-site two-column form -> one row, ids and widths kept", () => {
      const bs = parse('<div data-node-type="columnList" data-id="R"><div data-node-type="column" data-id="C0" style="flex:3 1 0"><p>A</p></div><div data-node-type="column"><p>B</p></div></div>');
      expect(bs.map((b) => b.type)).toEqual(["columnList"]);
      expect(bs[0]!.id).toBe("R");
      expect(bs[0]!.children[0]!.id).toBe("C0");
      expect(bs[0]!.children.map((c) => c.props.width)).toEqual([3, 1]);
    });
  });

  it("ids: an unmounted headless editor reads the same ids twice; insertBlocks gives ids to both the row and the columns", () => {
    const editor = BlockNoteEditor.create({
      schema: createHeadlessNoteSchema("http://localhost/"),
      initialContent: [row([[P("a")], [P("b")]])],
    }) as AnyEditor;
    const ids = () => {
      const r = editor.document[0] as Blk;
      return [r.id, ...r.children.map((c) => c.id)];
    };
    const first = ids();
    expect(first.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(ids()).toEqual(first);
    const [inserted] = editor.insertBlocks([row([[P("c")], [P("d")]])], editor.document[0]!, "after") as Blk[];
    const insertedIds = [inserted!.id, ...inserted!.children.map((c) => c.id)];
    expect(insertedIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(insertedIds).size).toBe(3);
  });

  it("in-site copy of a whole row then paste: two rows, the new row keeps its widths, ids aren't duplicated", () => {
    const { editor } = mount([P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r", [1.5, 1]), P("z", "z9")]);
    const view = editor.prosemirrorView!;
    let rowPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (rowPos < 0 && node.type.name === "columnList") rowPos = pos;
    });
    editor._tiptapEditor.commands.setNodeSelection(rowPos);
    const html = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
    editor.setTextCursorPosition("z9", "end");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the types of Plugin.key and props.handleDOMEvents aren't public
    for (const plugin of view.state.plugins.filter((p) => (p as any).key.startsWith("uniqueID"))) (plugin.props.handleDOMEvents as any).paste(view, new Event("paste"));
    editor.pasteHTML(html, true);
    const rows = (editor.document as Blk[]).filter((b) => b.type === "columnList");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.children.map((c) => c.props.width)).toEqual([1.5, 1]);
    const result = integrity(editor);
    expect(result.dupIds).toBe(0);
    expect(result.nullIds).toBe(0);
  });
});

/**
 * A `latex` code block is colored by the LaTeX grammar in the real editor, not only by shiki called directly: BlockNote picks the grammar from the block's language prop and
 * hands the string to the highlighter as is, so a change to how a latex block reaches the grammar shows up here. It covers latex blocks only: an alias that would send another fence (e.g. tex) to the LaTeX grammar is pinned by the language-list test in lib/code-highlight.test.ts.
 */
describe("latex code block coloring in the editor", () => {
  it("colors equation content as math and leaves plain prose in the foreground color", async () => {
    const editor = BlockNoteEditor.create({
      schema: noteSchema,
      initialContent: [{ type: "codeBlock", props: { language: "latex" }, content: "Plain words here\n\\begin{equation}\na = b\n\\end{equation}" }],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const colorOf = (text: string): string | undefined =>
      [...container.querySelectorAll<HTMLElement>('[data-content-type="codeBlock"] .shiki')]
        .filter((el) => el.textContent?.includes(text))
        .map((el) => el.style.color)[0];
    try {
      editor.mount(container);
      // The grammar loads lazily: poll until the equation body is colored at all, fail on timeout, no fixed sleeps.
      const deadline = Date.now() + 10_000;
      while (colorOf("a = b") === undefined) {
        if (Date.now() > deadline) throw new Error("latex block was not highlighted within 10s");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(colorOf("a = b")).toBe("var(--code-token-constant)");
      expect(colorOf("Plain words here")).toBe("var(--code-foreground)");
    } finally {
      editor.unmount();
      container.remove();
    }
  });
});
