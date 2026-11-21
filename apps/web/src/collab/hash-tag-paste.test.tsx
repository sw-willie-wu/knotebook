import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { TAGS_PER_NOTE_MAX, YDOC_FRAGMENT } from "@knotebook/shared";
import { collabUndoManager } from "./undo";
import { noteSchema } from "./schema";
import type { HashTagHooks, HashTagHooksRef } from "./hash-tag-input";
import { createHashTagPasteHook } from "./hash-tag-paste";
import { combinePasteHooks, createMarkdownPasteHandler, type PasteConversionHook } from "./paste";
import { attachTestElementRenderer } from "@/test/element-renderer";
import { P, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

const editors: AnyEditor[] = [];

interface Harness {
  editor: AnyEditor;
  hooks: HashTagHooksRef;
  applied: Array<{ names: string[]; restore: () => boolean }>;
  notify: ReturnType<typeof vi.fn>;
  paste: (data: { text?: string; html?: string }) => void;
}

function mount(opts: { blocks?: PartialBlockLike[]; withHooks?: boolean; current?: string[]; extra?: PasteConversionHook[] } = {}): Harness {
  const doc = new Y.Doc();
  const hooks: HashTagHooksRef = { current: null };
  const applied: Harness["applied"] = [];
  const notify = vi.fn();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: "u", name: "U", color: "#123456" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as AnyEditor;
  editors.push(editor);
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor);
  if (opts.blocks) editor.replaceBlocks(editor.document, opts.blocks as never);
  if (opts.withHooks !== false) {
    const live: HashTagHooks = {
      applyHash: (input) => void applied.push(input),
      currentTagNames: () => opts.current ?? [],
      undoBoundary: () => collabUndoManager(editor)?.stopCapturing(),
      notify,
      active: () => (editor.prosemirrorView ? { editor, view: editor.prosemirrorView } : null),
    };
    hooks.current = live;
  }
  const handler = createMarkdownPasteHandler(combinePasteHooks(createHashTagPasteHook(hooks), ...(opts.extra ?? [])));
  const paste = ({ text, html }: { text?: string; html?: string }) => {
    const types = [...(html !== undefined ? ["text/html"] : []), ...(text !== undefined ? ["text/plain"] : [])];
    const event = { clipboardData: { types, getData: (type: string) => (type === "text/html" ? (html ?? "") : type === "text/plain" ? (text ?? "") : "") } } as unknown as ClipboardEvent;
    handler({
      event,
      editor: editor as never,
      defaultPasteHandler: () => {
        if (html !== undefined) editor.pasteHTML(html);
        else editor.pasteText(text ?? "");
        return true;
      },
    });
  };
  return { editor, hooks, applied, notify, paste };
}

const textOf = (editor: AnyEditor, i = 0): string => {
  const content = editor.document[i]?.content;
  return Array.isArray(content) ? content.map((n: { text?: string }) => n.text ?? "").join("") : "";
};

afterEach(() => {
  for (const editor of editors.splice(0)) {
    try {
      editor.unmount();
    } catch {
      // never mounted
    }
  }
});

describe("pasting a line of #tags at the start of a note", () => {
  it("removes that block and hands the names over, for plain text", () => {
    const h = mount();
    h.editor.setTextCursorPosition(h.editor.document[0]!, "start");
    h.paste({ text: "#alpha   #beta" });
    expect(h.applied.map((a) => a.names)).toEqual([["alpha", "beta"]]);
    expect(textOf(h.editor)).toBe("");
    expect(h.editor.document).toHaveLength(1);
  });

  it("converts full-width marks and spaces the same way", () => {
    const h = mount();
    h.paste({ text: "＃alpha　＃beta" });
    expect(h.applied.map((a) => a.names)).toEqual([["alpha", "beta"]]);
  });

  it("converts an HTML paragraph and leaves the other pasted blocks in place", () => {
    const h = mount();
    h.paste({ html: "<p>#alpha #beta</p><p>body text</p>" });
    expect(h.applied.map((a) => a.names)).toEqual([["alpha", "beta"]]);
    expect(shape(h.editor)).toContain("paragraph:body text");
    expect(shape(h.editor)).not.toContain("#alpha");
  });

  it("keeps the line as text when it has other words, a bare #, a style or an invalid name", () => {
    for (const data of [{ text: "#alpha beta" }, { text: "#alpha #" }, { html: "<p>#alpha <b>#beta</b></p>" }, { text: `#${"x".repeat(41)}` }]) {
      const h = mount();
      h.paste(data);
      expect(h.applied, JSON.stringify(data)).toEqual([]);
      expect(h.editor.document.length, JSON.stringify(data)).toBeGreaterThan(0);
      expect(textOf(h.editor), JSON.stringify(data)).not.toBe("");
    }
  });

  it("pastes # Heading and ## Heading as headings and converts nothing", () => {
    for (const text of ["# Heading", "## Heading\n\ntext"]) {
      const h = mount();
      h.paste({ text });
      expect(h.applied, text).toEqual([]);
      expect(h.editor.document[0]!.type).toBe("heading");
    }
  });

  it("converts nothing in the middle of a note or after text in the first paragraph", () => {
    const middle = mount({ blocks: [P("one"), P("two")] });
    middle.editor.setTextCursorPosition(middle.editor.document[1]!, "end");
    middle.paste({ text: "#a #b" });
    expect(middle.applied).toEqual([]);

    const after = mount({ blocks: [P("hello")] });
    after.editor.setTextCursorPosition(after.editor.document[0]!, "end");
    after.paste({ text: "#a #b" });
    expect(after.applied).toEqual([]);
    expect(textOf(after.editor)).toContain("hello");

    const emptyFirstElsewhere = mount({ blocks: [P(""), P("two")] });
    emptyFirstElsewhere.editor.setTextCursorPosition(emptyFirstElsewhere.editor.document[1]!, "end");
    emptyFirstElsewhere.paste({ text: "#a #b" });
    expect(emptyFirstElsewhere.applied).toEqual([]);
  });

  it("converts nothing when the first line is older text and the paste landed further down", () => {
    const h = mount({ blocks: [P("#imported #tags"), P("body")] });
    h.editor.setTextCursorPosition(h.editor.document[1]!, "end");
    h.paste({ text: "more" });
    expect(h.applied).toEqual([]);
    expect(textOf(h.editor, 0)).toBe("#imported #tags");
  });

  it("restore does not duplicate the line when Ctrl+Z already brought it back", () => {
    const h = mount();
    h.paste({ text: "#alpha #beta" });
    h.editor.undo();
    expect(h.applied[0]!.restore()).toBe(true);
    expect(h.editor.document.map((_: unknown, i: number) => textOf(h.editor, i))).toEqual(["#alpha #beta"]);
  });

  it("keeps the line and notifies when the names would take the note past its limit", () => {
    const current = Array.from({ length: TAGS_PER_NOTE_MAX - 1 }, (_, i) => `t${i}`);
    const h = mount({ current });
    h.paste({ text: "#new1 #new2" });
    expect(h.applied).toEqual([]);
    expect(h.notify).toHaveBeenCalledWith("over_limit", { max: TAGS_PER_NOTE_MAX });
    expect(textOf(h.editor)).toContain("#new1");
  });

  it("counts a name already on the note, in any case, as not new", () => {
    const current = Array.from({ length: TAGS_PER_NOTE_MAX - 1 }, (_, i) => `t${i}`);
    const h = mount({ current });
    h.paste({ text: "#T0 #new1" });
    expect(h.applied.map((a) => a.names)).toEqual([["T0", "new1"]]);
  });

  it("keeps the line without hooks (no right to change tags)", () => {
    const h = mount({ withHooks: false });
    h.paste({ text: "#a #b" });
    expect(h.applied).toEqual([]);
    expect(textOf(h.editor)).toBe("#a #b");
  });

  it("Ctrl+Z right after a converting paste brings the line back as one step", () => {
    const h = mount();
    h.paste({ text: "#alpha #beta" });
    expect(textOf(h.editor)).toBe("");
    h.editor.undo();
    expect(textOf(h.editor)).toBe("#alpha #beta");
  });

  it("restore puts the line back at the start of the note", () => {
    const h = mount();
    h.paste({ text: "#alpha #beta" });
    expect(h.applied[0]!.restore()).toBe(true);
    expect(textOf(h.editor)).toBe("#alpha #beta");
  });
});

describe("combinePasteHooks", () => {
  it("runs before and after in order and skips an after whose snapshot is undefined", () => {
    const calls: string[] = [];
    const hook = (name: string, snapshot: unknown): PasteConversionHook => ({
      before: () => (calls.push(`${name}.before`), snapshot),
      after: () => void calls.push(`${name}.after`),
    });
    const combined = combinePasteHooks(hook("a", 1), hook("b", undefined), hook("c", 3));
    const snapshot = combined.before({});
    combined.after({}, snapshot);
    expect(calls).toEqual(["a.before", "b.before", "c.before", "a.after", "c.after"]);
  });

  it("keeps going when one hook throws", () => {
    const calls: string[] = [];
    const bad: PasteConversionHook = {
      before: () => {
        throw new Error("boom");
      },
      after: () => undefined,
    };
    const throwingAfter: PasteConversionHook = {
      before: () => true,
      after: () => {
        throw new Error("boom");
      },
    };
    const good: PasteConversionHook = { before: () => true, after: () => void calls.push("good.after") };
    const combined = combinePasteHooks(bad, throwingAfter, good);
    combined.after({}, combined.before({}));
    expect(calls).toEqual(["good.after"]);
  });

  it("still runs a second conversion after the tag line was taken out", () => {
    const calls: string[] = [];
    const h = mount({ extra: [{ before: () => true, after: () => void calls.push("site-links") }] });
    h.paste({ text: "#a #b" });
    expect(h.applied).toHaveLength(1);
    expect(calls).toEqual(["site-links"]);
  });
});
