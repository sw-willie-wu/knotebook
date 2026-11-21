import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { KnowledgeEntry } from "@knotebook/shared";
import i18n from "@/i18n";
import { NO_HOVER_QUERY, PHONE_QUERY } from "@/lib/layout-tiers";
import { useKnowledgeController, type KnowledgeController } from "./controller";
import { KnowledgeGlyph } from "./KnowledgeIcon";
import { KnowledgeLayer } from "./KnowledgeLayer";
import { useKnowledgeEntries } from "./use-knowledge-entries";
import { blocksHtml, knowledgeEntries, stubLayout, stubMedia, type KnowledgeFixture } from "./test-support";

const ALL = [
  { blockId: "a", title: "Alpha" },
  { blockId: "b", title: "Plain" },
  { blockId: "c", title: "Gamma" },
];

let lastController: KnowledgeController | null = null;

function Host({
  entries,
  editable = false,
  accept,
  editSurface,
  html = blocksHtml(ALL),
}: {
  entries: readonly KnowledgeEntry[];
  editable?: boolean;
  accept?: (outer: HTMLElement) => boolean;
  editSurface?: (blockId: string, close: () => void) => ReactNode;
  html?: string;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const controller = useKnowledgeController();
  lastController = controller;
  return (
    <div ref={setEl} data-testid="col">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <KnowledgeLayer container={el} entries={entries} editable={editable} noteId="n1" controller={controller} accept={accept} editSurface={editSurface} />
    </div>
  );
}

const two: KnowledgeFixture[] = [
  { id: "k_00000001", blockId: "a", title: "Alpha", props: { knowledgeVerified: "2026-10-01" } },
  { id: "k_00000002", blockId: "c", title: "Gamma" },
];

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubLayout();
  stubMedia([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  lastController = null;
});

const icons = () => document.querySelectorAll<HTMLButtonElement>("[data-kb-knowledge-icon]");

/** The structure BlockNote renders: the editor root holds the top-level block group. */
const editorHtml = (ids: Array<{ blockId: string; title: string }>) => `<div class="bn-editor"><div class="bn-block-group">${blocksHtml(ids)}</div></div>`;

const nestedOuter = (id: string) =>
  `<div class="bn-block-outer" data-id="${id}"><div class="bn-block"><div class="bn-block-content" data-content-type="paragraph"><p class="bn-inline-content">${id}</p></div></div></div>`;

/** Each block sits 40px below the previous one in document order, so moving or inserting a block shifts the icons below it. */
function stackedLayout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const outer = (this.startContainer as Element).closest(".bn-block-outer")!;
    const index = [...document.querySelectorAll(".bn-block-outer")].indexOf(outer);
    return [new DOMRect(0, index * 40, 200, 30)] as unknown as DOMRectList;
  });
}
const flushFrames = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("KnowledgeLayer", () => {
  it("renders one icon per entry at its heading and nothing for other headings", async () => {
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    expect([...icons()].map((i) => i.dataset.blockId)).toEqual(["a", "c"]);
    // 200px text end + 8px gap
    expect(icons()[0]!.style.left).toBe("208px");
  });

  it("no entries renders no knowledge element and creates no ResizeObserver or MutationObserver", () => {
    const Observer = vi.fn(() => ({ observe() {}, unobserve() {}, disconnect() {} }));
    const Mutations = vi.fn(() => ({ observe() {}, disconnect() {}, takeRecords: () => [] }));
    vi.stubGlobal("ResizeObserver", Observer);
    vi.stubGlobal("MutationObserver", Mutations);
    render(<Host entries={[]} html={editorHtml(ALL)} />);
    expect(icons()).toHaveLength(0);
    expect(Observer).not.toHaveBeenCalled();
    expect(Mutations).not.toHaveBeenCalled();
  });

  it("re-measures when the strip above the editor changes height, which moves the editor without resizing it", async () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(el: Element) {
          observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    render(<Host entries={knowledgeEntries(two)} html={`<div data-note-content-top=""></div>${editorHtml(ALL)}`} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    expect(observed).toContain(document.querySelector("[data-note-content-top]"));
  });

  it("each icon kind has its own glyph, data-kind and accessible name", async () => {
    const entries = knowledgeEntries([
      { id: "k_00000001", blockId: "a", props: { knowledgeVerified: "2026-10-01" } },
      { id: "k_00000002", blockId: "b" },
      { id: "k_00000003", blockId: "c", props: { knowledgeStatus: "unverified", knowledgeVerified: "2026-10-01" } },
      { id: "k_00000004", blockId: "d", props: { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000001" } },
      { id: "k_00000005", blockId: "e", level: 2, props: { knowledgeVerified: "2026-10-01" } },
    ]);
    const html = blocksHtml(["a", "b", "c", "d", "e"].map((blockId) => ({ blockId, title: blockId })));
    render(<Host entries={entries} html={html} />);
    await waitFor(() => expect(icons()).toHaveLength(5));
    const byId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-block-id="${id}"]`)!;
    expect(byId("a")).toHaveAttribute("data-kind", "verified");
    expect(byId("a")).toHaveAccessibleName("Knowledge info: Verified");
    expect(byId("b")).toHaveAttribute("data-kind", "noVerifiedDate");
    expect(byId("b")).toHaveAccessibleName("Knowledge info: Not verified");
    expect(byId("c")).toHaveAttribute("data-kind", "needsReview");
    expect(byId("c")).toHaveAccessibleName("Knowledge info: Needs review");
    expect(byId("d")).toHaveAttribute("data-kind", "outdated");
    expect(byId("d")).toHaveAccessibleName("Knowledge info: Outdated");
    // "e" sits under the outdated "d" in the heading outline.
    expect(byId("e")).toHaveAttribute("data-kind", "outdated");
    expect(new Set([...icons()].map((i) => i.querySelector("svg")!.getAttribute("data-icon"))).size).toBe(4);
  });

  it("KnowledgeGlyph renders no button, takes no focus and is hidden from assistive technology", () => {
    for (const kind of ["verified", "noVerifiedDate", "needsReview", "outdated"] as const) {
      const { container, unmount } = render(<KnowledgeGlyph kind={kind} className="extra" />);
      expect(container.querySelectorAll("button")).toHaveLength(0);
      const glyph = container.firstElementChild!;
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(glyph).not.toHaveAttribute("tabindex");
      expect(glyph).toHaveClass("extra");
      unmount();
    }
  });

  it("re-measures when web fonts finish loading", async () => {
    const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()[0]!.style.left).toBe("208px"));
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 300, 30)] as unknown as DOMRectList);
    fonts.dispatchEvent(new Event("loadingdone"));
    await waitFor(() => expect(icons()[0]!.style.left).toBe("308px"));
    Reflect.deleteProperty(document, "fonts");
  });

  it("hovering an icon shows the 350px card below it; a viewer's card has no Edit button", async () => {
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.pointerEnter(icons()[0]!);
    const card = await screen.findByText("when alice");
    expect(card.closest("[data-kb-knowledge-card]")).not.toBeNull();
    expect(card.closest(".w-\\[350px\\]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("clicking an icon whose hover card is open leaves only the popover", async () => {
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.focus(icons()[0]!);
    await screen.findByText("when alice");
    expect(document.querySelectorAll("[data-kb-knowledge-card]")).toHaveLength(1);
    fireEvent.click(icons()[0]!);
    await screen.findByRole("dialog");
    await waitFor(() => expect(document.querySelectorAll("[data-kb-knowledge-card]")).toHaveLength(1));
    expect(document.querySelector("[data-kb-knowledge-card]")!.closest("[role='dialog']")).not.toBeNull();
  });

  it("an editor's card Edit button and a click on the icon open the edit surface for that heading", async () => {
    const editSurface = (blockId: string) => <div data-testid="edit-surface">{blockId}</div>;
    render(<Host entries={knowledgeEntries(two)} editable editSurface={editSurface} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[1]!);
    expect((await screen.findByTestId("edit-surface")).textContent).toBe("c");
    expect(lastController!.state?.blockId).toBe("c");
    expect(lastController!.state?.mode).toBe("edit");
    expect(lastController!.state?.returnFocus === icons()[1]).toBe(true);
    act(() => lastController!.close());
    await waitFor(() => expect(screen.queryByTestId("edit-surface")).toBeNull());

    fireEvent.pointerEnter(icons()[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect((await screen.findByTestId("edit-surface")).textContent).toBe("a");
    expect(lastController!.state?.blockId).toBe("a");
    expect(lastController!.state?.returnFocus === icons()[0]).toBe(true);
  });

  it("a viewer's click opens the card as a popover on desktop and as a bottom sheet on a phone", async () => {
    const view = render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[0]!);
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveClass("w-[350px]");
    expect(popover.className).not.toContain("kb-sheet");
    view.unmount();

    stubMedia([PHONE_QUERY, NO_HOVER_QUERY]);
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[0]!);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.className).toContain("kb-sheet");
  });

  it("the bottom sheet shows the heading text and, for an editor, a 44px Edit button", async () => {
    stubMedia([PHONE_QUERY, NO_HOVER_QUERY]);
    render(<Host entries={knowledgeEntries(two)} editable />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[0]!);
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveAccessibleName("Alpha");
    expect(screen.getByRole("button", { name: "Edit" })).toHaveClass("h-11");
    // On a phone even an editor sees the card first.
    expect(lastController!.state?.mode).toBe("view");
  });

  it("the popover closes when its heading disappears from the entries", async () => {
    const view = render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[0]!);
    await screen.findByRole("dialog");
    view.rerender(<Host entries={knowledgeEntries([two[1]!])} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lastController!.state).toBeNull();
  });

  it("typing in one knowledge heading re-measures only that heading's icon", async () => {
    const view = render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    const rects = vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 250, 30)] as unknown as DOMRectList);
    view.rerender(<Host entries={knowledgeEntries([{ ...two[0]!, title: "Alpha plus" }, two[1]!])} />);
    await waitFor(() => expect(icons()[0]!.style.left).toBe("258px"));
    expect(rects).toHaveBeenCalledTimes(1);
    expect(icons()[1]!.style.left).toBe("208px");
  });

  it("accept() hides icons on blocks it rejects", async () => {
    render(<Host entries={knowledgeEntries(two)} accept={(outer) => outer.dataset.id !== "a"} />);
    await waitFor(() => expect(icons()).toHaveLength(1));
    expect(icons()[0]!.dataset.blockId).toBe("c");
  });

  it("Escape closes the popover and returns focus to the icon", async () => {
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    icons()[0]!.focus();
    fireEvent.click(icons()[0]!);
    const popover = await screen.findByRole("dialog");
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(icons()[0]);
    // Radix would open the hover card on that focus after its 300ms delay.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(document.querySelector("[data-kb-knowledge-card]")).toBeNull();
  });

  it("closing by pressing outside leaves focus on what was pressed instead of pulling it back to the icon", async () => {
    render(
      <>
        <Host entries={knowledgeEntries(two)} />
        <input data-testid="elsewhere" />
      </>,
    );
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[0]!);
    await screen.findByRole("dialog");
    const other = screen.getByTestId("elsewhere");
    // Radix starts listening for outside presses one tick after it opens.
    await flushFrames();
    fireEvent.pointerDown(other);
    fireEvent.mouseDown(other);
    other.focus();
    fireEvent.pointerUp(other);
    fireEvent.mouseUp(other);
    fireEvent.click(other);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await flushFrames();
    expect(document.activeElement).toBe(other);
  });

  it("Escape returns focus to the icon after an earlier close by pressing outside", async () => {
    render(
      <>
        <Host entries={knowledgeEntries(two)} />
        <input data-testid="elsewhere" />
      </>,
    );
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[0]!);
    await screen.findByRole("dialog");
    const other = screen.getByTestId("elsewhere");
    await flushFrames();
    fireEvent.pointerDown(other);
    fireEvent.mouseDown(other);
    other.focus();
    fireEvent.pointerUp(other);
    fireEvent.mouseUp(other);
    fireEvent.click(other);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await flushFrames();
    icons()[0]!.focus();
    fireEvent.click(icons()[0]!);
    const popover = await screen.findByRole("dialog");
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(icons()[0]));
  });

  it("a hover delay that expires while the popover is open leaves no hover card behind once the popover closes", async () => {
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.pointerEnter(icons()[0]!);
    fireEvent.click(icons()[0]!);
    const popover = await screen.findByRole("dialog");
    // The 300ms open timer started by the hover fires while the popover is up.
    await new Promise((resolve) => setTimeout(resolve, 450));
    fireEvent.pointerLeave(icons()[0]!);
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector("[data-kb-knowledge-card]")).toBeNull();
  });

  it("icons announce that they open a dialog and whether it is open", async () => {
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    expect(icons()[0]).toHaveAttribute("aria-haspopup", "dialog");
    expect(icons()[0]).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(icons()[0]!);
    await screen.findByRole("dialog");
    expect(icons()[0]).toHaveAttribute("aria-expanded", "true");
    expect(icons()[1]).toHaveAttribute("aria-expanded", "false");
  });

  it("needs-review and outdated icons carry a pale fill with a fixed dark-mode value; the other kinds have none", async () => {
    const entries = knowledgeEntries([
      { id: "k_00000001", blockId: "a", props: { knowledgeVerified: "2026-10-01" } },
      { id: "k_00000002", blockId: "b" },
      { id: "k_00000003", blockId: "c", props: { knowledgeStatus: "unverified", knowledgeVerified: "2026-10-01" } },
      { id: "k_00000004", blockId: "d", props: { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000001" } },
    ]);
    render(<Host entries={entries} html={blocksHtml(["a", "b", "c", "d"].map((blockId) => ({ blockId, title: blockId })))} />);
    await waitFor(() => expect(icons()).toHaveLength(4));
    const cls = (id: string) => document.querySelector<HTMLButtonElement>(`[data-block-id="${id}"]`)!.className;
    expect(cls("c")).toMatch(/\bbg-\[#[0-9a-f]{6}\]/);
    expect(cls("c")).toMatch(/\bdark:bg-\[#[0-9a-f]{6}\]/);
    expect(cls("d")).toMatch(/\bbg-\[#[0-9a-f]{6}\]/);
    expect(cls("d")).toMatch(/\bdark:bg-\[#[0-9a-f]{6}\]/);
    const fill = (id: string) => cls(id).match(/(?<![:\w-])bg-\[#[0-9a-f]{6}\]/)![0];
    expect(fill("c")).not.toBe(fill("d"));
    expect(cls("a")).not.toMatch(/\bbg-/);
    expect(cls("b")).not.toMatch(/\bbg-/);
  });

  it("hovering the icon of an open surface shows no second card", async () => {
    render(<Host entries={knowledgeEntries(two)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[0]!);
    await screen.findByRole("dialog");
    fireEvent.pointerEnter(icons()[0]!);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(document.querySelectorAll("[data-kb-knowledge-card]")).toHaveLength(1);
    expect(document.querySelector("[data-kb-knowledge-card]")!.closest("[role='dialog']")).not.toBeNull();
  });

  it("opens for a block id that contains selector metacharacters", async () => {
    const id = 'we"ird\\id';
    const entries = knowledgeEntries([{ id: "k_00000001", blockId: id, title: "Odd", props: { knowledgeVerified: "2026-10-01" } }]);
    const html = `<div class="bn-block-outer" data-id="we&quot;ird\\id"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">Odd</h2></div></div></div>`;
    render(<Host entries={entries} html={html} editable editSurface={() => <div data-testid="edit-surface" />} />);
    await waitFor(() => expect(icons()).toHaveLength(1));
    fireEvent.click(icons()[0]!);
    expect(await screen.findByTestId("edit-surface")).toBeInTheDocument();
  });

  it("an edit surface follows its heading when the editor swaps the heading's DOM node", async () => {
    const entries = knowledgeEntries(two);
    render(<Host entries={entries} editable editSurface={() => <div data-testid="edit-surface" />} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    fireEvent.click(icons()[0]!);
    await screen.findByTestId("edit-surface");
    const outer = document.querySelector<HTMLElement>('.bn-block-outer[data-id="a"]')!;
    const fresh = outer.querySelector<HTMLElement>(":scope > .bn-block > .bn-block-content")!.cloneNode(true) as HTMLElement;
    outer.querySelector(":scope > .bn-block")!.replaceChildren(fresh);
    const asked = vi.fn();
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === fresh) asked();
      return original.call(this);
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(asked).toHaveBeenCalled());
  });
});

describe("KnowledgeLayer after the layout moves without the editor changing size", () => {
  it("an icon follows its heading when a block is dragged above it", async () => {
    stackedLayout();
    const entries = knowledgeEntries(two);
    render(<Host entries={entries} html={editorHtml(ALL)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    const byId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-block-id="${id}"]`)!;
    expect([byId("a").style.top, byId("c").style.top]).toEqual(["7px", "87px"]);
    const group = document.querySelector(".bn-block-group")!;
    group.prepend(group.querySelector('[data-id="c"]')!);
    await waitFor(() => expect([byId("a").style.top, byId("c").style.top]).toEqual(["47px", "7px"]));
  });

  it("an icon follows its heading when a nested block appears above it, in an existing or a new child group", async () => {
    stackedLayout();
    const nested = `<div class="bn-block-group">${nestedOuter("n1")}</div>`;
    const html = `<div class="bn-editor"><div class="bn-block-group">
      <div class="bn-block-outer" data-id="a"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">Alpha</h2></div>${nested}</div></div>
      <div class="bn-block-outer" data-id="b"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">Plain</h2></div></div></div>
      <div class="bn-block-outer" data-id="c"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">Gamma</h2></div></div></div>
    </div></div>`;
    render(<Host entries={knowledgeEntries(two)} html={html} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    const c = () => document.querySelector<HTMLButtonElement>('[data-block-id="c"]')!;
    // a, n1, b, c
    expect(c().style.top).toBe("127px");
    document.querySelector('[data-id="a"] .bn-block-group')!.insertAdjacentHTML("beforeend", nestedOuter("n2"));
    await waitFor(() => expect(c().style.top).toBe("167px"));
    const block = document.querySelector('[data-id="b"] > .bn-block')!;
    block.insertAdjacentHTML("beforeend", `<div class="bn-block-group">${nestedOuter("n3")}</div>`);
    await waitFor(() => expect(c().style.top).toBe("207px"));
  });

  it("typing in a heading's text does not trigger a re-measurement", async () => {
    const rects = stackedLayout();
    render(<Host entries={knowledgeEntries(two)} html={editorHtml(ALL)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    await flushFrames();
    const before = rects.mock.calls.length;
    const inline = document.querySelector<HTMLElement>('[data-id="a"] .bn-inline-content')!;
    inline.firstChild!.textContent = "Alpha!";
    inline.replaceChildren(document.createTextNode("Alpha!!"), document.createElement("strong"));
    await flushFrames();
    expect(rects.mock.calls.length).toBe(before);
  });

  it("inserting and removing only a ProseMirror widget does not trigger a re-measurement, while a real block element does", async () => {
    const rects = stackedLayout();
    render(<Host entries={knowledgeEntries(two)} html={editorHtml(ALL)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    await flushFrames();
    const group = document.querySelector(".bn-block-group")!;
    const before = rects.mock.calls.length;
    const widget = document.createElement("div");
    widget.className = "bn-trailing-block ProseMirror-widget";
    group.append(widget);
    await flushFrames();
    widget.remove();
    await flushFrames();
    expect(rects.mock.calls.length).toBe(before);
    group.insertAdjacentHTML("afterbegin", nestedOuter("n9"));
    await flushFrames();
    expect(rects.mock.calls.length).toBeGreaterThan(before);
  });

  it("stops watching the blocks when it unmounts", async () => {
    const rects = stackedLayout();
    const view = render(<Host entries={knowledgeEntries(two)} html={editorHtml(ALL)} />);
    await waitFor(() => expect(icons()).toHaveLength(2));
    const group = document.querySelector(".bn-block-group")!;
    view.unmount();
    rects.mockClear();
    group.append(document.createElement("div"));
    await flushFrames();
    expect(rects).not.toHaveBeenCalled();
  });
});

describe("useKnowledgeEntries", () => {
  it("reads the plugin's entries at most once per animation frame however many changes arrive", () => {
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => queue.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    let reads = 0;
    const listeners: Array<() => void> = [];
    const editor = {
      get prosemirrorState() {
        reads += 1;
        return { plugins: [] };
      },
      onChange(listener: () => void) {
        listeners.push(listener);
        return () => {};
      },
    };
    function Probe() {
      useKnowledgeEntries(editor);
      return null;
    }
    render(<Probe />);
    reads = 0;
    act(() => {
      for (let i = 0; i < 10; i += 1) listeners.forEach((l) => l());
    });
    expect(queue).toHaveLength(1);
    expect(reads).toBe(0);
    act(() => queue.splice(0).forEach((cb) => cb(0)));
    expect(reads).toBe(1);
  });
});

describe("KnowledgeLayer ref source", () => {
  const OTHER = "99999999-2222-3333-4444-555555555555";
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;
  const outdatedTo = (ref: string): KnowledgeFixture[] => [{ id: "k_00000001", blockId: "a", title: "Alpha", props: { knowledgeStatus: "outdated", knowledgeSupersededBy: ref } }];

  it("an outdated knowledge replaced by another note's knowledge shows that heading and links to it after the server resolves it", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(reply(200, { noteId: OTHER, noteTitle: "Other note", path: "/n/alice/other", knowledgeId: "k_0000000f", blockId: "z", heading: "Elsewhere", conclusion: "" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter>
        <Host entries={knowledgeEntries(outdatedTo(`${OTHER}#k_0000000f`))} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(icons()).toHaveLength(1));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(icons()[0]!);
    const link = await screen.findByRole("button", { name: "Elsewhere" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`/api/knowledge/refs/${OTHER}/k_0000000f`);
    expect(link).toBeInTheDocument();
  });

  it("a reference the server can't resolve stays the plain other-note text", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(reply(404, { error: { code: "not_found", message: "No such knowledge." } }))));
    render(
      <MemoryRouter>
        <Host entries={knowledgeEntries(outdatedTo(`${OTHER}#k_0000000f`))} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(icons()).toHaveLength(1));
    fireEvent.click(icons()[0]!);
    await screen.findByText(/knowledge in another note/);
    expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull();
  });

  it("a same-note reference makes no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Host entries={knowledgeEntries(outdatedTo("k_00000002"))} />);
    await waitFor(() => expect(icons()).toHaveLength(1));
    fireEvent.click(icons()[0]!);
    await screen.findByText(/knowledge that no longer exists/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
