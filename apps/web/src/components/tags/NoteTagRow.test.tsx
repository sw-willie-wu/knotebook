import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto, NoteTagDto, SpaceTagDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import * as toastModule from "@/components/ui/toast";
import { NoteTagRow } from "./NoteTagRow";
import { openTagEntry } from "./tag-entry";

const aws: NoteTagDto = { id: "t1", name: "AWS", color: "blue" };
const budget: NoteTagDto = { id: "t2", name: "Budget", color: "green" };
const spaceList: SpaceTagDto[] = [
  { ...aws, noteCount: 3 },
  { ...budget, noteCount: 1 },
  { id: "t3", name: "Cloud", color: "red", noteCount: 2 },
];

function note(tags: NoteTagDto[] | undefined, groupId: string | null = null): NoteDto {
  return { id: "n1", groupId, ...(tags ? { tags } : {}) } as unknown as NoteDto;
}

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stubFetch(opts: { notes: NoteDto[]; post?: (name: string) => Response }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json(200, opts.notes));
      if (url === "/api/tags" && method === "GET") return Promise.resolve(json(200, spaceList));
      if (url === "/api/groups/g1/tags" && method === "GET") return Promise.resolve(json(200, spaceList));
      if (url === "/api/notes/n1/tags" && method === "POST") {
        return Promise.resolve(opts.post ? opts.post((body as { name: string }).name) : json(200, { tags: [aws, budget] }));
      }
      if (url === "/api/notes/n1/tags/t1" && method === "DELETE") return Promise.resolve(json(200, { tags: [budget] }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return calls;
}

function spaceListFetched(calls: Call[]): boolean {
  return calls.some((c) => c.method === "GET" && (c.url === "/api/tags" || /^\/api\/groups\/[^/]+\/tags$/.test(c.url)));
}

function renderRow(n: NoteDto, canEdit: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NoteTagRow note={n} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  dismissAllToasts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NoteTagRow", () => {
  it("renders nothing when the note has no tags, with or without canEdit", async () => {
    for (const canEdit of [true, false]) {
      const calls = stubFetch({ notes: [note([])] });
      const { container, unmount } = renderRow(note([]), canEdit);
      await waitFor(() => expect(calls.some((c) => c.url === "/api/notes")).toBe(true));
      await act(async () => {});
      expect(container.firstChild).toBeNull();
      expect(spaceListFetched(calls)).toBe(false);
      unmount();
    }
  });

  it("with tags and canEdit the row ends with the Add a tag button", async () => {
    stubFetch({ notes: [note([aws, budget])] });
    const { container } = renderRow(note([aws, budget]), true);
    await screen.findByText("AWS");
    const row = container.querySelector("[data-note-tags]")!;
    expect(row.lastElementChild).toBe(screen.getByRole("button", { name: "Add a tag" }));
    expect(screen.getByRole("button", { name: "Remove tag AWS" })).toBeTruthy();
  });

  it("viewers and edit shares (canEdit false) see the pills without remove buttons or Add, and never fetch the space's tag list", async () => {
    const calls = stubFetch({ notes: [note([aws, budget])] });
    renderRow(note([aws, budget]), false);
    await screen.findByText("AWS");
    await act(async () => {});
    expect(screen.queryByRole("button")).toBeNull();
    expect(spaceListFetched(calls)).toBe(false);
  });

  it("loads a group note's space list from the group endpoint", async () => {
    const calls = stubFetch({ notes: [note([aws], "g1")] });
    renderRow(note([aws], "g1"), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/groups/g1/tags")).toBe(true));
  });

  it("Enter on a new name posts it; Enter on 'aws' when 'AWS' exists posts AWS; an invalid name shows the message and posts nothing", async () => {
    const calls = stubFetch({ notes: [note([budget])] });
    renderRow(note([budget]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    const input = await screen.findByRole("combobox", { name: "Tag name" });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/tags")).toBe(true));

    fireEvent.change(input, { target: { value: "  brand new " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ name: "brand new" }]));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));

    fireEvent.change(input, { target: { value: "aws" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ name: "brand new" }, { name: "AWS" }]));

    fireEvent.change(input, { target: { value: "x".repeat(41) } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("Tag names must be 1 to 40 characters.");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("picking an option with the arrow keys attaches that tag", async () => {
    const calls = stubFetch({ notes: [note([budget])] });
    renderRow(note([budget]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    const input = await screen.findByRole("combobox", { name: "Tag name" });
    await screen.findByRole("option", { name: "AWS" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ name: "AWS" }]));
  });

  it("an API failure shows the error toast and keeps what was typed", async () => {
    const toastSpy = vi.spyOn(toastModule, "toast");
    stubFetch({
      notes: [note([budget])],
      post: () => json(409, { error: "tag_limit_reached" }),
    });
    renderRow(note([budget]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    const input = await screen.findByRole("combobox", { name: "Tag name" });
    fireEvent.change(input, { target: { value: "more" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy.mock.calls[0]![0]).toMatchObject({ variant: "destructive" });
    expect((input as HTMLInputElement).value).toBe("more");
  });

  it("Escape closes the input and focuses Add; Backspace in an empty input removes nothing", async () => {
    const calls = stubFetch({ notes: [note([aws])] });
    renderRow(note([aws]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    const input = await screen.findByRole("combobox", { name: "Tag name" });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.getByText("AWS")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a tag" }));
  });

  it("Enter while an IME is composing submits nothing and keeps the input open", async () => {
    const calls = stubFetch({ notes: [note([budget])] });
    renderRow(note([budget]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    const input = await screen.findByRole("combobox", { name: "Tag name" });
    fireEvent.change(input, { target: { value: "ni" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    await act(async () => {});
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.getByRole("combobox", { name: "Tag name" })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("ni");
  });

  it("mousedown on an option, a group heading or the error text is default-prevented, or the input would blur and close the list", async () => {
    stubFetch({ notes: [note([budget])] });
    renderRow(note([budget]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    const input = await screen.findByRole("combobox", { name: "Tag name" });
    const option = await screen.findByRole("option", { name: "AWS" });
    // fireEvent returns false when the event's default was prevented.
    expect(fireEvent.mouseDown(option)).toBe(false);
    expect(fireEvent.mouseDown(screen.getByText("Tags", { selector: "p" }))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByText("Suggestions"))).toBe(false);
    fireEvent.change(input, { target: { value: "x".repeat(41) } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fireEvent.mouseDown(await screen.findByRole("alert"))).toBe(false);
  });

  it("the remove button deletes that tag", async () => {
    const calls = stubFetch({ notes: [note([aws, budget])] });
    renderRow(note([aws, budget]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Remove tag AWS" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/notes/n1/tags/t1")).toBe(true));
  });

  it("suggestions follow the interface language and leave out names the space has", async () => {
    stubFetch({ notes: [note([aws])] });
    renderRow(note([aws]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    await screen.findByRole("option", { name: "Reference" });
    expect(screen.queryByRole("option", { name: "待辦" })).toBeNull();
    expect(screen.getByRole("option", { name: "To do" })).toBeTruthy();
    // "Cloud" is in the space but not on the note, so it is offered as existing; AWS is on the note and left out.
    expect(await screen.findByRole("option", { name: "Cloud" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "AWS" })).toBeNull();
  });
});

describe("NoteTagRow entry points", () => {
  it("renders nothing without tags until an entry request opens it with the input focused", async () => {
    const calls = stubFetch({ notes: [note([])] });
    const { container } = renderRow(note([]), true);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/notes")).toBe(true));
    await act(async () => {});
    expect(container.firstChild).toBeNull();
    act(() => openTagEntry("n1"));
    const input = await screen.findByRole("combobox", { name: "Tag name" });
    expect(document.activeElement).toBe(input);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/tags")).toBe(true));
  });

  it("a request for a note whose tags the viewer cannot change shows nothing", async () => {
    stubFetch({ notes: [note([])] });
    const { container } = renderRow(note([]), false);
    await act(async () => {});
    act(() => openTagEntry("n1"));
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("a request for another note does not open this one", async () => {
    stubFetch({ notes: [note([])] });
    const { container } = renderRow(note([]), true);
    await act(async () => {});
    act(() => openTagEntry("other-note"));
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("blurring the empty input with no tags folds the row away; with a tag added it stays", async () => {
    const notes = [note([])];
    const calls = stubFetch({
      notes,
      post: () => {
        notes[0] = note([aws]);
        return json(200, { tags: [aws] });
      },
    });
    const { container } = renderRow(note([]), true);
    await act(async () => {});
    act(() => openTagEntry("n1"));
    let input = await screen.findByRole("combobox", { name: "Tag name" });
    fireEvent.blur(input);
    await waitFor(() => expect(container.firstChild).toBeNull());

    act(() => openTagEntry("n1"));
    input = await screen.findByRole("combobox", { name: "Tag name" });
    fireEvent.change(input, { target: { value: "AWS" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await screen.findByText("AWS");
    fireEvent.blur(screen.getByRole("combobox", { name: "Tag name" }));
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    expect(screen.getByText("AWS")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a tag" })).toBeTruthy();
  });

  it("Escape and Tab out of the empty input hand focus to the entry's return function; blurring elsewhere does not", async () => {
    stubFetch({ notes: [note([])] });
    const { container } = renderRow(note([]), true);
    await act(async () => {});
    const back = vi.fn();
    act(() => openTagEntry("n1", { returnFocus: back }));
    let input = await screen.findByRole("combobox", { name: "Tag name" });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();

    act(() => openTagEntry("n1", { returnFocus: back }));
    input = await screen.findByRole("combobox", { name: "Tag name" });
    // fireEvent returns false when the default (moving focus to the next control, or to <body> once the input is gone) was prevented.
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    await waitFor(() => expect(back).toHaveBeenCalledTimes(2));
    expect(container.firstChild).toBeNull();

    act(() => openTagEntry("n1", { returnFocus: back }));
    input = await screen.findByRole("combobox", { name: "Tag name" });
    fireEvent.blur(input);
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("with tags, Escape focuses Add and Tab is left alone; the return function is not used", async () => {
    stubFetch({ notes: [note([aws])] });
    renderRow(note([aws]), true);
    await screen.findByText("AWS");
    const back = vi.fn();
    act(() => openTagEntry("n1", { returnFocus: back }));
    const input = await screen.findByRole("combobox", { name: "Tag name" });
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a tag" })));
    expect(back).not.toHaveBeenCalled();
  });

  it("asking again while the input is already open focuses it again", async () => {
    stubFetch({ notes: [note([])] });
    renderRow(note([]), true);
    await act(async () => {});
    act(() => openTagEntry("n1"));
    const first = await screen.findByRole("combobox", { name: "Tag name" });
    act(() => openTagEntry("n1"));
    const second = await screen.findByRole("combobox", { name: "Tag name" });
    expect(second).not.toBe(first);
    expect(document.activeElement).toBe(second);
  });

  function stubSlowSpaceList(outcome: "ok" | "fail") {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/notes") return json(200, [note([aws])]);
        if (url === "/api/tags") {
          await gate;
          return outcome === "ok" ? json(200, spaceList) : json(500, { error: "server_error" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    return release;
  }

  it("while the space list loads nothing is listed, so existing tags never push the suggestions down when they arrive", async () => {
    const release = stubSlowSpaceList("ok");
    renderRow(note([aws]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    await screen.findByRole("combobox", { name: "Tag name" });
    await act(async () => {});
    expect(screen.queryByRole("option")).toBeNull();
    await act(async () => release());
    await screen.findByRole("option", { name: "Cloud" });
    const headings = screen.getAllByText(/^(Tags|Suggestions)$/, { selector: "p" }).map((el) => el.textContent);
    expect(headings).toEqual(["Tags", "Suggestions"]);
  });

  it("when the space list fails to load the suggestions show and a new name can still be created", async () => {
    const release = stubSlowSpaceList("fail");
    renderRow(note([aws]), true);
    fireEvent.click(await screen.findByRole("button", { name: "Add a tag" }));
    await screen.findByRole("combobox", { name: "Tag name" });
    await act(async () => release());
    expect(await screen.findByRole("option", { name: "Reference" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Cloud" })).toBeNull();
  });

  it("with tags, the space list is not fetched until the input is opened", async () => {
    const calls = stubFetch({ notes: [note([aws])] });
    renderRow(note([aws]), true);
    await screen.findByText("AWS");
    await act(async () => {});
    expect(spaceListFetched(calls)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add a tag" }));
    await waitFor(() => expect(spaceListFetched(calls)).toBe(true));
  });

  it("switching to another note and back doesn't reopen the input", async () => {
    stubFetch({ notes: [note([]), { ...note([]), id: "n2" } as NoteDto] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const ui = (n: NoteDto) => (
      <QueryClientProvider client={queryClient}>
        <NoteTagRow key={n.id} note={n} canEdit />
      </QueryClientProvider>
    );
    const second = { ...note([]), id: "n2" } as NoteDto;
    const { container, rerender } = render(ui(note([])));
    await act(async () => {});
    act(() => openTagEntry("n1"));
    await screen.findByRole("combobox", { name: "Tag name" });
    rerender(ui(second));
    await act(async () => {});
    expect(container.firstChild).toBeNull();
    rerender(ui(note([])));
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });
});

describe("NoteTagRow folding to one line", () => {
  const many: NoteTagDto[] = [aws, budget, { id: "t3", name: "Cloud", color: "red" }];
  const originalClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const originalOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 204 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 60 });
  });

  afterEach(() => {
    if (originalClient) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClient);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (originalOffset) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffset);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
  });

  it("leaves the pills that do not fit behind a +N button; +N expands, Show less folds again; Add stays last", async () => {
    stubFetch({ notes: [note(many)] });
    const { container } = renderRow(note(many), true);
    const more = await screen.findByRole("button", { name: "Show 1 more tags" });
    expect(more.textContent).toBe("+1");
    const hidden = container.querySelectorAll("[data-pill-hidden]");
    expect([...hidden].map((el) => el.textContent)).toEqual(["Cloud"]);
    const row = container.querySelector("[data-note-tags]")!;
    expect(row.lastElementChild).toBe(screen.getByRole("button", { name: "Add a tag" }));

    fireEvent.click(more);
    expect(container.querySelectorAll("[data-pill-hidden]")).toHaveLength(0);
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("gap-y-[3px]");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(container.querySelectorAll("[data-pill-hidden]")).toHaveLength(1);
  });

  it("keeps the first pill visible when it alone is wider than the row; the rest go behind +N", async () => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
    stubFetch({ notes: [note([aws, budget])] });
    const { container } = renderRow(note([aws, budget]), true);
    expect(await screen.findByRole("button", { name: "Show 1 more tags" })).toBeTruthy();
    expect([...container.querySelectorAll("[data-pill-hidden]")].map((el) => el.textContent)).toEqual(["Budget"]);
    expect(container.querySelector("[data-note-tags] > span:not([data-pill-hidden])")!.textContent).toBe("AWS");
  });

  it("the +N and Show less buttons report aria-expanded and focus moves to the button that replaces them", async () => {
    stubFetch({ notes: [note(many)] });
    renderRow(note(many), true);
    const more = await screen.findByRole("button", { name: "Show 1 more tags" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(less);
    fireEvent.click(less);
    const again = screen.getByRole("button", { name: "Show 1 more tags" });
    expect(document.activeElement).toBe(again);
  });

  it("an open input takes its room out of the line, so more pills go behind +N", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 });
    stubFetch({ notes: [note(many)] });
    const { container } = renderRow(note(many), true);
    await screen.findByText("Cloud");
    expect(container.querySelectorAll("[data-pill-hidden]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Add a tag" }));
    await screen.findByRole("combobox", { name: "Tag name" });
    await waitFor(() => expect(container.querySelectorAll("[data-pill-hidden]")).toHaveLength(2));
  });

  it("shows every pill when they fit", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
    stubFetch({ notes: [note(many)] });
    const { container } = renderRow(note(many), true);
    await screen.findByText("Cloud");
    expect(container.querySelectorAll("[data-pill-hidden]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /more tags/ })).toBeNull();
  });
});
