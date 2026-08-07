import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type BacklinkDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { BacklinksSection } from "./BacklinksSection";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

function mockFetch(backlinks: BacklinkDto[]) {
  return vi.fn(() =>
    Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks }) })),
  );
}

function renderSection(noteId: string | undefined) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BacklinksSection noteId={noteId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

const NOTE_ID = "11111111-1111-1111-1111-111111111111";

const BACKLINKS: BacklinkDto[] = [
  { id: "22222222-2222-2222-2222-222222222222", title: "Alpha", slug: "alpha" },
  { id: "33333333-3333-3333-3333-333333333333", title: "Beta", slug: null },
];

describe("BacklinksSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("0 篇 backlinks → 整塊不渲染（不留任何 DOM 節點）", async () => {
    vi.stubGlobal("fetch", mockFetch([]));

    const { container, queryClient } = renderSection(NOTE_ID);

    // 關鍵：等 query 真的 settle（success）才斷言空 DOM——只等 fetch 被呼叫會在
    // pending 狀態就通過斷言，測不出「拿到 0 篇後仍正確隱藏」，`backlinks.length === 0`
    // 這個判斷被拿掉也會綠（審查抓到的空砲）。
    await waitFor(() =>
      expect(queryClient.getQueryState(["backlinks", NOTE_ID])?.status).toBe("success"),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("noteId 尚未知道（筆記還沒載完）→ 不發請求、不渲染", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { container } = renderSection(undefined);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("N 篇 → 標題含篇數，逐條渲染標題文字與正確的 canonicalNotePath href", async () => {
    const fetchSpy = mockFetch(BACKLINKS);
    vi.stubGlobal("fetch", fetchSpy);

    renderSection(NOTE_ID);

    expect(await screen.findByText("2 notes mention this page")).toBeInTheDocument();

    // 端點路徑釘死：不只驗證有打 fetch，還驗證打的是這篇筆記的 backlinks 端點
    // （不是隨便一個 URL 都會通過）。
    expect(fetchSpy).toHaveBeenCalledWith(`/api/notes/${NOTE_ID}/backlinks`, expect.anything());

    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", canonicalNotePath(BACKLINKS[0]));
    expect(screen.getByRole("link", { name: "Beta" })).toHaveAttribute("href", canonicalNotePath(BACKLINKS[1]));

    // 字面值錨點：canonicalNotePath 本身的行為已有 shared/NoteList 測試覆蓋，這裡多釘
    // 一個字面值，避免 `canonicalNotePath` 未來改行為時這支測試悄悄跟著失去意義
    // （比照 NoteList.test.tsx 的同款斷言形狀）。
    expect(canonicalNotePath(BACKLINKS[0])).toBe("/notes/alpha");
  });

  it("單數（1 篇）走 i18next 的 _one 分支", async () => {
    vi.stubGlobal("fetch", mockFetch([BACKLINKS[0]]));

    renderSection(NOTE_ID);

    expect(await screen.findByText("1 note mentions this page")).toBeInTheDocument();
  });

  it("預設折疊，點擊摘要可展開/再次點擊收合", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    renderSection(NOTE_ID);
    const summary = await screen.findByText("2 notes mention this page");

    // 收合時內容仍在 DOM 裡（RTL 查得到），但 `<details>` 沒有 `open` → 不可見。
    expect(screen.getByRole("link", { name: "Alpha" })).not.toBeVisible();

    fireEvent.click(summary);
    expect(screen.getByRole("link", { name: "Alpha" })).toBeVisible();

    fireEvent.click(summary);
    expect(screen.getByRole("link", { name: "Alpha" })).not.toBeVisible();
  });
});
