import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { GroupDto, GroupMemberDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { selectedValue } from "@/test/ui-select";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";
import { GroupMenu } from "./GroupMenu";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };
/** The only admin (`adminRole()`'s `memberCount` defaults to 1 = the number of people holding the built-in admin role). */
const ADMIN_GROUP: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());
/** One of two admins: not the last one, so they may leave. */
const CO_ADMIN_GROUP: GroupDto = groupDto({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Workshop C" }, adminRole({ memberCount: 2 }));
const MEMBER_GROUP: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Workshop B" }, memberRole({ memberCount: 3 }));

/** When the delete dialog mounts it calls `GET .../members` (dropdown) and `GET /api/notes` (count) - both are answered in `renderMenu`. */
const ME_AS_ADMIN: GroupMemberDto = { userId: ME.id, email: ME.email, displayName: ME.displayName, roleId: "r-admin", builtin: "admin", avatar: null };

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}|{JSON.stringify(location.state)}</div>;
}

function renderMenu(group: GroupDto, handler: (method: string, url: string) => Response, size?: "sidebar" | "default", indexPath?: string) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(200, ME));
      if (url.endsWith("/members") && method === "GET") return Promise.resolve(fakeResponse(200, [ME_AS_ADMIN]));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(200, []));
      return Promise.resolve(handler(method, url));
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/n/me/some-note"]}>
        <Routes>
          <Route path="*" element={<><GroupMenu group={group} size={size} indexPath={indexPath} /><LocationProbe /><Toaster /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient, unmount };
}

async function openMenu(name: string) {
  // Radix DropdownMenu's trigger only listens to onPointerDown (see NoteMenu.test.tsx).
  fireEvent.pointerDown(screen.getByRole("button", { name: `Group actions for ${name}` }), { button: 0 });
  return screen.findByRole("menu");
}

describe("GroupMenu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("last-admin form: members & settings / rename / delete group (danger); no leave group", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop A");
    expect(within(menu).getByRole("menuitem", { name: "Members & settings" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    // class assertion (jsdom has no CSS): the danger style class is applied
    expect(within(menu).getByRole("menuitem", { name: "Delete group" })).toHaveClass("text-destructive");
    expect(within(menu).queryByRole("menuitem", { name: "Leave group" })).not.toBeInTheDocument();
  });

  it("not the last admin (builtin admin, memberCount 2): all management items, leave group after delete group", async () => {
    renderMenu(CO_ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop C");
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Members & settings", "Rename", "Delete group", "Leave group"]);
  });

  it("with indexPath the menu has Open index right after the members item, and choosing it navigates there; without it the item list is unchanged", async () => {
    const withIndex = renderMenu(CO_ADMIN_GROUP, () => fakeResponse(500), "sidebar", "/knowledge/g/cccccccc-cccc-cccc-cccc-cccccccccccc");
    let menu = await openMenu("Workshop C");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Members & settings", "Open index", "Rename", "Delete group", "Leave group"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open index" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/knowledge\/g\/cccccccc/));
    withIndex.unmount();

    renderMenu(CO_ADMIN_GROUP, () => fakeResponse(500), "sidebar");
    menu = await openMenu("Workshop C");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Members & settings", "Rename", "Delete group", "Leave group"]);
  });

  it("each of the four items has an icon (users, pencil, trash, log-out), class contains mr-2 h-4 w-4", async () => {
    renderMenu(CO_ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop C");
    const icons = within(menu).getAllByRole("menuitem").map((item) => item.querySelector("svg"));
    expect(icons.map((svg) => svg?.getAttribute("data-icon"))).toEqual(["users", "pencil", "trash", "log-out"]);
    for (const svg of icons) expect(svg).toHaveClass("mr-2", "h-4", "w-4");
  });

  it("member form: view members / leave group; no rename or delete", async () => {
    renderMenu(MEMBER_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop B");
    expect(within(menu).getByRole("menuitem", { name: "View members" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Leave group" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Delete group" })).not.toBeInTheDocument();
  });

  it("the two management flags are separate: canManageMembers decides only \"members & settings / view members\", canManageGroup only rename and delete (myRole is ignored)", async () => {
    // A fixture deliberately inconsistent with myRole (only a custom role really yields a single flag; a site admin's OR also decouples both from the role)
    const membersOnly: GroupDto = { ...MEMBER_GROUP, id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "Only members", canManageMembers: true, canManageGroup: false };
    const first = renderMenu(membersOnly, () => fakeResponse(500));
    let menu = await openMenu("Only members");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Members & settings", "Leave group"]);
    first.unmount();

    const neither: GroupDto = { ...CO_ADMIN_GROUP, id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "Neither", canManageMembers: false, canManageGroup: false };
    const second = renderMenu(neither, () => fakeResponse(500));
    menu = await openMenu("Neither");
    // myRole is the built-in admin but both flags are false -> same form as an ordinary member
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["View members", "Leave group"]);
    second.unmount();

    const groupOnly: GroupDto = { ...MEMBER_GROUP, id: "ffffffff-ffff-ffff-ffff-ffffffffffff", name: "Only group", canManageMembers: false, canManageGroup: true };
    renderMenu(groupOnly, () => fakeResponse(500));
    menu = await openMenu("Only group");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["View members", "Rename", "Delete group", "Leave group"]);
  });

  it("members & settings navigates to /groups/:id with backgroundLocation (#247)", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Members & settings" }));
    // Compare the whole pathname before `|`: a substring match cannot catch the old destination (`/settings/groups/<id>|` also contains `/groups/<id>|`)
    await waitFor(() => expect(screen.getByTestId("location").textContent?.split("|")[0]).toBe(`/groups/${ADMIN_GROUP.id}`));
    expect(screen.getByTestId("location").textContent).toContain('"backgroundLocation"');
    expect(screen.getByTestId("location").textContent).toContain("/n/me/some-note");
  });

  it("size: default is the standard 32px icon button (h-8 w-8); sidebar is 24px (h-6 w-6)", () => {
    const first = renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const standard = screen.getByRole("button", { name: "Group actions for Workshop A" });
    expect(standard).toHaveClass("h-8", "w-8");
    expect(standard).not.toHaveClass("h-6");
    // The kebab on the settings page is always visible, no hover reveal
    expect(standard).not.toHaveClass("opacity-0");
    first.unmount();
    renderMenu(ADMIN_GROUP, () => fakeResponse(500), "sidebar");
    const compact = screen.getByRole("button", { name: "Group actions for Workshop A" });
    expect(compact).toHaveClass("h-6", "w-6");
    expect(compact).not.toHaveClass("h-8");
    // A class assertion, not a behaviour one: jsdom has no CSS, hover reveal has to be checked in a browser
    expect(compact).toHaveClass("opacity-0", "data-[state=open]:opacity-100");
  });

  // Asserts the Radix contract (the trigger carries data-state="open" when open); whether the CSS works has to be checked in a browser.
  it("the sidebar variant's trigger carries data-state=open while the menu is open (hover reveal's \"stay visible while open\" depends on it)", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500), "sidebar");
    const before = screen.getByRole("button", { name: "Group actions for Workshop A" });
    expect(before).toHaveAttribute("data-state", "closed");
    await openMenu("Workshop A");
    // While a modal menu is open the other elements are aria-hidden, so getting the trigger needs hidden: true
    expect(screen.getByRole("button", { name: "Group actions for Workshop A", hidden: true })).toHaveAttribute(
      "data-state",
      "open",
    );
  });

  it("kebab -> rename -> cancel: focus returns to the kebab trigger (not to body)", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename group" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename group" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Group actions for Workshop A" })).toHaveFocus());
  });

  it("kebab -> delete group -> cancel: focus returns to the kebab trigger", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete group" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete group?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete group?" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Group actions for Workshop A" })).toHaveFocus());
  });

  it("rename opens a dialog prefilled with the old name; save sends PATCH", async () => {
    const { calls } = renderMenu(ADMIN_GROUP, (method) => (method === "PATCH" ? fakeResponse(200, { ...ADMIN_GROUP, name: "Renamed" }) : fakeResponse(500)));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename group" });
    expect(within(dialog).getByLabelText("Group name")).toHaveValue("Workshop A");
    fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === `/api/groups/${ADMIN_GROUP.id}`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename group" })).not.toBeInTheDocument());
  });

  it("delete group -> two-mode dialog (default transfer, dropdown first) -> DELETE /api/groups/:id with {mode:'transfer', transferTo} -> the dialog closes on success", async () => {
    const { calls } = renderMenu(ADMIN_GROUP, (method) => (method === "DELETE" ? fakeResponse(204) : fakeResponse(500)));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete group" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete group?" });
    expect(within(dialog).getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    await waitFor(() => expect(selectedValue(within(dialog).getByLabelText("Admin who gets the notes"))).toBe(ME.id));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/groups/${ADMIN_GROUP.id}`)).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ mode: "transfer", transferTo: ME.id });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete group?" })).not.toBeInTheDocument());
  });

  it("delete group -> 409 not_admin -> toast errors.not_admin, the dialog stays and the confirm button can be pressed again", async () => {
    const { calls } = renderMenu(ADMIN_GROUP, (method) =>
      method === "DELETE" ? fakeResponse(409, { error: { code: "not_admin", message: "x" } }) : fakeResponse(500),
    );
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete group" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete group?" });
    await waitFor(() => expect(selectedValue(within(dialog).getByLabelText("Admin who gets the notes"))).toBe(ME.id));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE" && c.url === `/api/groups/${ADMIN_GROUP.id}`)).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("The notes can only be handed to one of the group's admins. Pick someone who is still an admin.", { exact: true })).toBeInTheDocument());
    // The toast has appeared = the catch has finished; the dialog is still there and the confirm button can be pressed again
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Delete group?" })).getByRole("button", { name: "Delete group" })).not.toBeDisabled());
  });

  it("leave group -> second confirmation -> DELETE /api/groups/:id/members/<me>; 409 last_admin (race fallback) -> toast errors.last_admin, the dialog closes", async () => {
    const { calls } = renderMenu(MEMBER_GROUP, (method) =>
      method === "DELETE" ? fakeResponse(409, { error: { code: "last_admin", message: "x" } }) : fakeResponse(500),
    );
    const menu = await openMenu("Workshop B");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Leave group" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave group?" });
    expect(dialog).toHaveTextContent('You will lose access to the notes in "Workshop B".');
    // The confirm button is disabled until the session has loaded (`!user`) - wait until it is pressable so as not to race /api/auth/me
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Leave group" })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave group" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/groups/${MEMBER_GROUP.id}/members/${ME.id}`)).toBe(true));
    await waitFor(() =>
      expect(screen.getByText("A group needs at least one admin. Make someone else an admin first.", { exact: true })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave group?" })).not.toBeInTheDocument());
  });
});
