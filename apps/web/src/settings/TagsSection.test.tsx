import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { SpaceTagDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { chooseOption } from "@/test/ui-select";
import {
  GROUP_ADMIN,
  GROUP_MEMBER,
  callsTo,
  fail,
  groupFetch,
  ok,
  renderGroupRoute,
  type Handler,
} from "@/components/groups/group-test-utils";

const WORK: SpaceTagDto = { id: "t-work", name: "Work", color: "blue", noteCount: 3 };
const READING: SpaceTagDto = { id: "t-reading", name: "Reading", color: "green", noteCount: 1 };
const IDEAS: SpaceTagDto = { id: "t-ideas", name: "Ideas", color: "purple", noteCount: 0 };

interface Space {
  tags: SpaceTagDto[];
  patch?: (tagId: string, body: Record<string, unknown>) => Response | null;
  /** Called for a merge or delete; returning a response replaces the default success. */
  write?: (method: string, url: string) => Response | null;
}

/** Serves both lists and records every write; `extra` is matched first by `groupFetch`. */
function tagsFetch(space: Space, groups = [GROUP_ADMIN, GROUP_MEMBER]) {
  const handler: Handler = (url, method, init) => {
    if (method === "GET" && (url === "/api/tags" || /^\/api\/groups\/[^/]+\/tags$/.test(url))) return ok(space.tags);
    if (method === "PATCH" && url.startsWith("/api/tags/")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return space.patch?.(url.slice("/api/tags/".length), body) ?? ok({ ...space.tags[0], ...body });
    }
    if (method !== "GET" && space.write) {
      const custom = space.write(method, url);
      if (custom) return custom;
    }
    if (method === "POST" && /^\/api\/tags\/[^/]+\/merge$/.test(url)) return ok(space.tags[0]);
    if (method === "DELETE" && url.startsWith("/api/tags/")) return { ok: true, status: 204, json: () => Promise.reject(new Error("no body")) } as unknown as Response;
    return null;
  };
  return groupFetch(() => groups, () => [], handler);
}

async function tagRow(name: string): Promise<HTMLElement> {
  return screen.findByRole("row", { name });
}

describe("personal tag management (/settings/tags)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists each tag with its color, name and note count; an empty space shows the empty text", async () => {
    renderGroupRoute("/settings/tags", tagsFetch({ tags: [WORK, READING, IDEAS] }));
    const work = await tagRow("Work");
    expect(within(work).getByText("3 notes")).toBeInTheDocument();
    expect(work.querySelector('[data-tag-color="blue"]')).not.toBeNull();
    expect(within(work).getByRole("button", { name: "Color of Work: Blue" })).toHaveTextContent("Blue");
    expect(within(await tagRow("Reading")).getByText("1 note")).toBeInTheDocument();
    expect(within(await tagRow("Ideas")).getByText("0 notes")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Tags" })).toBeInTheDocument();
    expect(screen.getByText(/Renaming or merging a tag changes it on every note/)).toBeInTheDocument();
  });

  it("an empty space shows the empty text and no table", async () => {
    renderGroupRoute("/settings/tags", tagsFetch({ tags: [] }));
    expect(await screen.findByText("No tags yet. Type /tag in a note, or choose Add tag in its ⋮ menu, or type #name and a space on the first line.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("rename sends PATCH with the normalized name, not what was typed", async () => {
    const fetchMock = tagsFetch({ tags: [WORK, READING] });
    renderGroupRoute("/settings/tags", fetchMock);
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Rename Work" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename tag" });
    expect(within(dialog).getByText("The new name applies to every note with this tag.")).toBeInTheDocument();
    const input = within(dialog).getByLabelText("Tag name");
    expect(input).toHaveValue("Work");
    fireEvent.change(input, { target: { value: "  Docs　" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", "/api/tags/t-work")).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PATCH", "/api/tags/t-work")[0]!.body))).toEqual({ name: "Docs" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename tag" })).toBeNull());
  });

  it("rename refuses an invalid name without sending anything; an unchanged name just closes", async () => {
    const fetchMock = tagsFetch({ tags: [WORK] });
    renderGroupRoute("/settings/tags", fetchMock);
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Rename Work" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename tag" });
    fireEvent.change(within(dialog).getByLabelText("Tag name"), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Tag names must be 1 to 40 characters.");
    fireEvent.change(within(dialog).getByLabelText("Tag name"), { target: { value: " Work " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename tag" })).toBeNull());
    expect(callsTo(fetchMock, "PATCH", "/api/tags/t-work")).toHaveLength(0);
  });

  it("rename: a 409 tag_name_taken shows the message and keeps the dialog open", async () => {
    const fetchMock = tagsFetch({ tags: [WORK, READING], patch: () => fail(409, "tag_name_taken") });
    renderGroupRoute("/settings/tags", fetchMock);
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Rename Work" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename tag" });
    fireEvent.change(within(dialog).getByLabelText("Tag name"), { target: { value: "reading" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This space already has a tag with that name.");
    expect(screen.getByRole("dialog", { name: "Rename tag" })).toBeInTheDocument();
  });

  it("choosing a color sends PATCH {color}", async () => {
    const fetchMock = tagsFetch({ tags: [WORK, READING] });
    renderGroupRoute("/settings/tags", fetchMock);
    const trigger = within(await tagRow("Work")).getByRole("button", { name: "Color of Work: Blue" });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["Blue", "Green", "Orange", "Purple", "Pink", "Red", "Yellow", "Brown", "Gray"]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    expect(items[2]).toHaveAttribute("aria-checked", "false");
    await act(async () => {
      fireEvent.click(items[2]!);
    });
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", "/api/tags/t-work")).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PATCH", "/api/tags/t-work")[0]!.body))).toEqual({ color: "orange" });
  });

  it("merge lists only the other tags and sends {into}; nothing is sent before a target is chosen", async () => {
    const fetchMock = tagsFetch({ tags: [WORK, READING, IDEAS] });
    renderGroupRoute("/settings/tags", fetchMock);
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Merge Work into another tag" }));
    const dialog = await screen.findByRole("dialog", { name: 'Merge "Work" into another tag' });
    expect(within(dialog).getByText('Notes tagged "Work" get the tag you pick, and "Work" is deleted.')).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Merge" });
    expect(confirm).toBeDisabled();
    const select = within(dialog).getByRole("combobox", { name: "Merge into" });
    await act(async () => {
      fireEvent.keyDown(select, { key: "Enter" });
    });
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Reading", "Ideas"]);
    await chooseOption(select, "Ideas");
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(callsTo(fetchMock, "POST", "/api/tags/t-work/merge")).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "POST", "/api/tags/t-work/merge")[0]!.body))).toEqual({ into: "t-ideas" });
  });

  it("merge is unavailable when the space has only one tag", async () => {
    renderGroupRoute("/settings/tags", tagsFetch({ tags: [WORK] }));
    const button = within(await tagRow("Work")).getByRole("button", { name: "Merge Work into another tag" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("title", "There is no other tag to merge into.");
    fireEvent.click(button);
    expect(screen.queryByRole("dialog", { name: /Merge/ })).toBeNull();
  });

  it("delete asks first, naming how many notes lose the tag, then sends DELETE", async () => {
    const fetchMock = tagsFetch({ tags: [WORK, READING] });
    renderGroupRoute("/settings/tags", fetchMock);
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Delete Work" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete tag "Work"?' });
    expect(within(dialog).getByText(/removed from 3 notes, and from notes in the trash too/)).toBeInTheDocument();
    expect(callsTo(fetchMock, "DELETE", "/api/tags/t-work")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: 'Delete tag "Work"?' })).toBeNull());
    expect(callsTo(fetchMock, "DELETE", "/api/tags/t-work")).toHaveLength(0);

    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Delete Work" }));
    const again = await screen.findByRole("dialog", { name: 'Delete tag "Work"?' });
    fireEvent.click(within(again).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", "/api/tags/t-work")).toHaveLength(1));
  });
});

describe("group tag management (/groups/:id/tags)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the Tags item sits after Roles and shows for a role that can manage the group", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, tagsFetch({ tags: [] }));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    const nav = within(dialog).getByRole("navigation", { name: "Team Alpha" });
    expect(within(nav).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Members", `/groups/${GROUP_ADMIN.id}`],
      ["Roles", `/groups/${GROUP_ADMIN.id}/roles`],
      ["Tags", `/groups/${GROUP_ADMIN.id}/tags`],
      ["Storage", `/groups/${GROUP_ADMIN.id}/storage`],
      ["About", `/groups/${GROUP_ADMIN.id}/about`],
    ]);
  });

  it("a member who cannot manage the group has no Tags item", async () => {
    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, tagsFetch({ tags: [] }));
    const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    const nav = within(dialog).getByRole("navigation", { name: "Team Beta" });
    expect(within(nav).queryByRole("link", { name: "Tags" })).toBeNull();
  });

  it("opening the URL without the permission shows the explanation and fetches no tags", async () => {
    const fetchMock = tagsFetch({ tags: [WORK] });
    renderGroupRoute(`/groups/${GROUP_MEMBER.id}/tags`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    expect(await within(dialog).findByText("Only roles that can manage this group can manage its tags.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("row", { name: "Work" })).toBeNull();
    expect(callsTo(fetchMock, "GET", `/api/groups/${GROUP_MEMBER.id}/tags`)).toHaveLength(0);
  });

  it("a manager lists the group's tags and renames through the group's own endpoint", async () => {
    const fetchMock = tagsFetch({ tags: [WORK, READING] });
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}/tags`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    expect(await within(dialog).findByText(/Tags in this group/)).toBeInTheDocument();
    fireEvent.click(within(await tagRow("Reading")).getByRole("button", { name: "Rename Reading" }));
    const rename = await screen.findByRole("dialog", { name: "Rename tag" });
    fireEvent.change(within(rename).getByLabelText("Tag name"), { target: { value: "Books" } });
    fireEvent.click(within(rename).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", "/api/tags/t-reading")).toHaveLength(1));
    expect(callsTo(fetchMock, "GET", `/api/groups/${GROUP_ADMIN.id}/tags`).length).toBeGreaterThan(0);
  });
});

describe("Settings navigation", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has a Tags item between Storage and Groups that opens /settings/tags", async () => {
    renderGroupRoute("/settings/storage", tagsFetch({ tags: [WORK] }));
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    const labels = within(nav).getAllByRole("link").map((link) => link.textContent?.replace(/\d+$/, ""));
    const tags = labels.indexOf("Tags");
    expect(tags).toBeGreaterThan(-1);
    expect(labels[tags - 1]).toBe("Storage");
    expect(labels[tags + 1]).toBe("Groups");
    const link = within(nav).getByRole("link", { name: "Tags" });
    expect(link).toHaveAttribute("href", "/settings/tags");
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { level: 1, name: "Tags" })).toBeInTheDocument();
    expect(await tagRow("Work")).toBeInTheDocument();
  });
});

describe("a tag someone else already removed", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The server forgets `id` and answers 404, as when another session deleted or merged it first. */
  function goneSpace(goneId: string, tags: SpaceTagDto[]): Space {
    const space: Space = {
      tags,
      patch: () => {
        space.tags = space.tags.filter((tag) => tag.id !== goneId);
        return fail(404, "tag_not_found");
      },
      write: () => {
        space.tags = space.tags.filter((tag) => tag.id !== goneId);
        return fail(404, "tag_not_found");
      },
    };
    return space;
  }

  it("rename: shows the message, closes the dialog, and the list and notes are refetched without the tag", async () => {
    const fetchMock = tagsFetch(goneSpace("t-work", [WORK, READING]));
    renderGroupRoute("/settings/tags", fetchMock);
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Rename Work" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename tag" });
    const listBefore = callsTo(fetchMock, "GET", "/api/tags").length;
    const notesBefore = callsTo(fetchMock, "GET", "/api/notes").length;
    fireEvent.change(within(dialog).getByLabelText("Tag name"), { target: { value: "Docs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("That tag no longer exists.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename tag" })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("row", { name: "Work" })).toBeNull());
    expect(callsTo(fetchMock, "GET", "/api/tags").length).toBeGreaterThan(listBefore);
    expect(callsTo(fetchMock, "GET", "/api/notes").length).toBeGreaterThan(notesBefore);
    expect(screen.getByRole("row", { name: "Reading" })).toBeInTheDocument();
  });

  it("color: shows the message and the list is refetched without the tag", async () => {
    renderGroupRoute("/settings/tags", tagsFetch(goneSpace("t-work", [WORK, READING])));
    const trigger = within(await tagRow("Work")).getByRole("button", { name: "Color of Work: Blue" });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    const items = await screen.findAllByRole("menuitemradio");
    await act(async () => {
      fireEvent.click(items[2]!);
    });
    expect(await screen.findByText("That tag no longer exists.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("row", { name: "Work" })).toBeNull());
  });

  it("delete: shows the message, closes the dialog and drops the row", async () => {
    renderGroupRoute("/settings/tags", tagsFetch(goneSpace("t-work", [WORK, READING])));
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Delete Work" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete tag "Work"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("That tag no longer exists.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: 'Delete tag "Work"?' })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("row", { name: "Work" })).toBeNull());
  });

  it("merge: a target that was deleted meanwhile closes the dialog and leaves the choices without it", async () => {
    renderGroupRoute("/settings/tags", tagsFetch(goneSpace("t-ideas", [WORK, READING, IDEAS])));
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Merge Work into another tag" }));
    const dialog = await screen.findByRole("dialog", { name: 'Merge "Work" into another tag' });
    const select = within(dialog).getByRole("combobox", { name: "Merge into" });
    await chooseOption(select, "Ideas");
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    expect(await screen.findByText("That tag no longer exists.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Merge/ })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("row", { name: "Ideas" })).toBeNull());
    fireEvent.click(within(await tagRow("Work")).getByRole("button", { name: "Merge Work into another tag" }));
    const again = await screen.findByRole("dialog", { name: 'Merge "Work" into another tag' });
    const trigger = within(again).getByRole("combobox", { name: "Merge into" });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Reading"]);
  });
});

describe("focus after a dialog closes", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["Rename Work", "Rename tag", "Cancel"],
    ["Merge Work into another tag", 'Merge "Work" into another tag', "Cancel"],
    ["Delete Work", 'Delete tag "Work"?', "Cancel"],
  ])("%s: the button that opened it gets focus back", async (buttonName, dialogName, closeName) => {
    renderGroupRoute("/settings/tags", tagsFetch({ tags: [WORK, READING] }));
    const row = await tagRow("Work");
    const button = within(row).getByRole("button", { name: buttonName });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: dialogName });
    fireEvent.click(within(dialog).getByRole("button", { name: closeName }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: dialogName })).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  });
});
