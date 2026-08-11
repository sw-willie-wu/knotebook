import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { NoteEditor } from "./NoteEditor";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const AI_ACTION: AiActionDto = { id: "action-1", name: "Rewrite", applyMode: "direct" };

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ actions: [AI_ACTION] }) }),
        );
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/**
 * fix round 1 Minor-1：brief 明講三層 flex class（root 的 `min-h-0`、左欄的
 * `min-w-0`/`overflow-y-auto`、`<aside>` 的 `shrink-0`/`overflow-y-auto`）漏掉任何一個
 * 都是「畫面在 jsdom 快照/一般互動測試裡看起來完全正常，只有真的有滾動內容、真的有
 * flex 容器擠壓時才會露餡」的靜默失敗——必須直接斷言 class 字串本身。這裡刻意掛**真正
 * 的** `<NoteEditor>`（不是 `NotePage.test.tsx`/`NoteEditorView.test.tsx` 用的 mock 或
 * 只測 `NoteEditorView` 半層），驗證 `NoteEditor.tsx` 實際渲染出來的容器 class 跟 brief
 * 逐字要求的一致（Step 6：root＝`flex h-full min-h-0`、左欄＝`flex-1 min-w-0
 * overflow-y-auto px-2 py-4`、`<aside>`＝`shrink-0 overflow-y-auto w-80`）。
 */
describe("NoteEditor 佈局（Task 6 MAJOR-2，fix round 1 Minor-1：三層 class smoke）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("root=flex h-full min-h-0；左欄=flex-1 min-w-0 overflow-y-auto px-2 py-4；aside=shrink-0 overflow-y-auto w-80", async () => {
    const doc = new Y.Doc();
    const provider = { awareness: null } as never;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={provider} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const editorRoot = await screen.findByTestId("note-editor");
    const leftColumn = editorRoot.parentElement;
    const root = leftColumn?.parentElement;
    expect(leftColumn).not.toBeNull();
    expect(root).not.toBeNull();

    expect(root).toHaveClass("flex", "h-full", "min-h-0");
    expect(leftColumn).toHaveClass("flex-1", "min-w-0", "overflow-y-auto", "px-2", "py-4");

    // AI 側欄預設收合，展開才會出現完整的 `<aside data-testid="ai-panel">`。
    fireEvent.click(await screen.findByRole("button", { name: "Expand AI panel" }));
    const aside = await screen.findByTestId("ai-panel");
    expect(aside).toHaveClass("shrink-0", "overflow-y-auto", "w-80");

    doc.destroy();
  });
});
