import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import {
  canonicalNotePath,
  type FavoriteDto,
  type FolderDto,
  type GroupDto,
  type GroupRoleFlags,
  type NoteDto,
  type NotePermissions,
  type UserDto,
} from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { NotePageControlsContext, type NotePageControls } from "@/lib/note-page-controls";
import { GROUPS_QUERY_KEY, useInvalidateGroupsAndNotes, useUpdateRole } from "@/api/groups";
import { FAVORITES_QUERY_KEY } from "@/api/favorites";
import { invalidateTrashRelated } from "@/api/trash";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { SidebarTabList } from "@/components/sidebar/SidebarTabList";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NoteList, type NoteListProps } from "./NoteList";
import { adminRole, customRole, EDITOR_PERMS, groupDto, memberRole, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests, setFolderSort } from "@/components/sidebar/folder-sort";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote as selGroupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { createFakeDataTransfer, mockFinePointer } from "@/test/drag-fixtures";
import { DRAG_NOTE_MIME } from "@/components/sidebar/drag-zone";
import { indexFolders } from "@/components/sidebar/folder-index";
import { noteLocationLabel } from "@/components/sidebar/tree";

// `sidebar.tab` and `sidebar.collapsed.*` (including the collapse store's in-memory overlay) leak into later cases of this file (especially when run out of order), so they are cleared at file top level.
afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

/** Simulates NotePage's "set after resolve": the minimal setter for tests (#122 ActiveNoteContext). */
function SetActive({ id }: { id: string }) {
  const { setActiveNoteId } = useActiveNote();
  useEffect(() => {
    setActiveNoteId(id);
  }, [id, setActiveNoteId]);
  return null;
}

// Same convention as App.test.tsx / guards.test.tsx: mock global fetch so the real useNotes() (react-query) hits fake responses
// instead of mocking the hook, so what is tested is NoteList wired to the real hooks.

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

interface RenderOpts {
  tab?: SidebarTab;
  queryClient?: QueryClient;
  activeId?: string;
  extra?: ReactNode;
}

/** In the real layout the tablist and tabpanel frame come from AppShell; this helper adds them (panel handles only hold then). */
function renderNoteList(props: Partial<NoteListProps> = {}, opts: RenderOpts = {}) {
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            {opts.activeId !== undefined && <SetActive id={opts.activeId} />}
            {opts.extra}
            <SidebarTabList idBase="t" />
            <div role="tabpanel">
              <NoteList {...props} />
            </div>
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

const panel = () => screen.getByRole("tabpanel");
const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;
const list = () => panel().querySelector("[data-sidebar-list]") as HTMLElement;
const noteRow = (id: string) => panel().querySelector(`[data-node-kind="note"][data-node-id="${id}"]`) as HTMLElement | null;
const groupNode = (id: string) => panel().querySelector(`[data-node-kind="group"][data-node-id="${id}"]`) as HTMLElement | null;
const selectTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
/** The Recent tab's link name includes the location line, so find titles with `^title`. */
const startsWith = (title: string) => new RegExp("^" + title);

const OWNER_NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Has A Slug",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "custom-slug",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "owner-one",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const SHARED_NOTE: NoteDto = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "No Slug Note",
  ownerId: "u9",
  role: "editor",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "no-slug-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "owner-nine",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: EDITOR_PERMS,
};

const THIRD_OWNER_NOTE: NoteDto = {
  id: "33333333-3333-3333-3333-333333333333",
  title: "Third Owner Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2025-12-01T00:00:00.000Z",
  slug: "third-owner-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "owner-one",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());
const GROUP_B: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Workshop B" }, adminRole());

/**
 * #175 group note fixture shape: owned by a group, no personal owner (`ownerId`/`ownerHandle` null), `role` derived from the group role (never owner), `permissions` derived from the role flags.
 * `perms` omitted = the built-in admin role's shape.
 */
function groupNote(
  base: { id: string; title: string; slug: string; groupId: string; groupName: string },
  role: "editor" | "viewer",
  perms: NotePermissions = { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
): NoteDto {
  return {
    ...OWNER_NOTE,
    id: base.id,
    title: base.title,
    slug: base.slug,
    slugIsCustom: false,
    ownerId: null,
    ownerHandle: null,
    role,
    groupId: base.groupId,
    group: { id: base.groupId, name: base.groupName },
    permissions: perms,
  };
}

const MY_GROUP_NOTE: NoteDto = groupNote(
  { id: "44444444-4444-4444-4444-444444444444", title: "Mine In A", slug: "mine-in-a", groupId: GROUP_A.id, groupName: GROUP_A.name },
  "editor",
);
const OTHERS_GROUP_NOTE: NoteDto = groupNote(
  { id: "55555555-5555-5555-5555-555555555555", title: "Theirs In A", slug: "theirs-in-a", groupId: GROUP_A.id, groupName: GROUP_A.name },
  "viewer",
  { ...VIEWER_PERMS },
);
/** Group note whose group isn't in useGroups() (just removed, list not refetched) -> shared with me (fallback). */
const ORPHAN_GROUP_NOTE: NoteDto = groupNote(
  { id: "66666666-6666-6666-6666-666666666666", title: "Orphan", slug: "orphan", groupId: "99999999-9999-9999-9999-999999999999", groupName: "Gone" },
  "editor",
  { ...EDITOR_PERMS },
);

const ME: UserDto = { id: "u1", email: "me@example.com", handle: "owner-one", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };

function stubNotesFetch(notes: NoteDto[], groups: GroupDto[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
      }
      // The group row's more menu (GroupMenu) gets its own id (leave group) from useSession
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function stubGroupsPending(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (String(input) === "/api/notes") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      return new Promise<Response>(() => {});
    }),
  );
}

function stubGroupsError(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (String(input) === "/api/notes") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      return Promise.resolve(
        fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }),
      );
    }),
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

    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
  });

  it("shows an error message when /api/notes fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/groups") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
          }),
        );
      }),
    );

    renderNoteList();

    await waitFor(() =>
      expect(within(list()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."),
    );
  });

  it("links each note to its canonicalNotePath - the single /n/<ownerHandle>/<slug> shape (#122)", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();

    const mine = await within(panel()).findByRole("link", { name: "Has A Slug" });
    expect(mine).toHaveAttribute("href", canonicalNotePath(OWNER_NOTE));
    expect(canonicalNotePath(OWNER_NOTE)).toBe("/n/owner-one/custom-slug");

    selectTab("Shared with me");
    expect(within(panel()).getByRole("link", { name: "No Slug Note" })).toHaveAttribute(
      "href",
      canonicalNotePath(SHARED_NOTE),
    );
    expect(canonicalNotePath(SHARED_NOTE)).toBe("/n/owner-nine/no-slug-note"); // literal of the new shape (the old not.toBe was always true once the slug is a constant string)

    // Row height: touch 44px, mouse 28px; h-11 pointer-fine:h-7 - dropping pointer-fine:h-7 makes mouse rows fat, dropping h-11 makes touch targets imprecise.
    selectTab("My notes");
    const touchRow = within(panel()).getByRole("link", { name: "Has A Slug" });
    expect(touchRow.closest("li")).toHaveClass("h-11", "pointer-fine:h-7");
    expect(touchRow.closest("li")).not.toHaveClass("md:h-7");
    // The touch target is the <Link>, not the <li>: the li stretches to 44 high but under items-center the anchor is only content height (~20px),
    // leaving 12px dead zones above and below; the Link must self-stretch to the full row height to be a real 44px target.
    expect(touchRow).toHaveClass("self-stretch", "flex", "items-center");
  });

  it("shows no role text on any row; no delete button anywhere (moved to the more menu)", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();
    await within(panel()).findByRole("link", { name: "Has A Slug" });
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.queryByText("Editor")).not.toBeInTheDocument();

    selectTab("Shared with me");
    await within(panel()).findByRole("link", { name: "No Slug Note" });
    expect(within(panel()).queryByText("Editor")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });


  it("lit on page open: context has an active id (set by NotePage after resolving) -> that row has aria-current=page, exactly one", async () => {
    stubNotesFetch([OWNER_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList({}, { activeId: OWNER_NOTE.id });

    const current = await within(panel()).findByRole("link", { current: "page" });
    expect(current).toHaveAccessibleName("Has A Slug");
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(1);
    expect(within(panel()).getByRole("link", { name: "Third Owner Note" })).not.toHaveAttribute("aria-current");
  });

  // The active row follows the theme color, and its hover state changes to brand together (twMerge lets the later hover:bg-brand-soft-strong override
  // hover:bg-brand-soft, since the same variant group is mutually exclusive).
  // Handle: the class is on the <li>, not the <a>, so get it with getByRole("link").closest("li").
  it("active row gets the theme tint (bg-brand-soft/text-brand-on-soft/hover:bg-brand-soft-strong)", async () => {
    stubNotesFetch([OWNER_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList({}, { activeId: OWNER_NOTE.id });

    const activeLink = await within(panel()).findByRole("link", { current: "page" });
    const activeRow = activeLink.closest("li");
    expect(activeRow).toHaveClass("bg-brand-soft", "text-brand-on-soft", "font-medium", "hover:bg-brand-soft-strong");
    // twMerge really replaced the base `hover:bg-brand-soft` with `hover:bg-brand-soft-strong`,
    // rather than both coexisting and being right by specificity luck.
    expect(activeRow).not.toHaveClass("hover:bg-brand-soft");

    const inactiveRow = within(panel()).getByRole("link", { name: "Third Owner Note" }).closest("li");
    expect(inactiveRow).not.toHaveClass("bg-brand-soft");
    expect(inactiveRow).toHaveClass("hover:bg-brand-soft", "hover:text-brand-on-soft", "active:bg-brand-soft-strong");
    expect(inactiveRow).not.toHaveClass("hover:bg-accent/60");
  });

  it("lit on click: optimistic set, doesn't wait for any resolution", async () => {
    stubNotesFetch([OWNER_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList();
    const link = await within(panel()).findByRole("link", { name: "Has A Slug" });
    expect(screen.queryAllByRole("link", { current: "page" })).toHaveLength(0);

    fireEvent.click(link);
    expect(within(panel()).getByRole("link", { name: "Has A Slug" })).toHaveAttribute("aria-current", "page");
  });

  it("navigating: clicking another note -> the highlight moves, nothing is left behind", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();
    fireEvent.click(await within(panel()).findByRole("link", { name: "Has A Slug" }));
    selectTab("Shared with me");
    fireEvent.click(within(panel()).getByRole("link", { name: "No Slug Note" }));
    expect(within(panel()).getByRole("link", { name: "No Slug Note" })).toHaveAttribute("aria-current", "page");
    selectTab("My notes");
    expect(within(panel()).getByRole("link", { name: "Has A Slug" })).not.toHaveAttribute("aria-current");
  });

  it("modifier-key click (cmd/ctrl/shift + left button = open in new tab) does **not** optimistically set", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();
    const link = await within(panel()).findByRole("link", { name: "Has A Slug" });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { shiftKey: true });
    expect(screen.queryAllByRole("link", { current: "page" })).toHaveLength(0);
  });

  it("active is anchored on id: with **the same tree**, title/slug all change (simulating the list updating after a rename) -> the highlight stays, exactly one", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);
    const { queryClient } = renderNoteList({}, { activeId: OWNER_NOTE.id });
    await within(panel()).findByRole("link", { current: "page" });

    // Swap the data in place in the same QueryClient (no unmount): same id, title and slug both change;
    // any implementation judging by title/slug/URL would lose the highlight here, an id anchor doesn't.
    const renamed = { ...OWNER_NOTE, title: "Renamed Entirely", slug: "renamed-entirely" };
    queryClient.setQueryData<NoteDto[]>(["notes"], [renamed, SHARED_NOTE]);

    const current = await within(panel()).findAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Renamed Entirely");
  });


  describe("tab header row", () => {
    // Every normal tab's header row has an extra "Select" button (selection mode itself: sidebar/SelectPanel.test.tsx).
    it("My notes: title + 'Select' + the always-visible 'New personal note' button (doesn't float in)", async () => {
      stubNotesFetch([OWNER_NOTE]);
      renderNoteList();
      await within(panel()).findByRole("link", { name: "Has A Slug" });
      expect(within(header()).getByText("My notes")).toHaveClass("truncate"); // the ellipsis must sit on the text element
      const plus = within(header()).getByRole("button", { name: "New personal note" });
      expect(plus).not.toHaveClass("opacity-0");
      expect(within(header()).getAllByRole("button")).toHaveLength(3);
      expect(within(header()).getAllByRole("button")[0]).toHaveAccessibleName("Select");
    });

    it("Groups: title + 'Select' + 'New group' button (always visible)", async () => {
      stubNotesFetch([OWNER_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      await within(panel()).findByRole("button", { name: "Workshop A" });
      expect(within(header()).getByText("Groups")).toBeInTheDocument();
      const plus = within(header()).getByRole("button", { name: "New group" });
      expect(plus).not.toHaveClass("opacity-0");
      expect(within(header()).getAllByRole("button")).toHaveLength(2);
      expect(within(header()).getAllByRole("button")[0]).toHaveAccessibleName("Select");
    });

    it("Recent: the header row has only 'Select'; Shared with me: 'Select' + 'New folder'", async () => {
      stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);
      renderNoteList({}, { tab: "recent" });
      await within(panel()).findByRole("link", { name: startsWith("Has A Slug") });
      expect(within(header()).getByText("Recent")).toBeInTheDocument();
      expect(within(header()).queryAllByRole("button")).toHaveLength(1);
      expect(within(header()).getByRole("button")).toHaveAccessibleName("Select");

      selectTab("Shared with me");
      await within(panel()).findByRole("link", { name: "No Slug Note" });
      expect(within(header()).getByText("Shared with me")).toBeInTheDocument();
      const buttons = within(header()).queryAllByRole("button");
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toHaveAccessibleName("Select");
      expect(buttons[1]).toHaveAccessibleName("New folder");
    });

    it("header '+': personal note -> onCreateNote(undefined); disabled follows createNotePending", async () => {
      const onCreateNote = vi.fn();
      stubNotesFetch([OWNER_NOTE]);
      renderNoteList({ onCreateNote });
      const plus = await within(header()).findByRole("button", { name: "New personal note" });
      expect(plus).toBeEnabled();
      expect(plus).toHaveAttribute("title", "New personal note");
      fireEvent.click(plus);
      expect(onCreateNote).toHaveBeenCalledTimes(1);
      expect(onCreateNote.mock.calls[0]).toEqual([undefined]);
    });

    it("createNotePending -> header '+' disabled", async () => {
      stubNotesFetch([OWNER_NOTE]);
      renderNoteList({ createNotePending: true });
      expect(await within(header()).findByRole("button", { name: "New personal note" })).toBeDisabled();
    });
  });


  it("favorites list not arrived: no star, the more menu takes the rightmost slot (3px from the row edge)", async () => {
    stubNotesFetch([OWNER_NOTE], []);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (String(input) === "/api/favorites" ? new Promise<Response>(() => {}) : inner(input, init)));
    renderNoteList();
    await within(panel()).findByRole("link", { name: "Has A Slug" });
    const row = noteRow(OWNER_NOTE.id)!;
    expect(within(row).queryByRole("button", { name: "Favorite" })).toBeNull();
    const menu = within(row).getByRole("button", { name: `Note actions for ${OWNER_NOTE.title}` });
    // The last child is the tag dots slot.
    expect(row.lastElementChild!.previousElementSibling).toBe(menu);
  });

  it("My notes: lists only personal notes, in server order, each row pl-2, each row has a more menu; no group or shared notes", async () => {
    stubNotesFetch([THIRD_OWNER_NOTE, MY_GROUP_NOTE, SHARED_NOTE, OWNER_NOTE], [GROUP_A]);

    renderNoteList();

    await within(panel()).findByRole("link", { name: "Has A Slug" });
    const titles = Array.from(panel().querySelectorAll('[data-node-kind="note"] a')).map((a) => a.textContent);
    expect(titles).toEqual(["Third Owner Note", "Has A Slug"]); // server order, not sorted by title
    for (const note of [THIRD_OWNER_NOTE, OWNER_NOTE]) {
      const row = noteRow(note.id)!;
      // Right padding 8px: the dots slot ends 16px from the list edge, symmetric with the left text start; phone title is 15px.
      expect(row).toHaveClass("pl-2", "pr-2", "text-[13px]", "max-sm:text-[15px]");
      expect(row).not.toHaveClass("pl-6", "pr-0.75");
      const menu = within(row).getByRole("button", { name: `Note actions for ${note.title}` });
      // Mouse: the more menu is in the flow, width 0 when not floated in (takes no space, -ms-1 cancels the extra gap); on hover, keyboard focus or open menu it grows to 24px and the title truncates earlier;
      // hover:none (always-visible more menu) restores 24px with `!`; no background color.
      expect(menu).toHaveClass(
        "pointer-fine:w-0",
        "pointer-fine:-ms-1",
        "pointer-fine:overflow-hidden",
        "pointer-fine:group-hover/noterow:w-6",
        "pointer-fine:group-has-[:focus-visible]/noterow:w-6",
        "pointer-fine:focus-visible:w-6",
        "pointer-fine:data-[state=open]:w-6",
        "[@media(hover:none)]:w-6!",
        "w-6",
        "opacity-0",
      );
      expect(menu.className).not.toMatch(/pointer-fine:absolute|bg-card|bg-inherit/);
    }
    expect(within(panel()).queryByRole("link", { name: "Mine In A" })).toBeNull();
    expect(within(panel()).queryByRole("link", { name: "No Slug Note" })).toBeNull();
  });

  it("Shared with me: per-person shares + orphan group notes; no personal notes", async () => {
    const viewerShared: NoteDto = { ...SHARED_NOTE, id: "77777777-7777-7777-7777-777777777777", title: "Read Only Share", role: "viewer", permissions: VIEWER_PERMS };
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, viewerShared, ORPHAN_GROUP_NOTE, MY_GROUP_NOTE], [GROUP_A]);

    renderNoteList({}, { tab: "shared" });

    const orphan = await within(panel()).findByRole("link", { name: "Orphan" });
    expect(orphan).toHaveAttribute("href", `/g/${ORPHAN_GROUP_NOTE.group!.id}/orphan`);
    expect(within(noteRow(SHARED_NOTE.id)!).queryByText("Editor")).toBeNull();
    expect(within(noteRow(viewerShared.id)!).queryByText("Viewer")).toBeNull();
    expect(within(panel()).queryByRole("link", { name: "Has A Slug" })).toBeNull();
    expect(within(panel()).queryByRole("link", { name: "Mine In A" })).toBeNull();
  });

  describe("groups", () => {
    it("group nodes follow groups order; group rows carry no role; #175: notes where my role is in the group land in the group", async () => {
      stubNotesFetch([OWNER_NOTE, MY_GROUP_NOTE, OTHERS_GROUP_NOTE, SHARED_NOTE, ORPHAN_GROUP_NOTE], [GROUP_B, GROUP_A]);
      renderNoteList({}, { tab: "workspace" });

      const groupA = await waitFor(() => {
        const node = groupNode(GROUP_A.id);
        expect(node).not.toBeNull();
        return node!;
      });
      const order = Array.from(panel().querySelectorAll('[data-node-kind="group"]')).map((el) => el.getAttribute("data-node-id"));
      expect(order).toEqual([GROUP_B.id, GROUP_A.id]);

      expect(within(groupA).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
      expect(within(groupA).getByRole("link", { name: "Theirs In A" })).toBeInTheDocument();
      // #182: group rows carry no role; the role is seen in the badge at the top of the note page.
      expect(within(groupA).queryByText("Editor")).not.toBeInTheDocument();
      expect(within(groupA).queryByText("Viewer")).not.toBeInTheDocument();
      expect(within(panel()).queryByRole("link", { name: "Has A Slug" })).toBeNull();
      expect(within(panel()).queryByRole("link", { name: "No Slug Note" })).toBeNull();
      expect(within(panel()).queryByRole("link", { name: "Orphan" })).toBeNull();
    });

    it("collapse: clicking a group -> aria-expanded=false, rows disappear, localStorage writes sidebar.collapsed.group:<id>=1; stays collapsed after remount", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      const first = renderNoteList({}, { tab: "workspace" });
      const button = await within(panel()).findByRole("button", { name: "Workshop A", expanded: true });
      expect(within(panel()).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
      fireEvent.click(button);
      expect(within(panel()).getByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "false");
      expect(within(panel()).queryByRole("link", { name: "Mine In A" })).not.toBeInTheDocument();
      expect(window.localStorage.getItem(`sidebar.collapsed.group:${GROUP_A.id}`)).toBe("1");

      first.view.unmount();
      renderNoteList({}, { tab: "workspace" });
      expect(await within(panel()).findByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(within(panel()).getByRole("button", { name: "Workshop A" }));
      expect(window.localStorage.getItem(`sidebar.collapsed.group:${GROUP_A.id}`)).toBeNull();
      expect(within(panel()).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
    });

    it("localStorage throws (private mode) -> the sidebar works as usual, expanded by default, can still collapse for this session", async () => {
      const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("SecurityError");
      });
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      try {
        stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
        renderNoteList();
        selectTab("Groups"); // can't write to storage, state still switches
        const button = await within(panel()).findByRole("button", { name: "Workshop A", expanded: true });
        fireEvent.click(button);
        expect(within(panel()).getByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel()).queryByRole("link", { name: "Mine In A" })).not.toBeInTheDocument();
      } finally {
        getItem.mockRestore();
        setItem.mockRestore();
      }
    });

    it("the collapse key name is sidebar.collapsed.group:<id> (no other shape)", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      fireEvent.click(await within(panel()).findByRole("button", { name: "Workshop A" }));
      expect(Object.keys(window.localStorage).filter((k) => k.startsWith("sidebar.collapsed."))).toEqual([
        `sidebar.collapsed.group:${GROUP_A.id}`,
      ]);
    });

    it("group note rows hang inside a guide-line container (border-l), row left padding pl-3; the group node's parent doesn't carry pl-4", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      const row = (await waitFor(() => {
        const r = noteRow(MY_GROUP_NOTE.id);
        expect(r).not.toBeNull();
        return r!;
      })) as HTMLElement;
      const guide = row.closest("ul")?.parentElement as HTMLElement;
      expect(guide).toHaveClass("ml-[15px]", "border-l", "border-muted-foreground/35", "pl-2");
      const group = groupNode(GROUP_A.id)!;
      expect(group).toContainElement(guide);
      expect(row).toHaveClass("pl-3", "pr-2");
      expect(row).not.toHaveClass("pl-6");
      expect(group.parentElement?.tagName).toBe("UL");
      expect(group.parentElement).not.toHaveClass("pl-4");
      expect(group.parentElement?.parentElement).toBe(list().firstElementChild);
    });

    it("#247: group row hover is a brand tint, not neutral grey", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      await within(panel()).findByRole("button", { name: "Workshop A" });
      const row = groupNode(GROUP_A.id)!.firstElementChild as HTMLElement; // the `group/grouprow` row
      expect(row).toHaveClass("group/grouprow", "hover:bg-brand-soft", "active:bg-brand-soft-strong");
      expect(row).not.toHaveClass("hover:bg-accent/60");
      // The text color is on child elements (the button carries text-foreground itself, the icon slot text-muted-foreground itself; neither inherits from the outer).
      const button = within(row).getByRole("button", { name: GROUP_A.name });
      expect(button).toHaveClass("group-hover/grouprow:text-brand-on-soft");
      expect(button.firstElementChild).toHaveClass("group-hover/grouprow:text-brand-on-soft");
    });

    it("group row leading slot: Users shown normally, replaced by a chevron on hover/focus-visible/touch; the button's name is only the group name", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      const button = await within(panel()).findByRole("button", { name: "Workshop A", expanded: true });
      expect(button).toHaveAccessibleName("Workshop A");
      expect(button).toHaveClass("h-full", "gap-1.5", "px-2", "text-[13px]", "font-medium", "text-foreground");
      expect(button).not.toHaveClass("text-muted-foreground");
      expect(button.parentElement).toHaveClass("group/grouprow", "hover:bg-brand-soft", "h-11", "pointer-fine:h-7");

      const users = button.querySelector('svg[data-icon="users"]');
      const chevron = button.querySelector('svg[data-icon="chevron-right"]');
      expect(users).not.toBeNull();
      expect(chevron).not.toBeNull();
      expect(users).toHaveAttribute("aria-hidden", "true");
      expect(chevron).toHaveAttribute("aria-hidden", "true");
      expect(users?.parentElement).toBe(chevron?.parentElement);
      expect(users).not.toHaveClass("hidden");
      expect(users).toHaveClass(
        "group-hover/grouprow:hidden",
        "group-has-[:focus-visible]/grouprow:hidden",
        "[@media(hover:none)]:hidden",
      );
      expect(chevron).toHaveClass(
        "hidden",
        "group-hover/grouprow:block",
        "group-has-[:focus-visible]/grouprow:block",
        "[@media(hover:none)]:block",
        "rotate-90",
      );
      // Only keyboard focus swaps the icon: focus left on the button after a mouse click must not keep the chevron stuck.
      expect(users).not.toHaveClass("group-focus-within/grouprow:hidden");
      expect(chevron).not.toHaveClass("group-focus-within/grouprow:block");

      // The group row's "+" still floats in with the group row.
      const plus = within(panel()).getByRole("button", { name: "New note in Workshop A" });
      expect(plus).toHaveClass(
        "opacity-0",
        "group-hover/grouprow:opacity-100",
        "group-has-[:focus-visible]/grouprow:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
      );
      expect(plus).not.toHaveClass("group-focus-within/grouprow:opacity-100");

      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(chevron).not.toHaveClass("rotate-90");
    });

    // Class assertion, not behaviour: jsdom has no CSS/hover; "really floats in on hover" has to be checked in a browser.
    it("group row more menu (aria-label contains the group name) is in the same row as '+', both float in together on hover (class assertion)", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      const button = await within(panel()).findByRole("button", { name: "Workshop A" });
      const menu = within(panel()).getByRole("button", { name: "Group actions for Workshop A" });
      expect(menu.parentElement).toBe(button.parentElement);
      expect(within(panel()).getByRole("button", { name: "New note in Workshop A" }).parentElement).toBe(button.parentElement);
      expect(menu).toHaveClass(
        "opacity-0",
        "group-hover/grouprow:opacity-100",
        "group-has-[:focus-visible]/grouprow:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
        "data-[state=open]:opacity-100",
      );
    });

    it("group row '+' -> onCreateNote(group id); when a group is named 'My notes' its accessible name differs from the header '+' (#103)", async () => {
      const onCreateNote = vi.fn();
      const lookalike: GroupDto = { ...GROUP_A, name: "My notes" };
      stubNotesFetch([OWNER_NOTE], [lookalike]);
      renderNoteList({ onCreateNote }, { tab: "workspace" });
      const groupPlus = await within(panel()).findByRole("button", { name: "New note in My notes" });
      fireEvent.click(groupPlus);
      expect(onCreateNote).toHaveBeenLastCalledWith(lookalike.id);
      expect(within(header()).queryByRole("button", { name: "New personal note" })).toBeNull();
    });

    it("#175: the group row '+' only renders when the role can create and edit - a role that can't create has no '+', the more menu stays as is", async () => {
      // Custom role (named Reader): read only. A regular (built-in) member has create: two groups side by side, each viewing its own role.
      const readerRole = memberRole({
        id: "r-reader",
        builtin: null,
        name: "讀者",
        permissions: { ...memberRole().permissions, create: false, edit: false },
      });
      const readOnlyGroup = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Readers" }, readerRole);
      const memberGroup = groupDto({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Writers" }, memberRole());
      const onCreateNote = vi.fn();
      stubNotesFetch([OWNER_NOTE], [readOnlyGroup, memberGroup]);
      renderNoteList({ onCreateNote }, { tab: "workspace" });

      const writersPlus = await within(panel()).findByRole("button", { name: "New note in Writers" });
      expect(within(panel()).queryByRole("button", { name: "New note in Readers" })).toBeNull();
      // The group row itself and its more menu (GroupMenu) stay; only "+" is hidden.
      expect(within(panel()).getByRole("button", { name: "Readers" })).toBeInTheDocument();
      expect(within(panel()).getByRole("button", { name: "Group actions for Readers" })).toBeInTheDocument();
      fireEvent.click(writersPlus);
      expect(onCreateNote).toHaveBeenLastCalledWith(memberGroup.id);
    });

    it("#175: a role that can create but not edit has no '+' (what it would create is a blank note it can't edit itself); the more menu stays as is", async () => {
      const creatorRole = memberRole({
        id: "r-creator",
        builtin: null,
        name: "Creators only",
        permissions: { ...memberRole().permissions, create: true, edit: false },
      });
      const creatorsGroup = groupDto({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "Creators" }, creatorRole);
      const memberGroup = groupDto({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Writers" }, memberRole());
      stubNotesFetch([OWNER_NOTE], [creatorsGroup, memberGroup]);
      renderNoteList({ onCreateNote: vi.fn() }, { tab: "workspace" });

      expect(await within(panel()).findByRole("button", { name: "New note in Writers" })).toBeInTheDocument();
      expect(within(panel()).queryByRole("button", { name: "New note in Creators" })).toBeNull();
      expect(within(panel()).getByRole("button", { name: "Group actions for Creators" })).toBeInTheDocument();
    });

    it("#175: a group with `myRole` null (defensive; GET /api/groups shouldn't return it) -> no '+', no throw", async () => {
      const orphanRoleGroup = groupDto({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "No Role" }, null);
      stubNotesFetch([OWNER_NOTE], [orphanRoleGroup]);
      renderNoteList({ onCreateNote: vi.fn() }, { tab: "workspace" });
      expect(await within(panel()).findByRole("button", { name: "No Role" })).toBeInTheDocument();
      expect(within(panel()).queryByRole("button", { name: "New note in No Role" })).toBeNull();
    });

    it("useGroups pending: notes arrived, groups not -> the Groups panel shows Loading... (no flash of the empty-state sentence); group notes temporarily fall under Shared with me via the fallback row", async () => {
      stubGroupsPending([OTHERS_GROUP_NOTE]);
      renderNoteList({}, { tab: "shared" });
      // Wait for the fallback row first: it proves notes have arrived while groups are still pending, which is the state under test.
      expect(await within(panel()).findByRole("link", { name: "Theirs In A" })).toBeInTheDocument();
      selectTab("Groups");
      expect(within(list()).getByText("Loading…")).toBeInTheDocument();
      expect(within(list()).queryByText("You're not in any group yet.")).toBeNull();
    });

    it("background refetch of groups fails: cached groups sit beside role=alert, groups aren't hidden", async () => {
      let groupsCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = (init?.method ?? "GET").toUpperCase();
          if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
          if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([MY_GROUP_NOTE]) }));
          if (url === "/api/groups" && method === "GET") {
            groupsCalls += 1;
            return groupsCalls === 1
              ? Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_A]) }))
              : Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }));
          }
          if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
          throw new Error(`unexpected fetch: ${method} ${url}`);
        }),
      );
      const { queryClient } = renderNoteList({}, { tab: "workspace" });
      await within(panel()).findByRole("button", { name: "Workshop A" });
      await queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
      await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
      expect(within(list()).getByRole("button", { name: "Workshop A" })).toBeInTheDocument();
      expect(within(list()).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
    });

    it("useGroups 500: role=alert in the panel; the My notes tab is unaffected", async () => {
      stubGroupsError([OWNER_NOTE]);
      renderNoteList({}, { tab: "workspace" });
      await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
      selectTab("My notes");
      expect(await within(panel()).findByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
      // The groups error sentence belongs to the Groups tab only and doesn't follow into My notes.
      expect(within(list()).queryByRole("alert")).toBeNull();
    });

    it("background refetch of groups fails (originally 0 groups): the alert coexists with the not-in-any-group-yet sentence", async () => {
      let groupsCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = (init?.method ?? "GET").toUpperCase();
          if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
          if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE]) }));
          if (url === "/api/groups" && method === "GET") {
            groupsCalls += 1;
            return groupsCalls === 1
              ? Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }))
              : Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }));
          }
          throw new Error(`unexpected fetch: ${method} ${url}`);
        }),
      );
      const { queryClient } = renderNoteList({}, { tab: "workspace" });
      await within(list()).findByText("You're not in any group yet.");
      await queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
      await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
      expect(within(list()).getByText("You're not in any group yet.")).toBeInTheDocument();
    });

    it("0 groups -> only the explanatory text; exactly one button named 'New group' in the whole DOM, inside the header row", async () => {
      stubNotesFetch([OWNER_NOTE], []);
      renderNoteList({}, { tab: "workspace" });
      expect(await within(list()).findByText("You're not in any group yet.")).toBeInTheDocument();
      const buttons = screen.getAllByRole("button", { name: "New group" });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.closest("[data-sidebar-header]")).not.toBeNull();
    });

    it("header '+' -> new group dialog; after creating, the new group row appears expanded and focus returns to the header '+'", async () => {
      let groups: GroupDto[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = (init?.method ?? "GET").toUpperCase();
          if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
          if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE]) }));
          if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
          if (url === "/api/groups" && method === "POST") {
            groups = [GROUP_A];
            return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(GROUP_A) }));
          }
          if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
          throw new Error(`unexpected fetch: ${method} ${url}`);
        }),
      );
      renderNoteList({}, { tab: "workspace" });
      await within(list()).findByText("You're not in any group yet.");
      const plus = within(header()).getByRole("button", { name: "New group" });
      plus.focus(); // fireEvent.click doesn't focus; a real person opens it by keyboard or by clicking it
      fireEvent.click(plus);
      const dialog = await screen.findByRole("dialog", { name: "New group" });
      fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Workshop A" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New group" })).not.toBeInTheDocument());
      expect(await within(panel()).findByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "true");
      await waitFor(() => expect(document.activeElement).toBe(plus));
    });
  });

  describe("Recent", () => {
    /** 25 notes: `updatedAt` increases in order (Note 0 oldest); Note 3 has the newest `lastEdited.at` and must sort first. */
    function manyNotes(): NoteDto[] {
      return Array.from({ length: 25 }, (_, i) => ({
        ...OWNER_NOTE,
        id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        title: `Note ${i}`,
        slug: `note-${i}`,
        updatedAt: new Date(Date.UTC(2026, 2, 1 + i)).toISOString(),
        lastEdited: i === 3 ? { at: "2026-06-01T00:00:00.000Z", byHandle: "x", agentLabel: null } : null,
      }));
    }

    it("25 notes -> 20 rows; ordered by last edit time (lastEdited.at and updatedAt interleaved)", async () => {
      stubNotesFetch(manyNotes());
      renderNoteList({}, { tab: "recent" });
      await within(panel()).findByRole("link", { name: startsWith("Note 24") });
      const rows = panel().querySelectorAll('[data-node-kind="note"]');
      expect(rows).toHaveLength(20);
      const titles = Array.from(rows).map((r) => r.querySelector("a div")?.textContent);
      expect(titles).toEqual(["Note 3", ...Array.from({ length: 19 }, (_, i) => `Note ${24 - i}`)]);
    });

    it("second line is the location (My notes, Groups with the group name, Shared with me with the role); group row accessible name = title + location; no role text; each row has a more menu", async () => {
      const mine = { ...OWNER_NOTE, updatedAt: "2026-03-03T00:00:00.000Z" };
      const group = { ...MY_GROUP_NOTE, updatedAt: "2026-03-02T00:00:00.000Z" };
      const shared = { ...SHARED_NOTE, updatedAt: "2026-03-01T00:00:00.000Z" };
      stubNotesFetch([shared, group, mine], [GROUP_A]);
      renderNoteList({}, { tab: "recent" });

      const groupLink = await within(panel()).findByRole("link", { name: startsWith("Mine In A") });
      await waitFor(() => expect(groupLink).toHaveAccessibleName("Mine In A Groups › Workshop A"));
      const lines = Array.from(panel().querySelectorAll('[data-node-kind="note"]')).map((row) => ({
        title: row.querySelector("a div:nth-child(1)")?.textContent,
        place: row.querySelector("a div:nth-child(2)")?.textContent,
      }));
      expect(lines).toEqual([
        { title: "Has A Slug", place: "My notes" },
        { title: "Mine In A", place: "Groups › Workshop A" },
        { title: "No Slug Note", place: "Shared with me · Editor" },
      ]);
      expect(within(panel()).queryByText("Editor")).toBeNull();
      expect(within(panel()).queryByText("Viewer")).toBeNull();
      for (const title of ["Has A Slug", "Mine In A", "No Slug Note"]) {
        expect(within(panel()).getByRole("button", { name: `Note actions for ${title}` })).toBeInTheDocument();
      }
    });

    it("long title: title and location elements truncate, link min-w-0 (both lines inside the Link, the more menu outside the Link)", async () => {
      stubNotesFetch([OWNER_NOTE]);
      renderNoteList({}, { tab: "recent" });
      const link = await within(panel()).findByRole("link", { name: startsWith("Has A Slug") });
      expect(link).toHaveClass("min-w-0", "py-1.5"); // padding is on the Link, so the touch target fills the row height
      expect(link.parentElement).not.toHaveClass("py-1");
      expect(link.children).toHaveLength(2);
      expect(link.children[1]).toHaveClass("mt-0.5");
      for (const line of Array.from(link.children)) expect(line).toHaveClass("truncate");
      const menu = within(noteRow(OWNER_NOTE.id)!).getByRole("button", { name: "Note actions for Has A Slug" });
      expect(link.contains(menu)).toBe(false);
    });

    it("#182: group notes in the Recent tab also carry no role (the location line is only Groups and the group name)", async () => {
      stubNotesFetch([MY_GROUP_NOTE, OTHERS_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "recent" });
      await within(panel()).findByRole("link", { name: startsWith("Mine In A") });
      expect(within(panel()).queryByText("Editor")).toBeNull();
      expect(within(panel()).queryByText("Viewer")).toBeNull();
    });
  });

  describe("empty states", () => {
    it("Recent with 0 notes -> No notes yet. plus the explanation", async () => {
      stubNotesFetch([], []);
      renderNoteList({}, { tab: "recent" });
      expect(await within(list()).findByText("No notes yet.")).toBeInTheDocument();
      expect(within(list()).getByText("Create your first note to get started.")).toBeInTheDocument();
    });

    it("My notes: 0 notes 0 groups -> the two-sentence EmptyState", async () => {
      stubNotesFetch([], []);
      renderNoteList();
      expect(await within(list()).findByText("No notes yet.")).toBeInTheDocument();
      expect(within(list()).getByText("Create your first note to get started.")).toBeInTheDocument();
    });

    it("My notes: 0 notes but has groups -> No personal notes yet. (not the EmptyState)", async () => {
      stubNotesFetch([], [GROUP_A]);
      renderNoteList();
      expect(await within(list()).findByText("No personal notes yet.")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
    });

    it("My notes: only others' notes (no personal notes) -> No personal notes yet.", async () => {
      stubNotesFetch([SHARED_NOTE], []);
      renderNoteList();
      expect(await within(list()).findByText("No personal notes yet.")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
    });

    it("My notes: 0 notes and /api/groups pending -> Loading... (not the EmptyState)", async () => {
      let notesFetched = false;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          if (String(input) === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
          if (String(input) === "/api/notes") {
            notesFetched = true;
            return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
          }
          return new Promise<Response>(() => {}); // /api/groups never resolves
        }),
      );
      renderNoteList();
      await waitFor(() => expect(notesFetched).toBe(true));
      // notes resolved but groups haven't arrived: still Loading...
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(within(list()).getByText("Loading…")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
      expect(screen.queryByText("No personal notes yet.")).not.toBeInTheDocument();
    });

    it("My notes: 0 notes and /api/groups 500 -> No personal notes yet., not the EmptyState", async () => {
      stubGroupsError([]);
      renderNoteList();
      expect(await within(list()).findByText("No personal notes yet.")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
    });

    it("Shared with me with 0 notes -> Nothing has been shared with you yet.", async () => {
      stubNotesFetch([OWNER_NOTE], []);
      renderNoteList({}, { tab: "shared" });
      expect(await within(list()).findByText("Nothing has been shared with you yet.")).toBeInTheDocument();
    });
  });

  it("node attributes: note rows have data-node-kind/data-node-id, group nodes have data-node-kind/data-node-id", async () => {
    stubNotesFetch([OWNER_NOTE, MY_GROUP_NOTE], [GROUP_A]);
    renderNoteList();
    await within(panel()).findByRole("link", { name: "Has A Slug" });
    expect(noteRow(OWNER_NOTE.id)).not.toBeNull();
    expect(noteRow(OWNER_NOTE.id)).toHaveAttribute("data-node-kind", "note");

    selectTab("Groups");
    await within(panel()).findByRole("button", { name: "Workshop A" });
    expect(groupNode(GROUP_A.id)).toHaveAttribute("data-node-kind", "group");
    expect(groupNode(GROUP_A.id)).toHaveAttribute("data-node-id", GROUP_A.id);
    expect(noteRow(MY_GROUP_NOTE.id)).toHaveAttribute("data-node-kind", "note");
  });

  it("switching tab swaps in a new list element (scroll position returns to top)", async () => {
    stubNotesFetch([OWNER_NOTE], [GROUP_A]);
    renderNoteList();
    await within(panel()).findByRole("link", { name: "Has A Slug" });
    const before = list();
    selectTab("Groups");
    expect(list()).not.toBe(before);
    expect(before.isConnected).toBe(false);
  });

  it("the top-level collapse is gone: an old sidebar.collapsed.myNotes=1 no longer collapses My notes, and the panel has no 'My notes' collapse button", async () => {
    localStorage.setItem("sidebar.collapsed.myNotes", "1");
    stubNotesFetch([OWNER_NOTE, THIRD_OWNER_NOTE]);
    renderNoteList();
    expect(await within(panel()).findByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    expect(within(panel()).getByRole("link", { name: "Third Owner Note" })).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: "My notes" })).toBeNull();
  });

  describe("aria-current", () => {
    it("active = group note: in the Groups tab that row has aria-current=page, exactly one in the whole DOM", async () => {
      stubNotesFetch([MY_GROUP_NOTE, OWNER_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace", activeId: MY_GROUP_NOTE.id });
      await within(panel()).findByRole("button", { name: "Workshop A" });
      const current = document.querySelectorAll('[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(groupNode(GROUP_A.id)).toContainElement(current[0] as HTMLElement);
    });

    it("active = personal note, in the Recent tab: the Recent row has aria-current=page", async () => {
      stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);
      renderNoteList({}, { tab: "recent", activeId: OWNER_NOTE.id });
      const link = await within(panel()).findByRole("link", { current: "page" });
      expect(link).toHaveAccessibleName(startsWith("Has A Slug"));
      expect(noteRow(OWNER_NOTE.id)).toContainElement(link);
      expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    });
  });

  it("order: the My notes panel follows server order (not sorted by title)", async () => {
    const zed: NoteDto = { ...OWNER_NOTE, id: "99999999-0000-0000-0000-000000000001", title: "Zed", slug: "zed" };
    const alpha: NoteDto = { ...OWNER_NOTE, id: "99999999-0000-0000-0000-000000000002", title: "Alpha", slug: "alpha" };
    stubNotesFetch([zed, alpha]);
    renderNoteList();
    await within(panel()).findByRole("link", { name: "Zed" });
    expect(Array.from(panel().querySelectorAll('[data-node-kind="note"] a')).map((a) => a.textContent)).toEqual(["Zed", "Alpha"]);
  });
});

// The existing stubNotesFetch throws on DELETE, and react-query swallows such a throw silently (the test wouldn't go red), so this writes its own stub that records every call;
// assert "which API was hit" always on `calls`.

function RowMenuLocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}|{JSON.stringify(location.state ?? null)}</div>;
}

function renderRowMenu(
  controls: NotePageControls | null,
  notes: NoteDto[] = [OWNER_NOTE, SHARED_NOTE],
  deleteFails = false,
  groups: GroupDto[] = [],
  tab?: SidebarTab,
) {
  if (tab) localStorage.setItem("sidebar.tab", tab);
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
      }
      if (url === "/api/favorites" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      // The group row's more menu (GroupMenu) gets its own id from useSession (only hit when groups are passed)
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
      }
      if (url.startsWith("/api/notes/") && method === "DELETE") {
        if (deleteFails) {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 403,
              json: () => Promise.resolve({ error: { code: "forbidden", message: "x" } }),
            }),
          );
        }
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      // Undo of the "moved to trash" toast (#181): treat the ids sent as restored successfully.
      if (url === "/api/trash/restore" && method === "POST") {
        const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
        const restored = notes.filter((n) => ids.includes(n.id));
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ restored, skipped: [] }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/somewhere"]}>
        <ActiveNoteProvider>
          <NotePageControlsContext.Provider value={controls}>
            <SidebarTabProvider>
              <SidebarTabList idBase="t" />
              <div role="tabpanel">
                <NoteList />
              </div>
            </SidebarTabProvider>
            <RowMenuLocationProbe />
            <Toaster />
          </NotePageControlsContext.Provider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

async function ownerRowTrigger(): Promise<HTMLElement> {
  return within(panel()).findByRole("button", { name: "Note actions for Has A Slug" });
}

async function openRowMenu(trigger: HTMLElement): Promise<HTMLElement> {
  // A Radix DropdownMenu trigger only listens to pointerdown.
  fireEvent.pointerDown(trigger, { button: 0 });
  return screen.findByRole("menu");
}

describe("note row more menu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("every row has one, the name includes the title; class = 24px + hover float-in (class assertion, not behaviour: jsdom has no CSS/hover)", async () => {
    renderRowMenu(null);
    const trigger = await ownerRowTrigger();
    const row = trigger.closest("li") as HTMLElement;
    expect(row).toHaveClass("group/noterow");
    expect(trigger).toHaveClass(
      "h-6",
      "w-6",
      "opacity-0",
      "focus-visible:opacity-100",
      "[@media(hover:none)]:opacity-100",
      "data-[state=open]:opacity-100",
      "group-hover/noterow:opacity-100",
      "group-has-[:focus-visible]/noterow:opacity-100",
    );
    // Owner rows have no badge: the more menu immediately follows the title link; the star is to its right (the rightmost slot) only after the favorites list loads, before which the more menu is the last child.
    expect(trigger.previousElementSibling).toBe(row.querySelector("a"));
    const last = row.lastElementChild!.previousElementSibling;
    expect(last === trigger || last?.getAttribute("aria-pressed") !== null).toBe(true);
    expect(within(panel()).getAllByRole("button", { name: "Note actions for Has A Slug" })).toHaveLength(1);

    // Shared-with-me (editor) row: order = title, more menu, star (the star exists only after the favorites list loads, rightmost slot); with a star the more menu floats one slot left of it.
    selectTab("Shared with me");
    const sharedTrigger = within(panel()).getByRole("button", { name: "Note actions for No Slug Note" });
    const star = await within(panel()).findByRole("button", { name: "Favorite" });
    expect(sharedTrigger.previousElementSibling).toBe(sharedTrigger.closest("li")!.querySelector("a"));
    expect(sharedTrigger.nextElementSibling).toBe(star);
    expect(star.className).not.toContain("me-7");
    expect(sharedTrigger.closest("li")?.lastElementChild).toBe(star.nextElementSibling);
  });

  it("when the menu is open the trigger has data-state=open (the hover float-in stays while open relies on it; the CSS taking effect needs a browser)", async () => {
    renderRowMenu(null);
    const trigger = await ownerRowTrigger();
    expect(trigger).toHaveAttribute("data-state", "closed");
    await openRowMenu(trigger);
    expect(trigger).toHaveAttribute("data-state", "open");
  });

  it("another note: AI edit history -> navigates to that note with {openEdits:true}", async () => {
    renderRowMenu(null);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent('/n/owner-one/custom-slug|{"openEdits":true}'),
    );
  });

  it("another note: move to trash -> no confirm, DELETE sent, no navigation, toast has Undo", async () => {
    const { calls } = renderRowMenu(null);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
    // An `await waitFor(...)` must come before the position assertion: without it the wrong implementation that adds an extra navigate("/") after deleting survives.
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/notes")).toHaveLength(2));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/somewhere\|null$/);
  });

  it("another note: pressing the toast's Undo -> restore sent, URL unchanged (it isn't the open note, so don't navigate there)", async () => {
    const { calls } = renderRowMenu(null);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(calls).toContain("POST /api/trash/restore");
    // After undo the list invalidates and refetches (the 3rd GET /api/notes) - wait for it to land before looking at the URL, so an extra navigate would already have taken effect.
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/notes")).toHaveLength(3));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/somewhere\|null$/);
  });

  it("another note: delete fails (403) -> error toast, no 'moved to trash', no navigation", async () => {
    const { calls } = renderRowMenu(null, [OWNER_NOTE, SHARED_NOTE], true);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("You don't have permission to do that.")).toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
    // An `await waitFor(...)` must come before the position assertion: without it the wrong implementation that adds an extra navigate("/") after deleting survives.
    await waitFor(() => expect(true).toBe(true));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/somewhere\|null$/);
  });

  it("deleting another note successfully invalidates all backlinks queries (deleting B while staying on page A must not leave B's chip at the bottom of A)", async () => {
    const { queryClient } = renderRowMenu(null);
    // Simulates the backlinks cache of the currently open page A (key shape as in useBacklinks).
    queryClient.setQueryData(["backlinks", SHARED_NOTE.id], []);
    expect(queryClient.getQueryState(["backlinks", SHARED_NOTE.id])?.isInvalidated).toBe(false);

    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(queryClient.getQueryState(["backlinks", SHARED_NOTE.id])?.isInvalidated).toBe(true);
  });

  it("the open note is another one (controls.noteId differs from this row): AI edit history navigates to this row's note and doesn't call openEdits; delete doesn't touch leavingRef and doesn't navigate", async () => {
    const openEdits = vi.fn();
    const leavingRef = { current: false };
    const { calls } = renderRowMenu({
      noteId: SHARED_NOTE.id,
      state: { phase: "connected", role: "editor" },
      leavingRef,
      openEdits,
    });

    let menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent('/n/owner-one/custom-slug|{"openEdits":true}'),
    );
    expect(openEdits).not.toHaveBeenCalled();

    menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(leavingRef.current).toBe(false);
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/notes")).toHaveLength(2));
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
    expect(leavingRef.current).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/owner-one\/custom-slug\|/);
  });

  it("the open note (controls.noteId equal): AI edit history calls controls.openEdits, no navigation; delete sets leavingRef before DELETE, on success returns to /", async () => {
    const openEdits = vi.fn();
    const leavingRef = { current: false };
    const { calls } = renderRowMenu({
      noteId: OWNER_NOTE.id,
      state: { phase: "connected", role: "owner" },
      leavingRef,
      openEdits,
    });

    let menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));
    expect(openEdits).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByTestId("location")).toHaveTextContent("/somewhere|null");

    menu = await openRowMenu(await ownerRowTrigger());
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    // Synchronous: the handler's first line sets the gate (before the DELETE response).
    expect(leavingRef.current).toBe(true);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/\|null$/));
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
  });

  // #175: the sidebar more menu and the page header share NoteMenuCore, but the list row's `permissions` comes from the grouped branch of `GET /api/notes`:
  // a different data path, so each is pinned on the list row.
  it("#175: a group note row (role editor, permissions.delete true) has 'Delete' in its more menu, pressing it sends DELETE", async () => {
    const deletable = groupNote(
      { id: "77777777-7777-7777-7777-777777777777", title: "Group Deletable", slug: "group-deletable", groupId: GROUP_A.id, groupName: GROUP_A.name },
      "editor",
      { ...EDITOR_PERMS, delete: true },
    );
    const { calls } = renderRowMenu(null, [deletable], false, [GROUP_A], "workspace");
    const menu = await openRowMenu(await within(panel()).findByRole("button", { name: "Note actions for Group Deletable" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(calls).toContain(`DELETE /api/notes/${deletable.id}`));
  });

  it("#175: the same kind of group note row with permissions.delete false -> no 'Delete' in the more menu (other items as usual)", async () => {
    const notDeletable = groupNote(
      { id: "88888888-8888-8888-8888-888888888888", title: "Group Kept", slug: "group-kept", groupId: GROUP_A.id, groupName: GROUP_A.name },
      "editor",
      { ...EDITOR_PERMS, delete: false },
    );
    renderRowMenu(null, [notDeletable], false, [GROUP_A], "workspace");
    const menu = await openRowMenu(await within(panel()).findByRole("button", { name: "Note actions for Group Kept" }));
    expect(within(menu).getByRole("menuitem", { name: "AI edit history" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("Recent tab rows also have a more menu (a sibling outside the Link), move to trash sends DELETE as usual", async () => {
    const { calls } = renderRowMenu(null, [OWNER_NOTE], false, [], "recent");
    const trigger = await within(panel()).findByRole("button", { name: "Note actions for Has A Slug" });
    const menu = await openRowMenu(trigger);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`));
  });
});

describe("NoteList - folder tree", () => {
  const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
  const FOLDERS: FolderDto[] = [
    folderDto({ id: "B", name: "B" }),
    folderDto({ id: "A1", name: "A1", parentId: "A" }),
    folderDto({ id: "A", name: "A" }),
    groupFolder({ id: "GF", name: "GF", groupId: "G" }),
    groupFolder({ id: "GF2", name: "GF2", groupId: "G", create: false }),
    sharedFolder({ id: "SF", name: "SF" }),
  ];
  const P1 = personalNote({ id: "p1", title: "P1", folderId: "A" });
  const P2 = personalNote({ id: "p2", title: "P2", folderId: "A1" });
  const P3 = personalNote({ id: "p3", title: "P3" });
  const G1 = selGroupNote({ id: "g1", title: "G1", group: G, folderId: "GF" });
  const G2 = selGroupNote({ id: "g2", title: "G2", group: G });
  const S1 = sharedNote({ id: "s1", title: "S1", folderId: "SF" });
  const S2 = sharedNote({ id: "s2", title: "S2" });
  const NOTES = [P1, P2, P3, G1, G2, S1, S2];

  type FolderReply = FolderDto[] | "error" | Promise<FolderDto[]>;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function stubTree(opts: { notes?: NoteDto[]; folders?: FolderReply } = {}) {
    const folders = opts.folders ?? FOLDERS;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders") {
          if (folders === "error") return Promise.resolve(json({ error: { code: "internal", message: "boom" } }, 500));
          if (folders instanceof Promise) return folders.then((list) => json({ folders: list }));
          return Promise.resolve(json({ folders }));
        }
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json(opts.notes ?? NOTES));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  const folderRow = (id: string, root: HTMLElement = panel()) =>
    root.querySelector(`[data-node-kind="folder"][data-node-id="${id}"]`) as HTMLElement | null;
  const ids = (ul: Element | null | undefined) => Array.from(ul?.children ?? []).map((li) => li.getAttribute("data-node-id"));
  const topIds = () => ids(list().firstElementChild?.querySelector(":scope > ul"));
  const childIds = (row: HTMLElement | null) => ids(row?.querySelector(":scope > div > ul"));
  const mainButton = (id: string, root?: HTMLElement) => folderRow(id, root)!.querySelector(":scope > div > button[aria-expanded]") as HTMLElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("my notes: first level A, B, p3; under A: A1, p1; under A1: p2; main button aria-expanded, accessible name is only the name, icon aria-hidden, title, row height h-11 pointer-fine:h-7", async () => {
    stubTree();
    renderNoteList();
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(topIds()).toEqual(["A", "B", "p3"]);
    expect(childIds(folderRow("A"))).toEqual(["A1", "p1"]);
    expect(childIds(folderRow("A1"))).toEqual(["p2"]);
    const button = within(folderRow("A")!).getByRole("button", { name: "A" });
    expect(button).toBe(mainButton("A"));
    expect(button).toHaveAttribute("aria-expanded", "true");
    const icons = button.querySelectorAll("svg");
    expect(icons.length).toBe(2);
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(button.querySelector('[title="A"]')).toHaveTextContent("A");
    expect(button).toHaveClass("font-medium");
    expect(folderRow("A")!.firstElementChild).toHaveClass("h-11", "pointer-fine:h-7");
    expect(folderRow("A")!.firstElementChild).not.toHaveClass("md:h-7");
  });

  it("Groups tab: under G are GF, GF2 (folders) and g2; under GF is g1; guide-line classes verbatim", async () => {
    stubTree();
    renderNoteList({}, { tab: "workspace" });
    await waitFor(() => expect(folderRow("GF")).not.toBeNull());
    expect(ids(groupNode("G")!.querySelector(":scope > div > ul"))).toEqual(["GF", "GF2", "g2"]);
    expect(childIds(folderRow("GF"))).toEqual(["g1"]);
    expect(folderRow("GF")!.lastElementChild!.className).toBe("ml-[15px] border-l border-muted-foreground/35 pl-2");
  });

  it("Shared with me: root SF, s2; under SF is s1", async () => {
    stubTree();
    renderNoteList({}, { tab: "shared" });
    await waitFor(() => expect(folderRow("SF")).not.toBeNull());
    expect(topIds()).toEqual(["SF", "s2"]);
    expect(childIds(folderRow("SF"))).toEqual(["s1"]);
  });

  it("collapse: writes sidebar.collapsed.folder:A, children leave the DOM; still collapsed after unmounting and remounting on the same QueryClient", async () => {
    stubTree();
    const { view, queryClient } = renderNoteList();
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    fireEvent.click(mainButton("A"));
    expect(localStorage.getItem("sidebar.collapsed.folder:A")).toBe("1");
    expect(mainButton("A")).toHaveAttribute("aria-expanded", "false");
    expect(folderRow("A1")).toBeNull();
    expect(noteRow("p1")).toBeNull();
    view.unmount();
    renderNoteList({}, { queryClient });
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(mainButton("A")).toHaveAttribute("aria-expanded", "false");
    expect(folderRow("A1")).toBeNull();
  });

  it("static card and drawer both in the DOM: toggling one syncs both", async () => {
    stubTree();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-sidebar-instance="" data-testid="inst-1">
                <NoteList />
              </div>
              <div data-sidebar-instance="" data-testid="inst-2">
                <NoteList />
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const one = screen.getByTestId("inst-1");
    const two = screen.getByTestId("inst-2");
    await waitFor(() => expect(folderRow("A", two)).not.toBeNull());
    fireEvent.click(mainButton("A", one));
    expect(mainButton("A", one)).toHaveAttribute("aria-expanded", "false");
    expect(mainButton("A", two)).toHaveAttribute("aria-expanded", "false");
    expect(within(two).queryByText("P1")).toBeNull();
  });

  it("empty folder expanded -> one 'No notes' line in its children; a folder with only subfolders doesn't show the line", async () => {
    stubTree({ folders: [...FOLDERS, folderDto({ id: "C", name: "C" }), folderDto({ id: "C1", name: "C1", parentId: "C" })] });
    renderNoteList();
    await waitFor(() => expect(folderRow("B")).not.toBeNull());
    expect(folderRow("B")!.lastElementChild).toHaveTextContent("No notes");
    expect(folderRow("C")!.querySelector(":scope > div > p")).toBeNull();
    expect(childIds(folderRow("C"))).toEqual(["C1"]);
    expect(within(folderRow("A")!.lastElementChild as HTMLElement).queryByText("No notes")).toBeNull();
  });

  it("'Create note in X': personal (undefined, A), group folder (G, GF); shared folders and group folders that can't create don't have this button", async () => {
    stubTree();
    const onCreateNote = vi.fn();
    renderNoteList({ onCreateNote });
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    const add = within(folderRow("A")!.firstElementChild as HTMLElement).getByRole("button", { name: "New note in A" });
    expect(add.className).toContain("group-hover/folderrow:opacity-100");
    fireEvent.click(add);
    expect(onCreateNote).toHaveBeenLastCalledWith(undefined, "A");

    selectTab("Groups");
    await waitFor(() => expect(folderRow("GF")).not.toBeNull());
    fireEvent.click(within(folderRow("GF")!.firstElementChild as HTMLElement).getByRole("button", { name: "New note in GF" }));
    expect(onCreateNote).toHaveBeenLastCalledWith("G", "GF");
    expect(within(folderRow("GF2")!.firstElementChild as HTMLElement).queryByRole("button", { name: "New note in GF2" })).toBeNull();

    selectTab("Shared with me");
    await waitFor(() => expect(folderRow("SF")).not.toBeNull());
    expect(within(folderRow("SF")!.firstElementChild as HTMLElement).queryByRole("button", { name: "New note in SF" })).toBeNull();
  });

  it("waiting for folders: while pending My notes, Groups and Shared with me show Loading...; the Recent tab is as usual; after release the tree appears", async () => {
    let release: (list: FolderDto[]) => void = () => {};
    stubTree({ folders: new Promise<FolderDto[]>((resolve) => (release = resolve)) });
    const { queryClient } = renderNoteList();
    // Conditional wait: notes and groups are already in the cache, so a Loading... seen afterwards can only be waiting for folders (no fixed milliseconds).
    await waitFor(() => expect(queryClient.getQueryData(["notes"])).toBeDefined());
    await waitFor(() => expect(queryClient.getQueryData(GROUPS_QUERY_KEY)).toBeDefined());
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    expect(noteRow("p1")).toBeNull();
    selectTab("Groups");
    // Not flattened even though groups arrived: the group's root g2 doesn't appear.
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    expect(noteRow("g2")).toBeNull();
    selectTab("Shared with me");
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    expect(noteRow("s2")).toBeNull();
    selectTab("Recent");
    await waitFor(() => expect(noteRow("p1")).not.toBeNull());
    selectTab("My notes");
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    release(FOLDERS);
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(childIds(folderRow("A"))).toEqual(["A1", "p1"]);
  });

  it("folders fail: the list has role=alert, p1/p2/p3 are all at the root (no crash)", async () => {
    stubTree({ folders: "error" });
    renderNoteList();
    await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent(i18n.t("errors.internal")));
    expect(folderRow("A")).toBeNull();
    expect(topIds()).toEqual(["p1", "p2", "p3"]);
  });

  it("the notes list itself failing shows only one error (the folders' isn't stacked)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ error: { code: "internal", message: "boom" } }, 500))),
    );
    renderNoteList();
    await waitFor(() => expect(within(list()).getAllByRole("alert")).toHaveLength(1));
  });

  it("fallback: folderId pointing to a nonexistent folder -> root", async () => {
    stubTree({ notes: [...NOTES, personalNote({ id: "p4", title: "P4", folderId: "gone" })] });
    renderNoteList();
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(topIds()).toEqual(["A", "B", "p3", "p4"]);
  });

  it("sort takes effect: after setFolderSort(A, name) without remounting, the notes inside A reorder", async () => {
    const older = personalNote({ id: "pa", title: "Alpha", folderId: "B", updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = personalNote({ id: "pb", title: "Beta", folderId: "B", updatedAt: "2026-03-01T00:00:00.000Z" });
    stubTree({ notes: [...NOTES, older, newer] });
    renderNoteList();
    await waitFor(() => expect(folderRow("B")).not.toBeNull());
    expect(childIds(folderRow("B"))).toEqual(["pb", "pa"]);
    act(() => {
      setFolderSort("B", "name");
    });
    expect(childIds(folderRow("B"))).toEqual(["pa", "pb"]);
  });

  it("Recent tab path line: p2's second line is the path My notes, A, A1 (title has the same text)", async () => {
    stubTree();
    renderNoteList({}, { tab: "recent" });
    await waitFor(() => expect(noteRow("p2")?.querySelector('[title="My notes › A › A1"]')).toHaveTextContent("My notes › A › A1"));
  });

  it("list wrapper: [data-sidebar-list] has exactly one child, which carries overflow-x-clip px-2; the list itself doesn't", async () => {
    stubTree();
    renderNoteList();
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(list().children).toHaveLength(1);
    expect(list().firstElementChild).toHaveClass("overflow-x-clip", "px-2");
    expect(list()).not.toHaveClass("overflow-x-clip");
    expect(list()).not.toHaveClass("px-2");
  });
});

describe("NoteList - new folder entry", () => {
  const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
  const R: GroupDto = groupDto({ id: "R", name: "R" }, customRole());

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function stubCreate() {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders" && method === "POST") {
          posts.push(JSON.parse(String(init?.body)));
          return Promise.resolve(json(folderDto({ id: "new", name: "New one" }), 201));
        }
        if (url === "/api/folders") return Promise.resolve(json({ folders: [] }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json([OWNER_NOTE]));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G, R]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return posts;
  }

  const headerNames = () => within(header()).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
  const rowNames = (id: string) =>
    Array.from(groupNode(id)!.querySelector(":scope > div")!.querySelectorAll("button")).map((button) => button.getAttribute("aria-label") ?? button.textContent);

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("My notes header row in order: Select, New folder, New personal note; New folder has the folder-plus icon, 24px; Shared with me: Select, New folder; Groups: Select, New group", async () => {
    stubCreate();
    renderNoteList();
    await within(panel()).findByRole("link", { name: OWNER_NOTE.title });
    expect(headerNames()).toEqual(["Select", "New folder", "New personal note"]);
    const newFolder = within(header()).getByRole("button", { name: "New folder" });
    expect(newFolder.querySelector('svg[data-icon="folder-plus"]')).not.toBeNull();
    expect(newFolder).toHaveClass("h-6", "w-6");
    selectTab("Shared with me");
    expect(headerNames()).toEqual(["Select", "New folder"]);
    selectTab("Groups");
    expect(headerNames()).toEqual(["Select", "New group"]);
  });

  it("pressing New folder -> dialog (lazy) -> submit with body space: personal", async () => {
    const posts = stubCreate();
    renderNoteList();
    await within(panel()).findByRole("link", { name: OWNER_NOTE.title });
    fireEvent.click(within(header()).getByRole("button", { name: "New folder" }));
    const input = await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.change(input, { target: { value: "Plans" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts).toEqual([{ name: "Plans", space: { kind: "personal" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Shared with me: pressing New folder -> dialog (lazy) -> submit with body space: shared", async () => {
    const posts = stubCreate();
    renderNoteList({}, { tab: "shared" });
    await waitFor(() => expect(within(header()).getByText("Shared with me")).toBeInTheDocument());
    fireEvent.click(within(header()).getByRole("button", { name: "New folder" }));
    const input = await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.change(input, { target: { value: "Inbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts).toEqual([{ name: "Inbox", space: { kind: "shared" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("group row 'New folder in G': renders only with edit, before 'New note in G', floats in on hover; submit with body space: group G", async () => {
    const posts = stubCreate();
    renderNoteList({}, { tab: "workspace" });
    await waitFor(() => expect(groupNode("G")).not.toBeNull());
    const names = rowNames("G");
    expect(names.indexOf("New folder in G")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("New folder in G")).toBeLessThan(names.indexOf("New note in G"));
    expect(rowNames("R")).not.toContain("New folder in R");
    const button = within(groupNode("G")!).getByRole("button", { name: "New folder in G" });
    expect(button.className).toContain("group-hover/grouprow:opacity-100");
    fireEvent.click(button);
    fireEvent.change(await screen.findByRole("textbox", { name: "Folder name" }), { target: { value: "Reports" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts).toEqual([{ name: "Reports", space: { kind: "group", groupId: "G" } }]));
  });
});

describe("NoteList - favorites", () => {
  const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
  const FOLDERS: FolderDto[] = [folderDto({ id: "A", name: "A" })];
  const IN_FOLDER = personalNote({ id: "fav-in-folder", title: "Alpha", folderId: "A" });
  const LOOSE = personalNote({ id: "fav-loose", title: "Beta" });
  const GROUPED = selGroupNote({ id: "fav-grouped", title: "Gamma", group: G });
  const SHARED = sharedNote({ id: "fav-shared", title: "Delta", role: "viewer" });
  /** The note that comes back mid-case (restored, regained read access). */
  const BACK = selGroupNote({ id: "back", title: "Back", group: G });
  const NO_FLAGS: GroupRoleFlags = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };

  const fav = (noteId: string, favoritedAt: string): FavoriteDto => ({ noteId, favoritedAt });
  const T1 = "2026-03-01T00:00:00.000Z";
  const T2 = "2026-03-02T00:00:00.000Z";
  const T3 = "2026-03-03T00:00:00.000Z";

  type Reply<T> = T | "error" | "pending";

  /** Fake server: fields can change mid-case and the next refetch returns the new value. `calls` records each `METHOD url`. */
  interface FakeServer {
    notes: NoteDto[];
    favorites: Reply<FavoriteDto[]>;
    folders: Reply<FolderDto[]>;
    calls: string[];
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  const boom = () => json({ error: { code: "internal", message: "boom" } }, 500);

  function stubServer(init: Partial<Omit<FakeServer, "calls">> = {}): FakeServer {
    const server: FakeServer = {
      notes: [IN_FOLDER, LOOSE, GROUPED, SHARED],
      favorites: [fav(SHARED.id, T3), fav(GROUPED.id, T2), fav(IN_FOLDER.id, T1)],
      folders: FOLDERS,
      calls: [],
      ...init,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        server.calls.push(`${method} ${url}`);
        if (url === "/api/folders" && method === "GET") {
          if (server.folders === "pending") return new Promise<Response>(() => {});
          if (server.folders === "error") return Promise.resolve(boom());
          return Promise.resolve(json({ folders: server.folders }));
        }
        if (url === "/api/favorites" && method === "GET") {
          if (server.favorites === "pending") return new Promise<Response>(() => {});
          if (server.favorites === "error") return Promise.resolve(boom());
          return Promise.resolve(json(server.favorites));
        }
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json(server.notes));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
        if (url === "/api/groups/G/roles/r1" && method === "PATCH") return Promise.resolve(json(customRole({ id: "r1" })));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return server;
  }

  const rowIds = () => Array.from(panel().querySelectorAll('[data-node-kind="note"]')).map((row) => row.getAttribute("data-node-id"));
  const favoritesGets = (server: FakeServer) => server.calls.filter((call) => call === "GET /api/favorites").length;

  /** Takes the two group-invalidation hooks inside render, so a case can call them without remounting. */
  interface GroupHooks {
    invalidateGroupsAndNotes: () => void;
    updateRole: ReturnType<typeof useUpdateRole>["mutateAsync"];
  }
  function GroupHooksProbe({ into }: { into: { current: GroupHooks | null } }) {
    const invalidateGroupsAndNotes = useInvalidateGroupsAndNotes();
    const updateRole = useUpdateRole("G").mutateAsync;
    useEffect(() => {
      into.current = { invalidateGroupsAndNotes, updateRole };
    });
    return null;
  }

  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("phone font size: two-line rows have title 15px, second line 12px (desktop 13/11 unchanged)", async () => {
    stubServer({ favorites: [fav(SHARED.id, T3)] });
    renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(noteRow(SHARED.id)).not.toBeNull());
    const link = noteRow(SHARED.id)!.querySelector("a")!;
    expect(link.children[0]).toHaveClass("text-[13px]", "max-sm:text-[15px]");
    expect(link.children[1]).toHaveClass("text-[11px]", "max-sm:text-xs");
  });

  it("lists the intersection of favorites and notes, in favorites order; each row has two lines, the second = noteLocationLabel", async () => {
    stubServer({ favorites: [fav(SHARED.id, T3), fav("gone", T3), fav(GROUPED.id, T2), fav(IN_FOLDER.id, T1)] });
    renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(noteRow(GROUPED.id)?.querySelector("a div:nth-child(2)")).toHaveTextContent("Groups › G"));
    expect(rowIds()).toEqual([SHARED.id, GROUPED.id, IN_FOLDER.id]);
    const location = { groupIds: new Set([G.id]), folders: indexFolders(FOLDERS) };
    const lines = [SHARED, GROUPED, IN_FOLDER].map((note) => {
      const link = noteRow(note.id)!.querySelector("a")!;
      expect(link.children).toHaveLength(2);
      return { title: link.children[0]!.textContent, place: link.children[1]!.textContent, expected: noteLocationLabel(note, location, i18n.t) };
    });
    expect(lines).toEqual([
      { title: "Delta", place: "Shared with me · Viewer", expected: "Shared with me · Viewer" },
      { title: "Gamma", place: "Groups › G", expected: "Groups › G" },
      { title: "Alpha", place: "My notes › A", expected: "My notes › A" },
    ]);
    expect(panel().querySelector('[data-node-kind="folder"], [data-node-kind="group"]')).toBeNull();
  });

  it("favorites pending -> Loading...", async () => {
    stubServer({ favorites: "pending" });
    const { queryClient } = renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(queryClient.getQueryData(["notes"])).toBeDefined());
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    expect(rowIds()).toEqual([]);
  });

  it("favorites fail with no old data -> role=alert", async () => {
    stubServer({ favorites: "error" });
    renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent(i18n.t("errors.internal")));
    expect(rowIds()).toEqual([]);
  });

  it("empty intersection -> empty-state sentence (favorites is empty, or has records that are all not in notes)", async () => {
    const empty = "No favorites yet. Click the star at the top of a note, or choose Add to favorites in its ⋮ menu.";
    stubServer({ favorites: [] });
    const first = renderNoteList({}, { tab: "favorites" });
    expect(await within(list()).findByText(empty)).toBeInTheDocument();
    first.view.unmount();

    stubServer({ favorites: [fav("gone-1", T2), fav("gone-2", T1)] });
    const { queryClient } = renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(queryClient.getQueryData(FAVORITES_QUERY_KEY)).toHaveLength(2));
    expect(await within(list()).findByText(empty)).toBeInTheDocument();
  });

  it("background refetch fails with old data -> the old list stays, no alert", async () => {
    const server = stubServer();
    const { queryClient } = renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(rowIds()).toEqual([SHARED.id, GROUPED.id, IN_FOLDER.id]));
    server.favorites = "error";
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: FAVORITES_QUERY_KEY });
    });
    await waitFor(() => expect(queryClient.getQueryState(FAVORITES_QUERY_KEY)?.status).toBe("error"));
    expect(rowIds()).toEqual([SHARED.id, GROUPED.id, IN_FOLDER.id]);
    expect(within(list()).queryByRole("alert")).toBeNull();
  });

  it("doesn't wait for ['folders']: with folders pending it lists as usual, no Loading...", async () => {
    stubServer({ folders: "pending" });
    renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(rowIds()).toEqual([SHARED.id, GROUPED.id, IN_FOLDER.id]));
    expect(within(list()).queryByText("Loading…")).toBeNull();
  });

  it("header row has only select, no new-folder or new-note button; under a fine pointer drag doesn't take over either (the same observation on the My notes tab would take over)", async () => {
    mockFinePointer(true);
    stubServer();
    renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(rowIds()).toEqual([SHARED.id, GROUPED.id, IN_FOLDER.id]));
    expect(within(header()).queryAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Select"]);
    expect(within(panel()).queryByRole("button", { name: "New folder" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "New personal note" })).toBeNull();

    const favoritesDrag = createFakeDataTransfer(["text/uri-list", "text/plain"]);
    fireEvent.dragStart(noteRow(IN_FOLDER.id)!.querySelector("a")!, { dataTransfer: favoritesDrag });
    expect(favoritesDrag.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());

    selectTab("My notes");
    await waitFor(() => expect(noteRow(LOOSE.id)).not.toBeNull());
    const myNotesDrag = createFakeDataTransfer(["text/uri-list", "text/plain"]);
    fireEvent.dragStart(noteRow(LOOSE.id)!.querySelector("a")!, { dataTransfer: myNotesDrag });
    expect(myNotesDrag.setData).toHaveBeenCalledWith(DRAG_NOTE_MIME, LOOSE.id);
  });

  it("every tab shares the same GET /api/favorites: switching tab doesn't hit it again", async () => {
    const server = stubServer();
    renderNoteList();
    await waitFor(() => expect(noteRow(LOOSE.id)).not.toBeNull());
    await waitFor(() => expect(favoritesGets(server)).toBe(1));
    selectTab("Recent");
    await waitFor(() => expect(noteRow(LOOSE.id)).not.toBeNull());
    selectTab("Shared with me");
    await waitFor(() => expect(noteRow(SHARED.id)).not.toBeNull());
    selectTab("Favorites");
    await waitFor(() => expect(rowIds()).toEqual([SHARED.id, GROUPED.id, IN_FOLDER.id]));
    expect(favoritesGets(server)).toBe(1);
  });

  it("the favorites list has no staleTime: a window regaining focus refetches", async () => {
    const server = stubServer();
    renderNoteList({}, { tab: "favorites" });
    await waitFor(() => expect(rowIds()).toEqual([SHARED.id, GROUPED.id, IN_FOLDER.id]));
    expect(favoritesGets(server)).toBe(1);
    try {
      act(() => focusManager.setFocused(true));
      await waitFor(() => expect(favoritesGets(server)).toBe(2));
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  describe("a note that comes back appears without remounting (['favorites'] was already refetched before and doesn't contain it)", () => {
    /** Precondition: BACK is in neither favorites query; the server is then switched to a response containing BACK. */
    async function setup() {
      const server = stubServer({ favorites: [fav(LOOSE.id, T1)] });
      const hooks: { current: GroupHooks | null } = { current: null };
      const { queryClient } = renderNoteList({}, { tab: "favorites", extra: <GroupHooksProbe into={hooks} /> });
      await waitFor(() => expect(rowIds()).toEqual([LOOSE.id]));
      await waitFor(() => expect(hooks.current).not.toBeNull());
      server.notes = [...server.notes, BACK];
      server.favorites = [fav(BACK.id, T2), fav(LOOSE.id, T1)];
      return { queryClient, hooks: hooks as { current: GroupHooks } };
    }

    it("invalidateTrashRelated (restore)", async () => {
      const { queryClient } = await setup();
      act(() => invalidateTrashRelated(queryClient, [BACK.id]));
      await waitFor(() => expect(rowIds()).toEqual([BACK.id, LOOSE.id]));
    });

    it("useInvalidateGroupsAndNotes (joining a group etc.)", async () => {
      const { hooks } = await setup();
      act(() => hooks.current.invalidateGroupsAndNotes());
      await waitFor(() => expect(rowIds()).toEqual([BACK.id, LOOSE.id]));
    });

    it("useUpdateRole succeeds (role changed back to readable)", async () => {
      const { hooks } = await setup();
      await act(async () => {
        await hooks.current.updateRole({ roleId: "r1", permissions: NO_FLAGS });
      });
      await waitFor(() => expect(rowIds()).toEqual([BACK.id, LOOSE.id]));
    });
  });
});

describe("NoteList - star on the row", () => {
  const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
  const FOLDERS: FolderDto[] = [folderDto({ id: "A", name: "A" })];
  const IN_FOLDER = personalNote({ id: "star-in-folder", title: "Alpha", folderId: "A" });
  const LOOSE = personalNote({ id: "star-loose", title: "Beta" });
  const GROUPED = selGroupNote({ id: "star-grouped", title: "Gamma", group: G });
  const SHARED = sharedNote({ id: "star-shared", title: "Delta", role: "viewer" });
  const NOTES = [IN_FOLDER, LOOSE, GROUPED, SHARED];
  const T1 = "2026-03-01T00:00:00.000Z";

  type Reply<T> = T | "error" | "pending";
  interface StarServer {
    favorites: Reply<FavoriteDto[]>;
    /** Response to PUT /api/favorites/:id: `"pending"` = never replies. */
    put: "ok" | "pending";
    calls: string[];
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  function stubStars(init: Partial<Omit<StarServer, "calls">> = {}): StarServer {
    const server: StarServer = { favorites: [{ noteId: LOOSE.id, favoritedAt: T1 }], put: "ok", calls: [], ...init };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
        const url = String(input);
        const method = (request?.method ?? "GET").toUpperCase();
        server.calls.push(`${method} ${url}`);
        if (url === "/api/folders" && method === "GET") return Promise.resolve(json({ folders: FOLDERS }));
        if (url === "/api/favorites" && method === "GET") {
          if (server.favorites === "pending") return new Promise<Response>(() => {});
          if (server.favorites === "error") return Promise.resolve(json({ error: { code: "internal", message: "boom" } }, 500));
          return Promise.resolve(json(server.favorites));
        }
        if (/^\/api\/favorites\/.+/.test(url) && method === "PUT") {
          if (server.put === "pending") return new Promise<Response>(() => {});
          return Promise.resolve(json({ noteId: url.split("/").pop(), favoritedAt: T1 }));
        }
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json(NOTES));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return server;
  }

  const stars = () => within(panel()).queryAllByRole("button", { name: "Favorite" });
  const starOf = (id: string) => within(noteRow(id)!).queryByRole("button", { name: "Favorite" });
  const favoritesGets = (server: StarServer) => server.calls.filter((call) => call === "GET /api/favorites").length;

  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["recent", [IN_FOLDER, LOOSE, GROUPED, SHARED]],
    ["favorites", [LOOSE]],
    ["myNotes", [IN_FOLDER, LOOSE]],
    ["workspace", [GROUPED]],
    ["shared", [SHARED]],
  ] as const)("%s tab: every note row has a star, its state = whether it is in favorites", async (tab, expected) => {
    stubStars();
    renderNoteList({}, { tab });
    await waitFor(() => expect(stars().length).toBe(expected.length));
    for (const note of expected) {
      expect(starOf(note.id), note.title).toHaveAttribute("aria-pressed", note.id === LOOSE.id ? "true" : "false");
    }
  });

  it("folder rows and group rows have no star (only note rows do)", async () => {
    stubStars();
    renderNoteList({}, { tab: "workspace" });
    await waitFor(() => expect(groupNode("G")).not.toBeNull());
    await waitFor(() => expect(stars().length).toBe(1));
    expect(within(groupNode("G")!.firstElementChild as HTMLElement).queryByRole("button", { name: "Favorite" })).toBeNull();
    cleanup();

    stubStars();
    renderNoteList({}, { tab: "myNotes" });
    await waitFor(() => expect(panel().querySelector('[data-node-kind="folder"]')).not.toBeNull());
    const folderRow = panel().querySelector('[data-node-kind="folder"]')!.firstElementChild as HTMLElement;
    expect(within(folderRow).queryByRole("button", { name: "Favorite" })).toBeNull();
  });

  it.each(["pending", "error"] as const)("favorites %s: note rows all present, none with a star (unknown state isn't shown as not added)", async (reply) => {
    stubStars({ favorites: reply });
    renderNoteList({}, { tab: "recent" });
    await waitFor(() => expect(noteRow(LOOSE.id)).not.toBeNull());
    await waitFor(() => expect(noteRow(SHARED.id)).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stars()).toHaveLength(0);
  });

  it("each NoteList hits GET /api/favorites once; two instances sharing the cache also hit it once", async () => {
    const server = stubStars();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div role="tabpanel">
                <NoteList />
              </div>
              <div data-testid="second" role="tabpanel">
                <NoteList />
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Favorite" }).length).toBeGreaterThanOrEqual(4));
    expect(favoritesGets(server)).toBe(1);
  });

  it("DOM order within a row is link, more menu, star, tag dots slot; the star isn't inside the link", async () => {
    stubStars();
    renderNoteList({}, { tab: "shared" });
    await waitFor(() => expect(starOf(SHARED.id)).not.toBeNull());
    const row = noteRow(SHARED.id)!;
    const link = within(row).getByRole("link");
    const star = starOf(SHARED.id)!;
    const actions = within(row).getByRole("button", { name: "Note actions for Delta" });
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(link, actions)).toBe(true);
    expect(before(actions, star)).toBe(true);
    expect(star.closest("a")).toBeNull();
    expect(star.parentElement).toBe(row);
  });

  it("touch star: only favorite rows have it, role=img, name Favorite, doesn't take clicks, not a button, placed left of the more menu (the more menu is still the rightmost slot); rows not added don't have it", async () => {
    stubStars();
    renderNoteList({}, { tab: "recent" });
    await waitFor(() => expect(stars().length).toBe(4));
    const row = noteRow(LOOSE.id)!;
    const marker = within(row).getByRole("img", { name: "Favorite" });
    const actions = within(row).getByRole("button", { name: `Note actions for ${LOOSE.title}` });
    expect(marker.tagName).toBe("SPAN");
    expect(marker).toHaveClass("pointer-events-none", "hidden", "[@media(hover:none)]:flex", "[@media(pointer:coarse)]:flex", "w-3.5", "ms-2");
    expect(marker.closest("button")).toBeNull();
    expect(marker.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(marker.nextElementSibling).toBe(actions);
    expect(within(noteRow(IN_FOLDER.id)!).queryByRole("img", { name: "Favorite" })).toBeNull();
    expect(within(panel()).getAllByRole("img", { name: "Favorite" })).toHaveLength(1);
  });

  it("only the note being sent is aria-disabled, other rows as usual", async () => {
    stubStars({ favorites: [], put: "pending" });
    renderNoteList({}, { tab: "recent" });
    await waitFor(() => expect(stars()).toHaveLength(4));
    fireEvent.click(starOf(LOOSE.id)!);
    await waitFor(() => expect(starOf(LOOSE.id)).toHaveAttribute("aria-disabled", "true"));
    expect(starOf(SHARED.id)).not.toHaveAttribute("aria-disabled");
    expect(starOf(GROUPED.id)).not.toHaveAttribute("aria-disabled");
  });
});
