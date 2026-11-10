import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// 上傳前驗的上限經 ref 讀當下值：`uploadFile` 在編輯器建立時就固定成閉包，
// 掛真 `<NoteEditor>`、拿真編輯器的 `uploadFile`，換 prop 不重掛，下一次上傳就要用新值。

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

describe("NoteEditor：上傳前驗的上限（maxUploadBytes）", () => {
  let uploadCalls: string[];

  beforeEach(async () => {
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

  it("上限換了、編輯器沒重掛：同一支 uploadFile 下一次就用新值；沒給值時不前驗", async () => {
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

    // 1 MiB 上限：1.5 MiB 被擋，沒打上傳端點。
    await uploadFile(fileOfSize(ONE_MIB * 1.5));
    expect(uploadCalls).toHaveLength(0);

    // 調到 2 MiB：同一個編輯器實例、同一支 uploadFile，放行。
    rerender(
      <Host>
        <NoteEditor {...base} maxUploadBytes={ONE_MIB * 2} />
      </Host>,
    );
    expect(captured.editor).toBe(editor);
    await uploadFile(fileOfSize(ONE_MIB * 1.5));
    expect(uploadCalls).toHaveLength(1);

    // 調回 1 MiB：又被擋（不是只在第一次 render 讀一次，也不是只往寬鬆方向生效）。
    rerender(
      <Host>
        <NoteEditor {...base} maxUploadBytes={ONE_MIB} />
      </Host>,
    );
    await uploadFile(fileOfSize(ONE_MIB * 1.5));
    expect(uploadCalls).toHaveLength(1);

    // 設定拿不到（undefined）：不前驗。
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
