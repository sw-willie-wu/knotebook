import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, NoteTagDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { stubLayoutTier } from "@/test/layout-tier";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { AppShell, SidebarDrawerButton } from "../AppShell";

// The controller chunk only resolves when the test opens the gate, which stands in for a slow network.
const gate = vi.hoisted(() => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
});

vi.mock("./TagSearchController", async () => {
  await gate.opened;
  return await vi.importActual<typeof import("./TagSearchController")>("./TagSearchController");
});


const USER = { id: "u1", email: "a@example.com", handle: "tester", displayName: "Ann", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null } satisfies UserDto;
const WORK: NoteTagDto = { id: "t-work", name: "Work", color: "green" };
const TODO: NoteTagDto = { id: "t-todo", name: "Todo", color: "red" };

function note(id: string, title: string, tags: NoteTagDto[]): NoteDto {
  return {
    id, title, ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", slug: id,
    slugIsCustom: false, prevSlug: null, ownerHandle: "tester", lastEdited: null, group: null, groupId: null, folderId: null,
    permissions: OWNER_PERMS, tags,
  };
}
const NOTES = [note("n1", "Quarterly plan", [WORK]), note("n2", "Budget", [WORK, TODO]), note("n3", "Groceries", [TODO]), note("n4", "Plain", [])];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const searchUrls: string[] = [];

function stubFetch() {
  searchUrls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(json(USER));
      if (url === "/api/groups" || url === "/api/favorites") return Promise.resolve(json([]));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes") return Promise.resolve(json(NOTES));
      if (url.startsWith("/api/search?")) {
        searchUrls.push(url);
        return Promise.resolve(json({ hits: [], nextCursor: null }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderShell() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveNoteProvider>
            <AppShell>
              <SidebarDrawerButton />
            </AppShell>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function type(input: HTMLElement, value: string) {
  input.focus();
  fireEvent.change(input, { target: { value } });
}

describe("search box while the completion chunk is still loading", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubFetch();
    stubLayoutTier("docked");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a # word is searched at once, Enter is left alone, and the list joins in when the chunk arrives", async () => {
    renderShell();
    await screen.findByText("Quarterly plan");
    const input = screen.getByRole("textbox", { name: "Search notes" });
    type(input, "#Wor");
    expect(await screen.findByTestId("sidebar-search")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    await waitFor(() => expect(searchUrls.some((url) => new URL(url, "http://x").searchParams.get("q") === "#Wor")).toBe(true));
    gate.open();
    expect(await screen.findByRole("option", { name: /Work/ })).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-search")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search notes" })).toHaveValue("#Wor");
  });
});
