import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  // PR2 F 節：折疊的 <details>/<summary> 改成常駐 chips 列——不必點擊任何東西，
  // 篇數＞0 時 chips 從掛載那一刻就可見（取代上面被刪掉的「預設折疊/點擊展開收合」案）。
  it("PR2：chips 常駐可見，不需要點擊展開", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    renderSection(NOTE_ID);
    await screen.findByText("2 notes mention this page");

    expect(screen.getByRole("link", { name: "Alpha" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Beta" })).toBeVisible();
  });

  it("PR2：chips 沒有折疊語意——沒有 <details>/<summary> 節點", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    const { container } = renderSection(NOTE_ID);
    await screen.findByText("2 notes mention this page");

    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
  });

  // review B2：篇數多不得把內文卡撐高——這是這個元件唯一的高度守衛，直接斷 class
  // 字串本身（比照 layout test 的手法）：footer 根要 `shrink-0`（不被上方 flex-1
  // 的捲動容器吃掉高度）＋`border-t`（跟內文卡分隔）；chips 容器要
  // `max-h-48 overflow-y-auto`（篇數多時自己捲動，不會撐高整個 footer）。
  it("PR2：footer 根帶 shrink-0/border-t，chips 容器帶 max-h-48/overflow-y-auto（撐高守衛）", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    const { container } = renderSection(NOTE_ID);
    const title = await screen.findByText("2 notes mention this page");

    const footerRoot = container.firstElementChild;
    expect(footerRoot).not.toBeNull();
    expect(footerRoot).toBe(title.parentElement);
    expect(footerRoot).toHaveClass("shrink-0", "border-t", "border-border");

    const chipsContainer = screen.getByRole("link", { name: "Alpha" }).parentElement;
    expect(chipsContainer).not.toBeNull();
    expect(chipsContainer).toHaveClass("max-h-48", "overflow-y-auto");
  });
});
