import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collabUndoManager } from "./undo";
import { noteSchema } from "./schema";
import { createMermaidFenceExtension } from "./mermaid-fence";
import { convertPastedMermaidBlocks } from "./mermaid-paste";
import { consumeMermaidEdit, peekMermaidEdit } from "@/components/mermaid/auto-edit";
import { ThemeProvider } from "@/theme";
import { NoteEditorView } from "@/components/NoteEditor";
import { attachTestElementRenderer } from "@/test/element-renderer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror view types can't be imported (see markdown-link.rule.test.tsx)
type AnyView = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

const editors: AnyEditor[] = [];

function mount(doc: Y.Doc, withExtension = true, mountDom = true): AnyEditor {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "#123456" },
      },
      _tiptapOptions: { extensions: withExtension ? [createMermaidFenceExtension()] : [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    } as any),
  ) as AnyEditor;
  editors.push(editor);
  if (!mountDom) return editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor);
  return editor;
}

function typeChar(view: AnyView, ch: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f: (v: AnyView, a: number, b: number, c: string) => boolean | void) => f(view, from, to, ch));
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}
const typeString = (view: AnyView, s: string) => [...s].forEach((ch) => typeChar(view, ch));
const pressEnter = (view: AnyView) =>
  view.someProp("handleKeyDown", (f: (v: AnyView, e: KeyboardEvent) => boolean | void) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));

function emptyNote(): { editor: AnyEditor; doc: Y.Doc; view: AnyView } {
  const doc = new Y.Doc();
  const editor = mount(doc);
  editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
  editor.setTextCursorPosition(editor.document[0]!, "start");
  return { editor, doc, view: editor.prosemirrorView };
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    try {
      editor.unmount();
    } catch {
      // never mounted
    }
  }
  document.body.innerHTML = "";
});

describe("typed mermaid fence", () => {
  it("```mermaid + Enter becomes a mermaid block", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```mermaid");
    pressEnter(view);
    expect(editor.document[0]!.type).toBe("mermaid");
    expect(editor.document[0]!.props).toMatchObject({ code: "" });
  });

  it("```mermaid + space becomes a mermaid block", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```mermaid ");
    expect(editor.document[0]!.type).toBe("mermaid");
    expect(editor.document.filter((b: { type: string }) => b.type === "codeBlock")).toHaveLength(0);
  });

  it("```Mermaid + Enter and ```MERMAID + space also become mermaid blocks (#590)", () => {
    const first = emptyNote();
    typeString(first.view, "```Mermaid");
    pressEnter(first.view);
    expect(first.editor.document[0]!.type).toBe("mermaid");

    const second = emptyNote();
    typeString(second.view, "```MERMAID ");
    expect(second.editor.document[0]!.type).toBe("mermaid");
  });

  const textOf = (b: { content?: unknown }) => (Array.isArray(b.content) ? b.content.map((n: { text?: string }) => n.text ?? "").join("") : "");

  it("puts the caret in a new paragraph after the diagram, so typing does not replace it", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```mermaid ");
    typeString(view, "abc");
    expect(editor.document.map((b: { type: string }) => b.type)).toEqual(["mermaid", "paragraph"]);
    expect(textOf(editor.document[1]!)).toBe("abc");
  });

  it("puts the caret in the next block when one follows, without adding a paragraph", () => {
    const doc = new Y.Doc();
    const editor = mount(doc);
    editor.replaceBlocks(editor.document, [{ type: "paragraph" }, { type: "paragraph", content: "tail" }]);
    editor.setTextCursorPosition(editor.document[0]!, "start");
    const view = editor.prosemirrorView;
    typeString(view, "```mermaid ");
    expect(editor.document.map((b: { type: string }) => b.type)).toEqual(["mermaid", "paragraph"]);
    typeString(view, "x");
    expect(textOf(editor.document[1]!)).toBe("xtail");
  });

  it("```js stays a code block", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```js ");
    expect(editor.document[0]!.type).toBe("codeBlock");
    expect(editor.document[0]!.props).toMatchObject({ language: "javascript" });
  });

  it("bare ``` stays a code block", () => {
    const { editor, view } = emptyNote();
    typeString(view, "``` ");
    expect(editor.document[0]!.type).toBe("codeBlock");
  });

  it("a code block switched to mermaid afterwards is left alone", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```js ");
    editor.updateBlock(editor.document[0]!, { props: { language: "mermaid" } });
    typeString(view, "x");
    expect(editor.document[0]!.type).toBe("codeBlock");
  });

  it("a codeBlock(mermaid) created by a peer is not converted", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = mount(docA);
    const b = mount(docB, false);
    b.replaceBlocks(b.document, [{ type: "codeBlock", props: { language: "mermaid" } }]);
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "remote");
    expect(a.document.some((x: { type: string }) => x.type === "codeBlock")).toBe(true);
    expect(a.document.some((x: { type: string }) => x.type === "mermaid")).toBe(false);
  });

  it("a peer turning the block under the local caret into an empty mermaid code block is not converted", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = mount(docA);
    a.replaceBlocks(a.document, [{ type: "paragraph" }]);
    const b = mount(docB, false);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    // Inserted without the input rule firing, so the local state looks exactly like the moment before the rule.
    a.setTextCursorPosition(a.document[0]!, "start");
    const view = a.prosemirrorView;
    view.dispatch(view.state.tr.insertText("```mermaid "));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    b.updateBlock(b.document[0]!, { type: "codeBlock", props: { language: "mermaid" }, content: [] });
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "remote");
    expect(a.document[0]!.type).toBe("codeBlock");
  });

  it("keeps nested children and puts the caret in the first one", () => {
    const { editor, view } = emptyNote();
    editor.replaceBlocks(editor.document, [{ type: "paragraph", children: [{ type: "paragraph", content: "child" }] }, { type: "paragraph", content: "tail" }]);
    editor.setTextCursorPosition(editor.document[0]!, "start");
    typeString(view, "```mermaid ");
    const top = editor.document;
    expect(top.map((x: { type: string }) => x.type)).toEqual(["mermaid", "paragraph"]);
    expect(top[0]!.children.map((x: { content?: unknown }) => textOf(x))).toEqual(["child"]);
    typeString(view, "x");
    expect(textOf(top[0]!.children[0]!)).toBe("child");
    expect(textOf(editor.document[0]!.children[0]!)).toBe("xchild");
  });

  it("never node-selects a following image: a paragraph is added instead", () => {
    const { editor, view } = emptyNote();
    editor.replaceBlocks(editor.document, [{ type: "paragraph" }, { type: "image", props: { url: "/api/uploads/x" } }]);
    editor.setTextCursorPosition(editor.document[0]!, "start");
    typeString(view, "```mermaid ");
    expect(editor.document.map((x: { type: string }) => x.type)).toEqual(["mermaid", "paragraph", "image"]);
    expect(view.state.selection.constructor.name).toBe("TextSelection");
  });

  it("one undo right after the conversion restores the typed fence text", () => {
    const { editor, view } = emptyNote();
    const manager = collabUndoManager(editor)!;
    manager.stopCapturing();
    typeString(view, "```mermaid");
    manager.stopCapturing();
    pressEnter(view);
    expect(editor.document[0]!.type).toBe("mermaid");
    manager.undo();
    expect(editor.document.map((b: { type: string }) => b.type)).toEqual(["paragraph"]);
    expect(textOf(editor.document[0]!)).toBe("```mermaid");
  });

  // `mount()` uses the test element renderer, which unmounts React blocks right away, so these only check the one-shot request; the rendered behaviour is in "MermaidBlock opens its source editor" below.
  describe("request to open the source editor", () => {
    const requested = (editor: AnyEditor) => editor.document.filter((b: { type: string }) => b.type === "mermaid").some((b: { id: string }) => peekMermaidEdit(b.id));

    it("is made for the block the typed fence created", () => {
      const { editor, view } = emptyNote();
      typeString(view, "```mermaid");
      pressEnter(view);
      expect(requested(editor)).toBe(true);
      editor.document.forEach((b: { id: string }) => consumeMermaidEdit(b.id));
    });

    it("is not made by paste conversion", () => {
      const editor = mount(new Y.Doc());
      editor.replaceBlocks(editor.document, [{ type: "codeBlock", props: { language: "mermaid" }, content: "graph TD; A-->B;" }]);
      expect(convertPastedMermaidBlocks(editor, new Set<string>())).toBe(1);
      expect(requested(editor)).toBe(false);
    });

    it("is not made for a diagram that arrives from a peer", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const a = mount(docA);
      const b = mount(docB, false);
      b.replaceBlocks(b.document, [{ type: "mermaid", props: { code: "graph TD; A-->B;" } }]);
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "remote");
      expect(a.document.some((x: { type: string }) => x.type === "mermaid")).toBe(true);
      expect(requested(a)).toBe(false);
    });
  });

  describe("MermaidBlock opens its source editor", () => {
    const getItems = async () => [];
    function mountView(strict: boolean): AnyEditor {
      const editor = mount(new Y.Doc(), true, false);
      const view = (
        <ThemeProvider>
          <NoteEditorView editor={editor} editable theme="light" noteId="n1" getItems={getItems} getSlashItems={getItems} />
        </ThemeProvider>
      );
      render(strict ? <StrictMode>{view}</StrictMode> : view);
      return editor;
    }

    for (const strict of [false, true]) {
      it(`focuses the textarea after the typed fence${strict ? " (StrictMode)" : ""}, and Esc hands focus back to the note`, async () => {
        const editor = mountView(strict);
        act(() => {
          editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
          editor.setTextCursorPosition(editor.document[0]!, "start");
        });
        const view = editor.prosemirrorView;
        act(() => {
          typeString(view, "```mermaid");
          pressEnter(view);
        });
        await waitFor(() => expect(document.querySelector("textarea")).not.toBeNull());
        const area = document.querySelector("textarea")!;
        expect(document.activeElement).toBe(area);
        fireEvent.change(area, { target: { value: "graph TD; A-->B;" } });
        fireEvent.keyDown(area, { key: "Escape" });
        expect(editor.document[0]!.props).toMatchObject({ code: "graph TD; A-->B;" });
        expect(view.dom.contains(document.activeElement)).toBe(true);
      });
    }

    it("after the auto-opened editor closes by blur, a later manual open does not hand focus back on Esc", async () => {
      const editor = mountView(false);
      act(() => {
        editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
        editor.setTextCursorPosition(editor.document[0]!, "start");
      });
      const view = editor.prosemirrorView;
      act(() => {
        typeString(view, "```mermaid");
        pressEnter(view);
      });
      await waitFor(() => expect(document.querySelector("textarea")).not.toBeNull());
      fireEvent.blur(document.querySelector("textarea")!);
      expect(document.querySelector("textarea")).toBeNull();
      fireEvent.click(document.querySelector("button[aria-label]")!);
      const area = await waitFor(() => {
        const found = document.querySelector("textarea");
        expect(found).not.toBeNull();
        return found!;
      });
      area.focus();
      fireEvent.keyDown(area, { key: "Escape" });
      expect(view.dom.contains(document.activeElement)).toBe(false);
    });

    it("a diagram that is already there does not open", () => {
      const editor = mountView(false);
      act(() => {
        editor.replaceBlocks(editor.document, [{ type: "mermaid", props: { code: "graph TD; A-->B;" } }]);
      });
      expect(document.querySelector("textarea")).toBeNull();
    });
  });
});
