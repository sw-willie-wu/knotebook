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
 * PR2（BC2 卡片版面）：改版前 brief 明講三層 flex class 漏掉任何一個都是
 * 「畫面在 jsdom 快照/一般互動測試裡看起來完全正常，只有真的有滾動內容、真的有
 * flex 容器擠壓時才會露餡」的靜默失敗——這裡延續同一個精神，直接斷言 class 字串
 * 本身，改測 slot 化後的新節點鏈（spec A 節逐字）：
 *
 *   根 row（flex h-full min-h-0 min-w-0 flex-1 gap-3）
 *     內文卡（flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl
 *             border border-border bg-card）
 *       {headerSlot}
 *       捲動容器（min-h-0 min-w-0 flex-1 overflow-y-auto）
 *         置中 wrapper（mx-auto flex min-h-full w-full max-w-[680px] flex-col
 *                        px-4 py-6）
 *           note-editor（BlockNoteView，className 加 flex-1——B-1 定案：wrapper
 *             的 min-h-full 無法把百分比高度傳給孫層，必須讓 BlockNoteView 自己
 *             成為置中 wrapper 的成長項。**兩者都要斷言，缺一即假守衛**）
 *       {footerSlot}
 *     AiPanel
 *
 * 這裡刻意掛**真正的** `<NoteEditor>`（不是 `NotePage.test.tsx`/`NoteEditorView.test.tsx`
 * 用的 mock 或只測 `NoteEditorView` 半層），驗證 `NoteEditor.tsx` 實際渲染出來的容器
 * class 跟 spec 逐字要求的一致。
 */
describe("NoteEditor 佈局（PR2 slot 化：節點鏈 + 雙層 class smoke）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("根/內文卡/捲動容器/置中 wrapper/BlockNoteView 五層 class 逐一斷言；headerSlot/footerSlot 落在正確位置", async () => {
    const doc = new Y.Doc();
    const provider = { awareness: null } as never;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={doc}
            provider={provider}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId="note-1"
            headerSlot={<div data-testid="header-slot-marker">header</div>}
            footerSlot={<div data-testid="footer-slot-marker">footer</div>}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const editorRoot = await screen.findByTestId("note-editor");
    const centerWrapper = editorRoot.parentElement;
    const scrollWrapper = centerWrapper?.parentElement;
    const contentCard = scrollWrapper?.parentElement;
    const root = contentCard?.parentElement;

    expect(centerWrapper).not.toBeNull();
    expect(scrollWrapper).not.toBeNull();
    expect(contentCard).not.toBeNull();
    expect(root).not.toBeNull();

    expect(root).toHaveClass("flex", "h-full", "min-h-0", "min-w-0", "flex-1", "gap-3");
    expect(contentCard).toHaveClass(
      "flex",
      "min-h-0",
      "min-w-0",
      "flex-1",
      "flex-col",
      "overflow-hidden",
      "rounded-xl",
      "border",
      "border-border",
      "bg-card",
    );
    expect(scrollWrapper).toHaveClass("min-h-0", "min-w-0", "flex-1", "overflow-y-auto");
    expect(centerWrapper).toHaveClass("mx-auto", "flex", "min-h-full", "w-full", "max-w-[680px]", "flex-col", "px-4", "py-6");
    // 雙層斷言（缺一即假守衛）：置中 wrapper 的 min-h-full/flex-col **與** BlockNoteView
    // 的 flex-1，兩者都要在——B-1 定案的高度鏈只有兩者同時存在才成立。
    expect(editorRoot).toHaveClass("min-h-full", "flex-1");

    // headerSlot/footerSlot 落在內文卡內、分別在捲動容器的前後（不是巢狀在裡面）。
    expect(contentCard).toContainElement(screen.getByTestId("header-slot-marker"));
    expect(contentCard).toContainElement(screen.getByTestId("footer-slot-marker"));
    expect(scrollWrapper).not.toContainElement(screen.getByTestId("header-slot-marker"));
    expect(scrollWrapper).not.toContainElement(screen.getByTestId("footer-slot-marker"));

    // AI 側欄預設收合，展開才會出現完整的 `<aside data-testid="ai-panel">`。
    fireEvent.click(await screen.findByRole("button", { name: "Expand AI panel" }));
    const aside = await screen.findByTestId("ai-panel");
    // PR2（E 節）：AI 卡跟其餘卡片同一套視覺——rounded-xl border bg-card 取代原本的
    // border-l/bg-background；z-30 保留（窄螢幕 fixed 抽屜仍需疊在內文卡之上）。
    expect(aside).toHaveClass("z-30", "w-80", "shrink-0", "overflow-y-auto", "rounded-xl", "border", "border-border", "bg-card");

    doc.destroy();
  });
});
