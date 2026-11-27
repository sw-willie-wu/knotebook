import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FilePanelExtension } from "@blocknote/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { FakeXhr, installFakeXhr } from "@/test/fake-xhr";
import { ThemeProvider } from "@/theme";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import type { PrecheckCtx } from "@/uploads/precheck";

// Mounts a real `<NoteEditor>` and goes through the real editor's paste and drop: the pre-check context is read through a ref at
// upload time (`uploadFile` is frozen as a closure when the editor is created), and a refused upload shows on its block.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; repo convention
type AnyEditor = any;
const captured = vi.hoisted(() => ({ editor: null as AnyEditor, created: 0 }));
vi.mock("@blocknote/react", async (importOriginal) => {
  const m = await importOriginal<typeof import("@blocknote/react")>();
  return {
    ...m,
    useCreateBlockNote: ((...args: Parameters<typeof m.useCreateBlockNote>) => {
      const editor = m.useCreateBlockNote(...args);
      if (captured.editor !== (editor as unknown)) captured.created += 1;
      captured.editor = editor;
      return editor;
    }) as typeof m.useCreateBlockNote,
  };
});
vi.mock("@/components/ui/toast", () => ({ toast: vi.fn() }));
// The write waits on the note's connection; these tests are about what happens before anything is sent.
vi.mock("@/collab/note-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/collab/note-connection")>()),
  acquireNoteConnection: () => ({
    doc: null,
    provider: {},
    getState: () => ({ phase: "connecting" }),
    isSynced: () => false,
    subscribe: () => () => {},
    whenWritable: () => new Promise(() => {}),
    release: () => {},
  }),
}));

const { NoteEditor } = await import("./NoteEditor");
const { resetUploadRunnerForTest } = await import("@/uploads/upload-runner");
const { putUpload, resetUploadQueueForTest } = await import("@/uploads/upload-queue-store");
const { createPrecheckCtxProvider } = await import("@/uploads/precheck");

const MIB = 1_048_576;

function fileOf(name: string, type: string, size: number): File {
  const f = new File([new Uint8Array([1])], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function Host({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

function transferOf(file: File) {
  return { types: ["Files"], items: [{ type: file.type, getAsFile: () => file }], files: [file], getData: () => "" };
}

function paste(file: File): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: transferOf(file) });
  captured.editor._tiptapEditor.view.dom.dispatchEvent(event);
}

function drop(...files: File[]): void {
  const view = captured.editor._tiptapEditor.view;
  // jsdom has no layout: give the drop position directly.
  view.posAtCoords = () => ({ pos: 1, inside: -1 });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], items: files.map((f) => ({ type: f.type, getAsFile: () => f })), files, getData: () => "" },
  });
  Object.defineProperty(event, "clientX", { value: 1 });
  Object.defineProperty(event, "clientY", { value: 1 });
  view.dom.dispatchEvent(event);
}

const ctx = (over: Partial<PrecheckCtx>) => () =>
  Promise.resolve<PrecheckCtx>({ maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB, roomBytes: null, ...over });

function statusOfBlockNamed(name: string): HTMLElement | null {
  const block = captured.editor.document.find((b: { props?: { name?: string } }) => b.props?.name === name);
  if (!block) return null;
  return document.querySelector<HTMLElement>(`[data-id="${block.id}"] .kn-upload-status`);
}

const reasonOf = (name: string) => statusOfBlockNamed(name)?.querySelector(".text-destructive")?.textContent;

describe("NoteEditor: pre-upload check on drop and paste", () => {
  let doc: Y.Doc;
  let apiCalls: string[];

  beforeEach(async () => {
    installFakeXhr();
    await i18n.changeLanguage("en");
    captured.editor = null;
    captured.created = 0;
    doc = new Y.Doc();
    apiCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/ai/actions") return Promise.resolve(json({ actions: [] }));
        if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
        if (url === "/api/auth/config" || url === "/api/storage") {
          apiCalls.push(url);
          const body = url === "/api/storage" ? { usedBytes: 0, quotaBytes: 100 * MIB } : { maxUploadBytes: 10 * MIB, maxMediaUploadBytes: 100 * MIB };
          // A server that takes a moment, as a real one does.
          return new Promise((resolve) => setTimeout(() => resolve(json(body)), 30));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  });

  afterEach(() => {
    resetUploadRunnerForTest();
    resetUploadQueueForTest();
    vi.unstubAllGlobals();
    doc.destroy();
  });

  // One provider object per test: a new one would rebuild the editor (`useCreateBlockNote` deps).
  const provider = { awareness: null } as never;
  const base = () => ({ doc, provider, editable: true, user: { id: "u1", name: "Ann" }, noteId: "note-1" });

  it("an mp4 dropped over the media limit and a pdf pasted larger than the room: no request, each block shows the formatted reason without Retry", async () => {
    render(
      <Host>
        <NoteEditor {...base()} precheckCtx={ctx({ roomBytes: 2 * MIB })} />
      </Host>,
    );
    await screen.findByTestId("note-editor");

    drop(fileOf("all-day.mp4", "video/mp4", 300 * MIB));
    paste(fileOf("quote.pdf", "application/pdf", 5 * MIB));

    await vi.waitFor(() => expect(reasonOf("quote.pdf")).toBe("This file is 5 MB; this space has 2 MB left."));
    expect(reasonOf("all-day.mp4")).toBe("This file is 300 MB; the limit for this type is 100 MB.");
    expect(statusOfBlockNamed("all-day.mp4")!.querySelector("button")).toBeNull();
    expect(statusOfBlockNamed("quote.pdf")!.querySelector("button")).toBeNull();
    expect(FakeXhr.instances).toHaveLength(0);

    // A file that fits is sent: the zero above isn't a broken upload path.
    paste(fileOf("small.pdf", "application/pdf", MIB));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(statusOfBlockNamed("small.pdf")?.getAttribute("data-upload-state")).toBe("uploading");
  });

  it("the provider is read at upload time: a new one handed in without remounting applies to the next file", async () => {
    const { rerender } = render(
      <Host>
        <NoteEditor {...base()} precheckCtx={ctx({ roomBytes: 2 * MIB })} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    const editor = captured.editor;

    paste(fileOf("first.pdf", "application/pdf", 5 * MIB));
    await vi.waitFor(() => expect(reasonOf("first.pdf")).toBe("This file is 5 MB; this space has 2 MB left."));
    expect(FakeXhr.instances).toHaveLength(0);

    rerender(
      <Host>
        <NoteEditor {...base()} precheckCtx={ctx({ roomBytes: 50 * MIB })} />
      </Host>,
    );
    expect(captured.editor).toBe(editor);
    paste(fileOf("second.pdf", "application/pdf", 5 * MIB));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(captured.created).toBe(1);
  });

  it.each([
    ["video", "Choose a video file to upload", fileOf("all-day.mp4", "video/mp4", 300 * MIB), "This file is 300 MB; the limit for this type is 100 MB."],
    ["file", "Choose a document or text file to upload", fileOf("quote.pdf", "application/pdf", 5 * MIB), "This file is 5 MB; this space has 2 MB left."],
  ])("the editor's file panel on a %s block uses the same provider: refused inline, nothing sent", async (type, label, file, message) => {
    render(
      <Host>
        <NoteEditor {...base()} precheckCtx={ctx({ roomBytes: 2 * MIB })} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    const editor = captured.editor;
    const id = editor.insertBlocks([{ type }], editor.document[0], "after")[0].id;
    act(() => editor.getExtension(FilePanelExtension).showMenu(id));

    fireEvent.change(await screen.findByLabelText(label), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    expect(FakeXhr.instances).toHaveLength(0);
    expect(editor.getBlock(id).props.url).toBe("");
  });

  it("one drop of three files with the page's real provider asks for the limits and the usage once", async () => {
    const precheckCtx = createPrecheckCtxProvider(new QueryClient(), { groupId: null, canViewUsage: true });
    render(
      <Host>
        <NoteEditor {...base()} precheckCtx={precheckCtx} />
      </Host>,
    );
    await screen.findByTestId("note-editor");

    drop(fileOf("a.pdf", "application/pdf", MIB), fileOf("b.pdf", "application/pdf", MIB), fileOf("c.pdf", "application/pdf", MIB));

    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(3));
    expect(apiCalls.filter((u) => u === "/api/auth/config")).toHaveLength(1);
    expect(apiCalls.filter((u) => u === "/api/storage")).toHaveLength(1);
  });

  it("the block's note is the one the editor was created for, not a newer noteId prop during a note switch", async () => {
    const { rerender } = render(
      <Host>
        <NoteEditor {...base()} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    const editor = captured.editor;
    const id = editor.insertBlocks([{ type: "video" }], editor.document[0], "after")[0].id;
    // Same doc and provider (the editor isn't replaced yet), noteId already the next note's.
    rerender(
      <Host>
        <NoteEditor {...base()} noteId="note-2" />
      </Host>,
    );
    expect(captured.editor).toBe(editor);
    const status = () => document.querySelector<HTMLElement>(`[data-id="${id}"] .kn-upload-status`)!;
    const item = { blockId: id, fileName: "clip.mp4", size: 2, loaded: 1, expectedUrl: "", status: "uploading" as const };
    act(() => putUpload({ ...item, id: "in-next-note", noteId: "note-2" }));
    expect(status().style.display).toBe("none");
    act(() => putUpload({ ...item, id: "in-this-note", noteId: "note-1" }));
    expect(status().style.display).toBe("");

    // The switch completes: a new doc and provider give this same NoteEditor a new editor, bound to the next note.
    const nextDoc = new Y.Doc();
    try {
      rerender(
        <Host>
          <NoteEditor {...base()} doc={nextDoc} provider={{ awareness: null } as never} noteId="note-2" />
        </Host>,
      );
      await vi.waitFor(() => expect(captured.editor).not.toBe(editor));
      const next = captured.editor;
      const nextId = next.insertBlocks([{ type: "video" }], next.document[0], "after")[0].id;
      act(() => putUpload({ ...item, blockId: nextId, id: "in-switched-note", noteId: "note-2" }));
      await vi.waitFor(() => expect(document.querySelector<HTMLElement>(`[data-id="${nextId}"] .kn-upload-status`)!.style.display).toBe(""));
    } finally {
      nextDoc.destroy();
    }
  });

  it("no provider handed in: limits and room unknown, the file is sent and the server decides", async () => {
    render(
      <Host>
        <NoteEditor {...base()} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    paste(fileOf("huge.mp4", "video/mp4", 900 * MIB));
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
  });
});
