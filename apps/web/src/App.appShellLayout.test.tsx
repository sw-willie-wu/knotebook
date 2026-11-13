import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarQueryProvider } from "@/lib/sidebar-query";
import { useAppShellInert } from "@/lib/app-shell-inert";
import { AppRoutes } from "./App";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * 側欄（AppShell）是 layout route：首頁 ↔ 筆記頁換路由時 `<aside>` 是同一個 DOM 節點，
 * 清單捲動位置、選取模式、NotePage chunk 載入中的側欄都不會被重掛丟掉。
 * NotePage 換成測試放行才 resolve 的 stub（它自己不含 AppShell）。
 */
const notePageGate = vi.hoisted(() => ({ pending: null as Promise<void> | null, release: () => {} }));
vi.mock("./pages/NotePage", async () => {
  if (notePageGate.pending) await notePageGate.pending;
  return {
    default: function NotePageStub() {
      const location = useLocation();
      // 與真 NotePage 一樣：簡報（?present）時把整個側欄標成 inert，離開時清掉。
      useAppShellInert(new URLSearchParams(location.search).has("present"));
      return <p>notepage-stub</p>;
    },
  };
});

const USER: UserDto = {
  id: "u1",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Wired Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "wired-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "alice",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="loc">{`${location.pathname}${location.search}`}</div>
      <button type="button" onClick={() => void navigate("/")}>
        go-home
      </button>
      <button type="button" onClick={() => void navigate("/n/alice/wired-note")}>
        go-note
      </button>
    </>
  );
}

function renderApp(initial: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initial]}>
          <ActiveNoteProvider>
            <SidebarQueryProvider>
              <AppRoutes />
              <LocationProbe />
            </SidebarQueryProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("App route tree：AppShell 是 layout route", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    notePageGate.pending = null;
    notePageGate.release = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/me") return Promise.resolve(json(USER));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
        if (url === "/api/notes") return Promise.resolve(json([NOTE]));
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    );
  });

  afterEach(() => {
    notePageGate.release();
    vi.unstubAllGlobals();
  });

  it("首頁點一篇筆記 → <aside> 是同一個節點（chunk 載入中也是）", async () => {
    notePageGate.pending = new Promise<void>((resolve) => {
      notePageGate.release = resolve;
    });
    renderApp("/");
    const asideBefore = await screen.findByRole("complementary");
    fireEvent.click(await within(asideBefore).findByRole("link", { name: /Wired Note/ }));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/n/alice/wired-note"));

    // chunk 還沒放行：fallback 在場，側欄沒有換掉
    expect(screen.getAllByText("Loading…").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("complementary")).toBe(asideBefore);

    notePageGate.release();
    expect(await screen.findByText("notepage-stub")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBe(asideBefore);
  });

  it("首頁 → 筆記頁：清單捲動位置與選取模式保留", async () => {
    renderApp("/");
    const aside = await screen.findByRole("complementary");
    const link = await within(aside).findByRole("link", { name: /Wired Note/ });

    // 側欄內第一個可捲動祖先（清單的捲動容器）
    let scroller: HTMLElement | null = link.parentElement;
    while (scroller !== null && !scroller.className.includes("overflow-y-auto")) scroller = scroller.parentElement;
    expect(scroller).not.toBeNull();
    scroller!.scrollTop = 37;

    fireEvent.click(within(aside).getAllByRole("button", { name: "Select" })[0]!);
    expect(await within(aside).findByRole("button", { name: "Done" })).toBeInTheDocument();

    // 選取模式中的列不是連結：用程式導覽
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/n/alice/wired-note"));
    expect(await screen.findByText("notepage-stub")).toBeInTheDocument();

    const asideAfter = screen.getByRole("complementary");
    expect(asideAfter).toBe(aside);
    expect(scroller!.scrollTop).toBe(37);
    expect(within(asideAfter).getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("簡報模式：整個 AppShell 在 inert 裡，離開簡報後清掉", async () => {
    renderApp("/n/alice/wired-note?present");
    const aside = await screen.findByRole("complementary");
    await screen.findByText("notepage-stub");
    expect(aside.closest("[inert]")).not.toBeNull();
  });

  it("沒有 ?present：AppShell 沒有 inert；簡報 → 一般模式清掉 inert", async () => {
    renderApp("/n/alice/wired-note?present");
    const aside = await screen.findByRole("complementary");
    await screen.findByText("notepage-stub");
    expect(aside.closest("[inert]")).not.toBeNull();

    // 同一個 NotePage 實例換成沒有 ?present：effect 依值重設
    const probeNote = within(aside).getByRole("link", { name: /Wired Note/ });
    fireEvent.click(probeNote);
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/n\/alice\/wired-note$/));
    await waitFor(() => expect(aside.closest("[inert]")).toBeNull());
  });

  it("離開筆記頁（回首頁）→ inert 一併清掉（卸載清除）", async () => {
    renderApp("/n/alice/wired-note?present");
    const aside = await screen.findByRole("complementary");
    await screen.findByText("notepage-stub");
    expect(aside.closest("[inert]")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "go-home" }));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent(/^\/$/));
    expect(screen.queryByText("notepage-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBe(aside);
    expect(aside.closest("[inert]")).toBeNull();
  });
});
