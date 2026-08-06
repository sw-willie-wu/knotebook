import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { NoteList } from "./NoteList";

// 跟 App.test.tsx / guards.test.tsx 同一套約定：mock 全域 fetch，讓真正的
// useNotes()/useDeleteNote()（react-query）打到假回應，而不是 mock hook 本身——
// 這樣測到的是 NoteList 與 Task 10 hooks 真實串接後的行為。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

function renderNoteList(queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NoteList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 掛在 `/notes/:ref` 路由底下渲染——側欄的「目前開啟中」判斷讀的是路由參數。 */
function renderNoteListAtRef(ref: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/notes/${ref}`]}>
        <Routes>
          <Route path="/notes/:ref" element={<NoteList />} />
          <Route path="/" element={<div>home landing</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const OWNER_NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Has A Slug",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "custom-slug",
};

const SHARED_NOTE: NoteDto = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "No Slug Note",
  ownerId: "u9",
  role: "editor",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: null,
};

describe("NoteList", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state while /api/notes is pending", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    renderNoteList();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows an error message when /api/notes fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          fakeResponse({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
          }),
        ),
      ),
    );

    renderNoteList();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."),
    );
  });

  it("shows guidance to create the first note when there are none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }))),
    );

    renderNoteList();

    await waitFor(() => expect(screen.getByText("No notes yet.")).toBeInTheDocument());
  });

  it("links each note to its canonicalNotePath — slug wins, no-slug falls back to title-slug+id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE, SHARED_NOTE]) }),
        ),
      ),
    );

    renderNoteList();

    await waitFor(() => expect(screen.getByRole("link", { name: "Has A Slug" })).toBeInTheDocument());

    expect(screen.getByRole("link", { name: "Has A Slug" })).toHaveAttribute(
      "href",
      canonicalNotePath(OWNER_NOTE),
    );
    expect(canonicalNotePath(OWNER_NOTE)).toBe("/notes/custom-slug");

    expect(screen.getByRole("link", { name: "No Slug Note" })).toHaveAttribute(
      "href",
      canonicalNotePath(SHARED_NOTE),
    );
    expect(canonicalNotePath(SHARED_NOTE)).not.toBe(`/notes/${SHARED_NOTE.id}`);
  });

  it("shows a role badge only for shared (non-owner) notes, and a delete button only for owned notes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE, SHARED_NOTE]) }),
        ),
      ),
    );

    renderNoteList();

    await waitFor(() => expect(screen.getByRole("link", { name: "Has A Slug" })).toBeInTheDocument());

    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
  });

  // ── Task 12 review 指派給 Task 13 的兩項側欄待辦 ──────────────────────────

  it("marks the currently open note with aria-current=page (slug ref)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE, SHARED_NOTE]) })),
      ),
    );

    renderNoteListAtRef("custom-slug");

    await waitFor(() => expect(screen.getByRole("link", { name: "Has A Slug" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Has A Slug" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "No Slug Note" })).not.toHaveAttribute("aria-current");
  });

  it("marks the currently open note when the ref is the vanity-slug+uuid form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE, SHARED_NOTE]) })),
      ),
    );

    renderNoteListAtRef(canonicalNotePath(SHARED_NOTE).replace("/notes/", ""));

    await waitFor(() => expect(screen.getByRole("link", { name: "No Slug Note" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "No Slug Note" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Has A Slug" })).not.toHaveAttribute("aria-current");
  });

  it("navigates home after deleting the note that is currently open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE") return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE, SHARED_NOTE]) }),
        );
      }),
    );

    renderNoteListAtRef("custom-slug");

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // dialog 打開後 Radix 會把背景整片標成 aria-hidden，確認鈕只能從 dialog 內找。
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
  });

  it("stays put after deleting a note that is not the one currently open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "DELETE") return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE, SHARED_NOTE]) }),
        );
      }),
    );

    // 開著的是 SHARED_NOTE，刪的是 OWNER_NOTE（唯一有刪除鈕的那一篇）。
    renderNoteListAtRef(canonicalNotePath(SHARED_NOTE).replace("/notes/", ""));

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
  });
});
