import { createRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { CollabState } from "@/collab/connection";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NoteMenu, SidebarNoteMenu } from "./NoteMenu";
import { NoteWidthMenuItems } from "./NoteWidthMenuItems";
import { NoteWidthToggle } from "./NoteWidthToggle";
import { EDITOR_PERMS, OWNER_PERMS } from "@/test/fixtures";
import { useVersionsController, VersionsProvider } from "@/lib/versions-context";
import { PHONE_QUERY } from "@/lib/layout-tiers";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";
import { mockWidePointer } from "@/test/wide-pointer";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { personalNote } from "@/test/select-fixtures";
import { NoteList } from "./NoteList";
import { NoteTagRow } from "@/components/tags/NoteTagRow";
import { openTagEntry } from "@/components/tags/tag-entry";
import { pressTrigger } from "@/test/menu-trigger";
import { OutlineMenuContext, type OutlineMenuValue } from "@/components/outline/outline-menu-context";

// The more menu: copy link (any role) + move to trash (#181: no confirm, success toast + undo; since #175 it looks at `permissions.delete`),
// including the leavingRef timing: when a delete fails and the note is already in a terminal state, `NoteMenu` must provide the same-text, same-destination terminal exit itself -
// NotePage's terminal effect is gated by the `leavingRef.current=true` this handler set and never fires again (see the header of `NoteMenu.tsx`).
// DropdownMenuTrigger only listens to onPointerDown (Radix), so a plain `fireEvent.click` can't open it - same approach as SettingsModal.test.tsx opening UserMenu.

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const OWNER_NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const CONNECTED: CollabState = { phase: "connected", role: "owner" };

function openMenu(): void {
  pressTrigger(screen.getByRole("button", { name: "More" }));
}

// `onOpenEdits` (#138) is required on `NoteMenuProps`: a no-op default here, only passed by the case that observes it.
function renderMenu(
  note: NoteDto,
  state: CollabState,
  leavingRef: { current: boolean },
  fetchImpl?: typeof fetch,
  onOpenEdits: () => void = () => {},
) {
  vi.stubGlobal("fetch", fetchImpl ?? vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/notes/my-note"]}>
        <Routes>
          <Route
            path="/notes/:ref"
            element={<NoteMenu note={note} state={state} leavingRef={leavingRef} onOpenEdits={onOpenEdits} />}
          />
          <Route path="/" element={<div>home landing</div>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

/** Fake server for move to trash + undo: DELETE 204, restore returns `{ restored: [note] }`; `GET /api/notes` and `/api/groups` return empty. Every call is recorded in `calls`. */
function trashFetch(note: NoteDto, opts: { onDelete?: () => void } = {}) {
  const calls: string[] = [];
  const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    if (url === `/api/notes/${note.id}` && method === "DELETE") {
      opts.onDelete?.();
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    if (url === "/api/trash/restore" && method === "POST") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ restored: [note], skipped: [] }) }));
    }
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if ((url === "/api/notes" || url === "/api/groups") && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { fetchSpy, calls };
}

/** `NoteMenu` only renders under a note route and `/` is a page without it: navigating home = the menu unmounts (the Toaster is outside the router, as in App.tsx). */
function renderRoutedMenu(
  note: NoteDto,
  leavingRef: { current: boolean },
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const menu = <NoteMenu note={note} state={CONNECTED} leavingRef={leavingRef} onOpenEdits={() => {}} />;
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[canonicalNotePath(note)]}>
        <LocationProbe />
        <Routes>
          <Route path="/n/:handle/:slug" element={menu} />
          <Route path="/g/:groupId/:slug" element={menu} />
          <Route path="/" element={<div>home landing</div>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

function groupMenuNote(perms: { edit: boolean; delete: boolean }): NoteDto {
  const groupId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  return {
    ...OWNER_NOTE,
    ownerId: null,
    ownerHandle: null,
    role: perms.edit ? "editor" : "viewer",
    groupId,
    group: { id: groupId, name: "Workshop A" },
    permissions: { ...EDITOR_PERMS, ...perms },
  };
}

describe("NoteMenu (more menu)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("owner: the menu has copy link and 'Delete' (move to trash) (trash icon; not the old text 'Delete note')", () => {
    renderMenu(OWNER_NOTE, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    const trashItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(trashItem.querySelector("svg")).toHaveAttribute("data-icon", "trash");
    expect(screen.queryByText(/Delete note/)).toBeNull();
  });

  // #138: AI edit history item. The state lives in `NotePage` (shared by two triggers); the menu only closes itself and then notifies the parent -
  // the `onSelect` three-step shape is identical to the delete item's (see the focus trap note in the header of `NoteMenu.tsx`).
  // Always open the menu with `openMenu()` (`pressTrigger`: pointerdown then click): the Radix trigger opens on pointerdown,
  // the phone sheet shape opens on the click of the same press.
  it("more menu -> AI edit history: closes the menu and calls onOpenEdits", async () => {
    const onOpenEdits = vi.fn();
    renderMenu(OWNER_NOTE, CONNECTED, { current: false }, undefined, onOpenEdits);
    openMenu();

    fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("note.menu.aiEdits") }));
    expect(onOpenEdits).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  });

  it("non-owner (per-person share editor, permissions.delete false): only copy link, no delete item", () => {
    renderMenu({ ...OWNER_NOTE, role: "editor", permissions: EDITOR_PERMS }, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  });

  // #175: the delete item looks at `note.permissions.delete`, no longer derived from `role === "owner"`:
  // a group note's role is never owner, but a member whose role has `can_delete` must be able to delete.
  it("#175: group note (role editor, permissions.delete true) -> has the delete item", () => {
    const groupNote: NoteDto = {
      ...OWNER_NOTE,
      ownerId: null,
      ownerHandle: null,
      role: "editor",
      groupId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      group: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" },
      permissions: { ...EDITOR_PERMS, delete: true },
    };
    renderMenu(groupNote, { phase: "connected", role: "editor" }, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("#175: personal note with role owner but permissions.delete false (a deliberately inconsistent fixture) -> no delete item: what counts is permissions", () => {
    renderMenu({ ...OWNER_NOTE, permissions: { ...OWNER_PERMS, delete: false } }, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("#175: a group note's copy link is /g/<groupId>/<slug>", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const groupNote: NoteDto = {
      ...OWNER_NOTE,
      ownerId: null,
      ownerHandle: null,
      role: "viewer",
      groupId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      group: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" },
      permissions: { ...EDITOR_PERMS, edit: false },
    };
    renderMenu(groupNote, { phase: "connected", role: "viewer" }, { current: false });

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy link/ }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/g/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/my-note`),
    );
  });

  it("copy link succeeds -> 'copied' toast, then the menu closes", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderMenu(OWNER_NOTE, CONNECTED, { current: false });

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy link/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/n/tester/my-note`));
    await waitFor(() => expect(screen.getByText("Link copied to clipboard.")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("copy link fails both ways -> opens the manual copy Dialog (title reuses share.copyLink)", async () => {
    vi.stubGlobal("navigator", {}); // plain http: the whole clipboard API doesn't exist
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });

    renderMenu(OWNER_NOTE, CONNECTED, { current: false });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy link/ }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Copy link" })).toBeInTheDocument());
    const manual = screen.getByLabelText("Couldn't copy automatically — select the link below and copy it yourself.");
    expect(manual).toHaveValue(`${window.location.origin}/n/tester/my-note`);
    expect(manual).toHaveAttribute("readonly");

    Reflect.deleteProperty(document, "execCommand");
  });

  it("owner moves to trash: no confirm, sent on click (leavingRef is already true synchronously) -> back to / -> toast has Undo", async () => {
    const leavingRef = { current: false };
    // Two separately monotonic conditions inside `waitFor` (fetchSpy was called + leavingRef is now true) is a tautology: whether `leavingRef.current = true`
    // is placed before or after sending the request, both conditions eventually hold together, so the order can't be detected.
    // What has teeth: assert **synchronously** after clicking the menu item, and side-record the then-current `leavingRef.current`
    // **inside** the fetch spy's DELETE branch (the moment the request is really sent): if the implementation moved the assignment
    // after `await deleteNote.mutateAsync(...)`, both reads would be false and the test goes red.
    let leavingAtFetch: boolean | undefined;
    const { fetchSpy } = trashFetch(OWNER_NOTE, {
      onDelete: () => {
        leavingAtFetch = leavingRef.current;
      },
    });

    renderRoutedMenu(OWNER_NOTE, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    // No confirm: no dialog, sent on click.
    expect(leavingRef.current).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(`/api/notes/${OWNER_NOTE.id}`, expect.objectContaining({ method: "DELETE" })),
    );
    expect(leavingAtFetch).toBe(true);

    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/"));
    expect(leavingRef.current).toBe(true);
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("menu already unmounted (after going back to /) then pressing Undo: still restores and navigates back to that note", async () => {
    const { fetchSpy, calls } = trashFetch(OWNER_NOTE);
    renderRoutedMenu(OWNER_NOTE, { current: false }, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/"));
    // `/` doesn't render NoteMenu: the toast's Undo can only rely on the queryClient/navigate captured when the toast was created.
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(OWNER_NOTE)));
    expect(calls).toContain("POST /api/trash/restore");
  });

  it("group note with only delete permission (edit false): the success toast has no Undo and says who can restore", async () => {
    const note = groupMenuNote({ edit: false, delete: true });
    const { fetchSpy } = trashFetch(note);
    renderRoutedMenu(note, { current: false }, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Members of the group whose role can both edit and delete notes can restore it.", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("group note with edit + delete permission: the success toast has Undo", async () => {
    const note = groupMenuNote({ edit: true, delete: true });
    const { fetchSpy } = trashFetch(note);
    renderRoutedMenu(note, { current: false }, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("while DELETE hangs: repeated clicks, and reopening the menu and clicking 'Delete', don't resend (item disabled, DELETE exactly once)", async () => {
    const pending = new Promise<Response>(() => {});
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(input) === `/api/notes/${OWNER_NOTE.id}` && method === "DELETE") return pending;
      throw new Error(`unexpected fetch: ${method} ${String(input)}`);
    });
    const deleteCount = () =>
      fetchSpy.mock.calls.filter(
        ([input, init]) => String(input) === `/api/notes/${OWNER_NOTE.id}` && (init?.method ?? "GET").toUpperCase() === "DELETE",
      ).length;
    renderMenu(OWNER_NOTE, CONNECTED, { current: false }, fetchSpy as unknown as typeof fetch);
    openMenu();
    const first = screen.getByRole("menuitem", { name: "Delete" });
    fireEvent.click(first);
    fireEvent.click(first);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(deleteCount()).toBe(1));

    openMenu();
    const again = await screen.findByRole("menuitem", { name: "Delete" });
    expect(again).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(again);
    fireEvent.keyDown(again, { key: "Enter" });
    // A resend would reach fetch only a few microtasks later; wait one macrotask so it has a chance to land before counting.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(deleteCount()).toBe(1);
  });

  it("delete fails and not terminal -> leavingRef is set back to false, error toast shown, no navigation", async () => {
    const leavingRef = { current: false };
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(input) === `/api/notes/${OWNER_NOTE.id}` && method === "DELETE") {
        return Promise.resolve(
          fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${String(input)}`);
    });

    renderMenu(OWNER_NOTE, CONNECTED, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(leavingRef.current).toBe(false);
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
  });

  // When a delete fails but the note is already in a terminal state, NotePage's terminal effect is gated by the `leavingRef.current=true` this handler set
  // and never fires again - `NoteMenu` must provide the same exit itself (same text, same destination). This really distinguishes "toast + navigation"
  // from the old misjudgement "no duplicate toast, let the terminal flow take over" (that path is never reached).
  it("delete fails but already terminal (deleted) -> toast 'deleted' in place + back to / (NotePage's terminal effect won't fire again)", async () => {
    const leavingRef = { current: false };
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }),
      ),
    );

    renderMenu(OWNER_NOTE, { phase: "deleted" }, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("This note has been deleted.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    // leavingRef stays true: this branch is meant to leave, it isn't the "stay on the page" error branch.
    expect(leavingRef.current).toBe(true);
    // Not the "Something went wrong" error mapping of the non-terminal path: the text must match the terminal exit.
    expect(screen.queryByText("Something went wrong. Please try again.")).not.toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
  });

  it("delete fails but already terminal (kicked) -> toast 'lost access' in place + back to /", async () => {
    const leavingRef = { current: false };
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }),
      ),
    );

    renderMenu(OWNER_NOTE, { phase: "kicked" }, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("You no longer have access to this note.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(leavingRef.current).toBe(true);
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
  });

  // Covers a real race and pins that `stateRef.current` must be read, not the `state` in the closure. Timeline: when the confirm button is pressed the `state` prop is still
  // connected (and so is what the `handleConfirmDelete` closure captured) -> the DELETE request is sent but **deliberately left hanging** -> collaboration receives
  // close(NOTE_DELETED) and the parent re-renders the `state` prop as deleted -> only then does the DELETE fail. If the catch branch read the closure's `state`
  // (connected at call time) it would misjudge "non-terminal" and take the wrong branch (leavingRef set back to false + "Something went wrong"), whose text/behaviour
  // differs from the correct terminal exit (toast 'deleted' + navigation); the two can't be confused, so this case really distinguishes them.
  it("stateRef regression case: state=connected at click time, a terminal state arrives while DELETE hangs -> on failure it still takes the terminal exit", async () => {
    const leavingRef = { current: false };
    let rejectDelete!: (err: unknown) => void;
    const deletePromise = new Promise<Response>((_resolve, reject) => {
      rejectDelete = reject;
    });
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(input) === `/api/notes/${OWNER_NOTE.id}` && method === "DELETE") {
        return deletePromise; // deliberately hung until the test rejects it manually
      }
      throw new Error(`unexpected fetch: ${method} ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function tree(state: CollabState) {
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/notes/my-note"]}>
            <Routes>
              <Route
                path="/notes/:ref"
                element={
                  <NoteMenu note={OWNER_NOTE} state={state} leavingRef={leavingRef} onOpenEdits={() => {}} />
                }
              />
              <Route path="/" element={<div>home landing</div>} />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(tree(CONNECTED));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(`/api/notes/${OWNER_NOTE.id}`, expect.objectContaining({ method: "DELETE" })),
    );

    // DELETE is still in flight (deferred, not settled) - collaboration now receives close(NOTE_DELETED) and the state prop becomes deleted.
    rerender(tree({ phase: "deleted" }));

    rejectDelete(new Error("boom"));

    // Takes the terminal exit: destructive toast 'deleted' + navigation. If `stateRef.current` were changed back to `state`
    // (the closure reads connected from creation time) it would take the non-terminal branch - this case must go red.
    await waitFor(() => expect(screen.getByText("This note has been deleted.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(leavingRef.current).toBe(true);
    expect(screen.queryByText("Something went wrong. Please try again.")).not.toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
  });
});

// #175 more menu "Copy to my notes", merged into "Copy to... -> My notes" since #216.
// The two shells (header NoteMenu, sidebar SidebarNoteMenu) share NoteMenuCore; one case each guards visibility.

const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_NOTE: NoteDto = {
  ...OWNER_NOTE,
  ownerId: null,
  ownerHandle: null,
  role: "viewer",
  groupId: GROUP_ID,
  group: { id: GROUP_ID, name: "Workshop A" },
  // Read-only role: can't edit or delete, can still copy to My notes (visible implies readable).
  permissions: { ...EDITOR_PERMS, edit: false, delete: false },
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

function renderCopyMenu(
  shell: "header" | "sidebar",
  note: NoteDto,
  fetchImpl: typeof fetch = vi.fn(() => Promise.reject(new Error("unexpected fetch"))) as unknown as typeof fetch,
) {
  // #216: after mounting, the more menu reads `GET /api/groups` (to decide whether to show "move/copy to group"): return an empty list here (neither item appears),
  // so the assertions below on `fetchImpl` call counts / the first call look only at the copy itself. Group item tests are in share/GroupTransfer.test.tsx.
  const spy = fetchImpl;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/groups" ? Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })) : spy(input, init),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/start"]}>
        <LocationProbe />
        {shell === "header" ? (
          <NoteMenu note={note} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
        ) : (
          <SidebarNoteMenu note={note} />
        )}
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

function openAnyMenu(shell: "header" | "sidebar"): void {
  const name = shell === "header" ? "More" : `Note actions for ${OWNER_NOTE.title}`;
  pressTrigger(screen.getByRole("button", { name }));
}

describe("NoteMenu: copy to my notes is merged into 'Copy to... -> My notes' (#216)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["header", "sidebar"] as const)("group notes / personal notes: the menu has no standalone 'Copy to my notes' item, only 'Copy to...' (%s)", async (shell) => {
    renderCopyMenu(shell, GROUP_NOTE);
    openAnyMenu(shell);
    expect(await screen.findByTestId("note-menu-copy-to")).toHaveTextContent("Copy to…");
    expect(screen.queryByRole("menuitem", { name: "Copy to my notes" })).not.toBeInTheDocument();
    cleanup();

    renderCopyMenu(shell, OWNER_NOTE);
    openAnyMenu(shell);
    expect(await screen.findByTestId("note-menu-copy-to")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy to my notes" })).not.toBeInTheDocument();
  });

  it("group note (with delete permission): Delete is still in the menu", async () => {
    renderCopyMenu("header", { ...GROUP_NOTE, role: "editor", permissions: { ...EDITOR_PERMS, edit: true, delete: true } });
    openAnyMenu("header");
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });
});

describe("NoteMenu - add tag", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the header menu shows Add tag after Copy link when onAddTag is given; without it, and in the sidebar row menu, never", async () => {
    const addTag = vi.fn();
    vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(String(input) === "/api/groups" ? [] : String(input) === "/api/folders" ? FOLDER_LIST_EMPTY : [OWNER_NOTE]) })),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (onAddTag?: () => void) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/start"]}>
          <NoteMenu note={OWNER_NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} onAddTag={onAddTag} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { unmount } = render(ui(addTag));
    openMenu();
    const names = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(names.indexOf("Add tag")).toBe(names.findIndex((name) => /Copy link/.test(name ?? "")) + 1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Add tag" }));
    expect(addTag).toHaveBeenCalledOnce();
    unmount();

    render(ui(undefined));
    openMenu();
    await screen.findByRole("menuitem", { name: /Copy link/ });
    expect(screen.queryByRole("menuitem", { name: "Add tag" })).toBeNull();
    cleanup();

    renderCopyMenu("sidebar", OWNER_NOTE);
    openAnyMenu("sidebar");
    await screen.findByRole("menuitem", { name: /Copy link/ });
    expect(screen.queryByRole("menuitem", { name: "Add tag" })).toBeNull();
  });

  it("choosing Add tag focuses the tag input within the same event and focus doesn't return to the more button", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(String(input) === "/api/notes" ? [{ ...OWNER_NOTE, tags: [] }] : String(input) === "/api/folders" ? FOLDER_LIST_EMPTY : []) })),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/start"]}>
          <NoteMenu note={OWNER_NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} onAddTag={() => openTagEntry(OWNER_NOTE.id)} />
          <NoteTagRow note={OWNER_NOTE} canEdit />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(async () => {});
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add tag" }));
    // Synchronously after the select event: iOS shows the keyboard only for focus given inside the gesture.
    const input = screen.getByRole("combobox", { name: "Tag name" });
    expect(document.activeElement).toBe(input);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Tag name" }));
  });
});

describe("NoteMenu - version history", () => {
  function VersionsHost({ enabled, children }: { enabled: boolean; children: ReactNode }) {
    const value = useVersionsController({ noteId: OWNER_NOTE.id, enabled });
    return (
      <VersionsProvider value={value}>
        <span data-testid="v-state">{JSON.stringify({ mode: value.mode, dialog: value.dialog?.kind ?? null })}</span>
        {children}
      </VersionsProvider>
    );
  }

  /** provider: "enabled" | "disabled" | "none" (none = the situation of each sidebar row's more menu: no VersionsProvider). */
  function renderVersionsMenu(provider: "enabled" | "disabled" | "none") {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const menu = <NoteMenu note={OWNER_NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />;
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/notes/my-note"]}>
          {provider === "none" ? menu : <VersionsHost enabled={provider === "enabled"}>{menu}</VersionsHost>}
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  async function openVersionsMenu(): Promise<HTMLElement> {
    pressTrigger(screen.getByRole("button", { name: "More" }));
    return screen.findByRole("menu");
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Controllable layout tier (`test/layout-tier.ts`): `installMatchMedia(true)` is phone (< 640); the returned handle can switch to any tier (notifying the flipped queries). */
  let liveListeners = (): number => 0;
  function installMatchMedia(phone: boolean, tier: LayoutTier = phone ? "phone" : "docked"): (next: boolean | LayoutTier) => void {
    const handle = stubLayoutTier(tier);
    liveListeners = () => handle.listenerCount(PHONE_QUERY);
    return (next) => {
      const target: LayoutTier = typeof next === "boolean" ? (next ? "phone" : "docked") : next;
      act(() => handle.setLayoutTier(target));
    };
  }

  it("phone (no history bubble): canEdit -> 'Version history' above 'AI edit history'; no 'Save current version'", async () => {
    installMatchMedia(true);
    renderVersionsMenu("enabled");
    const menu = await openVersionsMenu();
    const names = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    const iv = names.indexOf("Version history");
    expect(iv).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("AI edit history")).toBe(iv + 1);
    expect(names).not.toContain("Save current version");
  });

  it.each([["fixed (>= 1280)", "docked"], ["floating (640-1279)", "overlay"]] as const)("%s (has the history bubble): no 'Version history' and no 'Save current version'", async (_label, tier) => {
    installMatchMedia(false, tier);
    renderVersionsMenu("enabled");
    const menu = await openVersionsMenu();
    expect(within(menu).getByRole("menuitem", { name: "AI edit history" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Version history" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Save current version" })).not.toBeInTheDocument();
  });

  // The stand-in only flips the layout tier (`WIDE_POINTER_QUERY` never matches): it describes a touch device (the wide criterion doesn't flip) crossing widths.
  // The phone more menu is a sheet: crossing 640 while open closes the whole menu (`phoneSheet` of `DropdownMenu`); reopened, the items follow the new width.
  it("window crosses a breakpoint: crossing 640 with the menu open -> the menu closes; reopened on the wide side there's no 'Version history', back on narrow it's there again", async () => {
    const setNarrow = installMatchMedia(true);
    renderVersionsMenu("enabled");
    const menu = await openVersionsMenu();
    expect(within(menu).getByRole("menuitem", { name: "Version history" })).toBeInTheDocument();
    setNarrow(false);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const wide = await openVersionsMenu();
    expect(within(wide).queryByRole("menuitem", { name: "Version history" })).not.toBeInTheDocument();
    setNarrow(true);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const narrow = await openVersionsMenu();
    expect(within(narrow).getByRole("menuitem", { name: "Version history" })).toBeInTheDocument();
  });

  it("after unmount the change listener is removed (no subscription left)", async () => {
    installMatchMedia(true);
    const { unmount } = renderVersionsMenu("enabled");
    await openVersionsMenu();
    expect(liveListeners()).toBeGreaterThan(0);
    unmount();
    expect(liveListeners()).toBe(0);
  });

  it("narrow: clicking 'Version history' -> open()", async () => {
    installMatchMedia(true);
    renderVersionsMenu("enabled");
    fireEvent.click(within(await openVersionsMenu()).getByRole("menuitem", { name: "Version history" }));
    expect(JSON.parse(screen.getByTestId("v-state").textContent!).mode).not.toBeNull();
  });

  it("triggerRef (NotePage hands it to the version history page as a focus fallback) points at the header more menu trigger itself", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/notes/my-note"]}>
          <NoteMenu note={OWNER_NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} triggerRef={triggerRef} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(triggerRef.current).not.toBeNull();
    expect(triggerRef.current).toBe(screen.getByRole("button", { name: "More" }));
  });

  it.each([["disabled (viewer)"], ["none (sidebar row menus, outside the provider)"]] as const)("%s -> not rendered at narrow width either", async (label) => {
    installMatchMedia(true);
    renderVersionsMenu(label.startsWith("disabled") ? "disabled" : "none");
    const menu = await openVersionsMenu();
    expect(within(menu).getByRole("menuitem", { name: "AI edit history" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Version history" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Save current version" })).not.toBeInTheDocument();
  });
});

describe("NoteMenu - heading outline (#465)", () => {
  function renderOutlineMenu(opts: { shell?: "header" | "sidebar"; value?: OutlineMenuValue | null }) {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const menu =
      opts.shell === "sidebar" ? (
        <SidebarNoteMenu note={OWNER_NOTE} />
      ) : (
        <NoteMenu note={OWNER_NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
      );
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/notes/my-note"]}>
          {opts.value ? <OutlineMenuContext.Provider value={opts.value}>{menu}</OutlineMenuContext.Provider> : menu}
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  async function openOutlineMenu(trigger = "More"): Promise<HTMLElement> {
    pressTrigger(screen.getByRole("button", { name: trigger }));
    return screen.findByRole("menu");
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("phone, the note has headings: the header more menu has 'Heading outline' right after 'Present'; choosing it -> menu closes, open called once", async () => {
    stubLayoutTier("phone");
    const open = vi.fn();
    renderOutlineMenu({ value: { available: true, open } });
    const menu = await openOutlineMenu();
    const names = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    const ip = names.indexOf("Present");
    expect(ip).toBeGreaterThanOrEqual(0);
    expect(names[ip + 1]).toBe("Heading outline");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Heading outline" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
    // The sheet has no trigger button: on close focus is handed back to the more menu trigger.
    expect(open).toHaveBeenCalledWith(screen.getByRole("button", { name: "More" }));
  });

  it("phone, the note has no headings (available=false) -> none", async () => {
    stubLayoutTier("phone");
    renderOutlineMenu({ value: { available: false, open: vi.fn() } });
    const menu = await openOutlineMenu();
    expect(within(menu).getByRole("menuitem", { name: "Present" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Heading outline" })).not.toBeInTheDocument();
  });

  it("640-767: the outline is already the phone shape -> the more menu has 'Heading outline'", async () => {
    stubLayoutTier("compact");
    renderOutlineMenu({ value: { available: true, open: vi.fn() } });
    const menu = await openOutlineMenu();
    expect(within(menu).getByRole("menuitem", { name: "Heading outline" })).toBeInTheDocument();
  });

  it.each([["fixed (>= 1280)", "docked"], ["floating (>= 768)", "overlay"]] as const)("%s (with the right-side thin line) -> none", async (_label, tier) => {
    stubLayoutTier(tier);
    renderOutlineMenu({ value: { available: true, open: vi.fn() } });
    const menu = await openOutlineMenu();
    expect(within(menu).getByRole("menuitem", { name: "Present" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Heading outline" })).not.toBeInTheDocument();
  });

  it.each([["outside the provider (the real situation)", false], ["even inside the provider", true]] as const)("sidebar row more menu, %s -> none on phone either", async (_label, inside) => {
    stubLayoutTier("phone");
    renderOutlineMenu({ shell: "sidebar", value: inside ? { available: true, open: vi.fn() } : null });
    const menu = await openOutlineMenu(`Note actions for ${OWNER_NOTE.title}`);
    expect(within(menu).getByRole("menuitem", { name: "Present" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Heading outline" })).not.toBeInTheDocument();
  });
});

// The header and sidebar more menus share NoteMenuCore's level-by-level submenus; a same-space move of the open note doesn't leave it.
describe("NoteMenu - level-by-level submenus", () => {
  const A = folderDto({ id: "A", name: "A" });
  const A1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
  const B = folderDto({ id: "B", name: "B" });

  /** Empty groups, folder A containing A1, and B; `PUT /api/notes/:id/folder` returns the prepared note. Every call goes into `calls`. */
  function folderFetch(note: NoteDto) {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as { folderId: string | null });
      calls.push({ method, url, body });
      const json = (value: unknown) => Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(value) }));
      if (method === "GET" && url === "/api/groups") return json([]);
      if (method === "GET" && url === "/api/folders") return json({ folders: [A, A1, B] });
      if (method === "PUT" && url === `/api/notes/${note.id}/folder`) return json({ ...note, folderId: body?.folderId ?? null });
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    return { fetchSpy, calls };
  }

  /** Wide form (stacked): open the Move to... submenu (first level) with the keyboard, and wait for "A" (SubTrigger, without ", open") to appear. */
  async function openMoveCascade(): Promise<HTMLElement> {
    const trigger = await screen.findByTestId("note-menu-move-to");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const sub = await screen.findByRole("menu", { name: "Move to…" });
    await within(sub).findByRole("menuitem", { name: "A" });
    return sub;
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    cleanup();
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  // Wide form = stacks to the side (Radix nested submenus), narrow form (jsdom default) = expands in place level by level; the header and sidebar more menus share the same set.
  it.each([
    ["header", "wide"],
    ["sidebar", "wide"],
    ["header", "narrow"],
    ["sidebar", "narrow"],
  ] as const)("%s more menu (%s): wide form stacks (open A -> Move here, A1, no Back); narrow form expands in place level by level (click 'A, open' -> Back, Move here)", async (shell, form) => {
    mockWidePointer(form === "wide");
    const { fetchSpy } = folderFetch(OWNER_NOTE);
    renderCopyMenu(shell, OWNER_NOTE, fetchSpy as unknown as typeof fetch);
    openAnyMenu(shell);
    if (form === "wide") {
      const sub = await openMoveCascade();
      const a = within(sub).getByRole("menuitem", { name: "A" });
      expect(a).toHaveAttribute("aria-haspopup", "menu");
      a.focus();
      fireEvent.keyDown(a, { key: "ArrowRight" });
      const level = await screen.findByRole("menu", { name: "A" });
      await waitFor(() => expect(within(level).getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Move here", "A1"]));
      expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();
    } else {
      const trigger = await screen.findByTestId("note-menu-move-to");
      expect(trigger).not.toHaveAttribute("aria-haspopup");
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole("menuitem", { name: "A, open" }));
      expect(await screen.findByRole("menuitem", { name: "Back" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Move here" })).toBeInTheDocument();
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    }
  });

  it("in-place expansion at the second level crosses the criterion (narrow -> wide) -> the menu closes; back to narrow and reopening: Move to... is collapsed, expanding gives the first level (groupExpanded/paths were reset)", async () => {
    const mq = mockWidePointer(false);
    const { fetchSpy } = folderFetch(OWNER_NOTE);
    renderCopyMenu("header", OWNER_NOTE, fetchSpy as unknown as typeof fetch);
    openAnyMenu("header");
    fireEvent.click(await screen.findByTestId("note-menu-move-to"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "A, open" }));
    await screen.findByRole("menuitem", { name: "Back" });
    act(() => mq.setWide(true));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    act(() => mq.setWide(false));
    openAnyMenu("header");
    const trigger = await screen.findByTestId("note-menu-move-to");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Move to…" })).toBeNull();
    fireEvent.click(trigger);
    const group = screen.getByRole("group", { name: "Move to…" });
    expect(within(group).getAllByRole("menuitem").map((el) => el.getAttribute("aria-label") ?? el.textContent)).toEqual(["A, open", "B"]);
  });

  it("same-space move of the open note -> one PUT, toast, no leavingRef set, no navigation", async () => {
    mockWidePointer(true);
    const leavingRef = { current: false };
    const { fetchSpy, calls } = folderFetch(OWNER_NOTE);
    renderRoutedMenu(OWNER_NOTE, leavingRef, fetchSpy);
    openMenu();
    const sub = await openMoveCascade();
    fireEvent.click(within(sub).getByRole("menuitem", { name: "B" }));
    expect(await screen.findByText("Moved to “B”")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { method: "PUT", url: `/api/notes/${OWNER_NOTE.id}/folder`, body: { folderId: "B" } },
    ]);
    expect(leavingRef.current).toBe(false);
    expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(OWNER_NOTE));
    expect(screen.queryByText("home landing")).toBeNull();
  });

  // Phone (< 640): the more menu is a bottom-attached sheet; "Move to..." replaces the whole sheet content with a back row at the top. The header and sidebar more menus share the same set.
  const sheetRows = (): string[] =>
    within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");

  it.each(["header", "sidebar"] as const)("phone %s more menu: sheet, the note title at top, rows 48px; from 640 up it's still a small menu", async (shell) => {
    stubLayoutTier("phone");
    const { fetchSpy } = folderFetch(OWNER_NOTE);
    renderCopyMenu(shell, OWNER_NOTE, fetchSpy as unknown as typeof fetch);
    openAnyMenu(shell);
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-menu-sheet");
    expect(menu).toHaveClass("kb-menu-sheet", "w-full", "rounded-t-xl");
    expect(menu.firstElementChild).toHaveTextContent(OWNER_NOTE.title);
    await within(menu).findByTestId("note-menu-move-to");
    for (const item of within(menu).getAllByRole("menuitem")) expect(item).toHaveClass("min-h-12", "text-base");
    cleanup();
    vi.unstubAllGlobals();

    stubLayoutTier("overlay");
    renderCopyMenu(shell, OWNER_NOTE, folderFetch(OWNER_NOTE).fetchSpy as unknown as typeof fetch);
    openAnyMenu(shell);
    const popover = await screen.findByRole("menu");
    expect(popover).not.toHaveAttribute("data-menu-sheet");
    expect(within(popover).queryByText(OWNER_NOTE.title)).toBeNull();
    const trigger = await screen.findByTestId("note-menu-move-to");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(popover).getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
  });

  it.each(["header", "sidebar"] as const)("phone %s more menu: Move to... replaces the whole content (the back row is at the top and gets focus, title changes to Move to...); level by level in and out; back from the first level returns to the main menu, focus returns to Move to...", async (shell) => {
    stubLayoutTier("phone");
    const { fetchSpy } = folderFetch(OWNER_NOTE);
    renderCopyMenu(shell, OWNER_NOTE, fetchSpy as unknown as typeof fetch);
    openAnyMenu(shell);
    fireEvent.click(await screen.findByTestId("note-menu-move-to"));
    await waitFor(() => expect(sheetRows()).toEqual(["Back", "A, open", "B"]));
    const menu = screen.getByRole("menu");
    expect(menu.firstElementChild).toHaveTextContent("Move to…");
    expect(within(menu).queryByText(OWNER_NOTE.title)).toBeNull();
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Back" }));
    expect(screen.queryByTestId("note-menu-move-to")).toBeNull();
    expect(screen.queryByTestId("note-menu-copy-to")).toBeNull();
    expect(within(menu).getByRole("group", { name: "Move to…" })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "A, open" }));
    await waitFor(() => expect(sheetRows()).toEqual(["Back", "Move here", "A1"]));
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Back" }));

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Back" }));
    await waitFor(() => expect(sheetRows()).toEqual(["Back", "A, open", "B"]));

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Back" }));
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument());
    expect(sheetRows()).not.toContain("Back");
    expect(menu.firstElementChild).toHaveTextContent(OWNER_NOTE.title);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("note-menu-move-to")));
  });

  it("phone: Esc inside a submenu first returns to the main menu (menu doesn't close), a second Esc closes it and focus returns to the more menu; ArrowLeft also goes back", async () => {
    stubLayoutTier("phone");
    const { fetchSpy } = folderFetch(OWNER_NOTE);
    renderCopyMenu("header", OWNER_NOTE, fetchSpy as unknown as typeof fetch);
    openAnyMenu("header");
    fireEvent.click(await screen.findByTestId("note-menu-move-to"));
    await waitFor(() => expect(sheetRows()).toEqual(["Back", "A, open", "B"]));
    const a = screen.getByRole("menuitem", { name: "A, open" });
    fireEvent.keyDown(a, { key: "ArrowRight" });
    await waitFor(() => expect(sheetRows()).toEqual(["Back", "Move here", "A1"]));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "A1" }), { key: "ArrowLeft" });
    await waitFor(() => expect(sheetRows()).toEqual(["Back", "A, open", "B"]));

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More" }));
  });

  it("phone: choosing a destination in a submenu -> menu closes, same-space move is sent as usual; reopening shows the main menu", async () => {
    stubLayoutTier("phone");
    const { fetchSpy, calls } = folderFetch(OWNER_NOTE);
    renderCopyMenu("header", OWNER_NOTE, fetchSpy as unknown as typeof fetch);
    openAnyMenu("header");
    fireEvent.click(await screen.findByTestId("note-menu-move-to"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "B" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    openAnyMenu("header");
    expect(await screen.findByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();
  });
});


describe("NoteMenu - favorites", () => {
  const FAV_NOTE = OWNER_NOTE;
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const hang = () => new Promise<Response>(() => {});

  interface FavServer {
    favorites: string[];
    /** How to respond; "pending" = hang without replying. */
    get: "ok" | "pending";
    put: "ok" | "pending" | 404;
    del: "ok" | "pending" | 429;
    calls: string[];
  }

  function stubFavServer(init: Partial<Omit<FavServer, "calls">> = {}): FavServer {
    const server: FavServer = { favorites: [], get: "ok", put: "ok", del: "ok", calls: [], ...init };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
        const url = String(input);
        const method = (request?.method ?? "GET").toUpperCase();
        server.calls.push(`${method} ${url}`);
        if (url === "/api/favorites" && method === "GET") {
          if (server.get === "pending") return hang();
          return Promise.resolve(jsonResponse(server.favorites.map((noteId) => ({ noteId, favoritedAt: "2026-03-01T00:00:00.000Z" }))));
        }
        const target = /^\/api\/favorites\/(.+)$/.exec(url)?.[1];
        if (target !== undefined && method === "PUT") {
          if (server.put === "pending") return hang();
          if (server.put === 404) return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404));
          server.favorites = [target, ...server.favorites];
          return Promise.resolve(jsonResponse({ noteId: target, favoritedAt: "2026-03-02T00:00:00.000Z" }));
        }
        if (target !== undefined && method === "DELETE") {
          if (server.del === "pending") return hang();
          if (server.del === 429) return Promise.resolve(jsonResponse({ error: { code: "too_many_requests", message: "slow" } }, 429));
          server.favorites = server.favorites.filter((id) => id !== target);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url === "/api/groups" || url === "/api/notes") return Promise.resolve(jsonResponse([]));
        if (url === "/api/folders") return Promise.resolve(jsonResponse({ folders: [] }));
        return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404));
      }),
    );
    return server;
  }

  const count = (server: FavServer, call: string) => server.calls.filter((c) => c === call).length;

  function renderShell(shell: "header" | "sidebar", note: NoteDto = FAV_NOTE) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/start"]}>
          {shell === "header" ? (
            <NoteMenu note={note} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
          ) : (
            <SidebarNoteMenu note={note} />
          )}
        </MemoryRouter>
        <Toaster />
      </QueryClientProvider>,
    );
    return { queryClient };
  }

  const triggerName = (shell: "header" | "sidebar") => (shell === "header" ? "More" : `Note actions for ${FAV_NOTE.title}`);
  const openShellMenu = (shell: "header" | "sidebar") => pressTrigger(screen.getByRole("button", { name: triggerName(shell) }));
  const favItem = (name: "Add to favorites" | "Remove from favorites") => screen.findByRole("menuitem", { name });
  const ready = (item: HTMLElement) => waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["header", "sidebar"] as const)("%s shell: the favorites item is first, copy link is second", async (shell) => {
    stubFavServer();
    renderShell(shell);
    openShellMenu(shell);
    await favItem("Add to favorites");
    expect(screen.getAllByRole("menuitem")[0]).toHaveTextContent("Add to favorites");
    expect(screen.getAllByRole("menuitem")[1]).toHaveTextContent("Copy link");
  });

  it("not in favorites: hollow star + 'Add to favorites'", async () => {
    stubFavServer({ favorites: [] });
    renderShell("header");
    openShellMenu("header");
    const add = await favItem("Add to favorites");
    await ready(add);
    expect(add.querySelector("svg")).toHaveAttribute("data-icon", "star");
    expect(add.querySelector("svg")).toHaveAttribute("fill", "none");
  });

  it("in favorites: filled star + 'Remove from favorites'", async () => {
    stubFavServer({ favorites: [FAV_NOTE.id] });
    renderShell("header");
    openShellMenu("header");
    const remove = await favItem("Remove from favorites");
    await ready(remove);
    expect(remove.querySelector("svg")).toHaveAttribute("data-icon", "star");
    expect(remove.querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });

  it("list not arrived -> disabled, shows 'Add to favorites'", async () => {
    stubFavServer({ get: "pending" });
    renderShell("header");
    openShellMenu("header");
    expect(await favItem("Add to favorites")).toHaveAttribute("aria-disabled", "true");
  });

  it.each(["header", "sidebar"] as const)("%s shell: opening the menu with the keyboard before the list arrives, focus is on the first item and Enter sends no request; choosing after the list arrives does send", async (shell) => {
    const server = stubFavServer({ get: "pending" });
    const { queryClient } = renderShell(shell);
    fireEvent.keyDown(screen.getByRole("button", { name: triggerName(shell) }), { key: "Enter" });
    const add = await favItem("Add to favorites");
    expect(add).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(add).toHaveFocus());
    fireEvent.keyDown(add, { key: "Enter" });
    await act(async () => {});
    expect(count(server, `PUT /api/favorites/${FAV_NOTE.id}`)).toBe(0);
    expect(screen.getAllByRole("menuitem")[0]).toBe(add);

    act(() => queryClient.setQueryData(["favorites"], []));
    await ready(add);
    expect(add).toHaveFocus();
    fireEvent.click(add);
    await waitFor(() => expect(count(server, `PUT /api/favorites/${FAV_NOTE.id}`)).toBe(1));
  });

  it("pressing 'Add' -> PUT /api/favorites/<id>, 'Added to favorites' appears", async () => {
    const server = stubFavServer();
    renderShell("sidebar");
    openShellMenu("sidebar");
    const add = await favItem("Add to favorites");
    await ready(add);
    fireEvent.click(add);
    expect(await screen.findByText("Added to favorites")).toBeInTheDocument();
    expect(count(server, `PUT /api/favorites/${FAV_NOTE.id}`)).toBe(1);
  });

  it("add fails -> error toast, no success toast", async () => {
    stubFavServer({ put: 404 });
    renderShell("header");
    openShellMenu("header");
    const add = await favItem("Add to favorites");
    await ready(add);
    fireEvent.click(add);
    expect(await screen.findByText(i18n.t("errors.not_found"))).toBeInTheDocument();
    expect(screen.queryByText("Added to favorites")).toBeNull();
  });

  it("pressing 'Remove' -> confirm dialog, no DELETE yet; Cancel -> nothing sent, focus returns to the more menu; reopen, Remove in the dialog -> DELETE sent, dialog closes, toast has no Undo", async () => {
    const server = stubFavServer({ favorites: [FAV_NOTE.id] });
    renderShell("header");
    openShellMenu("header");
    const remove = await favItem("Remove from favorites");
    await ready(remove);
    fireEvent.click(remove);
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(0);
    expect(dialog).toHaveTextContent(`"${FAV_NOTE.title}" will be removed`);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toHaveFocus());
    expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(0);

    openShellMenu("header");
    fireEvent.click(await favItem("Remove from favorites"));
    const again = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    fireEvent.click(within(again).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed from favorites")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(1);
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toHaveFocus());
  });

  it("DELETE returns 429 -> dialog closes, error toast, cache unchanged, focus returns to the more menu", async () => {
    stubFavServer({ favorites: [FAV_NOTE.id], del: 429 });
    const { queryClient } = renderShell("sidebar");
    openShellMenu("sidebar");
    const remove = await favItem("Remove from favorites");
    await ready(remove);
    fireEvent.click(remove);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Too many requests. Please slow down.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Removed from favorites")).toBeNull();
    expect(queryClient.getQueryData(["favorites"])).toEqual([{ noteId: FAV_NOTE.id, favoritedAt: "2026-03-01T00:00:00.000Z" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: triggerName("sidebar") })).toHaveFocus());
  });

  it("removal request hasn't returned: the confirm dialog doesn't close, both buttons disabled, Esc has no effect, DELETE sent once", async () => {
    const server = stubFavServer({ favorites: [FAV_NOTE.id], del: "pending" });
    renderShell("sidebar");
    openShellMenu("sidebar");
    const remove = await favItem("Remove from favorites");
    await ready(remove);
    fireEvent.click(remove);
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(1));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled());
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Remove from favorites?" })).toBeInTheDocument();
    expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(1);
  });

  it("reopening the menu while sending: PUT hangs -> that item is disabled; pressing it sends no second request", async () => {
    const server = stubFavServer({ put: "pending" });
    renderShell("header");
    openShellMenu("header");
    const add = await favItem("Add to favorites");
    await ready(add);
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(count(server, `PUT /api/favorites/${FAV_NOTE.id}`)).toBe(1);

    openShellMenu("header");
    const during = await favItem("Remove from favorites");
    expect(during).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(during);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(count(server, `PUT /api/favorites/${FAV_NOTE.id}`)).toBe(1);
    expect(server.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("when the menu isn't open GET /api/favorites isn't hit (ten sidebar more menus); opening one hits it once", async () => {
    const server = stubFavServer();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const notes = Array.from({ length: 10 }, (_, i) => ({ ...FAV_NOTE, id: `${FAV_NOTE.id.slice(0, -2)}${String(i).padStart(2, "0")}`, title: `Note ${i}` }));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          {notes.map((n) => (
            <SidebarNoteMenu key={n.id} note={n} />
          ))}
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(count(server, "GET /api/favorites")).toBe(0);
    pressTrigger(screen.getByRole("button", { name: "Note actions for Note 3" }));
    await favItem("Add to favorites");
    await waitFor(() => expect(count(server, "GET /api/favorites")).toBe(1));
  });
});

// Removing with the row's own more menu in the Favorites tab: that row unmounts after the 204, focus must land on the next row / previous row / tabpanel, and the toast must not disappear with the row.
describe("NoteMenu - Favorites tab focus", () => {
  const A = personalNote({ id: "fa", title: "Alpha" });
  const B = personalNote({ id: "fb", title: "Bravo" });
  const C = personalNote({ id: "fc", title: "Charlie" });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    localStorage.setItem("sidebar.tab", "favorites");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("removing B, C, A in turn: focus lands on C's link, A's link, then the tabpanel; the removal toast appears all three times", async () => {
    let favorites = [A.id, B.id, C.id];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/favorites" && method === "GET") {
          return Promise.resolve(json(favorites.map((noteId) => ({ noteId, favoritedAt: "2026-03-01T00:00:00.000Z" }))));
        }
        const target = /^\/api\/favorites\/(.+)$/.exec(url)?.[1];
        if (target !== undefined && method === "DELETE") {
          favorites = favorites.filter((id) => id !== target);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url === "/api/notes") return Promise.resolve(json([A, B, C]));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json({ folders: [] }));
        return Promise.resolve(json({ error: { code: "not_found", message: "unexpected" } }, 404));
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-sidebar-instance="">
                <div role="tabpanel" tabIndex={0}>
                  <NoteList />
                </div>
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
        <Toaster />
      </QueryClientProvider>,
    );

    const rowLink = (id: string) => screen.getByRole("tabpanel").querySelector(`[data-node-id="${id}"] a`) as HTMLElement;
    await waitFor(() => expect(rowLink(C.id)).not.toBeNull());

    async function removeFrom(note: NoteDto) {
      const menuButton = screen.getByRole("button", { name: `Note actions for ${note.title}` });
      menuButton.focus();
      pressTrigger(menuButton);
      const item = await screen.findByRole("menuitem", { name: "Remove from favorites" });
      await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));
      fireEvent.click(item);
      const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
      expect(await screen.findByText("Removed from favorites")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(screen.getByRole("tabpanel").querySelector(`[data-node-id="${note.id}"]`)).toBeNull());
      dismissAllToasts();
    }

    await removeFrom(B);
    await waitFor(() => expect(rowLink(C.id)).toHaveFocus());
    await removeFrom(C);
    await waitFor(() => expect(rowLink(A.id)).toHaveFocus());
    await removeFrom(A);
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveFocus());
  });

  it("two sidebar instances on screen (drawer + hidden static card): the focus fallback only looks inside the instance that opened the dialog", async () => {
    let favorites = [A.id, B.id, C.id];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/favorites" && method === "GET") {
          return Promise.resolve(json(favorites.map((noteId) => ({ noteId, favoritedAt: "2026-03-01T00:00:00.000Z" }))));
        }
        const target = /^\/api\/favorites\/(.+)$/.exec(url)?.[1];
        if (target !== undefined && method === "DELETE") {
          favorites = favorites.filter((id) => id !== target);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url === "/api/notes") return Promise.resolve(json([A, B, C]));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json({ folders: [] }));
        return Promise.resolve(json({ error: { code: "not_found", message: "unexpected" } }, 404));
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-testid="static" data-sidebar-instance="">
                <div role="tabpanel" tabIndex={0}>
                  <NoteList />
                </div>
              </div>
              <div data-testid="drawer" data-sidebar-instance="">
                <div role="tabpanel" tabIndex={0}>
                  <NoteList />
                </div>
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
        <Toaster />
      </QueryClientProvider>,
    );

    const drawer = screen.getByTestId("drawer");
    const staticCard = screen.getByTestId("static");
    const linkIn = (root: HTMLElement, id: string) => root.querySelector(`[data-node-id="${id}"] a`) as HTMLElement;
    await waitFor(() => expect(linkIn(drawer, C.id)).not.toBeNull());

    const menuButton = within(drawer).getByRole("button", { name: `Note actions for ${B.title}` });
    menuButton.focus();
    pressTrigger(menuButton);
    const item = await screen.findByRole("menuitem", { name: "Remove from favorites" });
    await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed from favorites")).toBeInTheDocument();
    await waitFor(() => expect(drawer.querySelector(`[data-node-id="${B.id}"]`)).toBeNull());
    await waitFor(() => expect(linkIn(drawer, C.id)).toHaveFocus());
    expect(linkIn(staticCard, C.id)).not.toHaveFocus();
  });
});

describe("NoteMenu - width", () => {
  function renderWidthMenu(shell: "header" | "sidebar" = "header", withToggle = true) {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(String(input) === "/api/folders" ? FOLDER_LIST_EMPTY : []) })),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/notes/my-note"]}>
          {withToggle && <NoteWidthToggle noteId={OWNER_NOTE.id} />}
          {shell === "header" ? (
            <NoteMenu
              note={OWNER_NOTE}
              state={CONNECTED}
              leavingRef={{ current: false }}
              onOpenEdits={() => {}}
              widthItems={(control) => <NoteWidthMenuItems noteId={OWNER_NOTE.id} {...control} />}
            />
          ) : (
            <SidebarNoteMenu note={OWNER_NOTE} />
          )}
        </MemoryRouter>
        <Toaster />
      </QueryClientProvider>,
    );
  }
  // With the menu open Radix marks other content aria-hidden, so queries need `hidden`.
  const widthToggle = () => screen.getByRole("button", { name: /^Width:/, hidden: true });

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    act(() => dismissAllToasts());
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("header more menu has 'Width', sidebar row more menus don't", () => {
    renderWidthMenu("header");
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Width" })).toBeInTheDocument();
    cleanup();
    renderWidthMenu("sidebar", false);
    pressTrigger(screen.getByRole("button", { name: `Note actions for ${OWNER_NOTE.title}` }));
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Width" })).toBeNull();
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
  });

  it("phone (< 640): header more menu has no 'Width', other items as usual; from 640 up it's there", () => {
    stubLayoutTier("phone");
    renderWidthMenu("header");
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Width" })).toBeNull();
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    cleanup();
    stubLayoutTier("overlay");
    renderWidthMenu("header");
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Width" })).toBeInTheDocument();
  });

  it("wide form: Width is a submenu trigger item; expanded it has three menuitemradio, the current one aria-checked", async () => {
    mockWidePointer(true);
    renderWidthMenu();
    openMenu();
    const trigger = screen.getByRole("menuitem", { name: "Width" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const sub = await screen.findByRole("menu", { name: "Width" });
    const radios = within(sub).getAllByRole("menuitemradio");
    expect(radios.map((el) => el.textContent)).toEqual(["Standard", "Wide", "Full width"]);
    expect(radios.map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("stored width: in both forms the opened menu has that item aria-checked", async () => {
    window.localStorage.setItem(`note.width.${OWNER_NOTE.id}`, "full");
    mockWidePointer(true);
    renderWidthMenu();
    openMenu();
    const trigger = screen.getByRole("menuitem", { name: "Width" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const sub = await screen.findByRole("menu", { name: "Width" });
    expect(within(sub).getByRole("menuitemradio", { name: "Full width" })).toHaveAttribute("aria-checked", "true");
    expect(within(sub).getByRole("menuitemradio", { name: "Standard" })).toHaveAttribute("aria-checked", "false");
    cleanup();
    mockWidePointer(false);
    renderWidthMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Width" }));
    expect(screen.getByRole("menuitemradio", { name: "Full width" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Standard" })).toHaveAttribute("aria-checked", "false");
  });

  it("wide form: clicking 'Wide' -> written to localStorage, the header width button's name follows", async () => {
    mockWidePointer(true);
    renderWidthMenu();
    openMenu();
    const trigger = screen.getByRole("menuitem", { name: "Width" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const sub = await screen.findByRole("menu", { name: "Width" });
    expect(widthToggle()).toHaveAccessibleName("Width: Standard — click for Wide");
    fireEvent.click(within(sub).getByRole("menuitemradio", { name: "Wide" }));
    expect(window.localStorage.getItem(`note.width.${OWNER_NOTE.id}`)).toBe("wide");
    expect(widthToggle()).toHaveAccessibleName("Width: Wide — click for Full width");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("wide form: Esc closes only the submenu, focus returns to 'Width', the main menu stays open", async () => {
    mockWidePointer(true);
    renderWidthMenu();
    openMenu();
    const trigger = screen.getByRole("menuitem", { name: "Width" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const sub = await screen.findByRole("menu", { name: "Width" });
    fireEvent.keyDown(within(sub).getAllByRole("menuitemradio")[0]!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitemradio")).toBeNull());
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Width" })).toHaveFocus();
  });

  it("narrow form: clicking 'Width' shows three items in place, no aria-haspopup, menu stays open; clicking 'Full width' writes it and the menu doesn't close", () => {
    mockWidePointer(false);
    renderWidthMenu();
    openMenu();
    const trigger = screen.getByRole("menuitem", { name: "Width" });
    expect(trigger).not.toHaveAttribute("aria-haspopup");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Full width" }));
    expect(window.localStorage.getItem(`note.width.${OWNER_NOTE.id}`)).toBe("full");
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Full width" })).toHaveAttribute("aria-checked", "true");
    expect(widthToggle()).toHaveAccessibleName("Width: Full width — click for Standard");
  });

  it("narrow form: Esc collapses first then closes the menu; reopening is collapsed", () => {
    mockWidePointer(false);
    renderWidthMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Width" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Width" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Width" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
  });

  it("crossing the wide/narrow criterion with the menu open -> closes the whole menu", () => {
    const mq = mockWidePointer(false);
    renderWidthMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Width" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    act(() => mq.setWide(true));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("narrow form: crossing to wide and back to narrow, reopening the more menu is collapsed and the first Esc closes the menu", () => {
    const mq = mockWidePointer(false);
    renderWidthMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Width" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    act(() => mq.setWide(true));
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => mq.setWide(false));
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Width" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("narrow form: ArrowRight expands, ArrowLeft on a radio collapses and returns focus to 'Width'", () => {
    mockWidePointer(false);
    renderWidthMenu();
    openMenu();
    const trigger = screen.getByRole("menuitem", { name: "Width" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(3);
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(screen.getByRole("menuitem", { name: "Width" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("menuitem", { name: "Width" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Width" }), { key: "ArrowLeft" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const again = screen.getByRole("menuitem", { name: "Width" });
    again.focus();
    fireEvent.keyDown(again, { key: "ArrowRight" });
    expect(again).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(again, { key: "ArrowLeft" });
    expect(again).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("narrow form: after expanding width, clicking another item closes the menu, reopening is collapsed and the first Esc closes the menu", () => {
    mockWidePointer(false);
    renderWidthMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Width" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "AI edit history" }));
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Width" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("narrow form: after expanding 'Copy to...', clicking another item closes the menu, reopening is collapsed", () => {
    mockWidePointer(false);
    renderWidthMenu();
    openMenu();
    fireEvent.click(screen.getByTestId("note-menu-copy-to"));
    expect(screen.getByTestId("note-menu-copy-to")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "AI edit history" }));
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();
    expect(screen.getByTestId("note-menu-copy-to")).toHaveAttribute("aria-expanded", "false");
  });

  it("the width store isn't subscribed while the menu is closed (subscribed once it opens)", () => {
    const add = vi.spyOn(window, "addEventListener");
    const storageListeners = () => add.mock.calls.filter(([type]) => type === "storage").length;
    renderWidthMenu("header", false);
    expect(storageListeners()).toBe(0);
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Width" })).toBeInTheDocument();
    expect(storageListeners()).toBe(1);
  });
});
