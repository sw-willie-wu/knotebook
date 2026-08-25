import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { NoteList } from "./NoteList";

// 跟 App.test.tsx / guards.test.tsx 同一套約定：mock 全域 fetch，讓真正的
// useNotes()（react-query）打到假回應，而不是 mock hook 本身——這樣測到的是
// NoteList 與 Task 10 hooks 真實串接後的行為。

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

function renderNoteList(query?: string, queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NoteList query={query} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 掛在 `/notes/:ref` 路由底下渲染——側欄的「目前開啟中」判斷讀的是路由參數。 */
function renderNoteListAtRef(ref: string, query?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/notes/${ref}`]}>
        <Routes>
          <Route path="/notes/:ref" element={<NoteList query={query} />} />
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

// 第三篇筆記，只用於「三分組/過濾/最近前 2」那幾案——server 已按
// updated_at DESC 排序，這裡故意排在 OWNER_NOTE/SHARED_NOTE 之後，驗證
// 「最近」只取原始清單的前 2 篇。
const THIRD_OWNER_NOTE: NoteDto = {
  id: "33333333-3333-3333-3333-333333333333",
  title: "Third Owner Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2025-12-01T00:00:00.000Z",
  slug: "third-owner-note",
};

function stubNotesFetch(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }))),
  );
}

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
    stubNotesFetch([]);

    renderNoteList();

    await waitFor(() => expect(screen.getByText("No notes yet.")).toBeInTheDocument());
  });

  it("links each note to its canonicalNotePath — slug wins, no-slug falls back to title-slug+id", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();

    // 只有 2 篇筆記時兩篇都落在「最近」，也各自落在自己的主清單——用
    // `within` 鎖定主清單那份，href 兩份應該一致（同一個 canonicalNotePath）。
    const myNotes = await screen.findByTestId("notegroup-myNotes");
    expect(within(myNotes).getByRole("link", { name: "Has A Slug" })).toHaveAttribute(
      "href",
      canonicalNotePath(OWNER_NOTE),
    );
    expect(canonicalNotePath(OWNER_NOTE)).toBe("/notes/custom-slug");

    const shared = screen.getByTestId("notegroup-shared");
    expect(within(shared).getByRole("link", { name: "No Slug Note" })).toHaveAttribute(
      "href",
      canonicalNotePath(SHARED_NOTE),
    );
    expect(canonicalNotePath(SHARED_NOTE)).not.toBe(`/notes/${SHARED_NOTE.id}`);
  });

  it("shows a role badge only for shared (non-owner) notes; no delete button anywhere (moved to the ⋮ menu)", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Has A Slug" }).length).toBeGreaterThan(0));

    // "Editor" 出現兩次（最近 + 與我共享），"Owner" 之類的 owner 徽章從不存在。
    expect(screen.getAllByText("Editor").length).toBeGreaterThan(0);
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  // ── Task 12 review 指派給 Task 13 的兩項側欄待辦 ──────────────────────────

  it("marks the currently open note with aria-current=page (slug ref) — only in the primary list, never in 最近", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteListAtRef("custom-slug");

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Has A Slug" }).length).toBeGreaterThan(0));

    const currentLinks = screen.getAllByRole("link", { current: "page" });
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]).toHaveAccessibleName("Has A Slug");
    expect(within(screen.getByTestId("notegroup-myNotes")).getByRole("link", { name: "Has A Slug" })).toBe(
      currentLinks[0],
    );

    for (const link of screen.getAllByRole("link", { name: "No Slug Note" })) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("marks the currently open note when the ref is the vanity-slug+uuid form — only in the primary list", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteListAtRef(canonicalNotePath(SHARED_NOTE).replace("/notes/", ""));

    await waitFor(() => expect(screen.getAllByRole("link", { name: "No Slug Note" }).length).toBeGreaterThan(0));

    const currentLinks = screen.getAllByRole("link", { current: "page" });
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]).toHaveAccessibleName("No Slug Note");
    expect(within(screen.getByTestId("notegroup-shared")).getByRole("link", { name: "No Slug Note" })).toBe(
      currentLinks[0],
    );

    for (const link of screen.getAllByRole("link", { name: "Has A Slug" })) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  // ── PR2：三分組、先分組後過濾、最近前 2、無符合 ──────────────────────────

  it("groups notes into recent (first 2, server order) / my notes (owner) / shared (editor|viewer)", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList();

    const recent = await screen.findByTestId("notegroup-recent");
    // 「最近」固定取原始清單前 2 篇——THIRD_OWNER_NOTE 排第三，不在最近裡。
    expect(within(recent).getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    expect(within(recent).getByRole("link", { name: "No Slug Note" })).toBeInTheDocument();
    expect(within(recent).queryByRole("link", { name: "Third Owner Note" })).not.toBeInTheDocument();

    const myNotes = screen.getByTestId("notegroup-myNotes");
    expect(within(myNotes).getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    expect(within(myNotes).getByRole("link", { name: "Third Owner Note" })).toBeInTheDocument();
    expect(within(myNotes).queryByRole("link", { name: "No Slug Note" })).not.toBeInTheDocument();

    const shared = screen.getByTestId("notegroup-shared");
    expect(within(shared).getByRole("link", { name: "No Slug Note" })).toBeInTheDocument();
    expect(within(shared).queryByRole("link", { name: "Has A Slug" })).not.toBeInTheDocument();

    // 結構性守衛：分組 label 文案要對、DOM 順序要對（最近 → 我的筆記 → 與我共享）。
    // 沒有這三行，label 塞錯組、打錯 i18n key、或順序對調，上面全部靠 testid 鎖定
    // 的斷言照樣綠——這是唯一擋得住這幾種錯的地方。
    expect(within(recent).getByText("Recent")).toBeInTheDocument();
    expect(within(myNotes).getByText("My notes")).toBeInTheDocument();
    expect(within(shared).getByText("Shared with me")).toBeInTheDocument();
    const groupOrder = Array.from(document.querySelectorAll('[data-testid^="notegroup-"]')).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(groupOrder).toEqual(["notegroup-recent", "notegroup-myNotes", "notegroup-shared"]);
  });

  it("filters within each already-formed group by title (先分組、後過濾) — 最近 shrinks accordingly", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList("third");

    const myNotes = await screen.findByTestId("notegroup-myNotes");
    expect(within(myNotes).getByRole("link", { name: "Third Owner Note" })).toBeInTheDocument();
    expect(within(myNotes).queryByRole("link", { name: "Has A Slug" })).not.toBeInTheDocument();

    // 「最近」的固定集合是前 2 篇（Has A Slug / No Slug Note），過濾成 "third"
    // 之後兩篇都不合 → 最近整組不渲染（不是空的 group，是整個 testid 都不存在）。
    expect(screen.queryByTestId("notegroup-recent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notegroup-shared")).not.toBeInTheDocument();
  });

  it("shows sidebar.noMatch when there are notes but none match the filter", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList("nonexistent-xyz");

    await waitFor(() => expect(screen.getByText("No notes match your search.")).toBeInTheDocument());
    expect(screen.queryByTestId("notegroup-recent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notegroup-myNotes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notegroup-shared")).not.toBeInTheDocument();
  });

  it("still shows the fully-empty EmptyState (not sidebar.noMatch) when there are zero notes at all, regardless of query", async () => {
    stubNotesFetch([]);

    renderNoteList("anything");

    await waitFor(() => expect(screen.getByText("No notes yet.")).toBeInTheDocument());
    expect(screen.queryByText("No notes match your search.")).not.toBeInTheDocument();
  });
});
