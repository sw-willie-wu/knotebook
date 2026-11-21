import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TAG_PRESET_COLORS, type NoteDto, type NoteTagDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { RECENT_COLORS_KEY, resetRecentColorsForTest } from "@/lib/recent-colors";
import { NoteTagRow } from "./NoteTagRow";

const aws: NoteTagDto = { id: "t1", name: "AWS", color: "blue" };

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return { id: "n1", groupId: null, role: "owner", tags: [aws], ...overrides } as unknown as NoteDto;
}

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stubFetch(n: NoteDto) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url === "/api/notes") return Promise.resolve(json(200, [n]));
      if (url === "/api/tags" || /^\/api\/groups\/[^/]+\/tags$/.test(url)) return Promise.resolve(json(200, [{ ...aws, noteCount: 1 }]));
      if (url === "/api/tags/t1" && method === "PATCH") return Promise.resolve(json(200, { ...aws, ...(JSON.parse(String(init?.body)) as object), noteCount: 1 }));
      if (url === "/api/notes/n1/tags/t1" && method === "DELETE") return Promise.resolve(json(200, { tags: [] }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return calls;
}

function renderRow(n: NoteDto, canEdit: boolean, groups?: Array<{ id: string; canManageGroup: boolean }>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (groups) queryClient.setQueryData(["groups"], groups);
  return render(
    <QueryClientProvider client={queryClient}>
      <NoteTagRow note={n} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

async function openMenu(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: "Tag AWS" });
  fireEvent.pointerDown(trigger, { button: 0 });
  return screen.findByRole("menu");
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  dismissAllToasts();
  localStorage.removeItem(RECENT_COLORS_KEY);
  resetRecentColorsForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tag pill menu", () => {
  it("shows a manager Rename, nine colors and Custom… with the current one checked, the applies-to-all line and Remove from this note", async () => {
    stubFetch(note());
    renderRow(note(), true);
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Rename…" })).toBeTruthy();
    const radios = within(menu).getAllByRole("menuitemradio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([...TAG_PRESET_COLORS.map((c) => i18n.t(`tags.colors.${c}`)), "Custom…"]);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.getAttribute("aria-label"))).toEqual(["Blue"]);
    expect(within(menu).getByText("Applies to every note with this tag.")).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Remove from this note" })).toBeTruthy();
  });

  it("shows a member who can edit but not manage only Remove from this note", async () => {
    stubFetch(note({ groupId: "g1", role: "editor" }));
    renderRow(note({ groupId: "g1", role: "editor" }), true);
    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Remove from this note"]);
    expect(within(menu).queryByRole("menuitemradio")).toBeNull();
  });

  it("shows a group manager the full menu on a group note", async () => {
    stubFetch(note({ groupId: "g1", role: "editor" }));
    renderRow(note({ groupId: "g1", role: "editor" }), true, [{ id: "g1", canManageGroup: true }]);
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Rename…" })).toBeTruthy();
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(TAG_PRESET_COLORS.length + 1);
  });

  it("shows an edit share on a personal note only Remove from this note too", async () => {
    stubFetch(note({ role: "editor" }));
    renderRow(note({ role: "editor" }), true);
    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Remove from this note"]);
  });

  it("sends PATCH {color} when a color is chosen and keeps the menu open", async () => {
    const calls = stubFetch(note());
    renderRow(note(), true);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Red" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ color: "red" }));
    expect(calls.find((c) => c.method === "PATCH")?.url).toBe("/api/tags/t1");
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  it("opens the rename dialog from Rename", async () => {
    stubFetch(note());
    renderRow(note(), true);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Rename tag")).toBeTruthy();
    expect((within(dialog).getByLabelText("Tag name") as HTMLInputElement).value).toBe("AWS");
  });

  it("a custom color: the pill and the Custom… swatch carry it inline, Custom… is the checked choice and names the color", async () => {
    const red: NoteTagDto = { ...aws, color: "#e03e3e" };
    stubFetch(note({ tags: [red] }));
    renderRow(note({ tags: [red] }), true);
    const trigger = await screen.findByRole("button", { name: "Tag AWS" });
    const pill = trigger.closest("[data-tag-color]") as HTMLElement;
    expect(pill.getAttribute("data-tag-color")).toBe("#e03e3e");
    expect(pill.style.getPropertyValue("--tag-bg")).toBe("#e03e3e");
    expect(pill.style.getPropertyValue("--tag-fg")).toMatch(/^#[0-9a-f]{6}$/);
    const menu = await openMenu();
    const checked = within(menu).getAllByRole("menuitemradio").filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.getAttribute("aria-label"))).toEqual(["Custom color #e03e3e"]);
    expect(checked[0]!.style.getPropertyValue("--tag-dot")).toBe("#e03e3e");
  });

  it("Custom… opens a dialog whose hex box applies the color with PATCH and records it as a recent color", async () => {
    const calls = stubFetch(note());
    renderRow(note(), true);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Custom…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Custom color")).toBeTruthy();
    const hex = within(dialog).getByLabelText("Hex color") as HTMLInputElement;
    fireEvent.change(hex, { target: { value: "zz" } });
    expect(within(dialog).getByText("Enter a color as #rgb or #rrggbb")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(hex, { target: { value: "E03E3E" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ color: "#e03e3e" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? "[]")).toEqual(["#e03e3e"]);
  });

  it("removes the tag from the note with Remove from this note", async () => {
    const calls = stubFetch(note());
    renderRow(note(), true);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove from this note" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/notes/n1/tags/t1")).toBe(true));
  });

  it("gives a read-only pill no button and no menu", async () => {
    stubFetch(note());
    renderRow(note(), false);
    await screen.findByText("AWS");
    await act(async () => {});
    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.pointerDown(screen.getByText("AWS"), { button: 0 });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the remove cross for mouse users only: it is hidden on touch because the menu removes the tag", async () => {
    stubFetch(note());
    renderRow(note(), true);
    await screen.findByRole("button", { name: "Tag AWS" });
    const remove = screen.getByRole("button", { name: "Remove tag AWS" });
    expect(remove.className).toContain("pointer-coarse:hidden");
    expect(remove.className).toContain("pointer-fine:group-hover/tagpill:opacity-100");
  });
});
