import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { getDemoEditor, onEditorEditable, type TourEditor } from "@/lib/tour-bridge";
import { NoteEditor } from "./NoteEditor";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// NoteEditor 對功能導覽登記處的接線：掛真 `<NoteEditor>`（Host 照 `NoteEditor.cursor.test.tsx`）。

function fakeResponse(json: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(json) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(fakeResponse({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([]));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const provider = { awareness: null } as never;
const user = { id: "u1", name: "Ann" };

function Host({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

function renderEditor(props: { doc: Y.Doc; noteId: string; editable: boolean }) {
  const tree = (p: typeof props) => (
    <Host>
      <NoteEditor doc={p.doc} provider={provider} editable={p.editable} user={user} noteId={p.noteId} />
    </Host>
  );
  const view = render(tree(props));
  return { ...view, rerenderWith: (p: typeof props) => view.rerender(tree(p)) };
}

describe("NoteEditor：功能導覽登記處", () => {
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("B1 掛載後以 noteId 取得這份編輯器；別的 id 取不到；卸載後取不到", async () => {
    const doc = new Y.Doc();
    const { unmount } = renderEditor({ doc, noteId: "note-1", editable: true });
    await screen.findByTestId("note-editor");
    const editor = getDemoEditor("note-1");
    expect(editor).not.toBeNull();
    expect(getDemoEditor("note-2")).toBeNull();
    unmount();
    expect(getDemoEditor("note-1")).toBeNull();
    doc.destroy();
  });

  it("B2 換 doc（編輯器重建）：登記處換成新的那份；卸載後清空", async () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const { rerenderWith, unmount } = renderEditor({ doc: doc1, noteId: "note-1", editable: true });
    await screen.findByTestId("note-editor");
    const first = getDemoEditor("note-1");
    expect(first).not.toBeNull();
    rerenderWith({ doc: doc2, noteId: "note-1", editable: true });
    const second = getDemoEditor("note-1");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    unmount();
    expect(getDemoEditor("note-1")).toBeNull();
    doc1.destroy();
    doc2.destroy();
  });

  it("B6 editable false→true 呼叫一次（此時 isEditable 已為 true）；之後 true→false→true 不再呼叫", async () => {
    const calls: Array<{ noteId: string; editor: TourEditor; isEditable: boolean }> = [];
    disposers.push(onEditorEditable((noteId, editor) => calls.push({ noteId, editor, isEditable: editor.isEditable })));
    const doc = new Y.Doc();
    const { rerenderWith, unmount } = renderEditor({ doc, noteId: "note-1", editable: false });
    await screen.findByTestId("note-editor");
    expect(calls).toEqual([]);
    // 對照：唯讀時 isEditable 是 false，下面「通知當下已為 true」才有意義。
    expect(getDemoEditor("note-1")!.isEditable).toBe(false);

    rerenderWith({ doc, noteId: "note-1", editable: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.noteId).toBe("note-1");
    expect(calls[0]!.editor).toBe(getDemoEditor("note-1"));
    expect(calls[0]!.isEditable).toBe(true);

    rerenderWith({ doc, noteId: "note-1", editable: false });
    rerenderWith({ doc, noteId: "note-1", editable: true });
    expect(calls).toHaveLength(1);
    unmount();
    doc.destroy();
  });

  it("B6 一直唯讀 → 不呼叫", async () => {
    const fn = vi.fn();
    disposers.push(onEditorEditable(fn));
    const doc = new Y.Doc();
    const { rerenderWith, unmount } = renderEditor({ doc, noteId: "note-1", editable: false });
    await screen.findByTestId("note-editor");
    rerenderWith({ doc, noteId: "note-1", editable: false });
    expect(fn).not.toHaveBeenCalled();
    unmount();
    doc.destroy();
  });

  it("B6 一掛上就可編輯 → 呼叫一次（此刻已登記）；換 doc（新實例）且可編輯 → 對新實例再呼叫一次", async () => {
    const seen: TourEditor[] = [];
    const registeredAtCall: Array<TourEditor | null> = [];
    disposers.push(
      onEditorEditable((noteId, editor) => {
        seen.push(editor);
        registeredAtCall.push(getDemoEditor(noteId));
      }),
    );
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const { rerenderWith, unmount } = renderEditor({ doc: doc1, noteId: "note-1", editable: true });
    await screen.findByTestId("note-editor");
    const first = getDemoEditor("note-1");
    expect(seen).toEqual([first]);
    rerenderWith({ doc: doc2, noteId: "note-1", editable: true });
    const second = getDemoEditor("note-1");
    expect(seen).toEqual([first, second]);
    // 通知時導覽要能立刻用 getDemoEditor 取到同一份：登記必須先於通知。
    expect(registeredAtCall).toEqual([first, second]);
    unmount();
    doc1.destroy();
    doc2.destroy();
  });
});
