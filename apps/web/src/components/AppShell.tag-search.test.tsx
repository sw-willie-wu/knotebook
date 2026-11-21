import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { AppShell, SidebarDrawerButton } from "./AppShell";

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

describe("AppShell search box with tags", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("while the # list is open the text is searched as typed; picking a tag turns it into a token and drops the fragment from the search", async () => {
    stubLayoutTier("docked");
    renderShell();
    await screen.findByRole("tablist");
    // The list of notes has loaded once a tagged note row shows.
    await screen.findByText("Quarterly plan");
    const input = screen.getByRole("textbox", { name: "Search notes" });
    type(input, "#");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-search")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search notes" }), { key: "Enter" });
    const results = await screen.findByTestId("sidebar-search");
    await waitFor(() => expect(results).toHaveTextContent("My notes · Todo · 2 notes"));
    expect(within(results).getByRole("link", { name: /^Budget/ })).toBeInTheDocument();
    expect(within(results).queryByRole("link", { name: /^Quarterly plan/ })).toBeNull();
    // The clear button removes the token as well and the tab list returns.
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByRole("tablist");
    expect(screen.queryByRole("button", { name: /Remove tag filter/ })).toBeNull();
  });

  it("a # that matches no tag is searched as plain text", async () => {
    stubLayoutTier("docked");
    renderShell();
    await screen.findByText("Quarterly plan");
    type(screen.getByRole("textbox", { name: "Search notes" }), "#105");
    expect(await screen.findByTestId("sidebar-search")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(searchUrls.some((url) => new URL(url, "http://x").searchParams.get("q") === "#105")).toBe(true));
  });

  it("with the list open the body search runs on the typed # text; picking the tag re-runs it with the tag and without the fragment", async () => {
    stubLayoutTier("docked");
    renderShell();
    await screen.findByText("Quarterly plan");
    type(screen.getByRole("textbox", { name: "Search notes" }), "plan #wor");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    const params = (url: string) => new URL(url, "http://x").searchParams;
    await waitFor(() => expect(searchUrls.some((url) => params(url).get("q") === "plan #wor")).toBe(true));
    expect(searchUrls.some((url) => url.includes("%23wor"))).toBe(true);
    searchUrls.length = 0;
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search notes" }), { key: "Enter" });
    // The debounced text lags the box by a moment, so the last request is the one that has settled.
    await waitFor(() => {
      const last = params(searchUrls.at(-1) ?? "/api/search?");
      expect(last.get("tags")).toBe("t-work");
      expect(last.get("q")).toBe("plan");
    });
  });

  it("in the drawer, Esc with the # list open closes only the list and keeps the drawer open", async () => {
    stubLayoutTier("overlay");
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await within(drawer).findByText("Quarterly plan");
    type(within(drawer).getByRole("textbox", { name: "Search notes" }), "#");
    await within(drawer).findByRole("listbox");
    fireEvent.keyDown(within(drawer).getByRole("combobox", { name: "Search notes" }), { key: "Escape" });
    await waitFor(() => expect(within(drawer).queryByRole("listbox")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    const box = within(drawer).getByRole("combobox", { name: "Search notes" });
    expect(box).toHaveValue("#");
    expect(box).toHaveAttribute("aria-expanded", "false");
  });

  it("phone: the list belongs to the bottom search bar and the tokens show inside the bar", async () => {
    stubLayoutTier("phone");
    const { container } = renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Search notes" }));
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(container.querySelector("[data-phone-list-bar]")).not.toBeNull());
    type(input, "#W");
    const list = await screen.findByRole("listbox");
    const bar = container.querySelector<HTMLElement>("[data-phone-list-bar]")!;
    expect(bar).toContainElement(list);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search notes" }), { key: "Enter" });
    expect(await within(bar).findByRole("button", { name: "Remove tag filter Work" })).toBeInTheDocument();
    const phoneResults = await screen.findByTestId("sidebar-search");
    await waitFor(() => expect(phoneResults).toHaveTextContent("My notes · Work · 2 notes"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("tablist");
    expect(screen.queryByRole("button", { name: /Remove tag filter/ })).toBeNull();
  });
});
