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
import { installFetchBackedXhr } from "@/test/fake-xhr";
import { takeDropPoint } from "@/collab/columns/paste-rule";
import { stubLayoutTier } from "@/test/layout-tier";

// toast is a spy: what is asserted is whether the user is notified, no need to render all of Radix.
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));

// The upload queue writes the URL through the note's connection; here that is the editor's own Y.Doc, already writable.
const connection = vi.hoisted(() => ({ doc: null as unknown, acquired: 0 }));
vi.mock("@/collab/note-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/collab/note-connection")>()),
  acquireNoteConnection: () => {
    connection.acquired += 1;
    return {
      doc: connection.doc,
      provider: {},
      getState: () => ({ phase: "connected", role: "editor" }),
      isSynced: () => true,
      subscribe: () => () => {},
      whenWritable: () => Promise.resolve("ok"),
      hasEditor: () => true,
      release: () => {},
    };
  },
}));

const { buildNoteEditorOptions, collabUserColor, createMediaBlockingDOMEvents, insertLinkAtSavedSelection, lateBoundTranslate, useLinkMenuState } =
  await import("./NoteEditor");
const { bindUploadNote } = await import("@/collab/upload-block-status");
const { resetUploadRunnerForTest } = await import("@/uploads/upload-runner");
const { resetUploadQueueForTest } = await import("@/uploads/upload-queue-store");

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

  it("dropping an unsupported file among accepted ones -> returns true, preventDefault, the toast naming the accepted kinds", () => {
    const handlers = createMediaBlockingDOMEvents(translate);
    const event = dragEvent(
      transfer({ files: [file("a.png", "image/png"), file("b.zip", "application/zip")], types: ["Files"] }),
    );

    expect(handlers.drop(null, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:uploadBlock.unsupportedTransfer" });
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
    const event = dragEvent(transfer({ files: [file("a.zip", "application/zip")], types: ["Files"] }));
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.drop(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:uploadBlock.unsupportedTransfer" });
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
    const event = Object.assign(dragEvent(transfer({ files: [file("a.zip", "application/zip")], types: ["Files"] })), { clientX: 3, clientY: 4 });
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.drop(view as never, event)).toBe(true);
    expect(view.posAtCoords).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:uploadBlock.unsupportedTransfer" });
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
    const event = Object.assign(dragEvent(transfer({ files: [file("a.zip", "application/zip")], types: ["Files"] })), { clientX: 3, clientY: 4 });
    expect(buildWithSiteLinks()._tiptapOptions.editorProps.handleDOMEvents.drop(view as never, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:uploadBlock.unsupportedTransfer" });
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
    const event = Object.assign(dragEvent(transfer({ files: [file("a.zip", "application/zip")], types: ["Files"] })), { clientX: 3, clientY: 4 });
    let result: boolean | undefined;
    expect(() => {
      result = buildWithSiteLinks()._tiptapOptions.editorProps.handleDOMEvents.drop(view as never, event);
    }).not.toThrow();
    expect(result).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:uploadBlock.unsupportedTransfer" });
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

  it("the attached handler really blocks an unsupported file paste (end-to-end wiring, not just types)", () => {
    const event = clipboardEvent(transfer({ files: [file("a.zip", "application/zip")], types: ["Files"] }));
    expect(build()._tiptapOptions.editorProps.handleDOMEvents.paste(null, event)).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:uploadBlock.unsupportedTransfer" });
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

// uploadFile really connected to handleFileInsertion. `handleFileInsertion` isn't a public export of `@blocknote/core`; the only way to really go through it is to mount the editor and dispatch a real `paste` or `drop` DOM event,
// so BlockNote's own plugins (which run our `createMediaBlockingDOMEvents` handlers first; accepted files pass, returning false falls back to BlockNote) take over and call `editor.uploadFile`.
// jsdom has no constructible `ClipboardEvent`/`DataTransfer`: a minimal stand-in (`types`/`items`/`files`/`getData`) is attached to a plain `Event`.
describe("buildNoteEditorOptions uploadFile really connected (handleFileInsertion)", () => {
  let doc: Y.Doc;
  let editorRef: EditorRef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test editor; repo convention BlockNoteEditor<any,any,any>
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;
  let uploads: string[];

  beforeEach(() => {
    installFetchBackedXhr();
    toastMock.mockClear();
    doc = new Y.Doc();
    connection.doc = doc;
    connection.acquired = 0;
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
    bindUploadNote(editor, "note-1");

    container = document.createElement("div");
    document.body.appendChild(container);
    editor.mount(container);

    // A non-empty block under the cursor makes `handleFileInsertion` insert a new block after it instead of replacing the only one.
    editor.insertInlineContent(["hello"]);
    uploads = [];
  });

  afterEach(() => {
    resetUploadRunnerForTest();
    resetUploadQueueForTest();
    editor.unmount();
    container.remove();
    doc.destroy();
    vi.unstubAllGlobals();
  });

  function fakeResponse({ ok, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
    return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
  }

  function stubUpload(response: (n: number) => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.endsWith("/uploads")) {
          uploads.push(url);
          return Promise.resolve(response(uploads.length));
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }

  const stored = (kind: string, mime: string) => (n: number) =>
    fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ id: `u${n}`, url: `/api/uploads/u${n}`, mime, kind }) });

  function transferOf(file: File) {
    // `getData` must exist: `classifyMediaTransfer` looks for embedded data URLs before the file rules.
    return { types: ["Files"], items: [{ type: file.type, getAsFile: () => file }], files: [file], getData: () => "" };
  }

  function pasteFile(file: File): void {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transferOf(file) });
    editor._tiptapEditor.view.dom.dispatchEvent(event);
  }

  function dropFile(file: File): void {
    const view = editor._tiptapEditor.view as unknown as { posAtCoords: unknown; dom: HTMLElement };
    // jsdom has no layout: give the drop position directly (inside the first block).
    view.posAtCoords = () => ({ pos: 3, inside: -1 });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transferOf(file) });
    Object.defineProperty(event, "clientX", { value: 1 });
    Object.defineProperty(event, "clientY", { value: 1 });
    view.dom.dispatchEvent(event);
  }

  const lastBlock = () => editor.document[editor.document.length - 1]!;
  const propsOf = (block: { props: unknown }) => block.props as Record<string, unknown>;
  const fileOf = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  it("success: pasting an image file creates an image block, queues one upload, and the queue writes the returned url into it", async () => {
    stubUpload(stored("image", "image/png"));
    const before = editor.document.length;

    pasteFile(fileOf("a.png", "image/png"));

    expect(editor.document.length).toBe(before + 1);
    expect(lastBlock().type).toBe("image");
    await vi.waitFor(() => expect(propsOf(lastBlock()).url).toBe("/api/uploads/u1"));
    expect(uploads).toEqual(["/api/notes/note-1/uploads"]);
    expect(connection.acquired).toBe(1);
    expect(propsOf(lastBlock()).name).toBe("a.png");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it.each([
    ["song.mp3", "audio/mpeg", "audio", "audio/mpeg"],
    ["clip.mp4", "video/mp4", "video", "video/mp4"],
    ["quote.pdf", "application/pdf", "file", "application/pdf"],
    ["plan.docx", DOCX, "file", DOCX],
    ["data.csv", "text/csv", "file", "text/csv; charset=utf-8"],
  ])("paste of %s (%s) creates a %s block and starts one upload", async (name, type, kind, mime) => {
    stubUpload(stored(kind, mime));
    pasteFile(fileOf(name, type));
    expect(lastBlock().type).toBe(kind);
    await vi.waitFor(() => expect(propsOf(lastBlock()).url).toBe("/api/uploads/u1"));
    expect(uploads).toHaveLength(1);
    expect(propsOf(lastBlock()).name).toBe(name);
  });

  it.each([
    ["song.mp3", "audio/mpeg", "audio"],
    ["clip.mp4", "video/mp4", "video"],
    ["quote.pdf", "application/pdf", "file"],
    ["plan.docx", DOCX, "file"],
    ["data.csv", "text/csv", "file"],
  ])("drop of %s (%s) creates a %s block and starts one upload", async (name, type, kind) => {
    stubUpload(stored(kind, type));
    const before = editor.document.length;
    dropFile(fileOf(name, type));
    expect(editor.document.length).toBe(before + 1);
    const created = editor.document.find((b) => b.type === kind)!;
    expect(propsOf(created).name).toBe(name);
    await vi.waitFor(() => expect(propsOf(editor.getBlock(created.id)!).url).toBe("/api/uploads/u1"));
    expect(uploads).toHaveLength(1);
  });

  it("a .ts file the OS labels as video becomes a file block (the extension list comes first)", async () => {
    stubUpload(stored("file", "text/plain; charset=utf-8"));
    pasteFile(fileOf("main.ts", "video/mp2t"));
    expect(lastBlock().type).toBe("file");
    await vi.waitFor(() => expect(propsOf(lastBlock()).url).toBe("/api/uploads/u1"));
    expect(propsOf(lastBlock()).name).toBe("main.ts.txt");
  });

  it("the server's kind wins: an .m4a the server finds to be video turns its audio block into a video block", async () => {
    stubUpload(stored("video", "video/mp4"));
    pasteFile(fileOf("voice.m4a", "audio/mp4"));
    const id = lastBlock().id;
    expect(lastBlock().type).toBe("audio");
    await vi.waitFor(() => expect(editor.getBlock(id)!.type).toBe("video"));
    expect(propsOf(editor.getBlock(id)!).url).toBe("/api/uploads/u1");
    expect(propsOf(editor.getBlock(id)!).name).toBe("voice.mp4");
  });

  it.each([
    ["a.zip", "application/zip"],
    ["page.html", "text/html"],
  ])("paste or drop of %s: the toast naming the accepted kinds, no block inserted, no upload", (name, type) => {
    stubUpload(stored("file", "x"));
    const before = editor.document.length;
    pasteFile(fileOf(name, type));
    dropFile(fileOf(name, type));
    expect(editor.document.length).toBe(before);
    expect(toastMock).toHaveBeenCalledWith({ title: "t:uploadBlock.unsupportedTransfer" });
    expect(uploads).toEqual([]);
  });

  it("SVG paste (#389): pasting an image/svg+xml file creates an image block and uploads it", async () => {
    stubUpload(stored("image", "image/svg+xml"));
    pasteFile(new File(['<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'], "a.svg", { type: "image/svg+xml" }));
    expect(lastBlock().type).toBe("image");
    await vi.waitFor(() => expect(propsOf(lastBlock()).url).toBe("/api/uploads/u1"));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("failure (415): the block stays with the reason and no Retry, one toast; nothing is removed", async () => {
    stubUpload(() => fakeResponse({ ok: false, status: 415, json: () => Promise.resolve({ error: { code: "unsupported_media_type", message: "nope" } }) }));
    const before = editor.document.length;

    pasteFile(fileOf("a.png", "image/png"));
    const id = lastBlock().id;

    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledWith({ title: "t:errors.unsupported_media_type" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.document.length).toBe(before + 1);
    const status = container.querySelector(`[data-id="${id}"] .kn-upload-status`)!;
    expect(status.getAttribute("data-upload-state")).toBe("failed");
    expect(status.querySelector(".text-destructive")!.textContent).toBe("That file type isn't supported.");
    expect(status.querySelector("button")).toBeNull();
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("a network failure leaves the block with the reason and Retry", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    pasteFile(fileOf("a.png", "image/png"));
    const id = lastBlock().id;
    const status = () => container.querySelector(`[data-id="${id}"] .kn-upload-status`)!;
    await vi.waitFor(() => expect(status().getAttribute("data-upload-state")).toBe("failed"));
    expect(status().querySelector(".text-destructive")!.textContent).toBe("The upload was interrupted. Check your connection and try again.");
    expect(status().querySelector("button")!.textContent).toBe("Retry");
  });

  it("no object URL is created for a pasted file", async () => {
    stubUpload(stored("video", "video/mp4"));
    // jsdom has no createObjectURL of its own.
    const spy = vi.fn(() => "blob:x");
    Object.defineProperty(URL, "createObjectURL", { value: spy, configurable: true, writable: true });
    try {
      pasteFile(fileOf("clip.mp4", "video/mp4"));
      await vi.waitFor(() => expect(propsOf(lastBlock()).url).toBe("/api/uploads/u1"));
      expect(spy).not.toHaveBeenCalled();
      expect(container.innerHTML).not.toContain("blob:");
    } finally {
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
    }
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
