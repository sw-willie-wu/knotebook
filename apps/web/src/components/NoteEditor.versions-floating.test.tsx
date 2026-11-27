import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { vid, vtarget } from "@/test/version-fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { ThemeProvider } from "@/theme";
import { cornerStackFootprint } from "./corner-stack-geometry";
import { CORNER_STACK_COLLAPSED_STORAGE_KEY, __resetCornerStackForTests } from "./corner-stack-state";
import { NoteEditor } from "./NoteEditor";

// Make the panel throw on render, going through the error frame (`VERSIONS_ERROR_FRAME.panel`).
const crash = vi.hoisted(() => ({ on: false }));
vi.mock("@/components/versions/VersionsLazy", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/versions/VersionsLazy")>();
  return {
    ...original,
    VersionsPanel: (props: React.ComponentProps<typeof original.VersionsPanel>) => {
      if (crash.on) throw new Error("boom");
      return original.VersionsPanel(props);
    },
  };
});

const NOTE = "note-1";
const LIST_URL = `/api/notes/${NOTE}/versions?limit=50`;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
      if (url === LIST_URL) {
        return Promise.resolve(
          json({
            versions: [{ id: vid(1), seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, base: null, createdAt: "2026-10-09T01:00:00.000Z" }],
            current: { baseSeq: null, base: null, dirty: false, nextSeq: 2, autoEnabled: true },
            nextBefore: null,
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function Controls() {
  const v = useVersions();
  return (
    <div>
      <span data-testid="state">{JSON.stringify({ mode: v.mode, preview: v.preview?.seq ?? null })}</span>
      <button type="button" onClick={v.open}>host-open</button>
      <button type="button" onClick={() => v.startPreview(vtarget(1))}>host-preview</button>
      <button type="button" onClick={v.stopPreview}>host-stop-preview</button>
      <button type="button" onClick={() => v.openSave()}>host-save</button>
      <button type="button" data-testid="outside">outside</button>
    </div>
  );
}

function Host({ doc }: { doc: Y.Doc }) {
  const versions = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={versions}>
      <Controls />
      <NoteEditor
        doc={doc}
        provider={{ awareness: null } as never}
        editable
        user={{ id: "u1", name: "Ann" }}
        noteId={NOTE}
        headerSlot={<div data-testid="header-marker">header</div>}
        footerSlot={<div data-testid="footer-marker">footer</div>}
        previewSlot={versions.preview !== null ? <div data-testid="preview-marker">preview</div> : undefined}
      />
    </VersionsProvider>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent!) as { mode: string | null; preview: number | null };

async function renderAt(tier: LayoutTier) {
  const tierHandle = stubLayoutTier(tier);
  const doc = new Y.Doc();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={doc} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  const editor = await screen.findByTestId("note-editor");
  const row = editor.parentElement!.parentElement!.parentElement!.parentElement!.parentElement!;
  return { ...tierHandle, doc, row, ...utils };
}

async function openPanel() {
  fireEvent.click(screen.getByText("host-open"));
  return screen.findByTestId("versions-panel");
}

describe("NoteEditor versions panel: floating and fixed", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    __resetCornerStackForTests();
    stubFetch();
    crash.on = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the row container is the positioning base; the panel carries both the floating (absolute, z-20, shadow, top edge clears the header) and the fixed (xl:relative) class sets", async () => {
    const { row, doc } = await renderAt("overlay");
    expect(row).toHaveClass("relative", "flex", "h-full", "gap-3");
    const panel = await openPanel();
    // The panel is wrapped in a `display: contents` slot (it produces no box), so the positioning base is still the row container.
    const slot = panel.parentElement!;
    expect(slot).toHaveAttribute("data-versions-panel-slot");
    expect(slot).toHaveClass("contents");
    expect(slot.parentElement).toBe(row);
    expect(panel).toHaveClass("absolute", "right-0", "bottom-[var(--corner-stack-clearance,0px)]", "z-20", "shadow-lg", "top-[var(--note-header-h,0px)]");
    expect(panel).toHaveClass("xl:relative", "xl:inset-auto", "xl:shadow-none", "xl:w-[var(--versions-panel-width)]");
    expect(panel).toHaveClass("w-[min(var(--versions-panel-width),calc(100%_-_3rem))]");
    expect(panel).not.toHaveClass("fixed");
    doc.destroy();
  });

  it("history bubble anchor is inside the content card, before the footer (above the mentions row, not in a window corner); stays while the panel is open, outside the third column; none on phone", async () => {
    const { row, setLayoutTier } = await renderAt("docked");
    const anchor = await screen.findByTestId("corner-anchor");
    const card = row.firstElementChild!;
    expect(anchor.parentElement).toBe(card);
    expect(anchor.nextElementSibling).toBe(screen.getByTestId("footer-marker"));
    expect(screen.getByTestId("corner-stack").closest(".fixed")).toBeNull();
    const panel = await openPanel();
    expect(screen.getByTestId("corner-anchor").parentElement).toBe(card);
    expect(panel).not.toContainElement(screen.getByTestId("corner-stack"));
    expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "true");
    act(() => setLayoutTier("phone"));
    expect(screen.queryByTestId("corner-anchor")).not.toBeInTheDocument();
  });

  it.each(["overlay", "docked"] as const)("%s: the history bubble opens the panel and, pressed, closes it again; the toggle never closes it", async (tier) => {
    const { doc } = await renderAt(tier);
    const bubble = await screen.findByTestId("versions-bubble");
    expect(bubble).toHaveAttribute("aria-pressed", "false");
    fireEvent.pointerDown(bubble);
    fireEvent.click(bubble);
    const panel = await screen.findByTestId("versions-panel");
    await waitFor(() => expect(panel).toHaveFocus());
    expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "true");
    const toggle = screen.getByTestId("corner-toggle");
    toggle.focus();
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);
    expect(screen.queryByTestId("versions-bubble")).toBeNull();
    expect(toggle).toHaveFocus();
    expect(screen.getByTestId("versions-panel")).toBeInTheDocument();
    fireEvent.click(toggle);
    const again = screen.getByTestId("versions-bubble");
    fireEvent.pointerDown(again);
    fireEvent.click(again);
    expect(screen.queryByTestId("versions-panel")).toBeNull();
    expect(state().mode).toBeNull();
    doc.destroy();
  });

  /** Row, anchor (the scroll area's bottom edge) and header boxes; the clearance is row bottom - anchor top + 12 + the stack's footprint. */
  function stubBoxes(row: HTMLElement, box: { rowHeight: number; anchorTop: number; header: number }) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === row) return new DOMRect(0, 0, 900, box.rowHeight);
      if ((this as HTMLElement).dataset.testid === "corner-anchor") return new DOMRect(0, box.anchorTop, 900, 0);
      if (this.hasAttribute("data-note-header-slot")) return new DOMRect(0, 0, 900, box.header);
      return new DOMRect(0, 0, 0, 0);
    });
  }

  /** ResizeObserver whose callbacks for the row container run only when asked. */
  function controllableResize(isRow: (el: Element) => boolean) {
    const callbacks = new Set<() => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly cb: (entries: unknown[], observer: unknown) => void) {}
        observe(target: Element) {
          if (isRow(target)) callbacks.add(() => this.cb([], this));
        }
        unobserve() {}
        disconnect() {}
      },
    );
    return () => act(() => callbacks.forEach((fire) => fire()));
  }

  it("640-1279: while the panel floats, its bottom edge keeps clear of the corner stack (row bottom - anchor top + gap + the toggle and bubble); not at 1280+, and gone once closed", async () => {
    const { row, doc, setLayoutTier } = await renderAt("overlay");
    await screen.findByTestId("corner-stack");
    stubBoxes(row, { rowHeight: 700, anchorTop: 600, header: 57 });
    const expected = `${700 - 600 + 12 + cornerStackFootprint(2)}px`;
    await openPanel();
    expect(row.style.getPropertyValue("--corner-stack-clearance")).toBe(expected);
    act(() => setLayoutTier("docked"));
    expect(row.style.getPropertyValue("--corner-stack-clearance")).toBe("");
    act(() => setLayoutTier("overlay"));
    expect(row.style.getPropertyValue("--corner-stack-clearance")).toBe(expected);
    fireEvent.click(within(screen.getByTestId("versions-panel")).getByRole("button", { name: "Close version history" }));
    expect(row.style.getPropertyValue("--corner-stack-clearance")).toBe("");
    doc.destroy();
  });

  it("640-1279, a window too short for the panel above the expanded stack: only the toggle shows (not saved); pressing it shows the bubble for now; with room again the stack is back", async () => {
    let rowEl: Element | null = null;
    const fireResize = controllableResize((el) => el === rowEl);
    const { row, doc } = await renderAt("overlay");
    rowEl = row;
    await screen.findByTestId("versions-bubble");
    const box = { rowHeight: 390, anchorTop: 330, header: 57 };
    stubBoxes(row, box);
    await openPanel();
    const toggle = screen.getByTestId("corner-toggle");
    expect(screen.queryByTestId("versions-bubble")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(row.style.getPropertyValue("--corner-stack-clearance")).toBe(`${390 - 330 + 12 + cornerStackFootprint(1)}px`);
    expect(window.localStorage.getItem(CORNER_STACK_COLLAPSED_STORAGE_KEY)).toBeNull();

    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveFocus();
    expect(row.style.getPropertyValue("--corner-stack-clearance")).toBe(`${390 - 330 + 12 + cornerStackFootprint(2)}px`);
    expect(window.localStorage.getItem(CORNER_STACK_COLLAPSED_STORAGE_KEY)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("versions-bubble")).toBeNull();

    Object.assign(box, { rowHeight: 800, anchorTop: 700 });
    fireResize();
    expect(screen.getByTestId("versions-bubble")).toBeInTheDocument();
    expect(row.style.getPropertyValue("--corner-stack-clearance")).toBe(`${800 - 700 + 12 + cornerStackFootprint(2)}px`);
    expect(screen.getByTestId("versions-panel")).toBeInTheDocument();
    doc.destroy();
  });

  it("640-1279, a window too short with the stack saved as collapsed: the first press of the toggle shows the bubble for now and saves nothing", async () => {
    window.localStorage.setItem(CORNER_STACK_COLLAPSED_STORAGE_KEY, "1");
    const { row, doc } = await renderAt("overlay");
    await screen.findByTestId("corner-toggle");
    stubBoxes(row, { rowHeight: 390, anchorTop: 330, header: 57 });
    await openPanel();
    const toggle = screen.getByTestId("corner-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem(CORNER_STACK_COLLAPSED_STORAGE_KEY)).toBe("1");
    doc.destroy();
  });

  it.each(["overlay", "docked"] as const)("%s: ✕ gives the focus to the history bubble, or to the toggle while the stack is collapsed", async (tier) => {
    const { doc } = await renderAt(tier);
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    await waitFor(() => expect(screen.getByTestId("versions-bubble")).toHaveFocus());
    fireEvent.click(screen.getByTestId("corner-toggle"));
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    await waitFor(() => expect(screen.getByTestId("corner-toggle")).toHaveFocus());
    doc.destroy();
  });

  it("--note-header-h: the row container measures the header wrapper's height (ResizeObserver reports 57 -> 57px)", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly cb: (entries: unknown[], observer: unknown) => void) {}
        observe(target: Element) {
          if (target.hasAttribute("data-note-header-slot")) this.cb([{ target, contentRect: { height: 57 } }], this);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const { row, doc } = await renderAt("overlay");
    await waitFor(() => expect(row.style.getPropertyValue("--note-header-h")).toBe("57px"));
    expect(screen.getByTestId("header-marker").parentElement).toHaveAttribute("data-note-header-slot");
    doc.destroy();
  });

  it("crossing 1280 (floating <-> fixed): the panel stays, same DOM node, state unchanged", async () => {
    const { setLayoutTier, doc } = await renderAt("overlay");
    const panel = await openPanel();
    expect(state().mode).toBe("panel");
    act(() => setLayoutTier("docked"));
    expect(state().mode).toBe("panel");
    expect(screen.getByTestId("versions-panel")).toBe(panel);
    act(() => setLayoutTier("overlay"));
    expect(state().mode).toBe("panel");
    expect(screen.getByTestId("versions-panel")).toBe(panel);
    doc.destroy();
  });

  it("preview area: with the panel open it yields the panel's width on the right (only below xl); when the panel is closed it doesn't", async () => {
    const { doc } = await renderAt("overlay");
    await openPanel();
    fireEvent.click(screen.getByText("host-preview"));
    const slot = await screen.findByTestId("preview-slot");
    expect(slot).toHaveClass("max-xl:mr-[min(var(--versions-panel-width),calc(100%_-_3rem))]");
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    // Closing the panel takes the preview with it; a preview with the panel closed can't normally exist, so open a preview again directly to verify there is no yielding without a panel.
    fireEvent.click(screen.getByText("host-preview"));
    expect(screen.queryByTestId("versions-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-slot")).not.toHaveClass("max-xl:mr-[min(var(--versions-panel-width),calc(100%_-_3rem))]");
    doc.destroy();
  });

  it("crossing 640 (floating -> phone): panel and preview both close", async () => {
    const { setLayoutTier, doc } = await renderAt("overlay");
    await openPanel();
    fireEvent.click(screen.getByText("host-preview"));
    expect(state()).toEqual({ mode: "panel", preview: 1 });
    act(() => setLayoutTier("phone"));
    expect(state()).toEqual({ mode: null, preview: null });
    expect(screen.queryByTestId("versions-panel")).not.toBeInTheDocument();
    doc.destroy();
  });

  describe("click on the note area collapses it (floating tier only, and only with the list open)", () => {
    it("list only (no preview): clicking the note body, the header, or a button outside the panel -> the panel closes", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.pointerDown(await screen.findByTestId("note-editor"));
      expect(state().mode).toBeNull();
      expect(screen.queryByTestId("versions-panel")).not.toBeInTheDocument();
      await openPanel();
      fireEvent.pointerDown(screen.getByTestId("header-marker"));
      expect(state().mode).toBeNull();
      doc.destroy();
    });

    it("list only: clicking inside the panel -> doesn't close", async () => {
      const { doc } = await renderAt("overlay");
      const panel = await openPanel();
      fireEvent.pointerDown(within(panel).getByRole("heading", { name: "Version history" }));
      fireEvent.pointerDown(panel);
      expect(state().mode).toBe("panel");
      expect(screen.getByTestId("versions-panel")).toBe(panel);
      doc.destroy();
    });

    it("during diff view (preview non-null): clicking the note body -> the panel stays; only its close button closes it", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-preview"));
      fireEvent.pointerDown(await screen.findByTestId("note-editor"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state()).toEqual({ mode: "panel", preview: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
      expect(state()).toEqual({ mode: null, preview: null });
      doc.destroy();
    });

    it("back from diff view to the list (stopPreview), then clicking the note area -> closes", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-preview"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBe("panel");
      fireEvent.click(screen.getByText("host-stop-preview"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBeNull();
      doc.destroy();
    });

    it("error frame when the panel fails to load: pressing 'Try again' doesn't count as an outside click, so retry can be pressed", async () => {
      crash.on = true;
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { doc } = await renderAt("overlay");
      fireEvent.click(screen.getByText("host-open"));
      const retry = await screen.findByRole("button", { name: "Try again" });
      fireEvent.pointerDown(retry);
      expect(state().mode).toBe("panel");
      expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
      doc.destroy();
    });

    it("list only: pressing on an item of the panel row's more menu -> doesn't close", async () => {
      const { doc } = await renderAt("overlay");
      const panel = await openPanel();
      const triggers = await within(panel).findAllByRole("button", { name: /more|actions|options/i });
      fireEvent.pointerDown(triggers[0], { button: 0, ctrlKey: false, pointerType: "mouse" });
      const item = within(await screen.findByRole("menu")).getAllByRole("menuitem")[0];
      fireEvent.pointerDown(item);
      expect(state().mode).toBe("panel");
      doc.destroy();
    });

    it.each([
      ["menu (role=menu)", { role: "menu" }],
      ["popper layer", { "data-radix-popper-content-wrapper": "" }],
      ["dialog (role=dialog)", { role: "dialog" }],
    ])("list only: pressing inside %s -> doesn't close; pressing outside after removing it closes", async (_name, attrs) => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      const portal = document.createElement("div");
      for (const [k, v] of Object.entries(attrs)) portal.setAttribute(k, v);
      const inner = document.createElement("button");
      portal.append(inner);
      document.body.append(portal);
      try {
        fireEvent.pointerDown(inner);
        expect(state().mode).toBe("panel");
      } finally {
        portal.remove();
      }
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBeNull();
      doc.destroy();
    });

    it("list only: with the versions dialog open (state present, node not yet mounted), pressing outside -> doesn't close", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-save"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBe("panel");
      doc.destroy();
    });

    it("list only: with the sidebar drawer open, clicking its overlay (outside the role=dialog) -> the panel stays; after the drawer closes, clicking outside closes it", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      const drawer = document.createElement("div");
      drawer.setAttribute("role", "dialog");
      drawer.setAttribute("data-sidebar-drawer", "");
      const overlayEl = document.createElement("div");
      document.body.append(overlayEl, drawer);
      try {
        fireEvent.pointerDown(overlayEl);
        expect(state().mode).toBe("panel");
      } finally {
        overlayEl.remove();
        drawer.remove();
      }
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBeNull();
      doc.destroy();
    });

    it("fixed tier (>= 1280): with list only or in diff view, clicking the note area doesn't close", async () => {
      const { doc } = await renderAt("docked");
      await openPanel();
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBe("panel");
      fireEvent.click(screen.getByText("host-preview"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state()).toEqual({ mode: "panel", preview: 1 });
      doc.destroy();
    });

    it("follows breakpoint changes: floating with list only, clicking outside closes; after switching to the fixed tier the same click doesn't close", async () => {
      const { setLayoutTier, doc } = await renderAt("overlay");
      await openPanel();
      act(() => setLayoutTier("docked"));
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(state().mode).toBe("panel");
      doc.destroy();
    });
  });

  describe("pressing Esc inside the panel", () => {
    it("floating tier: closes the panel (and the preview), focus returns to the history bubble", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-preview"));
      const closeButton = screen.getByRole("button", { name: "Close version history" });
      closeButton.focus();
      fireEvent.keyDown(closeButton, { key: "Escape" });
      expect(state()).toEqual({ mode: null, preview: null });
      const bubble = await screen.findByTestId("versions-bubble");
      expect(document.activeElement).toBe(bubble);
      doc.destroy();
    });

    it("floating tier with the stack collapsed: focus returns to the toggle", async () => {
      const { doc } = await renderAt("overlay");
      fireEvent.click(await screen.findByTestId("corner-toggle"));
      await openPanel();
      const closeButton = screen.getByRole("button", { name: "Close version history" });
      closeButton.focus();
      fireEvent.keyDown(closeButton, { key: "Escape" });
      expect(state().mode).toBeNull();
      await waitFor(() => expect(screen.getByTestId("corner-toggle")).toHaveFocus());
      doc.destroy();
    });

    it("fixed tier: the same action doesn't close the panel", async () => {
      const { doc } = await renderAt("docked");
      await openPanel();
      const closeButton = screen.getByRole("button", { name: "Close version history" });
      closeButton.focus();
      fireEvent.keyDown(closeButton, { key: "Escape" });
      expect(state().mode).toBe("panel");
      doc.destroy();
    });

    it("floating tier: in diff view, Esc pressed with focus inside the row container but outside the panel (header) -> the panel doesn't close", async () => {
      const { doc } = await renderAt("overlay");
      await openPanel();
      fireEvent.click(screen.getByText("host-preview"));
      fireEvent.keyDown(screen.getByTestId("header-marker"), { key: "Escape" });
      expect(state()).toEqual({ mode: "panel", preview: 1 });
      doc.destroy();
    });

    it("floating tier: Esc inside the error frame of a panel that failed to load -> closes as usual", async () => {
      crash.on = true;
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { doc } = await renderAt("overlay");
      fireEvent.click(screen.getByText("host-open"));
      const retry = await screen.findByRole("button", { name: "Try again" });
      fireEvent.keyDown(retry, { key: "Escape" });
      expect(state().mode).toBeNull();
      doc.destroy();
    });
  });
});
