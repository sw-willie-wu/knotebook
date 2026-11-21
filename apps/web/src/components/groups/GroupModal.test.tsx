import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { selectedValue } from "@/test/ui-select";
import type { Location } from "react-router";
import { dismissAllToasts } from "@/components/ui/toast";
import {
  BG_NOTE,
  GROUP_ADMIN,
  GROUP_CO_ADMIN,
  GROUP_MEMBER,
  ME,
  ADMIN_ROLE,
  MEMBER_ROLE,
  callsTo,
  fail,
  fakeResponse,
  groupFetch,
  locationText,
  member,
  ok,
  renderGroupRoute,
} from "./group-test-utils";

const NOT_FOUND = "We couldn't find what you were looking for.";

describe("GroupModal (/groups/:id/*, #247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("five-item navigation for a role that can manage the group (nav accessible name = group name): Members/Roles/Tags/Storage/About, hrefs in order; at /groups/:id Members is aria-current", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    const nav = within(dialog).getByRole("navigation", { name: "Team Alpha" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Members", `/groups/${GROUP_ADMIN.id}`],
      ["Roles", `/groups/${GROUP_ADMIN.id}/roles`],
      ["Tags", `/groups/${GROUP_ADMIN.id}/tags`],
      ["Storage", `/groups/${GROUP_ADMIN.id}/storage`],
      ["About", `/groups/${GROUP_ADMIN.id}/about`],
    ]);
    expect(within(nav).getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
  });

  it("Members carries end: at /groups/:id/roles Members is not aria-current (Roles is)", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}/roles`, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    // Wait for the roles page's h1 first: it proves the roles route is mounted (without it the splat would redirect back to the members page; at the moment before the redirect aria-current also happens to be right).
    await within(dialog).findByRole("heading", { level: 1, name: "Roles" });
    const nav = within(dialog).getByRole("navigation", { name: "Team Alpha" });
    expect(within(nav).getByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });

  it("title = group name, subtext = my role (roleLabel: built-in member shows Member); the members page h1 is Members", async () => {
    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, groupFetch(() => [GROUP_MEMBER]));
    const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    expect(within(dialog).getByText("Member", { selector: "span, p, div" })).toBeInTheDocument();
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
  });

  it("not found (non-member / nonexistent / invalid id, all the same shape): right card errors.not_found, the title is the fallback \"Group\", no subtext; shell and navigation as usual", async () => {
    for (const path of [`/groups/${GROUP_MEMBER.id}`, "/groups/not-a-real-id"]) {
      const view = renderGroupRoute(path, groupFetch(() => [GROUP_ADMIN]));
      const dialog = await screen.findByRole("dialog", { name: "Group" });
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(NOT_FOUND));
      expect(within(dialog).getByRole("navigation", { name: "Group" })).toBeInTheDocument();
      expect(within(dialog).queryByText("Admin")).not.toBeInTheDocument();
      expect(dialog.querySelector("[data-management-content]")).toContainElement(within(dialog).getByRole("alert"));
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("groups list loading: right card \"Loading...\", title \"Group\"; load failure (500 on first fetch): right card error text, title \"Group\"", async () => {
    const view = renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [], (url, method) => (url === "/api/groups" && method === "GET" ? new Promise<Response>(() => {}) : null)),
    );
    const loading = await screen.findByRole("dialog", { name: "Group" });
    expect(within(loading).getByText("Loading…")).toBeInTheDocument();
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [], (url, method) => (url === "/api/groups" && method === "GET" ? fail(500, "internal") : null)),
    );
    const errored = await screen.findByRole("dialog", { name: "Group" });
    await waitFor(() => expect(within(errored).getByRole("alert")).toBeInTheDocument());
    expect(within(errored).queryByRole("heading", { level: 1, name: "Members" })).not.toBeInTheDocument();
  });

  it("/groups/:id renders the members page with the URL unchanged (not a redirect loop); /groups/:id/xyz -> /groups/:id forwarding backgroundLocation", async () => {
    const view = renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
    expect(locationText()).toBe(`/groups/${GROUP_ADMIN.id}|null`);
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute({ pathname: `/groups/${GROUP_ADMIN.id}/xyz`, state: { backgroundLocation: BG_NOTE } }, groupFetch(() => [GROUP_ADMIN]));
    await waitFor(() => expect(locationText().startsWith(`/groups/${GROUP_ADMIN.id}|`)).toBe(true));
    expect(JSON.parse(locationText().split("|")[1])).toEqual({ backgroundLocation: BG_NOTE });
  });

  it("Esc and the close button -> navigate(backgroundLocation); a deep link (no state) -> /", async () => {
    const view = renderGroupRoute({ pathname: `/groups/${GROUP_ADMIN.id}`, state: { backgroundLocation: BG_NOTE } }, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(locationText().startsWith(`${BG_NOTE.pathname}|`)).toBe(true));
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN]));
    const deep = await screen.findByRole("dialog", { name: "Team Alpha" });
    fireEvent.click(within(deep).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(locationText().startsWith("/|")).toBe(true));
  });

  it("an uppercase group id in the URL still resolves to the same group (case-insensitive match)", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id.toUpperCase()}`, groupFetch(() => [GROUP_ADMIN]));
    expect(await screen.findByRole("dialog", { name: "Team Alpha" })).toBeInTheDocument();
  });

  it("after the group has been shown, a failing ['groups'] refetch leaves the right card content (not replaced by the error text)", async () => {
    let failGroups = false;
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) =>
      url === "/api/groups" && method === "GET" && failGroups ? fail(500, "internal") : null,
    );
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    await within(dialog).findByRole("heading", { level: 1, name: "Members" });
    failGroups = true;
    // Adding a member invalidates and refetches ['groups'] (useAddMember -> invalidate)
    fetchMock.mockImplementationOnce(() => Promise.resolve(ok(member("u-x", "x@example.com", "X", ADMIN_ROLE), 201)));
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "x@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/groups").length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("dialog", { name: "Team Alpha" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
  });
});

describe("GroupAboutSection (/groups/:id/about, #247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const BG_GROUP_NOTE = (id: string) => ({ pathname: `/g/${id}/some-note`, search: "", hash: "", state: null, key: "bg2" }) as Location;

  async function openAbout(entry: string | { pathname: string; state?: unknown }, fetchMock: ReturnType<typeof groupFetch>, name: string) {
    renderGroupRoute(entry, fetchMock);
    const dialog = await screen.findByRole("dialog", { name });
    await within(dialog).findByRole("heading", { level: 1, name: "About" });
    return dialog;
  }

  it("canManageGroup: the name can be edited (PATCH, toast); the info area has creation time and member count; there is an outline \"Delete group\" button (not red)", async () => {
    let group = { ...GROUP_ADMIN };
    const fetchMock = groupFetch(() => [group], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)], (url, method) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}` && method === "PATCH") {
        group = { ...group, name: "Team Alpha Renamed" };
        return ok(group);
      }
      return null;
    });
    const dialog = await openAbout(`/groups/${GROUP_ADMIN.id}/about`, fetchMock, "Team Alpha");
    const nameInput = within(dialog).getByLabelText("Group name");
    fireEvent.change(nameInput, { target: { value: "Team Alpha Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(1));
    expect(await screen.findByText("Group renamed.")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText("2 members")).toBeInTheDocument());
    expect(within(dialog).getByText(new Date("2026-01-01T00:00:00.000Z").toLocaleDateString("en"))).toBeInTheDocument();
    const del = within(dialog).getByRole("button", { name: "Delete group" });
    expect(del.className).not.toMatch(/(^|\s)(bg-destructive|text-destructive)(\s|$)/);
  });

  it("without canManageGroup: the name is read-only (plain text, no input, no Save name); no Delete group; the four nav items are unchanged (not hidden)", async () => {
    const dialog = await openAbout(
      `/groups/${GROUP_MEMBER.id}/about`,
      groupFetch(() => [GROUP_MEMBER], () => [member("u-a", "a@example.com", "A", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)]),
      "Team Beta",
    );
    expect(within(dialog).queryByLabelText("Group name")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save name" })).not.toBeInTheDocument();
    // `:not(.sr-only)`: the shell's sr-only DialogDescription defaults to the title and is also a <p> whose content is the group name (ManagementShell)
    expect(within(dialog).getByText("Team Beta", { selector: "p:not(.sr-only)" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete group" })).not.toBeInTheDocument();
    expect(within(within(dialog).getByRole("navigation", { name: "Team Beta" })).getAllByRole("link")).toHaveLength(4);
  });

  it("where to go after leaving (three cases): background is another page -> back to the background; background is this group's note (including an uppercase id) -> /; no background -> /; never to /settings/*", async () => {
    const members = [member("u-a", "a@example.com", "A", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)];
    const cases: Array<[unknown, string]> = [
      [{ backgroundLocation: BG_NOTE }, BG_NOTE.pathname],
      [{ backgroundLocation: BG_GROUP_NOTE(GROUP_MEMBER.id) }, "/"],
      [{ backgroundLocation: BG_GROUP_NOTE(GROUP_MEMBER.id.toUpperCase()) }, "/"],
      [undefined, "/"],
    ];
    for (const [state, expected] of cases) {
      const fetchMock = groupFetch(() => [GROUP_MEMBER], () => members, (url, method) =>
        url === `/api/groups/${GROUP_MEMBER.id}/members/${ME.id}` && method === "DELETE" ? fakeResponse({ ok: true, status: 204 }) : null,
      );
      const view = renderGroupRoute({ pathname: `/groups/${GROUP_MEMBER.id}/about`, state }, fetchMock);
      const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Leave group" }));
      const confirm = await screen.findByRole("dialog", { name: "Leave group?" });
      fireEvent.click(within(confirm).getByRole("button", { name: "Leave group" }));
      await waitFor(() => expect(locationText().split("|")[0]).toBe(expected));
      expect(locationText()).not.toMatch(/^\/settings\//);
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("where to go after deleting the group: background is this group's note -> /; background is another page -> back to the background (DELETE {mode:'delete'})", async () => {
    for (const [bg, expected] of [
      [BG_GROUP_NOTE(GROUP_ADMIN.id), "/"],
      [BG_NOTE, BG_NOTE.pathname],
    ] as const) {
      let deleted = false;
      const fetchMock = groupFetch(() => (deleted ? [] : [GROUP_ADMIN]), () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) => {
        if (url === `/api/groups/${GROUP_ADMIN.id}` && method === "DELETE") {
          deleted = true;
          return fakeResponse({ ok: true, status: 204 });
        }
        return null;
      });
      const view = renderGroupRoute({ pathname: `/groups/${GROUP_ADMIN.id}/about`, state: { backgroundLocation: bg } }, fetchMock);
      const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Delete group" }));
      const confirm = await screen.findByRole("dialog", { name: "Delete group?" });
      fireEvent.click(within(confirm).getByRole("radio", { name: "Delete everything" }));
      fireEvent.click(within(confirm).getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete group" }));
      await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(1));
      expect(JSON.parse(String(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)[0].body))).toEqual({ mode: "delete" });
      await waitFor(() => expect(locationText().split("|")[0]).toBe(expected));
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("delete 409 not_admin: toast, the confirm dialog stays, no navigation", async () => {
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) =>
      url === `/api/groups/${GROUP_ADMIN.id}` && method === "DELETE" ? fail(409, "not_admin") : null,
    );
    const dialog = await openAbout(`/groups/${GROUP_ADMIN.id}/about`, fetchMock, "Team Alpha");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete group?" });
    await waitFor(() => expect(selectedValue(within(confirm).getByLabelText("Admin who gets the notes"))).toBe(ME.id));
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete group" }));
    expect(
      await screen.findByText("The notes can only be handed to one of the group's admins. Pick someone who is still an admin.", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
    expect(locationText().startsWith(`/groups/${GROUP_ADMIN.id}/about|`)).toBe(true);
  });

  it("leave section: the last admin does not see it; one of two admins does; not rendered while the member list is loading; 409 last_admin -> toast, no navigation", async () => {
    const lone = renderGroupRoute(`/groups/${GROUP_ADMIN.id}/about`, groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)]));
    let dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    await within(dialog).findByRole("button", { name: "Delete group" });
    // Wait for the member list to land (the leave section needs it to know whether this is the last admin), otherwise "does not see Leave group" is always true
    await within(dialog).findByText("1 member");
    expect(within(dialog).queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();
    lone.unmount();
    vi.unstubAllGlobals();

    const co = renderGroupRoute(`/groups/${GROUP_CO_ADMIN.id}/about`, groupFetch(() => [GROUP_CO_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-b", "b@example.com", "B", ADMIN_ROLE)]));
    dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    expect(await within(dialog).findByRole("button", { name: "Leave group" })).toBeInTheDocument();
    co.unmount();
    vi.unstubAllGlobals();

    const gate: { release?: () => void } = {};
    const members = [member("u-a", "a@example.com", "A", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)];
    const pendingView = renderGroupRoute(
      `/groups/${GROUP_MEMBER.id}/about`,
      groupFetch(() => [GROUP_MEMBER], () => new Promise<Response>((resolve) => (gate.release = () => resolve(ok(members))))),
    );
    dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    await within(dialog).findByRole("heading", { level: 1, name: "About" });
    await waitFor(() => expect(gate.release).toBeDefined());
    expect(within(dialog).queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();
    gate.release?.();
    expect(await within(dialog).findByRole("button", { name: "Leave group" })).toBeInTheDocument();
    pendingView.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(
      `/groups/${GROUP_MEMBER.id}/about`,
      groupFetch(() => [GROUP_MEMBER], () => members, (url, method) =>
        url === `/api/groups/${GROUP_MEMBER.id}/members/${ME.id}` && method === "DELETE" ? fail(409, "last_admin") : null,
      ),
    );
    dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Leave group" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Leave group?" })).getByRole("button", { name: "Leave group" }));
    expect(await screen.findByText("A group needs at least one admin. Make someone else an admin first.", { exact: true })).toBeInTheDocument();
    expect(locationText().startsWith(`/groups/${GROUP_MEMBER.id}/about|`)).toBe(true);
  });
});
