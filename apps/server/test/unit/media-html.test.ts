// Audio, video and file blocks in the markdown form (packages/shared/src/note-media-html.ts). The read-out and round-trip
// cases for each block type are the G5-media goldens in note-markdown-goldens.test.ts; this file covers writes an agent makes by hand.
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { blocksToNoteMarkdown, buildMediaElement } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const ORIGIN = "http://localhost";
const ID = "00000000-0000-4000-8000-000000000001";

type B = { type: string; props?: Record<string, unknown>; content?: unknown; children?: B[] };
const parse = async (md: string): Promise<B[]> => {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    const r = parseMarkdownForNote(s.editor, md, [], ORIGIN);
    if ("error" in r) throw new Error(r.error);
    return r.blocks as B[];
  } finally {
    s.close();
  }
};
const parseError = async (md: string): Promise<string | undefined> => {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    const r = parseMarkdownForNote(s.editor, md, [], ORIGIN);
    return "error" in r ? r.error : undefined;
  } finally {
    s.close();
  }
};

describe("agent-written media markdown", () => {
  it("<video src> with a relative upload URL -> a video block that keeps the relative URL", async () => {
    const [b, ...rest] = await parse(`<video src="/api/uploads/${ID}"></video>`);
    expect(rest).toEqual([]);
    expect(b!.type).toBe("video");
    expect(b!.props).toMatchObject({ url: `/api/uploads/${ID}` });
  });

  it("<embed src data-name> -> a file block with that name", async () => {
    const [b] = await parse(`<embed src="/api/uploads/${ID}" data-name="a.pdf">`);
    expect(b!.type).toBe("file");
    expect(b!.props).toMatchObject({ url: `/api/uploads/${ID}`, name: "a.pdf" });
  });

  it("<audio data-name data-show-preview=false> in a captioned figure -> name, caption and showPreview", async () => {
    const [b] = await parse(`<figure><audio src="/api/uploads/${ID}" data-name="s.mp3" data-show-preview="false"></audio><figcaption>cap</figcaption></figure>`);
    expect(b!.type).toBe("audio");
    expect(b!.props).toMatchObject({ url: `/api/uploads/${ID}`, name: "s.mp3", caption: "cap", showPreview: false });
  });

  it("video width becomes previewWidth; an out-of-range width is rejected like an image's", async () => {
    const [b] = await parse(`<video src="/api/uploads/${ID}" width="320"></video>`);
    expect(b!.props).toMatchObject({ previewWidth: 320 });
    expect(await parseError(`<video src="/api/uploads/${ID}" width="20"></video>`)).toBe("unsupported_size");
  });

  it("an ordinary link to an upload stays a link in a paragraph", async () => {
    const bs = await parse(`[a.pdf](/api/uploads/${ID})`);
    expect(bs.map(b => b.type)).toEqual(["paragraph"]);
    expect(JSON.stringify(bs[0]!.content)).toContain(`/api/uploads/${ID}`);
  });

  it("an <embed> with an event handler is refused", async () => {
    expect(await parseError(`<embed src="/api/uploads/${ID}" onload="x()">`)).toBe("unsupported_block");
  });

  it("media written after a list item parses to sibling blocks (read-back: golden G5-media-in-list)", async () => {
    const bs = await parse(`* item\n\n<video src="/api/uploads/${ID}" data-name="v" width="100"></video>\n\n<embed src="/api/uploads/${ID}" data-name="f">\n`);
    expect(bs.map(b => b.type)).toEqual(["bulletListItem", "video", "file"]);
  });
});

describe("read fallback", () => {
  it("when a placeholder can't be found (every private-use character is in the note) the lossy export is used and a warning is logged once", async () => {
    let all = "";
    for (let cp = 0xe000; cp <= 0xf8ff; cp += 1) all += String.fromCharCode(cp);
    const s = await EditorSession.open(rt, new Y.Doc());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      s.editor.replaceBlocks(s.editor.document, [
        { type: "paragraph", content: all },
        { type: "file", props: { name: "a.pdf", url: `/api/uploads/${ID}` } },
      ] as never);
      const md = blocksToNoteMarkdown(s.editor, s.editor.document);
      expect(md).toContain(`[a.pdf](/api/uploads/${ID})`);
      expect(md).not.toContain("<embed");
      blocksToNoteMarkdown(s.editor, s.editor.document);
      expect(warn.mock.calls.filter(c => String(c[0]).includes("media blocks")).length).toBe(1);
    } finally {
      warn.mockRestore();
      s.close();
    }
  });
});

describe("buildMediaElement", () => {
  const html = (type: "audio" | "video" | "file", props: Record<string, unknown>, url = "/api/uploads/u") => buildMediaElement({ type, props } as never, url).outerHTML;

  it("fixed attribute order, escaped values, name omitted when empty", () => {
    expect(html("video", { name: 'a"b', previewWidth: 320, showPreview: false })).toBe('<video src="/api/uploads/u" data-name="a&quot;b" data-show-preview="false" width="320"></video>');
    expect(html("audio", { name: "" })).toBe('<audio src="/api/uploads/u"></audio>');
    expect(html("file", { name: "a.pdf", showPreview: false, previewWidth: 50 })).toBe('<embed src="/api/uploads/u" data-name="a.pdf">');
  });

  it("width is for video only and is clamped; a caption wraps the element in a figure", () => {
    expect(html("audio", { previewWidth: 100 })).toBe('<audio src="/api/uploads/u"></audio>');
    expect(html("video", { previewWidth: 9000, caption: "c" })).toBe('<figure><video src="/api/uploads/u" width="4000"></video><figcaption>c</figcaption></figure>');
  });
});
