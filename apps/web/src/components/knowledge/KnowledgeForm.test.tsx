import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { KnowledgeEntry } from "@knotebook/shared";
import { listKnowledgeInBlocks, readKnowledgeInfo } from "@knotebook/shared";
import i18n from "@/i18n";
import { P, mountEditor, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { PHONE_QUERY } from "@/lib/layout-tiers";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { removeKnowledge, todayLocalDate } from "./commands";
import { useKnowledgeController, type KnowledgeController } from "./controller";
import { KnowledgeForm } from "./KnowledgeForm";
import { KnowledgeLayer } from "./KnowledgeLayer";
import { KnowledgeRefSourceContext, type KnowledgeRefSource } from "./ref-source";
import { stubMedia } from "./test-support";
import "@/i18n/knowledge-strings";

const NOTE = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

const K = (n: number, extra: Record<string, unknown> = {}) => ({ knowledgeId: `k_0000000${n}`, knowledgeWhen: `when ${n}`, knowledgeConclusion: `conclusion ${n}`, ...extra });
const heading = (text: string, id: string, props: Record<string, unknown> = {}): PartialBlockLike => ({ id, type: "heading", props: { level: 1, ...props }, content: text }) as PartialBlockLike;

const cleanups: (() => void)[] = [];
function mount(content: PartialBlockLike[]): AnyEditor {
  const m = mountEditor(content, { collab: true });
  cleanups.push(m.destroy);
  return m.editor;
}

// The test editor has no knowledge plugin, so the list is read from the document.
function entriesOf(editor: AnyEditor): readonly KnowledgeEntry[] {
  return listKnowledgeInBlocks(editor.document as never);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubMedia([]);
});
afterEach(() => {
  cleanup();
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

function renderForm(editor: AnyEditor, blockId: string, over: { close?: () => void; phone?: boolean } = {}) {
  const close = over.close ?? vi.fn();
  const view = render(<KnowledgeForm editor={editor} blockId={blockId} getEntries={() => entriesOf(editor)} noteId={NOTE} phone={over.phone ?? false} close={close} />);
  return { close, ...view };
}
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const infoOf = (editor: AnyEditor, id: string) => readKnowledgeInfo(editor.getBlock(id)!.props as Record<string, unknown>);

describe("KnowledgeForm layout", () => {
  it("fields come in the order when to read, conclusion, basis, status, last verified, with Remove in the title row only for existing knowledge", () => {
    const editor = mount([heading("Alpha", "a", K(1)), heading("Plain", "b")]);
    const { container, unmount } = renderForm(editor, "a");
    const order = [...container.querySelectorAll("label, [id$='status-label']")].map((el) => el.textContent);
    expect(order).toEqual(["When to read", "Conclusion", "Basis", "Status", "Last verified"]);
    const titleRow = container.querySelector("h2")!.parentElement!;
    expect(within(titleRow).getByRole("button", { name: "Remove knowledge info" })).toBeInTheDocument();
    unmount();
    renderForm(editor, "b");
    expect(screen.queryByRole("button", { name: "Remove knowledge info" })).toBeNull();
  });

  it("when to read and conclusion are single-line inputs without maxLength and without a counter", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    renderForm(editor, "a");
    for (const label of ["When to read", "Conclusion"]) {
      const el = input(label);
      expect(el.tagName).toBe("INPUT");
      expect(el.hasAttribute("maxlength")).toBe(false);
    }
    expect(document.body.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it("status is three segmented buttons and the selected Needs review button is amber", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified" }))]);
    renderForm(editor, "a");
    const group = screen.getByRole("radiogroup", { name: "Status" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Current", "Needs review", "Outdated"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios[1]!.className).toContain("amber");
    fireEvent.click(radios[0]!);
    expect(radios[1]!.className).not.toContain("amber");
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("arrow keys move the status selection", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    renderForm(editor, "a");
    const radios = within(screen.getByRole("radiogroup")).getAllByRole("radio");
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios[1]);
  });

  it("Mark verified today sits next to the date and fills today's local date", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    renderForm(editor, "a");
    const date = input("Last verified");
    const button = screen.getByRole("button", { name: "Mark verified today" });
    expect(date.parentElement).toBe(button.parentElement);
    fireEvent.click(button);
    expect(date.value).toBe(todayLocalDate());
  });

  it("the footer shows the Esc hint on the left and Cancel, Save on the right", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    renderForm(editor, "a");
    const hint = screen.getByText("Esc to cancel");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(hint.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cancel.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("on a phone the footer buttons are 44px high and there is no Esc hint", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    render(
      <Dialog open>
        <DialogContent>
          <KnowledgeForm editor={editor} blockId="a" getEntries={() => entriesOf(editor)} noteId={NOTE} phone close={() => {}} />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("h-11");
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("h-11");
    expect(screen.queryByText("Esc to cancel")).toBeNull();
  });
});

describe("KnowledgeForm saving", () => {
  it("Save writes one edit, closes, and Enter in a field saves too", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "new text" } });
    fireEvent.keyDown(input("Conclusion"), { key: "Enter" });
    expect(infoOf(editor, "a")).toMatchObject({ id: "k_00000001", when: "when 1", conclusion: "new text" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("Enter that confirms an input-method composition does not save", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "ni" } });
    fireEvent.keyDown(input("Conclusion"), { key: "Enter", isComposing: true });
    fireEvent.keyDown(input("Conclusion"), { key: "Enter", keyCode: 229 });
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")!.conclusion).toBe("conclusion 1");
  });

  it("saving every field empty shows the error and writes nothing; Remove clears the knowledge", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("When to read"), { target: { value: "" } });
    fireEvent.change(input("Conclusion"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Fill in at least one field.");
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove knowledge info" }));
    expect(infoOf(editor, "a")).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a half-typed date refuses to save and says so instead of clearing the stored date", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeVerified: "2026-01-02" }))]);
    const { close } = renderForm(editor, "a");
    const date = input("Last verified");
    Object.defineProperty(date, "validity", { value: { badInput: true }, configurable: true });
    fireEvent.change(input("Conclusion"), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const message = screen.getByText("Enter a complete date.");
    expect(date.getAttribute("aria-describedby")).toBe(message.id);
    expect(date.getAttribute("aria-invalid")).toBe("true");
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")).toMatchObject({ conclusion: "conclusion 1", verified: "2026-01-02" });
  });

  it("Remove is hidden once a collaborator has removed the knowledge info", async () => {
    const editor = mount([heading("Alpha", "a", K(1)), P("p", "p")]);
    renderForm(editor, "a");
    expect(screen.getByRole("button", { name: "Remove knowledge info" })).toBeInTheDocument();
    act(() => {
      removeKnowledge(editor, "a");
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove knowledge info" })).toBeNull());
  });

  it("past 200 or 300 code points the field shows the too-long message and Save is refused; under the limit no message shows", () => {
    const editor = mount([heading("Alpha", "a", K(1))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("When to read"), { target: { value: "x".repeat(200) } });
    expect(screen.queryByText(/At most/)).toBeNull();
    fireEvent.change(input("When to read"), { target: { value: "x".repeat(201) } });
    expect(screen.getByText("At most 200 characters (now 201).")).toBeInTheDocument();
    expect(input("When to read").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input("Conclusion"), { target: { value: "😀".repeat(301) } });
    expect(screen.getByText("At most 300 characters (now 301).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).not.toHaveBeenCalled();
    expect(infoOf(editor, "a")!.when).toBe("when 1");
  });

  it("a value with line breaks written elsewhere is shown with spaces and left unchanged when another field is saved", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeConclusion: "first\nsecond" }))]);
    renderForm(editor, "a");
    expect(input("Conclusion").value).toBe("first second");
    fireEvent.change(input("When to read"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ when: "changed", conclusion: "first\nsecond" });
  });

  it("editing such a field saves the edited text with line breaks turned into spaces", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeConclusion: "first\nsecond" }))]);
    renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "first second third" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")!.conclusion).toBe("first second third");
  });

  it("an over-limit value written elsewhere doesn't block saving another field, but editing that field must bring it under the limit", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeWhen: "w".repeat(250) }))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(infoOf(editor, "a")).toMatchObject({ when: "w".repeat(250), conclusion: "short" });
  });

  it("an edited field that stays over the limit blocks saving", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeWhen: "w".repeat(250) }))]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("When to read"), { target: { value: "w".repeat(240) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(close).not.toHaveBeenCalled();
  });

  it("a heading that a collaborator turned into a paragraph closes the form with a notice and writes nothing", async () => {
    const editor = mount([heading("Alpha", "a", K(1)), P("para", "p")]);
    const { close } = renderForm(editor, "a");
    fireEvent.change(input("Conclusion"), { target: { value: "typed" } });
    act(() => {
      editor.updateBlock("a", { type: "paragraph" } as never);
    });
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(editor.getBlock("a")!.type).toBe("paragraph");
    expect(editor.getBlock("p")).toBeDefined();
    expect(editor.getBlock("a")!.props).not.toHaveProperty("knowledgeConclusion", "typed");
  });
});

describe("KnowledgeForm replacement picker", () => {
  const three = () => mount([heading("Alpha", "a", K(1)), heading("Beta", "b", K(2)), heading("Gamma", "c", K(3))]);
  const pickOutdated = () => fireEvent.click(screen.getByRole("radio", { name: "Outdated" }));

  it("choosing Outdated shows the replacement picker between status and last verified, and Save is refused until one is picked", () => {
    const editor = three();
    const { close, container } = renderForm(editor, "a");
    expect(screen.queryByRole("combobox", { name: "Replaced by" })).toBeNull();
    pickOutdated();
    const picker = screen.getByRole("combobox", { name: "Replaced by" });
    const names = [...container.querySelectorAll("label, span[id$='-label']")].map((el) => el.textContent);
    expect(names.indexOf("Status")).toBeLessThan(names.indexOf("Replaced by"));
    expect(names.indexOf("Replaced by")).toBeLessThan(names.indexOf("Last verified"));
    expect(picker).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Choose the knowledge that replaces this one.")).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
  });

  it("the picker lists the note's other knowledge but not this one, and stores a bare id", async () => {
    const editor = three();
    const { close } = renderForm(editor, "a");
    pickOutdated();
    fireEvent.focus(screen.getByRole("combobox", { name: "Replaced by" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Beta"), expect.stringContaining("Gamma")]));
    expect(options.some((o) => o.textContent!.includes("Alpha"))).toBe(false);
    fireEvent.mouseDown(options.find((o) => o.textContent!.includes("Beta"))!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ status: "outdated", supersededBy: "k_00000002" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("typing narrows the list and Enter picks the highlighted row without saving the form", async () => {
    const editor = three();
    const { close } = renderForm(editor, "a");
    pickOutdated();
    const combo = screen.getByRole("combobox", { name: "Replaced by" });
    fireEvent.focus(combo);
    fireEvent.change(combo, { target: { value: "gam" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    fireEvent.keyDown(combo, { key: "Enter" });
    expect(close).not.toHaveBeenCalled();
    expect(combo.getAttribute("aria-expanded")).toBe("false");
    expect((combo as HTMLInputElement).value).toBe("Gamma");
  });

  it("a candidate from another note is stored as noteId#knowledgeId", async () => {
    const editor = three();
    const source: KnowledgeRefSource = {
      search: () => Promise.resolve([{ ref: `${OTHER}#k_0000000f`, noteId: OTHER, noteTitle: "Other note", blockId: "z", heading: "Elsewhere", conclusion: "", href: `/n/${OTHER}` }]),
      resolve: () => Promise.resolve(null),
    };
    render(
      <KnowledgeRefSourceContext.Provider value={source}>
        <KnowledgeForm editor={editor} blockId="a" getEntries={() => entriesOf(editor)} noteId={NOTE} phone={false} close={() => {}} />
      </KnowledgeRefSourceContext.Provider>,
    );
    pickOutdated();
    fireEvent.focus(screen.getByRole("combobox", { name: "Replaced by" }));
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Elsewhere/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ status: "outdated", supersededBy: `${OTHER}#k_0000000f` });
  });

  it("a same-note replacement that no longer exists shows the missing text, and one in another note shows the other-note text", async () => {
    const gone = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_0000000f" }))]);
    renderForm(gone, "a");
    const combo = screen.getByRole("combobox", { name: "Replaced by" }) as HTMLInputElement;
    await waitFor(() => expect(combo.value).toBe("knowledge that no longer exists"));
    cleanup();
    const other = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "outdated", knowledgeSupersededBy: `${OTHER}#k_0000000f` }))]);
    renderForm(other, "a");
    const combo2 = screen.getByRole("combobox", { name: "Replaced by" }) as HTMLInputElement;
    await waitFor(() => expect(combo2.value).toBe("knowledge in another note"));
  });

  it("switching away from Outdated drops the replacement", () => {
    const editor = mount([heading("Alpha", "a", K(1, { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000002" })), heading("Beta", "b", K(2))]);
    renderForm(editor, "a");
    fireEvent.click(screen.getByRole("radio", { name: "Current" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(infoOf(editor, "a")).toMatchObject({ status: "", supersededBy: "" });
  });
});

let lastController: KnowledgeController | null = null;
function Host({ editor, container, editable = true }: { editor: AnyEditor; container: HTMLElement; editable?: boolean }) {
  const controller = useKnowledgeController();
  lastController = controller;
  const [entries, setEntries] = useState(() => entriesOf(editor));
  useEffect(() => editor.onChange(() => setEntries(entriesOf(editor))), [editor]);
  return <KnowledgeLayer container={container} entries={entries} editable={editable} noteId={NOTE} controller={controller} editor={editor} />;
}

describe("edit surface in the layer", () => {
  function layerWith(content: PartialBlockLike[], editable = true) {
    const m = mountEditor(content, { collab: true });
    cleanups.push(m.destroy);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 600, 30));
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 200, 30)] as unknown as DOMRectList);
    render(<Host editor={m.editor} container={m.container} editable={editable} />);
    return m.editor;
  }
  const openEdit = (id: string) => act(() => lastController!.open(id, "edit", null));

  it("a click outside does not close the form; Escape and Cancel do", async () => {
    const editor = layerWith([heading("Alpha", "a", K(1)), P("para", "p")]);
    openEdit("a");
    expect(await screen.findByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(screen.getByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Knowledge info" })).toBeNull());
    openEdit("a");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Knowledge info" })).toBeNull());
    expect(infoOf(editor, "a")!.conclusion).toBe("conclusion 1");
  });

  it("Escape with the replacement list open closes only the list; a second Escape closes the form", async () => {
    layerWith([heading("Alpha", "a", K(1)), heading("Beta", "b", K(2))]);
    openEdit("a");
    fireEvent.click(await screen.findByRole("radio", { name: "Outdated" }));
    const combo = screen.getByRole("combobox", { name: "Replaced by" });
    fireEvent.focus(combo);
    await screen.findAllByRole("option");
    fireEvent.keyDown(combo, { key: "Escape" });
    await waitFor(() => expect(combo.getAttribute("aria-expanded")).toBe("false"));
    expect(screen.getByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
    fireEvent.keyDown(combo, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Knowledge info" })).toBeNull());
  });

  it("opens on a heading that is not knowledge yet and Save turns it into knowledge", async () => {
    const editor = layerWith([heading("Plain", "b"), P("para", "p")]);
    openEdit("b");
    fireEvent.change(await screen.findByLabelText("When to read"), { target: { value: "alice reads this" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(infoOf(editor, "b")).toMatchObject({ when: "alice reads this" }));
    await waitFor(() => expect(screen.queryByLabelText("When to read")).toBeNull());
  });

  it("Save returns focus to the element that opened it", async () => {
    const editor = layerWith([heading("Plain", "b"), P("para", "p")]);
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    cleanups.push(() => opener.remove());
    act(() => lastController!.open("b", "edit", opener));
    fireEvent.change(await screen.findByLabelText("When to read"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(infoOf(editor, "b")).not.toBeNull();
  });

  it("the first field has the focus when the form opens", async () => {
    layerWith([heading("Alpha", "a", K(1))]);
    openEdit("a");
    const when = await screen.findByLabelText("When to read");
    await waitFor(() => expect(document.activeElement).toBe(when));
  });

  it("there is no edit surface for a viewer", async () => {
    layerWith([heading("Alpha", "a", K(1))], false);
    openEdit("a");
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(screen.queryByLabelText("When to read")).toBeNull();
  });

  it("the form closes when the heading is deleted by someone else", async () => {
    const editor = layerWith([heading("Alpha", "a", K(1)), P("para", "p")]);
    openEdit("a");
    await screen.findByLabelText("When to read");
    act(() => {
      editor.removeBlocks(["a"]);
    });
    await waitFor(() => expect(screen.queryByLabelText("When to read")).toBeNull());
  });

  it("on a phone the form opens in a dialog whose title is the form title", async () => {
    stubMedia([PHONE_QUERY]);
    layerWith([heading("Alpha", "a", K(1))]);
    openEdit("a");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Knowledge info" })).toBeInTheDocument();
  });

  it("the phone sheet shows Mark as verified and Edit for an editor, and nothing for a viewer", async () => {
    stubMedia([PHONE_QUERY]);
    const editor = layerWith([heading("Alpha", "a", K(1, { knowledgeStatus: "unverified" })), P("para", "p")]);
    act(() => lastController!.open("a", "view", null));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark as verified" }));
    expect(infoOf(editor, "a")).toMatchObject({ verified: todayLocalDate(), status: "" });
  });

  it("the phone sheet has no actions for a viewer", async () => {
    stubMedia([PHONE_QUERY]);
    layerWith([heading("Alpha", "a", K(1))], false);
    act(() => lastController!.open("a", "view", null));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Mark as verified" })).toBeNull();
  });
});
