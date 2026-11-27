import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRefOrNull, reEscape, vid, vlabel, vrow, vtarget } from "@/test/version-fixtures";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { VersionCurrentDto, VersionDto, VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { versionListKey, versionsKey } from "@/api/versions";
import { KIND_FILTER_STORAGE_KEY, VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { VersionsPanel } from "./VersionsPanel";

const NOTE = "n1";
const v = (seq: number, over: Partial<VersionDto> = {}): VersionDto => ({
  id: vid(seq),
  seq,
  kind: "auto",
  name: null,
  editors: [{ handle: "ann", agentLabel: null, avatar: null }],
  baseSeq: null,
  base: baseRefOrNull(over.baseSeq),
  createdAt: "2026-10-09T01:00:00.000Z",
  ...over,
});
const cur = (over: Partial<VersionCurrentDto> = {}): VersionCurrentDto => ({ baseSeq: null, base: baseRefOrNull(over.baseSeq), dirty: false, nextSeq: 1, autoEnabled: true, ...over });

function stub(pages: Record<string, VersionListDto>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body = pages[url];
      if (!body) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    }),
  );
  return calls;
}
const FIRST = `/api/notes/${NOTE}/versions?limit=50`;
const FIRST_MANUAL = `/api/notes/${NOTE}/versions?kind=manual&limit=50`;

function Probe() {
  const s = useVersions();
  return (
    <span data-testid="state">
      {JSON.stringify({ preview: s.preview, mode: s.mode, dialog: s.dialog?.kind ?? null, dialogSeq: s.dialog && "version" in s.dialog ? s.dialog.version.seq : null })}
    </span>
  );
}
function Host({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={value.open}>host-open</button>
      <Probe />
      {value.panelOpen && <VersionsPanel doc={doc} width={320} onWidthChange={() => {}} />}
    </VersionsProvider>
  );
}
function renderPanel(doc = new Y.Doc()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={queryClient}>
      <Host doc={doc} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("host-open"));
  return { ...r, doc, queryClient };
}
const state = () => JSON.parse(screen.getByTestId("state").textContent!);

describe("VersionsPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("card classes: floating (absolute, z-20, shadow, width clamped to card width - 3rem) + fixed (xl:relative xl:w-[var(--versions-panel-width)]) + cardSurface", async () => {
    stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
    renderPanel();
    const panel = await screen.findByTestId("versions-panel");
    expect(panel).toHaveClass("absolute", "right-0", "bottom-[var(--corner-stack-clearance,0px)]", "z-20", "shadow-lg", "rounded-xl", "border", "bg-card");
    expect(panel).toHaveClass("w-[min(var(--versions-panel-width),calc(100%_-_3rem))]", "xl:relative", "xl:inset-auto", "xl:z-30", "xl:shadow-none", "xl:w-[var(--versions-panel-width)]");
    expect(panel).not.toHaveClass("w-[var(--versions-panel-width)]");
    expect(panel).not.toHaveClass("fixed");
  });

  it("the handle is present in both floating and fixed sections (right-full, no max-md:hidden)", async () => {
    stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
    renderPanel();
    const handle = await screen.findByRole("separator");
    expect(handle).toHaveClass("right-full");
    expect(handle).not.toHaveClass("max-md:hidden");
    expect(handle).not.toHaveClass("max-xl:hidden");
  });

  // #258: the subtitle depends only on current.baseSeq / dirty, not on the list contents (the list may be filtered or empty).
  it.each([
    ["no base (empty list)", { versions: [], current: cur() }, "No base version"],
    ["no base version", { versions: [v(2), v(1)], current: cur({ baseSeq: null, dirty: true, nextSeq: 3 }) }, "No base version"],
    ["based on vN, no changes", { versions: [v(2), v(1)], current: cur({ baseSeq: 2, dirty: false, nextSeq: 3 }) }, `Based on ${vlabel(2)} · no changes`],
    ["based on vN, unsaved changes (vN is the latest)", { versions: [v(2), v(1)], current: cur({ baseSeq: 2, dirty: true, nextSeq: 3 }) }, `Based on ${vlabel(2)} · unsaved changes`],
    ["based on vN, unsaved changes (vN is not the latest)", { versions: [v(2), v(1)], current: cur({ baseSeq: 1, dirty: true, nextSeq: 3 }) }, `Based on ${vlabel(1)} · unsaved changes`],
    ["base not in the list (filtered out)", { versions: [v(2)], current: cur({ baseSeq: 7, dirty: false, nextSeq: 8 }) }, `Based on ${vlabel(7)} · no changes`],
  ])("current-state subtitle: %s", async (_name, body, text) => {
    stub({ [FIRST]: { ...(body as Omit<VersionListDto, "nextBefore">), nextBefore: null } });
    renderPanel();
    const top = await screen.findByTestId("versions-current");
    expect(await within(top).findByText(text)).toBeInTheDocument();
  });

  it("!autoEnabled -> an extra line under the subtitle saying auto-save is off for this space; none when autoEnabled", async () => {
    stub({ [FIRST]: { versions: [v(1)], current: cur({ baseSeq: 1, autoEnabled: false, nextSeq: 2 }), nextBefore: null } });
    const { queryClient } = renderPanel();
    const top = await screen.findByTestId("versions-current");
    expect(await within(top).findByText("Automatic saving is off for this space")).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(versionListKey(NOTE, "all"), {
        pages: [{ versions: [v(1)], current: cur({ baseSeq: 1, autoEnabled: true, nextSeq: 2 }), nextBefore: null }],
        pageParams: [undefined],
      });
    });
    await waitFor(() => expect(screen.queryByText("Automatic saving is off for this space")).not.toBeInTheDocument());
    expect(within(top).getByText(`Based on ${vlabel(1)} · no changes`)).toBeInTheDocument();
  });

  it("row (#258): no green base dot and no manual / auto text; only auto versions have the Auto-saved pill; first line 'name (short id)'; second line editors (agent), time, based-on; a deleted user shows a placeholder", async () => {
    stub({
      [FIRST]: {
        versions: [
          v(3, { kind: "manual", name: "給客戶", baseSeq: 1, editors: [{ handle: "ann", agentLabel: null, avatar: null }, { handle: "bob", agentLabel: "Claude", avatar: null }] }),
          v(2, { editors: [{ handle: "", agentLabel: null, avatar: null }] }),
          v(1),
        ],
        current: cur({ baseSeq: 3, nextSeq: 4 }),
        nextBefore: null,
      },
    });
    renderPanel();
    const row3 = await screen.findByRole("button", { name: vrow(3, "給客戶") });
    expect(row3).toHaveTextContent("給客戶 (0003aaa)");
    expect(screen.queryByTestId("base-dot")).not.toBeInTheDocument();
    expect(row3).toHaveTextContent("ann, bob (Claude) ·");
    expect(row3).toHaveTextContent(`based on ${vlabel(1)}`);
    expect(row3).not.toHaveTextContent("Manual");
    expect(within(row3).queryByTestId("auto-badge")).not.toBeInTheDocument();
    const row2 = screen.getByRole("button", { name: vrow(2) });
    expect(row2).toHaveTextContent("Deleted user ·");
    expect(within(row2).getByTestId("auto-badge")).toHaveTextContent("Auto-saved");
    expect(within(row2).getByTestId("auto-badge")).toHaveClass("shrink-0", "rounded-full", "border", "border-border", "bg-muted", "text-foreground/70");
    expect(screen.getAllByTestId("auto-badge")).toHaveLength(2);
    // With a long name the pill is not squeezed out: the name truncates and the pill is shrink-0.
    expect(within(row3).getByText(vlabel(3, "給客戶"))).toHaveClass("truncate");
  });

  it("a row has an editor avatar group: ones with an avatar show the picture, the rest the first letter; a person and an agent with the same handle are drawn once; the accessible name and text are unchanged", async () => {
    const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    stub({
      [FIRST]: {
        versions: [
          v(2, {
            editors: [
              { handle: "alice", agentLabel: null, avatar: { id: ID, v: 1 } },
              { handle: "alice", agentLabel: "Claude", avatar: { id: ID, v: 1 } },
              { handle: "bob", agentLabel: null, avatar: null },
            ],
          }),
          v(1),
        ],
        current: cur({ baseSeq: 2, nextSeq: 3 }),
        nextBefore: null,
      },
    });
    renderPanel();
    const row2 = await screen.findByRole("button", { name: vrow(2) });
    expect(row2.querySelectorAll("img")).toHaveLength(1);
    expect(row2.querySelectorAll("[data-editor-avatar]")).toHaveLength(2);
    expect(row2).toHaveTextContent("alice, alice (Claude), bob ·");
    // The image and the first letter are decorative and do not enter the accessible name.
    expect(screen.queryByRole("button", { name: /^[AB]\s/ })).toBeNull();
    expect(within(row2).queryByRole("img")).toBeNull();
    expect(row2.querySelector("[data-editor-avatar]")!.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("clicking a row toggles the preview (startPreview carries seq and id); the selected row has bg-accent; clicking another row switches to it", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: vrow(1) }));
    expect(state().preview).toEqual(vtarget(1));
    expect(screen.getByRole("button", { name: vrow(1) })).toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: vrow(2) })).not.toHaveClass("bg-accent");
    fireEvent.click(screen.getByRole("button", { name: vrow(2) }));
    expect(state().preview).toEqual(vtarget(2));
  });

  it("clicking the selected row again leaves the preview (toggle); clicking once more enters it again", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    const row1 = await screen.findByRole("button", { name: vrow(1) });
    fireEvent.click(row1);
    expect(state().preview).toEqual(vtarget(1));
    fireEvent.click(row1);
    expect(state().preview).toBeNull();
    expect(row1).not.toHaveClass("bg-accent");
    fireEvent.click(row1);
    expect(state().preview).toEqual(vtarget(1));
  });

  it("clicking blank space in the list (the <ul> itself) leaves the preview; clicking a row or the ... button does not count as blank (does not leave)", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: vrow(1) }));
    expect(state().preview).toEqual(vtarget(1));
    fireEvent.click(screen.getByRole("button", { name: vrow(2) }));
    expect(state().preview).toEqual(vtarget(2));
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${vlabel(1)}` }));
    expect(state().preview).toEqual(vtarget(2));
    // A click in the gap between the <li> row and the ... button does not count either (the target is the <li>, not the <ul>).
    fireEvent.click(screen.getByRole("button", { name: vrow(1) }).closest("li")!);
    expect(state().preview).toEqual(vtarget(2));
    // Only press and release both on the <ul> itself count as clicking blank space.
    const list = screen.getByRole("list");
    fireEvent.pointerDown(list);
    fireEvent.click(list);
    expect(state().preview).toBeNull();
    expect(state().mode).toBe("panel");
  });

  it("pressing on a row and releasing in the gap between rows (the click goes to <ul>) does not leave the preview; a later lone click on <ul> does not count either", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    const row1 = await screen.findByRole("button", { name: vrow(1) });
    fireEvent.click(row1);
    expect(state().preview).toEqual(vtarget(1));
    const list = screen.getByRole("list");
    // When press and release land on different elements, the browser dispatches click to their common ancestor (here the <ul>).
    fireEvent.pointerDown(row1);
    fireEvent.click(list);
    expect(state().preview).toEqual(vtarget(1));
    fireEvent.click(list);
    expect(state().preview).toEqual(vtarget(1));
  });

  it("the panel's close button closes the panel -> the preview is left too", async () => {
    stub({ [FIRST]: { versions: [v(1)], current: cur({ baseSeq: 1, nextSeq: 2 }), nextBefore: null } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: vrow(1) }));
    expect(state().preview).toEqual(vtarget(1));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    expect(state().mode).toBeNull();
    expect(state().preview).toBeNull();
  });

  it("keyboard: Down / Up on a row moves focus and switches the preview (the preview target carries that row's name, #272)", async () => {
    stub({ [FIRST]: { versions: [v(3), v(2, { kind: "manual", name: "草稿" }), v(1)], current: cur({ baseSeq: 3, nextSeq: 4 }), nextBefore: null } });
    renderPanel();
    const row3 = await screen.findByRole("button", { name: vrow(3) });
    row3.focus();
    fireEvent.keyDown(row3, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: vrow(2, "草稿") })).toHaveFocus();
    expect(state().preview).toEqual(vtarget(2, "草稿"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(row3).toHaveFocus();
    expect(state().preview).toEqual(vtarget(3));
  });

  it("bottom buttons: nothing selected -> apply disabled; seq 1 selected -> 'Apply name (short id)' is enabled; save is enabled only when dirty or there is no base", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, dirty: false, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    const footer = await screen.findByTestId("versions-footer");
    // Wait for the list to land first: the footer exists before the data arrives, with current undefined and the save button always disabled (the assertion would spin idle).
    const row1 = await screen.findByRole("button", { name: vrow(1) });
    expect(within(footer).getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(within(footer).getByRole("button", { name: "Save current version" })).toBeDisabled();
    fireEvent.click(row1);
    expect(within(footer).getByRole("button", { name: `Apply ${vlabel(1)}` })).toBeEnabled();
  });

  it("bottom 'Save current version': enabled with a base and dirty", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, dirty: true, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    const footer = await screen.findByTestId("versions-footer");
    await screen.findByRole("button", { name: vrow(2) });
    await waitFor(() => expect(within(footer).getByRole("button", { name: "Save current version" })).toBeEnabled());
  });

  it("bottom 'Save current version': enabled with no base even when clean, and clicking opens the save dialog", async () => {
    stub({ [FIRST]: { versions: [], current: cur({ baseSeq: null, dirty: false }), nextBefore: null } });
    renderPanel();
    const save = await within(await screen.findByTestId("versions-footer")).findByRole("button", { name: "Save current version" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(state().dialog).toBe("save");
  });

  it("... menu: apply, edit version name, delete; delete for the base version is disabled with a visible explanation", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    fireEvent.pointerDown(await screen.findByRole("button", { name: `Actions for ${vlabel(2)}` }), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Apply" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Edit version name" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /^Delete/ })).toHaveAttribute("data-disabled");
    expect(within(menu).getByText("The base of the current content can't be deleted")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit version name" }));
    expect(state()).toMatchObject({ dialog: "rename", dialogSeq: 2 });
  });

  it("... menu: delete for a non-base version is enabled -> opens the delete dialog", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    fireEvent.pointerDown(await screen.findByRole("button", { name: `Actions for ${vlabel(1)}` }), { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete/ }));
    expect(state()).toMatchObject({ dialog: "delete", dialogSeq: 1 });
  });

  it("cursor: with nextBefore the load-older-versions item is shown and pressing it continues with the second page", async () => {
    const calls = stub({
      [FIRST]: { versions: [v(52)], current: cur({ baseSeq: 52, nextSeq: 53 }), nextBefore: 52 },
      [`/api/notes/${NOTE}/versions?before=52&limit=50`]: { versions: [v(51)], current: cur({ baseSeq: 52, nextSeq: 53 }), nextBefore: null },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Load older versions" }));
    expect(await screen.findByRole("button", { name: vrow(51) })).toBeInTheDocument();
    expect(calls).toContain(`/api/notes/${NOTE}/versions?before=52&limit=50`);
    expect(screen.queryByRole("button", { name: "Load older versions" })).not.toBeInTheDocument();
  });

  it("the close button closes the panel (mode=null)", async () => {
    stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Close version history" }));
    expect(state().mode).toBeNull();
  });

  it("a live-document update while the panel is open -> the list is refetched after a 1 s debounce (once); after the panel closes it is not refetched", async () => {
    const calls = stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
    const { doc, queryClient } = renderPanel();
    await screen.findByTestId("versions-current");
    await waitFor(() => expect(calls.filter((c) => c === FIRST)).toHaveLength(1));
    // Do not enable shouldAdvanceTime (real time would advance the fake clock in 20 ms steps and "still 1 at 999 ms" would turn red intermittently).
    // Switch to fake timers after the list lands, advance to 1000, then switch back to real timers and waitFor (react-query's notification scheduling uses setTimeout).
    vi.useFakeTimers();
    doc.getText("t").insert(0, "a");
    doc.getText("t").insert(0, "b");
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(calls.filter((c) => c === FIRST)).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();
    await waitFor(() => expect(calls.filter((c) => c === FIRST)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    doc.getText("t").insert(0, "c");
    await new Promise((r) => setTimeout(r, 1100));
    expect(calls.filter((c) => c === FIRST)).toHaveLength(2);
    // After unmount there is no observer, so invalidate only marks the query stale and does not refetch, so the fetch count alone cannot catch a listener that was not removed;
    // a leftover listener marks the query invalidated, so check that flag directly.
    expect(queryClient.getQueryState(versionListKey(NOTE, "all"))?.isInvalidated).toBe(false);
  });
  describe("filter (#258)", () => {
    const manual = (seq: number) => v(seq, { kind: "manual" });
    const ALL = { versions: [manual(4), v(3), manual(2), v(1)], current: cur({ baseSeq: 4, nextSeq: 5 }), nextBefore: null };
    const ONLY = { versions: [manual(4), manual(2)], current: cur({ baseSeq: 4, nextSeq: 5 }), nextBefore: null };

    it("above the list there is an All / Manual only two-way toggle (aria-pressed); the default is all; pressing Manual only requests kind=manual, the list shows only manual versions, and the pressed state has PRESSED_CLASS", async () => {
      const calls = stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      renderPanel();
      await screen.findByRole("button", { name: vrow(3) });
      const group = screen.getByRole("group", { name: "Filter versions" });
      const allBtn = within(group).getByRole("button", { name: "All" });
      const manualBtn = within(group).getByRole("button", { name: "Manual only" });
      expect(allBtn).toHaveAttribute("aria-pressed", "true");
      expect(manualBtn).toHaveAttribute("aria-pressed", "false");
      expect(allBtn).toHaveClass("bg-brand/25");
      const order = [screen.getByTestId("versions-current"), group, screen.getByRole("list")];
      for (let i = 1; i < order.length; i += 1) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.click(manualBtn);
      expect(await screen.findByRole("button", { name: vrow(4) })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: vrow(2) })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: vrow(3) })).not.toBeInTheDocument();
      expect(calls).toContain(FIRST_MANUAL);
      expect(manualBtn).toHaveAttribute("aria-pressed", "true");
      expect(manualBtn).toHaveClass("bg-brand/25");
      expect(allBtn).toHaveAttribute("aria-pressed", "false");
      expect(within(screen.getByTestId("versions-current")).getByText(`Based on ${vlabel(4)} · no changes`)).toBeInTheDocument();
    });

    it("the filter is written to localStorage; the initial value is read from localStorage (an invalid value counts as all)", async () => {
      stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      const first = renderPanel();
      await screen.findByRole("button", { name: vrow(3) });
      fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
      expect(window.localStorage.getItem(KIND_FILTER_STORAGE_KEY)).toBe("manual");
      first.unmount();
      const second = renderPanel();
      expect(await screen.findByRole("button", { name: "Manual only" })).toHaveAttribute("aria-pressed", "true");
      await screen.findByRole("button", { name: vrow(2) });
      expect(screen.queryByRole("button", { name: vrow(3) })).not.toBeInTheDocument();
      second.unmount();
      window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "auto");
      renderPanel();
      expect(await screen.findByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    });

    it("localStorage read/write throws -> no crash: the initial value is all and toggling still takes effect for this session", async () => {
      stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("denied");
      });
      try {
        renderPanel();
        await screen.findByRole("button", { name: vrow(3) });
        expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
        await waitFor(() => expect(screen.queryByRole("button", { name: vrow(3) })).not.toBeInTheDocument());
        expect(screen.getByRole("button", { name: "Manual only" })).toHaveAttribute("aria-pressed", "true");
      } finally {
        get.mockRestore();
        set.mockRestore();
      }
    });

    it("manual only with no matching version -> a one-line grey empty state (not shown while loading); it disappears when switching back to all", async () => {
      window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "manual");
      stub({ [FIRST_MANUAL]: { versions: [], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null }, [FIRST]: { versions: [v(2)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
      renderPanel();
      expect(screen.queryByTestId("versions-filter-empty")).not.toBeInTheDocument();
      const empty = await screen.findByTestId("versions-filter-empty");
      expect(empty).toHaveTextContent("No manually saved versions");
      expect(empty).toHaveClass("text-muted-foreground");
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      await screen.findByRole("button", { name: vrow(2) });
      expect(screen.queryByTestId("versions-filter-empty")).not.toBeInTheDocument();
    });

    it("all with no versions at all -> the filter empty state is not shown", async () => {
      stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
      renderPanel();
      await within(await screen.findByTestId("versions-current")).findByText("No base version");
      expect(screen.queryByTestId("versions-filter-empty")).not.toBeInTheDocument();
    });

    it("a previewed version is filtered out: the preview stays unchanged (preview untouched) and the bottom 'Apply vN' is still enabled", async () => {
      stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      renderPanel();
      fireEvent.click(await screen.findByRole("button", { name: vrow(3) }));
      expect(state().preview).toEqual(vtarget(3));
      const footer = screen.getByTestId("versions-footer");
      expect(within(footer).getByRole("button", { name: `Apply ${vlabel(3)}` })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: vrow(3) })).not.toBeInTheDocument());
      expect(state().preview).toEqual(vtarget(3));
      expect(within(footer).getByRole("button", { name: `Apply ${vlabel(3)}` })).toBeEnabled();
      fireEvent.click(await screen.findByRole("button", { name: vrow(2) }));
      expect(within(footer).getByRole("button", { name: `Apply ${vlabel(2)}` })).toBeEnabled();
      expect(screen.queryByRole("button", { name: vrow(3) })).not.toBeInTheDocument();
    });

    it("the debounced invalidate on a live-document update marks the caches of both filters by prefix", async () => {
      stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      const { queryClient } = renderPanel();
      await screen.findByRole("button", { name: vrow(3) });
      fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
      await waitFor(() => expect(queryClient.getQueryState(versionListKey(NOTE, "manual"))?.status).toBe("success"));
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: versionsKey(NOTE), refetchType: "none" });
      });
      expect(queryClient.getQueryState(versionListKey(NOTE, "all"))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(versionListKey(NOTE, "manual"))?.isInvalidated).toBe(true);
    });
  });
  it("#258 switching notes does not close the panel: the new note's list replaces the old one and the previous note's rows and selection (preview / Apply) do not linger", async () => {
    const N2 = "n2";
    stub({
      [FIRST]: { versions: [v(2, { name: "舊筆記的版本" }), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null },
      [`/api/notes/${N2}/versions?limit=50`]: { versions: [v(9, { name: "新筆記的版本" })], current: cur({ baseSeq: 9, nextSeq: 10 }), nextBefore: null },
    });
    function SwitchHost({ noteId, doc }: { noteId: string; doc: Y.Doc }) {
      const value = useVersionsController({ noteId, enabled: true });
      return (
        <VersionsProvider value={value}>
          <button type="button" onClick={value.open}>host-open</button>
          <Probe />
          {value.panelOpen && <VersionsPanel doc={doc} width={320} onWidthChange={() => {}} />}
        </VersionsProvider>
      );
    }
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (noteId: string) => (
      <QueryClientProvider client={queryClient}>
        <SwitchHost noteId={noteId} doc={doc} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(NOTE));
    fireEvent.click(screen.getByText("host-open"));
    const row2 = await screen.findByRole("button", { name: vrow(2, "舊筆記的版本") });
    row2.focus();
    fireEvent.click(row2);
    expect(state().preview).toEqual(vtarget(2, "舊筆記的版本"));
    expect(within(screen.getByTestId("versions-footer")).getByRole("button", { name: `Apply ${vlabel(2, "舊筆記的版本")}` })).toBeEnabled();

    rerender(ui(N2));
    expect(state().mode).toBe("panel");
    expect(state().preview).toBeNull();
    expect(screen.getByTestId("versions-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: vrow(2, "舊筆記的版本") })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: vrow(9, "新筆記的版本") })).toBeInTheDocument();
    expect(screen.queryByText("舊筆記的版本")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: vrow(1) })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("versions-footer")).getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(within(screen.getByTestId("versions-current")).getByText(`Based on ${vlabel(9)} · no changes`)).toBeInTheDocument();
  });

  it("#258: at the moment of switching filters (the new key has no data yet) the current-state subtitle and save button do not disappear and read the current cached by the other filter; once new data arrives it takes precedence", async () => {
    let release!: () => void;
    const body = (current: VersionCurrentDto, versions: VersionDto[]): VersionListDto => ({ versions, current, nextBefore: null });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === FIRST) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body(cur({ baseSeq: 2, dirty: true, nextSeq: 3 }), [v(2, { kind: "manual" }), v(1)])) } as Response);
        if (url === FIRST_MANUAL)
          return new Promise<Response>((r) => (release = () => r({ ok: true, status: 200, json: () => Promise.resolve(body(cur({ baseSeq: 2, dirty: false, nextSeq: 3 }), [v(2, { kind: "manual" })])) } as Response)));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPanel();
    const top = await screen.findByTestId("versions-current");
    expect(await within(top).findByText(`Based on ${vlabel(2)} · unsaved changes`)).toBeInTheDocument();
    const save = within(screen.getByTestId("versions-footer")).getByRole("button", { name: "Save current version" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
    // The new key is loading: the list is empty but the subtitle remains and the save button does not flash disabled.
    await waitFor(() => expect(screen.queryByRole("button", { name: vrow(1) })).not.toBeInTheDocument());
    expect(within(top).getByText(`Based on ${vlabel(2)} · unsaved changes`)).toBeInTheDocument();
    expect(save).toBeEnabled();
    release();
    expect(await within(top).findByText(`Based on ${vlabel(2)} · no changes`)).toBeInTheDocument();
  });
  it("#258: the query for its own filtered list fails -> it does not fall back to the other, possibly stale current (the subtitle disappears and the save button is disabled)", async () => {
    const body = (current: VersionCurrentDto, versions: VersionDto[]): VersionListDto => ({ versions, current, nextBefore: null });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === FIRST) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body(cur({ baseSeq: 2, dirty: true, nextSeq: 3 }), [v(2, { kind: "manual" }), v(1)])) } as Response);
        if (url === FIRST_MANUAL) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const { queryClient } = renderPanel();
    const top = await screen.findByTestId("versions-current");
    expect(await within(top).findByText(`Based on ${vlabel(2)} · unsaved changes`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
    await waitFor(() => expect(queryClient.getQueryState(versionListKey(NOTE, "manual"))?.status).toBe("error"));
    await waitFor(() => expect(within(top).queryByText(new RegExp(`^Based on ${reEscape(vlabel(2))}`))).not.toBeInTheDocument());
    expect(within(screen.getByTestId("versions-footer")).getByRole("button", { name: "Save current version" })).toBeDisabled();
  });

  it("#272: the row's second line - cookie and web AI writes list only the handle; token writes list 'handle (agent)'", async () => {
    stub({
      [FIRST]: {
        versions: [v(2, { editors: [{ handle: "ann", agentLabel: null, avatar: null }] }), v(1, { editors: [{ handle: "ann", agentLabel: "Claude Code", avatar: null }] })],
        current: cur({ baseSeq: 2, nextSeq: 3 }),
        nextBefore: null,
      },
    });
    renderPanel();
    const row2 = await screen.findByRole("button", { name: vrow(2) });
    expect(row2).toHaveTextContent("ann ·");
    expect(row2).not.toHaveTextContent("ann (");
    expect(screen.getByRole("button", { name: vrow(1) })).toHaveTextContent("ann (Claude Code) ·");
  });

  it("#272: the based-on version was deleted -> 'derived name (short id) (deleted)' (not the original name); deleted before the upgrade -> 'a deleted version'; the current state follows the same rule", async () => {
    stub({
      [FIRST]: {
        versions: [
          v(3, { baseSeq: 1, base: { id: vid(1), name: "原名", deleted: true } }),
          v(2, { baseSeq: 1, base: { id: null, name: null, deleted: true } }),
        ],
        current: cur({ baseSeq: 1, base: { id: vid(1), name: "原名", deleted: true } }),
        nextBefore: null,
      },
    });
    renderPanel();
    expect(await screen.findByRole("button", { name: vrow(3) })).toHaveTextContent("based on agile-beaver (0001aaa) (deleted)");
    expect(screen.getByRole("button", { name: vrow(2) })).toHaveTextContent("based on a deleted version");
    expect(within(screen.getByTestId("versions-current")).getByText("Based on agile-beaver (0001aaa) (deleted) · no changes")).toBeInTheDocument();
  });
});
