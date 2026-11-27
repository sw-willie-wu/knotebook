import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { installFetchBackedXhr } from "@/test/fake-xhr";
import { ThemeProvider } from "@/theme";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// The pre-upload limit is read through a ref at call time: `uploadFile` is frozen as a closure when the editor is created.
// Mounts a real `<NoteEditor>` and takes the real editor's `uploadFile`; changing the prop doesn't remount, and the next upload must use the new value.

const captured = vi.hoisted(() => ({ editor: null as null | { uploadFile?: (file: File, blockId?: string) => Promise<unknown> }, created: 0 }));
vi.mock("@blocknote/react", async importOriginal => {
  const m = await importOriginal<typeof import("@blocknote/react")>();
  return {
    ...m,
    useCreateBlockNote: ((...args: Parameters<typeof m.useCreateBlockNote>) => {
      const editor = m.useCreateBlockNote(...args);
      if (captured.editor !== (editor as unknown)) captured.created += 1;
      captured.editor = editor as never;
      return editor;
    }) as typeof m.useCreateBlockNote,
  };
});
vi.mock("@/components/ui/toast", () => ({ toast: vi.fn() }));

const { NoteEditor } = await import("./NoteEditor");

const ONE_MIB = 1048576;

function fileOfSize(size: number): File {
  const f = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
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

describe("NoteEditor: pre-upload limit (maxUploadBytes)", () => {
  let uploadCalls: string[];

  beforeEach(async () => {
    installFetchBackedXhr();
    await i18n.changeLanguage("en");
    captured.editor = null;
    captured.created = 0;
    uploadCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/ai/actions") return Promise.resolve(json({ actions: [] }));
        if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
        if (url.endsWith("/uploads") && method === "POST") {
          uploadCalls.push(url);
          return Promise.resolve(json({ id: "u1", url: "/api/uploads/u1" }, 201));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("limit changed without remounting the editor: the same uploadFile uses the new value next time; with no value there is no pre-check", async () => {
    const doc = new Y.Doc();
    const base = { doc, provider: { awareness: null } as never, editable: true, user: { id: "u1", name: "Ann" }, noteId: "note-1" };
    const { rerender } = render(
      <Host>
        <NoteEditor {...base} maxUploadBytes={ONE_MIB} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    const editor = captured.editor!;
    const uploadFile = editor.uploadFile!;
    expect(typeof uploadFile).toBe("function");

    await uploadFile(fileOfSize(ONE_MIB * 1.5));
    expect(uploadCalls).toHaveLength(0);

    rerender(
      <Host>
        <NoteEditor {...base} maxUploadBytes={ONE_MIB * 2} />
      </Host>,
    );
    expect(captured.editor).toBe(editor);
    await uploadFile(fileOfSize(ONE_MIB * 1.5));
    expect(uploadCalls).toHaveLength(1);

    // Back to 1 MiB: blocked again (the value isn't read once at first render, and doesn't only take effect in the looser direction).
    rerender(
      <Host>
        <NoteEditor {...base} maxUploadBytes={ONE_MIB} />
      </Host>,
    );
    await uploadFile(fileOfSize(ONE_MIB * 1.5));
    expect(uploadCalls).toHaveLength(1);

    rerender(
      <Host>
        <NoteEditor {...base} maxUploadBytes={undefined} />
      </Host>,
    );
    await uploadFile(fileOfSize(ONE_MIB * 1.5));
    expect(uploadCalls).toHaveLength(2);
    expect(captured.editor).toBe(editor);
    doc.destroy();
  });
});
