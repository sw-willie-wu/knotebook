import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor, defaultBlockSpecs, SuggestionMenu } from "@blocknote/core";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";
import type { EditorRef } from "@/components/wikilink/menu";
import { attachTestElementRenderer } from "@/test/element-renderer";
import { takeDropPoint } from "@/collab/columns/paste-rule";
import { stubLayoutTier } from "@/test/layout-tier";

// toast is a spy: what is asserted is whether the user is notified, no need to render all of Radix.
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));

const { buildNoteEditorOptions, collabUserColor, createMediaBlockingDOMEvents, insertLinkAtSavedSelection, lateBoundTranslate, useLinkMenuState } =
  await import("./NoteEditor");

/**
 * Only the `defaultBlockSpecs.image` layer is taken: BlockNote's block spec generic triple is meaningless in tests, so the minimal structure is used (as other tests in this file handle editor generics).
 */
interface ImageSpecLike {
  implementation: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
    render: (block: any, editor: any) => { dom: HTMLElement };
  };
}

/**
 * jsdom has no constructible DataTransfer: a minimal stand-in. `types` is given explicitly by the caller, independent of `html`/`text` (`classifyMediaTransfer` rule 2 only looks at which format names `dataTransfer.types` lists, separate from whether `getData` returns content);
 * `files` uses a real `File` shape (rules 3 and 4 read `File.type`, a fake with only `{ length }` can't carry that).
 */
function transfer(options: { files?: File[]; types?: string[]; html?: string; text?: string }): DataTransfer {
  const map: Record<string, string> = {};
  if (options.html !== undefined) map["text/html"] = options.html;
  if (options.text !== undefined) map["text/plain"] = options.text;
  const files = options.files ?? [];
  return {
    files: files as unknown as FileList,
    types: options.types ?? [],
    getData: (type: string) => map[type] ?? "",
  } as unknown as DataTransfer;
}

function file(name: string, type: string): File {
  return new File([new Uint8Array([1])], name, { type });
}

function clipboardEvent(data: DataTransfer): ClipboardEvent {
  const event = { clipboardData: data, preventDefault: vi.fn() };
  return event as unknown as ClipboardEvent;
}

function dragEvent(data: DataTransfer): DragEvent {
  const event = { dataTransfer: data, preventDefault: vi.fn() };
  return event as unknown as DragEvent;
}

const translate = (key: string) => `t:${key}`;

describe("createMediaBlockingDOMEvents (paste/drop interception)", () => {
  beforeEach(() => {
    toastMock.mockClear();
  });

  it("provides both paste and drop handlers", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    expect(typeof handlers.paste).toBe("function");
    expect(typeof handlers.drop).toBe("function");
  });

  it("pasting only image files -> returns false, no preventDefault, no toast (rule 3 lets it through to the uploadFile pipeline)", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ files: [file("a.png", "image/png")], types: ["Files"] }));

    expect(handlers.paste(null, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("dropping mixed or non-image files -> returns true, preventDefault, matching toast (rule 4)", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = dragEvent(
      transfer({ files: [file("a.png", "image/png"), file("b.pdf", "application/pdf")], types: ["Files"] }),
    );

    expect(handlers.drop(null, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.transferNonImage" });
  });

  it("pasting a data URL image inside text/html (the common shape when copying an image from a web page) -> blocked", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ html: '<img src="data:image/png;base64,iVBORw0KGgo=">', text: "" }));

    expect(handlers.paste(null, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("pasting a data URL image inside text/plain -> blocked", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ text: "data:image/gif;base64,R0lGOD" }));

    expect(handlers.paste(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("dropping a data URL image inside text/html -> blocked", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = dragEvent(transfer({ html: '<img src="data:image/png;base64,AAA">' }));

    expect(handlers.drop(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("ordinary text paste -> returns false, no preventDefault, no toast (falls back to BlockNote as usual)", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = clipboardEvent(transfer({ text: "hello world", html: "<p>hello world</p>" }));

    expect(handlers.paste(null, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("dragging an existing block inside the editor (no files, no data URL) -> returns false", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = dragEvent(transfer({ html: "<p>moved block</p>" }));

    expect(handlers.drop(null, event)).toBe(false);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("each toast text is the current translation (not an old string after a language switch)", () => {
    let lang = "en";
    const handlers = createMediaBlockingDOMEvents((key) => `${lang}:${key}`);
    const dataUrlEvent = () => clipboardEvent(transfer({ text: "data:image/png;base64,AAA" }));

    handlers.paste(null, dataUrlEvent());
    expect(toastMock).toHaveBeenLastCalledWith({ title: "en:note.transferDataUrl" });

    lang = "zh";
    handlers.paste(null, dataUrlEvent());
    expect(toastMock).toHaveBeenLastCalledWith({ title: "zh:note.transferDataUrl" });
  });
});

describe("buildNoteEditorOptions", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    toastMock.mockClear();
    doc = new Y.Doc();
  });

  afterEach(() => doc.destroy());

  const build = (language = "en", editorRef: EditorRef = { current: null }, noteId = "note-1") =>
    buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language,
      translate,
      editorRef,
      noteId,
      siteLinks: { current: null },
    });

  it("collab fragment uses shared's YDOC_FRAGMENT (same name as the server's collab/store)", () => {
    const options = build();
    expect(options.collaboration.fragment).toBe(doc.getXmlFragment(YDOC_FRAGMENT));
    // Hard-coding another name would split into two unrelated documents.
    expect(options.collaboration.fragment).not.toBe(doc.getXmlFragment("default"));
  });

  it("schema contains the image block", () => {
    expect(Object.keys(build().schema.blockSpecs)).toContain("image");
  });

  it("schema is noteSchema itself (wiring pin for issue #43)", () => {
    // The #43 toExternalHTML guard wraps noteSchema's four file-type specs; assembling a separate schema from defaultBlockSpecs here would keep schema.test.ts green
    // while the hole silently returns - this pins the wiring.
    expect(build().schema).toBe(noteSchema);
  });

  it("uploadFile option is attached (createUploadFile)", () => {
    expect(typeof build().uploadFile).toBe("function");
  });

  /**
   * `pasteHandler` is the line that carries the markdown paste fix (#27/#28) to users: deleting it in `buildNoteEditorOptions` would leave the whole suite green with the fix silently dead,
   * so behaviour is pinned too: CRLF markdown must be taken over.
   */
  it("pasteHandler is attached and really takes over markdown paste (#27/#28)", () => {
    const CRLF_MARKDOWN = "# 標題\r\n\r\n- 一\r\n- 二\r\n";
    const LF_MARKDOWN = "# 標題\n\n- 一\n- 二\n";
    const pasteHandler = build().pasteHandler;
    expect(typeof pasteHandler).toBe("function");

    const pasteMarkdown = vi.fn();
    const defaultPasteHandler = vi.fn(() => true);
    const resolved = { parent: { type: { spec: { code: false } } } };

    pasteHandler!({
      event: {
        clipboardData: {
          types: ["text/plain"],
          getData: (type: string) => (type === "text/plain" ? CRLF_MARKDOWN : ""),
        },
      } as never,
      editor: {
        pasteMarkdown,
        transact: (callback: (tr: never) => unknown) => callback({ selection: { $from: resolved, $to: resolved } } as never),
      } as never,
      defaultPasteHandler,
    } as never);

    expect(pasteMarkdown).toHaveBeenCalledWith(LF_MARKDOWN);
    expect(defaultPasteHandler).not.toHaveBeenCalled();
  });

  /**
   * The whole guard line for issue #12: **our callback** + **BlockNote really calls it**. Asserting only the first is not enough: in `@blocknote/core` 0.52.1 render is
   * `editor.resolveFileUrl ? resolveFileUrl(url).then(el.src = ...) : el.src = url`, a **conditional branch**; after an upgrade renames the option or routes to another resolver our callback becomes dead code
   * while a wiring-only test stays green. So this runs the real render of `defaultBlockSpecs`' image block and asserts the `src` that lands on the DOM.
   */
  it("dangerous schemes never reach <img src>: runs BlockNote's image render directly (issue #12)", async () => {
    const imageSpec = (defaultBlockSpecs as unknown as Record<string, ImageSpecLike>).image;
    const resolveFileUrl = build().resolveFileUrl;
    expect(typeof resolveFileUrl).toBe("function");

    const render = (url: string) => {
      const block = {
        id: "b1",
        type: "image",
        props: { url, name: "some.png", caption: "", showPreview: true, previewWidth: undefined },
        content: undefined,
        children: [],
      };
      // render only touches these two editor members (`onUploadStart` drives the uploading hint when url is empty).
      return imageSpec.implementation.render(block, { resolveFileUrl, onUploadStart: () => () => {} }).dom;
    };

    const blocked = render("javascript:alert(1)");
    await vi.waitFor(() => expect(blocked.querySelector("img")?.getAttribute("src")).toBe("about:blank"));

    const uploaded = render("/api/uploads/u1");
    await vi.waitFor(() => expect(uploaded.querySelector("img")?.getAttribute("src")).toBe("/api/uploads/u1"));
  });

  it("resolveFileUrl logic itself: dangerous schemes -> about:blank, own upload relative URLs pass as is (issue #12)", async () => {
    const resolveFileUrl = build().resolveFileUrl;

    await expect(resolveFileUrl!("javascript:alert(1)")).resolves.toBe("about:blank");
    await expect(resolveFileUrl!("data:text/html;base64,PHNjcmlwdD4=")).resolves.toBe("about:blank");
    // Own uploaded images are relative URLs (`/api/uploads/<id>`): blocking them would block every uploaded image.
    await expect(resolveFileUrl!("/api/uploads/u1")).resolves.toBe("/api/uploads/u1");
    await expect(resolveFileUrl!("https://example.com/a.png")).resolves.toBe("https://example.com/a.png");
  });

  /**
   * Wiring pin for issue #99: `_tiptapOptions.extensions` is the line that reaches users - deleting the `extensions: [...]` line in `buildNoteEditorOptions` would keep the whole suite green
   * (including `markdown-link.rule.test.tsx`, which mounts its own editor, not the product of `buildNoteEditorOptions`) while the feature is dead in the real app.
   * This pins that the extension is really in the array (identified by the `name` given via `Extension.create`, not array identity or length).
   */
  it("_tiptapOptions.extensions has the markdown link extension (issue #99)", () => {
    const extensions = build()._tiptapOptions.extensions;
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.map((ext: { name: string }) => ext.name)).toContain("knotebookMarkdownLink");
  });

  // Same wiring-pin reason: `code-block-caret.test.ts` mounts its own editor, so removing the line here would stay green while touch can't open the language dropdown in the real app.
  it("_tiptapOptions.extensions has the code block caret signal extension (touch opens the language dropdown)", () => {
    const extensions = build()._tiptapOptions.extensions;
    expect(extensions.map((ext: { name: string }) => ext.name)).toContain("knotebookCodeBlockCaret");
  });

  // Same: `edge-keymap.test.ts` mounts its own editor (column-start Backspace / column-end Delete).
  it("_tiptapOptions.extensions has the side-by-side column-start/column-end key extension", () => {
    const extensions = build()._tiptapOptions.extensions;
    expect(extensions.map((ext: { name: string }) => ext.name)).toContain("knotebookColumnEdgeKeys");
  });

  // Same: `paste-rule.test.ts` mounts its own editor (pasted row).
  it("_tiptapOptions.extensions has the side-by-side paste rule extension", () => {
    const extensions = build()._tiptapOptions.extensions;
    expect(extensions.map((ext: { name: string }) => ext.name)).toContain("knotebookColumnsPaste");
  });

  // Same: `tour-transaction-filter.test.ts` mounts its own editor. It must be attached at editor creation and exactly once: plugins can't be registered again during the tour.
  it("_tiptapOptions.extensions has exactly one tour transaction filter extension", () => {
    const extensions = build()._tiptapOptions.extensions;
    expect(extensions.filter((ext: { name: string }) => ext.name === "knotebookTourTransactionFilter")).toHaveLength(1);
  });

  it("_tiptapOptions.extensions has the three knowledge extensions", () => {
    const names = build()._tiptapOptions.extensions.map((ext: { name: string }) => ext.name);
    expect(names).toContain("knotebookKnowledgeIds");
    expect(names).toContain("knotebookKnowledgeEnter");
    expect(names).toContain("knotebookKnowledgeDecorations");
  });

  // The existing drop cases call createMediaBlockingDOMEvents' handler directly, not through build(), so they don't cover the composition that records the drop position.
  it("the composed drop still reaches the media blocking (through build())", () => {
    const event = dragEvent(transfer({ files: [file("a.pdf", "application/pdf")], types: ["Files"] }));
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.drop(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.transferNonImage" });
  });

  it("the composed drop first records the drop position for the paste rule (through build())", () => {
    const view = { posAtCoords: vi.fn(() => ({ pos: 9, inside: -1 })) };
    const event = Object.assign(dragEvent(transfer({ html: "<p>moved block</p>" })), { clientX: 3, clientY: 4 });
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.drop(view as never, event)).toBe(false);
    expect(view.posAtCoords).toHaveBeenCalledWith({ left: 3, top: 4 });
    expect(takeDropPoint()).toBe(9);
  });

  it("composed drop: posAtCoords throws -> media blocking still works, drop position is null", () => {
    const view = {
      posAtCoords: vi.fn(() => {
        throw new Error("posAtCoords failed");
      }),
    };
    const event = Object.assign(dragEvent(transfer({ files: [file("a.pdf", "application/pdf")], types: ["Files"] })), { clientX: 3, clientY: 4 });
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.drop(view as never, event)).toBe(true);
    expect(view.posAtCoords).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.transferNonImage" });
    expect(takeDropPoint()).toBeNull();
  });

  // #352: when the outermost `withSiteLinkDrop` is active (editable, env present, not dragging) it still returns the inner result, and an error thrown by its own check doesn't block the inner one.
  // The three cases above have env null and a view that is null or only has posAtCoords, so the hook isn't active - this builds a separate builder with a non-null env.
  const buildWithSiteLinks = () =>
    buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language: "en",
      translate,
      editorRef: { current: null },
      noteId: "note-1",
      siteLinks: { current: { origin: "http://localhost", notes: () => [], schedule: () => {} } },
    });
  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it("site-link drop hook active: media blocking still returns true, the drop position is still recorded (#352)", async () => {
    const view = { editable: true, dragging: null, posAtCoords: vi.fn(() => ({ pos: 9, inside: -1 })) };
    const event = Object.assign(dragEvent(transfer({ files: [file("a.pdf", "application/pdf")], types: ["Files"] })), { clientX: 3, clientY: 4 });
    expect(buildWithSiteLinks()._tiptapOptions.editorProps.handleDOMEvents.drop(view as never, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.transferNonImage" });
    expect(takeDropPoint()).toBe(9);
    await flushMicrotasks();
  });

  it("drop hook check throws (editable getter throws) -> doesn't throw, inner runs as usual (#352)", async () => {
    const view = { dragging: null, posAtCoords: vi.fn(() => ({ pos: 9, inside: -1 })) };
    Object.defineProperty(view, "editable", {
      get() {
        throw new Error("boom");
      },
    });
    const event = Object.assign(dragEvent(transfer({ files: [file("a.pdf", "application/pdf")], types: ["Files"] })), { clientX: 3, clientY: 4 });
    let result: boolean | undefined;
    expect(() => {
      result = buildWithSiteLinks()._tiptapOptions.editorProps.handleDOMEvents.drop(view as never, event);
    }).not.toThrow();
    expect(result).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.transferNonImage" });
    await flushMicrotasks();
  });

  it("media interception is attached to editorProps.handleDOMEvents, **not** handlePaste/handleDrop", () => {
    const editorProps = build()._tiptapOptions.editorProps;

    // BlockNote 0.52: its own handleDOMEvents.paste plugin always preventDefaults and takes over first (only afterwards parsing to a slice via `view.pasteHTML`/`pasteText`), and a file-only drop never reaches handleDrop,
    // so data URL / non-image file interception must sit at the raw DataTransfer layer (handleDOMEvents). handlePaste/handleDrop are only for the note size limit check
    // (the parsed slice; reachable, see `NoteEditor.size-guard.test.tsx`), so media interception can't be moved there.
    expect(typeof editorProps.handleDOMEvents.paste).toBe("function");
    expect(typeof editorProps.handleDOMEvents.drop).toBe("function");
    const blocked = clipboardEvent(transfer({ html: '<img src="data:image/png;base64,AAAA">', types: ["text/html"] }));
    expect(editorProps.handleDOMEvents.paste(null, blocked)).toBe(true);
  });

  // One real File shape each for pass-through and block: ensures the same function reference on `_tiptapOptions.editorProps.handleDOMEvents`
  // is really wired to `classifyMediaTransfer`'s rules.
  it("the attached handler really lets a pure image file paste through (end-to-end wiring, not just types)", () => {
    const event = clipboardEvent(transfer({ files: [file("a.png", "image/png")], types: ["Files"] }));
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.paste(null, event)).toBe(false);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("the attached handler really blocks a non-image file paste (end-to-end wiring, not just types)", () => {
    const event = clipboardEvent(transfer({ files: [file("a.pdf", "application/pdf")], types: ["Files"] }));
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.paste(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:note.transferNonImage" });
  });

  it("language starting with zh -> Traditional Chinese dictionary attached; otherwise undefined (BlockNote defaults to English)", () => {
    expect(build("zh-TW").dictionary).toBe(blocknoteZhTW);
    expect(build("zh").dictionary).toBe(blocknoteZhTW);
    expect(build("en").dictionary).toBeUndefined();
    expect(build("en-US").dictionary).toBeUndefined();
  });

  it("user info goes into the collab cursor, color is determined stably by id", () => {
    const options = build();
    expect(options.collaboration.user).toEqual({ id: "user-1", name: "Ann", color: collabUserColor("user-1") });
    expect(collabUserColor("user-1")).toBe(collabUserColor("user-1"));
    expect(collabUserColor("user-1")).not.toBe(collabUserColor("user-2"));
  });
});

// `[[` trigger detection (handleTextInput). Mount harness: after `BlockNoteEditor.create` the editor must be `editor.mount(element attached to document.body)`:
// headless `openSuggestionMenu` returns early (`SuggestionMenu.ts`: `if (editor.headless) return;`), so without mounting every assertion here would be a false green.
// `test/setup.ts` shims `getBoundingClientRect` so `SuggestionMenuView.update()` doesn't blow up computing decoration positions.
// `handleTextInput` is taken straight from the options object returned by `buildNoteEditorOptions`: it is the same function reference ProseMirror calls,
// so calling it directly is equivalent, without depending on how tiptap merges several editorProps sources.
describe("buildNoteEditorOptions [[ trigger detection (handleTextInput)", () => {
  let doc: Y.Doc;
  let editorRef: EditorRef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test editor; repo convention BlockNoteEditor<any,any,any>
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;
  // `view` is deliberately typed `unknown` (as in createMediaBlockingDOMEvents): the test hands the real view over as is and reads none of its fields.
  let handleTextInput: (view: unknown, from: number, to: number, text: string) => boolean | void;

  beforeEach(() => {
    doc = new Y.Doc();
    editorRef = { current: null };
    const options = buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language: "en",
      translate,
      editorRef,
      noteId: "note-1",
      siteLinks: { current: null },
    });
    handleTextInput = options._tiptapOptions.editorProps.handleTextInput as typeof handleTextInput;

    editor = BlockNoteEditor.create(options);
    editorRef.current = editor;

    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    doc.destroy();
  });

  /** Simulates "the user just pressed the second `[`": `from`/`to` is the current cursor, PM hasn't inserted the character yet. */
  function typeSecondBracket(): boolean | void {
    const view = editor._tiptapEditor.view;
    const from = editor.transact((tr) => tr.selection.from);
    return handleTextInput(view, from, from, "[");
  }

  it("[[ mid-sentence: typing the second [ in the middle of a sentence -> swallows the input, opens the menu, document stays 'Hello [['", () => {
    editor.insertInlineContent(["Hello ["]);

    const handled = typeSecondBracket();

    expect(handled).toBe(true);
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    expect(suggestionMenu.shown()).toBe(true);
    expect(suggestionMenu.store.state?.triggerCharacter).toBe("[[");
    expect(suggestionMenu.store.state?.query).toBe("");
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("Hello [[");
  });

  it("[[ at block start: an empty block with a single [ typed -> likewise swallows the input, opens the menu, document stays '[['", () => {
    editor.insertInlineContent(["["]);

    const handled = typeSecondBracket();

    expect(handled).toBe(true);
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    expect(suggestionMenu.shown()).toBe(true);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("[[");
  });

  it("previous character isn't [ (the other half of the same-parent guard): input not swallowed, menu not opened", () => {
    editor.insertInlineContent(["Hello"]);

    const handled = typeSecondBracket();

    expect(handled).toBe(false);
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(false);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("Hello");
  });

  // #98: several characters arrive in one event (fast typing, IME composition end). Ordinary typing doesn't go through the keypress branch of `input.ts` but is written to the DOM by the browser first and picked up by `readDOMChange` in `domchange.ts`,
  // whose call `handleTextInput(view, chFrom, chTo, text)` means "replace [chFrom, chTo) of the old document with text": `text` can be any length and `chFrom` may differ from `chTo`; a per-character `text === "["` comparison fails both.
  // Shapes seen via real DOM mutations driven through `view.domObserver.flush()`: batch typing {from:8,to:8,text:"[["}, IME end {from:4,to:4,text:"<CJK>[["}, typing over a selection {from:8,to:14,text:"[["}.

  /**
   * Simulates ProseMirror sending one input event "replace [from, to) with text". **If `range` is given the selection must be set too**: `readDOMChange`'s `findDiff` uses `state.selection.from` as `preferredPos`, so the range passed to the handler always matches the current selection,
   * and `openSuggestionMenu` uses position-less `insertText()` (acting on the current selection); passing only `range` without moving the selection builds an input shape ProseMirror never produces, so the behaviour measured wouldn't be real.
   */
  function typeInput(text: string, range?: { from: number; to: number }): boolean | void {
    const view = editor._tiptapEditor.view;
    if (range) editor._tiptapEditor.commands.setTextSelection(range);
    const at = editor.transact((tr) => tr.selection.from);
    return handleTextInput(view, range?.from ?? at, range?.to ?? at, text);
  }

  it("batched [[ (fast typing): both [ arrive in one event -> the menu opens as well", () => {
    const handled = typeInput("[[");

    expect(handled).toBe(true);
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    expect(suggestionMenu.shown()).toBe(true);
    expect(suggestionMenu.store.state?.triggerCharacter).toBe("[[");
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("[[");
  });

  it("IME composition end delivered as one string: CJK before [[ in the text must stay in the document, not be swallowed", () => {
    editor.insertInlineContent(["x"]);

    const handled = typeInput("測試[[");

    expect(handled).toBe(true);
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("x測試[[");
  });

  it("replacing a range (from !== to, typing after selecting): the selected content is replaced and the menu still opens", () => {
    editor.insertInlineContent(["a[ world"]);
    // Paragraph content starts at 3, so after "a[" = 5 and the end of the whole = 11: equivalent to selecting " world" and typing "[".
    const handled = typeInput("[", { from: 5, to: 11 });

    expect(handled).toBe(true);
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("a[[");
  });

  it("selection disagrees with the argument range: hand back to ProseMirror (deletion uses argument coordinates but insertion goes through the selection; if they differ it would edit somewhere else)", () => {
    editor.insertInlineContent(["a[bcdef"]);
    // Cursor stays at line end while claiming input at position 5: ProseMirror never produces this, but if it ever happens it must do nothing
    // rather than insert `[[` at the cursor and delete characters near position 5.
    const view = editor._tiptapEditor.view;
    const handled = handleTextInput(view, 5, 5, "[");

    expect(handled).toBe(false);
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(false);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("a[bcdef");
  });

  it("SuggestionMenu extension unavailable: hand back to ProseMirror, never swallow what the user typed", () => {
    editorRef.current = null;

    const handled = typeInput("測試[[");

    expect(handled).toBe(false);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("");
  });

  it("from === 0: the range check must come before resolve(from - 1) (must not throw)", () => {
    expect(() => typeInput("[", { from: 0, to: 0 })).not.toThrow();
  });
});

// uploadFile really connected to handleFileInsertion. `handleFileInsertion` isn't a public export of `@blocknote/core`; the only way to really go through it is to mount the editor and dispatch a real `paste` DOM event,
// so BlockNote's own paste plugin (`pasteExtension.ts`, which always runs our `createMediaBlockingDOMEvents.paste` first - pure image files pass, returning false falls back to BlockNote) takes over and calls `editor.uploadFile`.
// jsdom 30 has no constructible `ClipboardEvent`/`DataTransfer`: a minimal stand-in (`types`/`items`/`files`) is attached to a plain `Event`; `handleFileInsertion` only reads these three (`acceptedMIMETypes` checks go through `types`, files come from `items[i].getAsFile()`), and doesn't need `getData` (the "Files" branch doesn't call it, see defaultPasteHandler in `pasteExtension.ts`).
// Cleanup after a failed upload (4xx) is a macrotask scheduled by `setTimeout(..., 0)`, while `editor.updateBlock(insertedBlockId, ...)` (writing the url back) is the microtask continuation after `await editor.uploadFile(...)` resolves:
// a real `setTimeout(resolve, 0)` of our own flushes both (microtasks run first). The cleanup itself is another macrotask queued after, so verifying "block removed" needs one more round.
describe("buildNoteEditorOptions #name tags (handleTextInput)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test editor; repo convention BlockNoteEditor<any,any,any>
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;
  let applied: Array<{ names: string[] }>;
  let handleTextInput: (view: unknown, from: number, to: number, text: string) => boolean | void;

  function setUp(withHooks: boolean): void {
    applied = [];
    const editorRef: EditorRef = { current: null };
    const hashTagHooks = {
      current: withHooks
        ? {
            applyHash: (input: { names: string[] }) => void applied.push(input),
            currentTagNames: () => [],
            undoBoundary: () => undefined,
            notify: () => undefined,
            active: () => (editor.prosemirrorView ? { editor, view: editor.prosemirrorView } : null),
          }
        : null,
    };
    const options = buildNoteEditorOptions({
      doc: new Y.Doc(),
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language: "en",
      translate: (key: string) => key,
      editorRef,
      noteId: "note-1",
      siteLinks: { current: null },
      hashTagHooks,
    });
    handleTextInput = options._tiptapOptions.editorProps.handleTextInput as typeof handleTextInput;
    editor = BlockNoteEditor.create(options);
    editorRef.current = editor;
    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);
  }

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  function typeSpace(): boolean | void {
    const at = editor.transact((tr) => tr.selection.from);
    return handleTextInput(editor._tiptapEditor.view, at, at, " ");
  }

  it("takes #name and a space typed in the first paragraph", () => {
    setUp(true);
    editor.insertInlineContent(["#alpha"]);
    expect(typeSpace()).toBe(true);
    expect(applied.map((a) => a.names)).toEqual([["alpha"]]);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("");
  });

  it("leaves # and a space to the heading shortcut", () => {
    setUp(true);
    editor.insertInlineContent(["#"]);
    expect(typeSpace()).toBeFalsy();
    expect(applied).toEqual([]);
  });

  it("leaves everything to the editor when hooks are not available", () => {
    setUp(false);
    editor.insertInlineContent(["#alpha"]);
    expect(typeSpace()).toBeFalsy();
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("#alpha");
  });
});

describe("buildNoteEditorOptions uploadFile really connected (handleFileInsertion)", () => {
  let doc: Y.Doc;
  let editorRef: EditorRef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test editor; repo convention BlockNoteEditor<any,any,any>
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(() => {
    toastMock.mockClear();
    doc = new Y.Doc();
    editorRef = { current: null };
    const options = buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "user-1", name: "Ann" },
      language: "en",
      translate,
      editorRef,
      noteId: "note-1",
      siteLinks: { current: null },
    });

    editor = BlockNoteEditor.create(options);
    editorRef.current = editor;

    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);

    // Give the block under the cursor content: `handleFileInsertion`'s `insertOrUpdateBlock` does an in-place `updateBlock` on an empty block (overwriting the only block, hard to assert a lifecycle on)
    // but `insertBlocks(..., "after")` on a non-empty one, adding a brand-new block - only that has a separate insert/remove to observe, and its internal id doesn't matter.
    editor.insertInlineContent(["hello"]);
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    doc.destroy();
    vi.unstubAllGlobals();
  });

  function fakeResponse({ ok, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
    return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
  }

  function pasteFile(file: File): void {
    // `getData` must exist: the handler from `createMediaBlockingDOMEvents` first runs `classifyMediaTransfer` (before rule 3 lets it through), which calls `data.getData("text/html"/"text/plain")` to look for embedded data URLs;
    // without it the whole event dispatch blows up (a real browser's DataTransfer always has it, returning an empty string for a pure image paste).
    const clipboardData = {
      types: ["Files"],
      items: [{ type: file.type, getAsFile: () => file }],
      files: [file],
      getData: () => "",
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    editor._tiptapEditor.view.dom.dispatchEvent(event);
  }

  const imageFile = () => new File([new Uint8Array([1])], "a.png", { type: "image/png" });

  async function flushMacrotask(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("success: pasting an image file really triggers uploadFile, the block gets the returned url (image is in the schema, the placeholder is a real image block)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u1", url: "/api/uploads/u1" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const before = editor.document.length;

    pasteFile(imageFile());

    expect(editor.document.length).toBe(before + 1);

    await flushMacrotask();

    const placeholder = editor.document[editor.document.length - 1];
    // `handleFileInsertion` picks the block type by checking `schema.blockSpecs` against `fileBlockAccept` one by one (see `@blocknote/core` source); with image in the schema an image/png file lands in an image block, not the generic file block.
    expect(placeholder.type).toBe("image");
    expect((placeholder.props as Record<string, unknown>).url).toBe("/api/uploads/u1");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("SVG paste (#389): pasting an image/svg+xml file creates an image block and uploads via uploadFile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: "u-svg", url: "/api/uploads/u-svg" }) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const before = editor.document.length;

    const svgFile = new File(['<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'], "a.svg", {
      type: "image/svg+xml",
    });
    pasteFile(svgFile);

    expect(editor.document.length).toBe(before + 1);
    await flushMacrotask();

    const placeholder = editor.document[editor.document.length - 1];
    expect(placeholder.type).toBe("image");
    expect((placeholder.props as Record<string, unknown>).url).toBe("/api/uploads/u-svg");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("failure (4xx): one toast, the placeholder block is removed only after the next macrotask (ordering: updateBlock finishes first, then removal)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 415,
        json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const before = editor.document.length;

    pasteFile(imageFile());
    expect(editor.document.length).toBe(before + 1);

    await flushMacrotask();
    // This round: uploadFile's promise has resolved (sentinel ""), the toast fired and `handleFileInsertion`'s `editor.updateBlock(...)` has run synchronously - but cleanup is another, later-registered macrotask that hasn't run yet.
    expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.unsupported_media_type" });
    expect(editor.document.length).toBe(before + 1);

    await flushMacrotask();

    expect(editor.document.length).toBe(before);
  });
});

// issue #99: `insertLinkAtSavedSelection`. "Restore selection then createLink" used to live inside `NoteEditor`'s `handleLinkInsert` closure, leaving the NoteEditor wiring layer uncovered
// (deleting the `<LinkDialog>` mount, the selection restore, or making the handler a no-op all stayed green). As an exported pure function it can be measured with a real editor.
describe("insertLinkAtSavedSelection", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as the other mount tests in this file
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(() => {
    editor = BlockNoteEditor.create({ schema: noteSchema });
    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("with restore: the link lands at the saved position, not at the paragraph end (real editor)", () => {
    editor.insertInlineContent(["hello "]);
    // This is the selection `openLinkDialog` saved when opening the dialog; "world" is typed afterwards, moving the selection to the paragraph end, so the two positions really differ and "restored or not" is distinguishable.
    const savedSelection = editor.transact((tr) => ({ from: tr.selection.from, to: tr.selection.to }));
    editor.insertInlineContent(["world"]);
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("hello world");

    insertLinkAtSavedSelection(editor, savedSelection, { text: "x", href: "https://example.com" });

    // Without the restore (`editor.createLink` straight at the current selection = paragraph end) this would be "hello worldx".
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("hello xworld");
    // A correct position isn't enough: also confirm the mark really sits in the document with the right href.
    const hasLink = editor.transact((tr) => {
      let found = false;
      tr.doc.descendants((node) => {
        if (node.isText && node.marks.some((m) => m.type.name === "link" && m.attrs.href === "https://example.com")) found = true;
      });
      return found;
    });
    expect(hasLink).toBe(true);
  });

  it("savedSelection null (defensive when no selection can be obtained): doesn't blow up, lands at the current selection", () => {
    editor.insertInlineContent(["hello "]);

    expect(() => insertLinkAtSavedSelection(editor, null, { text: "x", href: "https://example.com" })).not.toThrow();

    expect(editor.transact((tr) => tr.doc.textContent)).toBe("hello x");
  });
});

// issue #99: `<LinkDialog>` mount structure guard (source regex). These two only compare source strings, mount no real component and verify nothing rendered,
// so they can't catch shapes like "the mount wrapped in an always-false condition" or "`linkDialogOpen` never true".
describe("NoteEditor JSX: <LinkDialog> mount guard", () => {
  const source = readFileSync(`${process.cwd()}/src/components/NoteEditor.tsx`, "utf8");

  it("mounted with all four props wired (editor/open/onOpenChange/onSubmit), prefill values wired too", () => {
    expect(source).toMatch(
      /<LinkDialog\s+editor=\{editor\}\s+open=\{linkDialogOpen\}\s+onOpenChange=\{setLinkDialogOpen\}\s+onSubmit=\{handleLinkInsert\}\s+initialText=\{linkPrefill\.text\}\s+initialUrl=\{linkPrefill\.url\}\s*\/>/,
    );
  });

  it("handleLinkInsert's body really calls insertLinkAtSavedSelection (not reduced to a no-op)", () => {
    expect(source).toMatch(/insertLinkAtSavedSelection\(currentEditor,\s*linkSelectionRef\.current,\s*\{\s*text:\s*keepText \? "" : text,\s*href\s*\}\)/);
  });
});

// issue #99: `useLinkMenuState`'s `getSlashItems` identity must not change across dialog open/close; after extracting `useLinkMenuState`
// this hooks-composition fact is verified directly with `renderHook`, no BlockNote mount needed.
describe("useLinkMenuState", () => {
  const editorRef: EditorRef = { current: null };
  const translate = (key: string) => key;

  it("dialog open + close (linkDialogOpen changes): getSlashItems identity unchanged", () => {
    const { result } = renderHook(() => useLinkMenuState(editorRef, translate));
    const before = result.current.getSlashItems;

    act(() => {
      result.current.openLinkDialog();
    });
    // First confirm it really re-rendered (state really changed); otherwise the identity comparison below is a false positive (no re-render trivially keeps identity).
    expect(result.current.linkDialogOpen).toBe(true);
    expect(result.current.getSlashItems).toBe(before);

    act(() => {
      result.current.setLinkDialogOpen(false);
    });
    expect(result.current.linkDialogOpen).toBe(false);
    expect(result.current.getSlashItems).toBe(before);
  });

  it("positive control: a really different translate -> getSlashItems changes identity (proves the equality assertion above isn't a tautology and does measure the dependency)", () => {
    const { result, rerender } = renderHook(({ translate: t }) => useLinkMenuState(editorRef, t), {
      initialProps: { translate },
    });
    const before = result.current.getSlashItems;

    rerender({ translate: (key: string) => `zh:${key}` });

    expect(result.current.getSlashItems).not.toBe(before);
  });

  // The two above test getSlashItems identity; the half where `openLinkDialog` really **saves** the selection isn't caught by `insertLinkAtSavedSelection`'s unit test
  // (it receives a savedSelection prepared by the caller, not the one `openLinkDialog` saved) - this mounts a real editor and goes through `openLinkDialog` -> `handleLinkInsert`, measuring saving and restoring together.
  it("the selection saved by openLinkDialog is really restored by handleLinkInsert (not passing by coincidence through the null fallback)", () => {
    const realEditor = BlockNoteEditor.create({ schema: noteSchema });
    const container = document.createElement("div");
    document.body.appendChild(container);
    realEditor.mount(container);
    const realEditorRef: EditorRef = { current: realEditor };

    const { result } = renderHook(() => useLinkMenuState(realEditorRef, translate));

    realEditor.insertInlineContent(["hello "]);
    act(() => {
      result.current.openLinkDialog();
    });
    // After the dialog opens the document keeps changing, moving the current selection to the paragraph end - different from the position `openLinkDialog` saved, so "really saved or not" is distinguishable.
    realEditor.insertInlineContent(["world"]);

    act(() => {
      result.current.handleLinkInsert({ text: "x", href: "https://example.com" });
    });

    // If openLinkDialog didn't really save the selection (e.g. always saved null), handleLinkInsert would fall back to the current selection = paragraph end, giving "hello worldx".
    expect(realEditor.transact((tr) => tr.doc.textContent)).toBe("hello xworld");

    realEditor.unmount();
    container.remove();
  });
});

describe("useLinkMenuState getSlashItems has no shortcut column on phone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const translate = (key: string) => key;
  async function slashItems(tier: "phone" | "docked") {
    stubLayoutTier(tier);
    const realEditor = BlockNoteEditor.create({ schema: noteSchema });
    const container = document.createElement("div");
    document.body.appendChild(container);
    realEditor.mount(container);
    const { result } = renderHook(() => useLinkMenuState({ current: realEditor } as EditorRef, translate));
    const items = await result.current.getSlashItems("");
    realEditor.unmount();
    container.remove();
    return items as { title: string; badge?: string }[];
  }

  it("phone: no item has a badge, the item set equals docked", async () => {
    const docked = await slashItems("docked");
    const phone = await slashItems("phone");
    expect(docked.some((item) => item.badge)).toBe(true);
    expect(phone.some((item) => item.badge)).toBe(false);
    expect(phone.map((item) => item.title)).toEqual(docked.map((item) => item.title));
  });
});

describe("useLinkMenuState tag entry", () => {
  const translate = (key: string) => key;

  it("getSlashItems keeps its identity when tagEntry changes, and reads the current entry on every query", async () => {
    const realEditor = BlockNoteEditor.create({ schema: noteSchema });
    const container = document.createElement("div");
    document.body.appendChild(container);
    realEditor.mount(container);
    const tagEntryRef: { current: { open: (opts?: { returnFocus?: () => void }) => void } | undefined } = { current: undefined };
    const editorRef = { current: realEditor } as EditorRef;
    const { result, rerender } = renderHook(() => useLinkMenuState(editorRef, translate, tagEntryRef));
    await act(async () => {});
    const before = result.current.getSlashItems;
    const titles = async () => (await result.current.getSlashItems("")).map((item) => item.title);

    expect(await titles()).not.toContain("tags.entry.slashTitle");
    const open = vi.fn();
    tagEntryRef.current = { open };
    rerender();
    expect(result.current.getSlashItems).toBe(before);
    expect(await titles()).toContain("tags.entry.slashTitle");
    (await result.current.getSlashItems("tag")).find((item) => item.title === "tags.entry.slashTitle")!.onItemClick();
    expect(open).toHaveBeenCalledOnce();
    tagEntryRef.current = undefined;
    expect(await titles()).not.toContain("tags.entry.slashTitle");

    // Choosing /tag hands the entry a way back to the caret, for when the input is left without adding a tag.
    tagEntryRef.current = { open };
    open.mockClear();
    (await result.current.getSlashItems("tag")).find((item) => item.title === "tags.entry.slashTitle")!.onItemClick();
    const opts = open.mock.calls[0]![0] as { returnFocus: () => void };
    realEditor.insertInlineContent(["caret here"]);
    (document.activeElement as HTMLElement | null)?.blur();
    opts.returnFocus();
    expect(container.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("contenteditable")).toBe("true");

    realEditor.unmount();
    container.remove();
  });
});

describe("lateBoundTranslate (late-bound wrapper must forward interpolation args)", () => {
  it("forwards opts, and reads the ref's current value on every call", () => {
    const ref: { current: (key: string, opts?: Record<string, unknown>) => string } = {
      current: (key, opts) => `a:${key}:${JSON.stringify(opts ?? null)}`,
    };
    const translate = lateBoundTranslate(ref);
    expect(translate("storage.quotaDetail", { used: "1.5 MB", quota: "1 MB" })).toBe('a:storage.quotaDetail:{"used":"1.5 MB","quota":"1 MB"}');
    ref.current = (key) => `b:${key}`;
    expect(translate("x")).toBe("b:x");
  });
});

describe("#269 wiring: the site-link plugin is really attached to the editor built by buildNoteEditorOptions (removing the wiring must go red)", () => {
  function mountBuilt() {
    const doc = new Y.Doc();
    const editorRef: { current: unknown } = { current: null };
    const siteLinks = {
      current: {
        origin: window.location.origin,
        notes: () => [{ id: "11111111-1111-4111-8111-111111111111", title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" }],
        schedule: () => {},
      },
    };
    const editor = BlockNoteEditor.create(
      buildNoteEditorOptions({
        doc,
        provider: { awareness: undefined } as never,
        user: { id: "u1", name: "U" },
        language: "en",
        translate: (k) => k,
        editorRef: editorRef as never,
        noteId: "n1",
        siteLinks,
      }) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
    ) as BlockNoteEditor<any, any, any>;
    editorRef.current = editor;
    const container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);
    attachTestElementRenderer(editor); // there is no <BlockNoteView>, but wikilink's toDOM needs this (see the helper header)
    const cleanup = () => {
      editor.unmount();
      container.remove();
      doc.destroy();
    };
    return { editor, cleanup };
  }

  it("createLink with a cache-hit site URL -> wikilink", () => {
    const { editor, cleanup } = mountBuilt();
    try {
      editor.setTextCursorPosition(editor.document[0]!.id, "end");
      editor.createLink("/n/alice/alpha", "go");
      expect((editor.document[0]!.content as Array<{ type: string }>).map((n) => n.type)).toContain("wikilink");
    } finally {
      cleanup();
    }
  });

  it("input rule wiring (createMarkdownLinkExtension receives siteLinks): typing `see [x](/n/alice/alpha)` char by char -> wikilink", () => {
    const { editor, cleanup } = mountBuilt();
    try {
      const view = editor._tiptapEditor.view;
      editor.setTextCursorPosition(editor.document[0]!.id, "end");
      // Go through the plugin chain's handleTextInput (the input rule lives there); the direct editorProps typeInput would bypass the input rule.
      for (const ch of "see [x](/n/alice/alpha)") {
        const { from, to } = view.state.selection;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the callback only forwards to the handleTextInput prop; not worth building PM's prop type
        const handled = view.someProp("handleTextInput", (f: any) => f(view, from, to, ch));
        if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
      }
      expect((editor.document[0]!.content as Array<{ type: string }>).map((n) => n.type)).toEqual(["text", "wikilink"]);
    } finally {
      cleanup();
    }
  });

  it("paste wiring (pasteHandler carries createSiteLinkPasteHook): pasting HTML <a> mid-paragraph -> wikilink", () => {
    const { editor, cleanup } = mountBuilt();
    try {
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello " }]);
      editor.setTextCursorPosition(editor.document[0]!.id, "end");
      const data: Record<string, string> = { "text/html": '<a href="/n/alice/alpha">go</a>', "text/plain": "go" };
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { types: Object.keys(data), items: [], files: [], getData: (t: string) => data[t] ?? "" } });
      editor._tiptapEditor.view.dom.dispatchEvent(event);
      expect((editor.document[0]!.content as Array<{ type: string }>).map((n) => n.type)).toEqual(["text", "wikilink"]);
    } finally {
      cleanup();
    }
  });

  const a353 = (t: string) => `<a href="/n/alice/alpha">${t}</a>`;
  it.each([
    // Cursor after AAA: the second half of the split part gets a new block id (the old diff range covered L).
    ["two paragraphs", "AAA", `<p>X ${a353("pa")}</p><p>Y ${a353("pb")}</p>`, ["link:H", "wiki:pa", "wiki:pb", "link:L"]],
    // Last block is a nested list item with the cursor right before L: PM moves the existing content after the cursor into that item with a ReplaceAroundStep ("selection + size difference" would cover L).
    ["last block is a nested list item", "AAA ", `<p>X ${a353("pa")}</p><ul><li>Y ${a353("pb")}<ul><li>Z ${a353("pc")}</li></ul></li></ul>`, ["link:H", "wiki:pa", "wiki:pb", "wiki:pc", "link:L"]],
  ] as const)("#353 product config: `[H] AAA [L] BBB` pasting into the middle: %s -> the pasted ones become wikilinks, existing H and L stay ordinary links", (_name, after, html, expected) => {
    const { editor, cleanup } = mountBuilt();
    try {
      const href = "/notes/11111111-1111-4111-8111-111111111111"; // differs from the pasted href: when adjacent, PM doesn't merge them into one link
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href, content: "H" }, " AAA ", { type: "link", href, content: "L" }, " BBB"] }]);
      const view = editor._tiptapEditor.view;
      let caret = -1;
      view.state.doc.descendants((n: { isText: boolean; text?: string }, p: number) => {
        if (caret === -1 && n.isText && String(n.text).includes(after)) caret = p + String(n.text).indexOf(after) + after.length;
        return caret === -1;
      });
      editor._tiptapEditor.commands.setTextSelection(caret);
      const data: Record<string, string> = { "text/html": html, "text/plain": "X" };
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { types: Object.keys(data), items: [], files: [], getData: (t: string) => data[t] ?? "" } });
      view.dom.dispatchEvent(event);
      const seq: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM Node types aren't available at value level in apps/web (same as the other descendants walks in this file)
      view.state.doc.descendants((n: any) => {
        if (n.type.name === "wikilink") seq.push(`wiki:${String(n.attrs.snapshotTitle)}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
        else if (n.isText && n.marks.some((m: any) => m.type.name === "link")) seq.push(`link:${String(n.text)}`);
        return true;
      });
      expect(seq).toEqual(expected);
    } finally {
      cleanup();
    }
  });
});
