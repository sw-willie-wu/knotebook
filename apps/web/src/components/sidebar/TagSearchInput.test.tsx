import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GroupDto, NoteDto, NoteTagDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SidebarQueryProvider, useSidebarQuery } from "@/lib/sidebar-query";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { TagSearchInput } from "./TagSearchInput";

const GROUP: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Product team" }, adminRole());
const tag = (id: string, name: string, color: NoteTagDto["color"] = "blue"): NoteTagDto => ({ id, name, color });
const WORK = tag("t-work", "Work", "green");
const TODO = tag("t-todo", "Todo", "red");
const MEETINGS = tag("t-meetings", "會議", "yellow");
const DECISIONS = tag("t-decisions", "決策", "purple");

function note(id: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id, title: id, ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    slug: id, slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, folderId: null,
    permissions: OWNER_PERMS, ...over,
  };
}
const groupNote = (id: string, tags: NoteTagDto[]) =>
  note(id, { ownerId: null, ownerHandle: null, role: "editor", groupId: GROUP.id, group: { id: GROUP.id, name: GROUP.name }, permissions: EDITOR_PERMS, tags });

const TAGGED = [note("a", { tags: [WORK, TODO] }), note("b", { tags: [WORK] }), groupNote("c", [MEETINGS, DECISIONS]), groupNote("d", [MEETINGS])];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function stubFetch(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/notes") return Promise.resolve(json(notes));
      if (url === "/api/groups") return Promise.resolve(json([GROUP]));
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

let escapes = 0;

function Box() {
  const { query, setQuery, clearSearch, tagTokens } = useSidebarQuery();
  const ref = createRef<HTMLInputElement>();
  return (
    <>
      <TagSearchInput
        query={query}
        onQueryChange={setQuery}
        searchRef={ref}
        size="desktop"
        className="mx-2"
        onEscape={() => {
          escapes += 1;
          clearSearch();
        }}
        inputProps={{ "aria-label": "Search notes" }}
      />
      <output data-testid="effective">{query}</output>
      <output data-testid="tokens">{tagTokens.map((token) => token.name).join("|")}</output>
    </>
  );
}

async function renderBox(notes: NoteDto[] = TAGGED) {
  stubFetch(notes);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The lazy controller reads these two lists from the cache the sidebar has already filled.
  client.setQueryData(["notes"], notes);
  client.setQueryData(["groups"], [GROUP]);
  render(
    <QueryClientProvider client={client}>
      <SidebarQueryProvider>
        <Box />
      </SidebarQueryProvider>
    </QueryClientProvider>,
  );
  return screen.getByLabelText("Search notes") as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string) {
  input.focus();
  fireEvent.change(input, { target: { value } });
}

const tokens = () => screen.getByTestId("tokens").textContent;

describe("TagSearchInput", () => {
  beforeEach(async () => {
    escapes = 0;
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("with no filterable tags, typing # renders no list and the input has no combobox attributes", async () => {
    const input = await renderBox([note("x"), note("y", { ownerId: "u9", role: "editor", permissions: EDITOR_PERMS, tags: [WORK] })]);
    type(input, "#");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("role")).toBeNull();
    expect(input.hasAttribute("aria-expanded")).toBe(false);
    expect(screen.getByTestId("effective")).toHaveTextContent("#");
  });

  it("a # inside a word, or a # that matches no tag, stays plain text", async () => {
    const input = await renderBox();
    type(input, "C#");
    expect(screen.queryByRole("listbox")).toBeNull();
    type(input, "#105");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("effective")).toHaveTextContent("#105");
  });

  it("typing #會 or ＃會 lists 會議 under its group, and the fragment stays in the searched text while the list is open", async () => {
    const input = await renderBox();
    type(input, "#會");
    const list = await screen.findByRole("listbox");
    expect(within(list).getByRole("option", { name: /會議/ })).toBeInTheDocument();
    expect(within(list).getByText("Product team")).toBeInTheDocument();
    expect(screen.getByTestId("effective")).toHaveTextContent("#會");
    type(input, "＃會");
    expect(await screen.findByRole("option", { name: /會議/ })).toBeInTheDocument();
  });

  it("options sit in one group per space, named by the space, and each option's name carries its note count", async () => {
    const same = tag("t-work-g", "Work", "red");
    const input = await renderBox([...TAGGED, groupNote("e", [same])]);
    type(input, "#wor");
    const list = await screen.findByRole("listbox");
    const groups = within(list).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-labelledby")).every((id) => id !== null && document.getElementById(id) !== null)).toBe(true);
    const mine = within(list).getByRole("group", { name: "My notes" });
    const theirs = within(list).getByRole("group", { name: "Product team" });
    expect(within(mine).getByRole("option", { name: "Work 2 notes" })).toBeInTheDocument();
    expect(within(theirs).getByRole("option", { name: "Work 1 note" })).toBeInTheDocument();
    // Every option is inside a group, none directly under the listbox.
    expect(within(list).getAllByRole("option").every((option) => option.closest('[role="group"]') !== null)).toBe(true);
  });

  it("the input follows the combobox pattern: aria-controls the list, aria-activedescendant the highlighted option", async () => {
    const input = await renderBox();
    type(input, "#");
    const list = await screen.findByRole("listbox");
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-controls", list.id);
    const options = within(list).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[1]!.id);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", options.at(-1)!.id);
  });

  it("Enter turns the highlighted tag into a token and removes the fragment from the text", async () => {
    const input = await renderBox();
    type(input, "plan #會");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(tokens()).toBe("會議");
    expect(input.value).toBe("plan ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove tag filter 會議" })).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("a new # list starts on its first option, whatever was highlighted in the last one", async () => {
    const input = await renderBox();
    type(input, "#");
    const first = await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(tokens()).toBe(first[2]!.querySelector(".truncate")!.textContent);
    type(input, "#");
    const second = await screen.findAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", second[0]!.id);
    expect(second[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter during IME composition does nothing", async () => {
    const input = await renderBox();
    type(input, "#會");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
    expect(tokens()).toBe("");
    expect(input.value).toBe("#會");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("Esc closes the list and keeps the # word as text; a second Esc clears text and tokens", async () => {
    const input = await renderBox();
    type(input, "#會");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(escapes).toBe(0);
    expect(input.value).toBe("#會");
    expect(screen.getByTestId("effective")).toHaveTextContent("#會");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(escapes).toBe(1);
    expect(input.value).toBe("");
  });

  it("Backspace with the caret at the start of an unselected box removes the last token", async () => {
    const input = await renderBox();
    type(input, "#W");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter" });
    type(input, "#T");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(tokens()).toBe("Work|Todo");
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(tokens()).toBe("Work");
    input.value = "abc";
    input.setSelectionRange(2, 2);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(tokens()).toBe("Work");
  });

  it("tags already used as tokens are not offered again, and a tag of another space is dimmed and replaces the tokens", async () => {
    const input = await renderBox();
    type(input, "#W");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter" });
    type(input, "#");
    const list = await screen.findByRole("listbox");
    expect(within(list).queryByRole("option", { name: /Work/ })).toBeNull();
    const other = within(list).getByRole("option", { name: /會議/ });
    expect(other).toHaveClass("opacity-50");
    expect(within(list).getByRole("option", { name: /Todo/ })).not.toHaveClass("opacity-50");
    fireEvent.click(other);
    expect(tokens()).toBe("會議");
  });

  it("clicking an option with the mouse adds it (the list survives the mousedown)", async () => {
    const input = await renderBox();
    type(input, "#");
    const option = await screen.findByRole("option", { name: /Todo/ });
    const notPrevented = fireEvent.mouseDown(option);
    expect(notPrevented).toBe(false);
    fireEvent.click(option);
    expect(tokens()).toBe("Todo");
  });

  it("a token's remove button drops just that token", async () => {
    const input = await renderBox();
    type(input, "#W");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter" });
    type(input, "#T");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag filter Work" }));
    expect(tokens()).toBe("Todo");
  });

  it("the remove button is named in zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    const input = await renderBox();
    type(input, "#W");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "移除標籤篩選 Work" })).toBeInTheDocument();
  });

  it("the list closes when the box loses focus and the word becomes plain text again", async () => {
    const input = await renderBox();
    type(input, "#會");
    await screen.findByRole("listbox");
    fireEvent.blur(input);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("effective")).toHaveTextContent("#會");
  });
});
