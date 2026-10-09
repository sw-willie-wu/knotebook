import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import * as Y from "yjs";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { FakeReveal } from "@/test/fake-reveal";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { createExportEditor, renderDeck } from "@/present/render";
import PublicNotePage from "./PublicNotePage";

vi.mock("reveal.js", async () => ({ default: (await import("@/test/fake-reveal")).FakeReveal }));
vi.mock("@/lib/mermaid", () => ({ renderMermaid: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })) }));
vi.mock("@/components/PublicNoteEditor", () => ({ PublicNoteEditor: () => <div data-testid="public-note-editor" /> }));
vi.mock("@/present/render", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/present/render")>();
  return { ...mod, renderDeck: vi.fn(mod.renderDeck) };
});
const nav = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      return ((...args: Parameters<typeof real>) => {
        nav.fn(...args);
        return real(...args);
      }) as typeof real;
    },
  };
});

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

function ydocBase64(blocks: unknown[]): string {
  const doc = blocksToYDoc(createExportEditor(), blocks as never, YDOC_FRAGMENT);
  const bytes = Y.encodeStateAsUpdate(doc);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const V1 = [
  { id: "a", type: "heading", props: { level: 2 }, content: "A" },
  { id: "b", type: "heading", props: { level: 2 }, content: "B" },
];
const V2 = [
  { id: "a", type: "heading", props: { level: 2 }, content: "A" },
  { id: "n", type: "heading", props: { level: 2 }, content: "New before B" },
  { id: "b", type: "heading", props: { level: 2 }, content: "B" },
];

/** 回應可在測試中換；只回公開端點，其餘一律炸（匿名頁不得打需要登入的 API）。 */
const server = vi.hoisted(() => ({ status: 200, body: null as unknown, calls: [] as string[] }));
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      server.calls.push(`${method} ${url}`);
      if (method !== "GET" || url !== `/api/public/notes/${TOKEN}`) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve({
        ok: server.status === 200,
        status: server.status,
        // 每次回**新的**物件（structuredClone），等同真瀏覽器每次 JSON 解析——回同一個參照的話，關掉 structural sharing
        // 也看不出差別，S6 沒有鑑別力（r1-p3 M1 實跑 2×2 矩陣）
        json: () => Promise.resolve(server.status === 200 ? structuredClone(server.body) : { error: { code: server.status === 404 ? "not_found" : "internal", message: "x" } }),
      } as unknown as Response);
    }),
  );
}

function Probe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function renderPublic(entry: string) {
  window.history.replaceState(null, "", entry);
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Probe />
          <Routes>
            <Route path="/p/:token" element={<PublicNotePage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

const ready = async () => {
  await waitFor(() => expect(FakeReveal.instances.length).toBeGreaterThan(0));
  const deck = FakeReveal.instances.at(-1)!;
  await waitFor(() => expect(deck.listenerCount("slidechanged")).toBe(1)); // 已就緒（見 fake-reveal.ts）
  return deck;
};

describe("公開頁 × 簡報（spec §8、F1）", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    FakeReveal.reset();
    nav.fn.mockClear();
    vi.mocked(renderDeck).mockClear();
    server.status = 200;
    server.body = { title: "Public Note", ydoc: ydocBase64(V1) };
    server.calls = [];
    stubFetch();
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("頁首「簡報模式」按鈕 → push ?present（帶旗標）、requestFullscreen 早於導頁、外殼出現", async () => {
    fake = installFakeFullscreen();
    renderPublic(`/p/${TOKEN}`);
    fireEvent.click(await screen.findByRole("button", { name: "Present" }));
    expect(nav.fn).toHaveBeenCalledWith({ pathname: `/p/${TOKEN}`, search: "?present", hash: "" }, { state: { knotebookPresentPushed: true } });
    expect(fake.requestFullscreen.mock.invocationCallOrder[0]).toBeLessThan(nav.fn.mock.invocationCallOrder[0]);
    expect(await screen.findByRole("dialog", { name: "Public Note — presentation" })).toBeInTheDocument();
  });

  it("簡報中只打公開端點（不打 /api/auth/me、/api/notes）", async () => {
    renderPublic(`/p/${TOKEN}?present`);
    await ready();
    expect(new Set(server.calls)).toEqual(new Set([`GET /api/public/notes/${TOKEN}`]));
  });

  it("test 21：PublicPageFrame 根有 inert；外殼與 overlay 的祖先都沒有", async () => {
    renderPublic(`/p/${TOKEN}?present`);
    const deck = await ready();
    expect(screen.getByTestId("public-note-editor").closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    expect(deck.el.closest("[inert]")).toBeNull();
  });

  it("F1：重抓到內容不同的新 Y.Doc → 經防抖重切、停在同一張（b 的新索引）", async () => {
    const queryClient = renderPublic(`/p/${TOKEN}?present`);
    const deck = await ready();
    act(() => deck.slide(2, 0)); // b
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(`/p/${TOKEN}?present#/b`));
    const calls = vi.mocked(renderDeck).mock.calls.length;
    server.body = { title: "Public Note", ydoc: ydocBase64(V2) };
    await act(async () => queryClient.invalidateQueries());
    await waitFor(() => expect(vi.mocked(renderDeck).mock.calls.length).toBe(calls + 1), { timeout: 2500 });
    await waitFor(() => expect(deck.slide).toHaveBeenLastCalledWith(3, 0));
    expect(screen.getByTestId("loc").textContent).toBe(`/p/${TOKEN}?present#/b`);
  });

  it("S6：資料相同的重抓不重切（react-query structural sharing 讓 doc 不換）", async () => {
    const queryClient = renderPublic(`/p/${TOKEN}?present`);
    await ready();
    const calls = vi.mocked(renderDeck).mock.calls.length;
    await act(async () => queryClient.invalidateQueries());
    await waitFor(() => expect(server.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(vi.mocked(renderDeck).mock.calls.length).toBe(calls);
  });

  it("重抓 404 → 簡報層卸載、顯示失效卡、退出我們的全螢幕", async () => {
    fake = installFakeFullscreen();
    const queryClient = renderPublic(`/p/${TOKEN}?present`);
    await ready();
    const { enterPresentationFullscreen } = await import("@/present/fullscreen");
    enterPresentationFullscreen();
    await act(async () => fake!.grantEventFirst());
    server.status = 404;
    await act(async () => queryClient.invalidateQueries());
    expect(await screen.findByText("This link doesn't exist or is no longer active.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("重抓非 404 失敗 → 簡報層不動（續渲快照）", async () => {
    const queryClient = renderPublic(`/p/${TOKEN}?present`);
    const deck = await ready();
    server.status = 500;
    await act(async () => queryClient.invalidateQueries());
    await waitFor(() => expect(server.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(deck.destroy).not.toHaveBeenCalled();
  });
});
