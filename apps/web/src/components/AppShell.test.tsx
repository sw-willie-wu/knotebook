import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { canonicalNotePath, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppShell } from "./AppShell";

// Task 12 review 指派給 Task 13 的第三項待辦：`/notes/:ref` 這條路由存在之後，
// 「新增筆記 → 導向新筆記頁」這件事才驗得起來（在此之前所有連結都落在 catch-all）。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

const CREATED: NoteDto = {
  id: "33333333-3333-3333-3333-333333333333",
  title: "Untitled",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: null,
};

/** 停在 `/notes/:ref` 的替身頁——只把解析到的 ref 印出來，讓斷言看得到落點。 */
function NoteRouteProbe() {
  const { ref } = useParams<{ ref: string }>();
  return <div data-testid="note-route">{ref}</div>;
}

describe("AppShell — new note", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates to the created note's canonical path after POST /api/notes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(CREATED) }));
        }
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route path="/" element={<AppShell>home</AppShell>} />
              <Route path="/notes/:ref" element={<NoteRouteProbe />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    // 新筆記沒有自訂 slug、標題是 "Untitled" → canonical 是 `Untitled-<uuid>`。
    const expectedRef = canonicalNotePath(CREATED).replace("/notes/", "");
    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent(expectedRef));
  });

  it("shows an error toast and stays put when POST /api/notes fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 500,
              json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
            }),
          );
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route path="/" element={<AppShell>home</AppShell>} />
              <Route path="/notes/:ref" element={<NoteRouteProbe />} />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(screen.queryByTestId("note-route")).not.toBeInTheDocument();
  });
});

// PR2 wave 2 Review A（B1/B2）：Ctrl/Cmd+K 聚焦搜尋框、Esc 清空+blur、以及
// AppShell → NoteList 的 query 接線是否真的讓側欄清單縮減——這三件事目前
// 都無人守。兩篇 owner 筆記時「最近」跟「我的筆記」會重複顯示同一篇（見
// `NoteList` 檔頭），所以下面一律用 `getAllByRole`/`queryAllByRole` 而不是
// 單數版本，避免因重複命中而 throw。
describe("AppShell — search box & Ctrl/Cmd+K", () => {
  const ALPHA_NOTE: NoteDto = {
    id: "44444444-4444-4444-4444-444444444444",
    title: "Alpha Note",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "alpha-note",
  };

  const BETA_NOTE: NoteDto = {
    id: "55555555-5555-5555-5555-555555555555",
    title: "Beta Note",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2025-12-01T00:00:00.000Z",
    slug: "beta-note",
  };

  function stubFetchWithNotes(notes: NoteDto[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  function renderShell() {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <AppShell>home</AppShell>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Ctrl+K focuses the search box and prevents the browser's default (address-bar search)", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(input).not.toHaveFocus();

    // `fireEvent` 回傳 `dispatchEvent` 的結果：cancelable 事件被 `preventDefault()`
    // 攔下時回傳 `false`——藉此在不碰內部實作的前提下斷言 `defaultPrevented`。
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(input).toHaveFocus();
    expect(notCanceled).toBe(false);
  });

  it("Cmd+K (metaKey) also focuses the search box", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(input).toHaveFocus();
  });

  it("Ctrl+K is ignored while a [role=\"dialog\"] is open on the page — no focus, no preventDefault", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    // 不需要真的開一個 Radix Dialog——handler 只檢查 DOM 上有沒有這個選擇器。
    render(<div role="dialog">fake dialog</div>);

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(input).not.toHaveFocus();
    expect(notCanceled).toBe(true);
  });

  it("按鍵語意刻意釘死：Ctrl+Shift+K 不觸發（嚴格比對 event.key===\"k\"，Shift 讓瀏覽器回報大寫 \"K\"）", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const notCanceled = fireEvent.keyDown(window, { key: "K", ctrlKey: true, shiftKey: true });

    expect(input).not.toHaveFocus();
    expect(notCanceled).toBe(true);
  });

  it("Escape clears the search box and blurs it", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "Alpha" } });
    input.focus();
    expect(input).toHaveValue("Alpha");
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
  });

  it("real path: typing in the search box actually shrinks the sidebar note list (AppShell → NoteList query wiring)", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Beta Note" }).length).toBeGreaterThan(0));

    fireEvent.change(input, { target: { value: "Alpha" } });

    await waitFor(() => expect(screen.queryAllByRole("link", { name: "Beta Note" })).toHaveLength(0));
    expect(screen.getAllByRole("link", { name: "Alpha Note" }).length).toBeGreaterThan(0);
  });
});
