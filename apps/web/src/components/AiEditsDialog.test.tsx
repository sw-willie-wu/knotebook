/**
 * #138 Task 4：AI 修改紀錄 dialog。
 *
 * 沿 `ShareDialog.test.tsx` 的慣例：不 mock hook，而是 stub 全域 `fetch` 讓真的
 * react-query 打到假回應。`stubFetch` 的 handler 對未預期的 URL 直接 throw——那是
 * 「元件多打了一發沒人知道的 API」的守衛。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import type { NoteDto, NoteEditDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NOTE_EDITS_QUERY_KEY } from "@/api/noteEdits";
import { AiEditsDialog } from "./AiEditsDialog";

const NOTE: NoteDto = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
};

const EDITS_URL = `/api/notes/${NOTE.id}/edits`;
const revertUrl = (editId: string) => `${EDITS_URL}/${editId}/revert`;

const E1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const E2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const E3 = "cccccccc-3333-4333-8333-cccccccccccc";

/** `byHandle` 用 `NOTE.ownerHandle`——這篇筆記的編輯者就是它的 owner，不另外寫死別的名字。 */
function edit(patch: Partial<NoteEditDto> & { id: string }): NoteEditDto {
  return {
    op: "replace_section",
    sectionId: "sec-1",
    heading: "Section A",
    byHandle: NOTE.ownerHandle,
    agentLabel: "claude",
    createdAt: "2026-02-03T04:05:06.000Z",
    revertedAt: null,
    revertOf: null,
    revertable: false,
    ...patch,
  };
}

function tree(ui: React.ReactElement, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        {ui}
        <Toaster />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(tree(ui, queryClient));
  return {
    queryClient,
    rerender: (next: React.ReactElement) => view.rerender(tree(next, queryClient)),
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), init });
      const { status, body } = handler(url, init);
      return { ok: status < 400, status, json: async () => body } as unknown as Response;
    }),
  );
  return calls;
}

const listBody = (edits: NoteEditDto[]) => ({ status: 200, body: { edits } });

describe("AiEditsDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("三態：可撤回列有撤回鈕、已撤回列標記 reverted、其餘不可撤回列標記 stale", async () => {
    const edits = [
      edit({ id: E1, revertable: true }),
      edit({ id: E2, revertable: false, revertedAt: "2026-02-04T00:00:00.000Z", agentLabel: null }),
      edit({ id: E3, revertable: false }),
    ];
    stubFetch((url) => {
      if (url === EDITS_URL) return listBody(edits);
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderWithQuery(<AiEditsDialog note={NOTE} open onOpenChange={vi.fn()} />);

    const first = await screen.findByTestId(`ai-edit-${E1}`);
    expect(within(first).getByRole("button", { name: i18n.t("aiEdits.revert") })).toBeInTheDocument();
    // AI 形：handle (label)。這一列的 agentLabel 是 "claude"。
    expect(within(first).getByTestId("ai-edit-who").textContent).toBe(`${NOTE.ownerHandle} (claude)`);
    expect(within(first).queryByText(i18n.t("aiEdits.reverted"))).toBeNull();

    const second = screen.getByTestId(`ai-edit-${E2}`);
    expect(within(second).getByText(i18n.t("aiEdits.reverted"))).toBeInTheDocument();
    expect(within(second).queryByRole("button", { name: i18n.t("aiEdits.revert") })).toBeNull();
    // agentLabel 為 null＝那次是真人經 cookie 寫的，只顯示 handle。
    expect(within(second).getByTestId("ai-edit-who").textContent).toBe(NOTE.ownerHandle);

    const third = screen.getByTestId(`ai-edit-${E3}`);
    expect(within(third).getByText(i18n.t("aiEdits.stale"))).toBeInTheDocument();
    expect(within(third).queryByText(i18n.t("aiEdits.reverted"))).toBeNull();
    expect(within(third).queryByRole("button", { name: i18n.t("aiEdits.revert") })).toBeNull();
  });

  it("撤回：409 stale → errors.stale toast 且列表不重抓；成功 → 列表重抓、三把 note query 失效、revertOk toast", async () => {
    const edits = [edit({ id: E1, revertable: true }), edit({ id: E2, revertable: true })];
    const calls = stubFetch((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === EDITS_URL && method === "GET") return listBody(edits);
      if (url === revertUrl(E1) && method === "POST") {
        return { status: 409, body: { error: { code: "stale", message: "x" } } };
      }
      if (url === revertUrl(E2) && method === "POST") {
        return { status: 201, body: { editId: "new", fingerprint: "f", outline: [] } };
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const { queryClient } = renderWithQuery(<AiEditsDialog note={NOTE} open onOpenChange={vi.fn()} />);
    // 這三把 key 就是 `invalidateNoteQueries` 的目標；先種進 cache，`isInvalidated`
    // 才觀測得到（invalidateQueries 對不存在的 key 什麼都不會留下）。
    queryClient.setQueryData(["note", NOTE.id], NOTE);
    queryClient.setQueryData(["note-by-path", NOTE.ownerHandle, NOTE.slug], NOTE);

    const first = await screen.findByTestId(`ai-edit-${E1}`);
    // 清單真的住在 `NOTE_EDITS_QUERY_KEY(noteId)` 這把 key 底下（介面與碼一致；
    // hook 若換了 key，這裡就是 undefined）。
    expect(queryClient.getQueryState(NOTE_EDITS_QUERY_KEY(NOTE.id))?.data).toHaveLength(2);
    fireEvent.click(within(first).getByRole("button", { name: i18n.t("aiEdits.revert") }));

    await screen.findByText(i18n.t("errors.stale"));
    expect(screen.queryByText(i18n.t("aiEdits.revertOk"))).toBeNull();
    // 失敗不該讓列表重抓——只有開啟時那一發 GET。
    expect(calls.filter((c) => c.url === EDITS_URL && c.method === "GET")).toHaveLength(1);
    expect(queryClient.getQueryState(["note-by-path", NOTE.ownerHandle, NOTE.slug])?.isInvalidated).toBe(false);

    const second = screen.getByTestId(`ai-edit-${E2}`);
    fireEvent.click(within(second).getByRole("button", { name: i18n.t("aiEdits.revert") }));

    await screen.findByText(i18n.t("aiEdits.revertOk"));
    await waitFor(() =>
      expect(calls.filter((c) => c.url === EDITS_URL && c.method === "GET").length).toBeGreaterThan(1),
    );
    await waitFor(() => {
      expect(queryClient.getQueryState(["note", NOTE.id])?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(["note-by-path", NOTE.ownerHandle, NOTE.slug])?.isInvalidated).toBe(true);
    });
  });

  it("對話框關著時一發請求都不打；開啟才打恰好一發 GET /edits", async () => {
    const calls = stubFetch((url) => {
      if (url === EDITS_URL) return listBody([]);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { rerender } = renderWithQuery(<AiEditsDialog note={NOTE} open={false} onOpenChange={vi.fn()} />);
    // 讓出一個 macrotask，react-query 真的有機會排程那一發 fetch——同步斷言是假守衛。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);

    rerender(<AiEditsDialog note={NOTE} open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(calls.map((c) => c.url)).toEqual([EDITS_URL]));
    expect(await screen.findByText(i18n.t("aiEdits.empty"))).toBeInTheDocument();
  });
});
