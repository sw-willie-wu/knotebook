import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { TableHandlesExtension } from "@blocknote/core/extensions";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { buildCollabEditorBase, NOTE_TABLE_SETTINGS } from "@/collab/editor-options";
import { resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { renderAiHost, type AnyEditor } from "@/test/ai-host";

// 表格的儲存格把手與列／欄把手：選單裡的「Colors」子選單多了「Custom…」，點了把根選單的 dropdown 換成自訂色面板。
// 一律掛真的 `NoteEditorView`（`renderAiHost`），把手由 `NoteEditor.tsx` 裡接上的 `TableHandlesController` 畫出來；
// 自己組 BlockNoteView 測不到那段接線。表格把手的 state 由真的 mousemove 讓 TableHandlesExtension 自己算出來：
// 它從事件的 target 往上找儲存格，jsdom 沒有版面不影響。SideMenu 與欄寬調整外掛在同一次 mousemove 會用到
// jsdom 沒有的 elementsFromPoint／elementFromPoint，各墊一支回傳該格文字的版本，每案結束後拿掉。

type CellLike = { type: "tableCell"; props: Record<string, string>; content: { type: "text"; text: string; styles: Record<string, never> }[] };

const cell = (text: string, props: Record<string, string> = {}): CellLike => ({
  type: "tableCell",
  props,
  content: [{ type: "text", text, styles: {} }],
});

/** 2×2 表格 `t1`：(0,0)=a1、(0,1)=b1、(1,0)=a2、(1,1)=b2；第一列兩格可另帶 props。 */
function table(row0Props: [Record<string, string>, Record<string, string>] = [{}, {}]) {
  return {
    id: "t1",
    type: "table",
    content: {
      type: "tableContent",
      rows: [{ cells: [cell("a1", row0Props[0]), cell("b1", row0Props[1])] }, { cells: [cell("a2"), cell("b2")] }],
    },
  };
}

function mount(row0Props?: [Record<string, string>, Record<string, string>]): AnyEditor {
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    tables: NOTE_TABLE_SETTINGS,
    initialContent: [{ id: "p0", type: "paragraph", content: "top" }, table(row0Props)] as never,
  }) as AnyEditor;
  renderAiHost({ editor });
  return editor;
}

type Cell = { props: Record<string, string>; content: { text: string }[] };
function cellAt(editor: AnyEditor, r: number, c: number): Cell {
  const t = editor.getBlock("t1")!.content as unknown as { rows: { cells: Cell[] }[] };
  return t.rows[r]!.cells[c]!;
}
const cellText = (editor: AnyEditor, r: number, c: number) => cellAt(editor, r, c).content.map((x) => x.text).join("");

const cellHandles = () => Array.from(document.querySelectorAll<HTMLElement>("button.bn-table-cell-handle"));
// 列把手與欄把手是同一個元件，欄把手以 transform 轉 90 度
const rowHandle = () => Array.from(document.querySelectorAll<HTMLElement>(".bn-table-handle")).find((el) => !el.style.transform) ?? null;
const tableMenu = () => document.querySelector<HTMLElement>(".bn-table-handle-menu");
/**
 * 某個把手的根選單 dropdown（Mantine 的 trigger 以 aria-controls 指向它）。開了儲存格選單之後，列把手的浮層淡出期間
 * BlockNote 會顯示它最後一次開著時的 HTML 複本（可能含剛關掉的列選單），用 class 查會先查到那份複本。
 */
const menuOf = (trigger: HTMLElement) => document.getElementById(trigger.getAttribute("aria-controls") ?? "");
const colorsItem = () => document.querySelector<HTMLElement>('[data-kb-color-return="tbl-colors"]');
const item = (test: string) => document.querySelector<HTMLElement>(`[data-test="${test}"]`);
const panel = () => document.querySelector<HTMLElement>(".bn-table-handle-menu .kb-color-panel");
const hexInput = () => screen.getByRole("textbox", { name: "Hex color", hidden: true }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
/** Menu.Item 打勾時右側是勾號 svg，沒打勾時是 `.bn-tick-space` 佔位。 */
const isChecked = (el: Element) => el.querySelector(".bn-tick-space") === null && el.querySelector("svg") !== null;

/** 滑鼠移到文字為 `text` 的儲存格上，等把手出現。 */
async function hoverCell(editor: AnyEditor, text: string): Promise<void> {
  const el = screen.getByText(text);
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => el });
  act(() => {
    fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
  });
  expect(editor.getExtension(TableHandlesExtension)!.store.state?.block?.id).toBe("t1");
  await waitFor(() => expect(rowHandle()).not.toBeNull());
}

/** 點把手開根選單，等 dropdown 掛上並讓 Mantine 開選單時排的初始聚焦計時器跑完。 */
async function openMenu(trigger: HTMLElement): Promise<void> {
  fireEvent.click(trigger);
  await waitFor(() => expect(tableMenu()).not.toBeNull());
  await wait(0);
}

/** 從「Colors」以鍵盤（→）開子選單，等「自訂…」出現。 */
async function openColorsSub(): Promise<void> {
  const colors = colorsItem()!;
  colors.focus();
  fireEvent.keyDown(colors, { key: "ArrowRight" });
  await waitFor(() => expect(item("text-color-custom") ?? item("background-color-custom")).not.toBeNull());
}

/** 子選單裡該段的「自訂…」（`detail` 0＝鍵盤啟動，色碼框取得焦點），等面板掛上。 */
async function clickCustom(section: "text" | "background"): Promise<void> {
  fireEvent.click(item(`${section}-color-custom`)!, { detail: 0 });
  await waitFor(() => expect(panel()).not.toBeNull());
}

/** 根選單已關：dropdown 不在；把手若還在則 aria-expanded 為 false（套色改了文件之後把手可能整個收起）。 */
async function expectMenuClosed(trigger: () => HTMLElement | null | undefined): Promise<void> {
  await waitFor(() => {
    expect(tableMenu()).toBeNull();
    expect(trigger()?.getAttribute("aria-expanded") ?? "false").toBe("false");
  });
}

/**
 * 別人把 (r,c) 的文字改成 `text`：從當下的表格重建 rows、只換那一格的內容，再整張 `updateBlock`。
 * 單一編輯器裡這樣改不會換掉表格的 block 元素，把手的 state 與開著的面板都留著。
 */
function remoteSetCellText(editor: AnyEditor, r: number, c: number, text: string): void {
  const block = editor.getBlock("t1")!;
  const t = block.content as unknown as { rows: { cells: object[] }[] };
  const rows = t.rows.map((row, ri) => ({
    ...row,
    cells: row.cells.map((x, ci) => (ri === r && ci === c ? { ...x, content: [{ type: "text", text, styles: {} }] } : x)),
  }));
  act(() => {
    editor.updateBlock(block, { type: "table", content: { ...t, rows } } as never);
  });
}

beforeEach(async () => {
  localStorage.clear();
  resetRecentColorsForTest();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetCustomColorsForTest();
  Reflect.deleteProperty(document, "elementsFromPoint");
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("表格把手的顏色選單", () => {
  it("TM0 編輯器接上自家的表格把手：滑鼠移到儲存格上只出現一顆儲存格把手，選單是自家的（只有 Colors）", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await waitFor(() => expect(cellHandles().length).toBeGreaterThan(0));
    await wait(50);
    expect(cellHandles()).toHaveLength(1);
    await openMenu(cellHandles()[0]!);
    const menu = tableMenu()!;
    expect(within(menu).getAllByRole("menuitem", { hidden: true }).map((el) => el.textContent)).toEqual(["Colors"]);
    expect(within(menu).queryByText("Split cell")).toBeNull();
    expect(colorsItem()).not.toBeNull();
  });

  it("TM1 列把手選單：Delete row、Add row above、Add row below、Colors，沒有標題列／欄切換", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    const texts = within(tableMenu()!)
      .getAllByRole("menuitem", { hidden: true })
      .map((el) => el.textContent);
    expect(texts).toEqual(["Delete row", "Add row above", "Add row below", "Colors"]);
    expect(screen.queryByText("Header row")).toBeNull();
    expect(screen.queryByText("Header column")).toBeNull();
  });

  it("TM2 列把手的 dropdown 有 bn-table-handle-menu、沒有 bn-menu-dropdown；儲存格選單兩者都有", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    expect(tableMenu()!.classList.contains("bn-table-handle-menu")).toBe(true);
    expect(tableMenu()!.classList.contains("bn-menu-dropdown")).toBe(false);
    fireEvent.keyDown(tableMenu()!, { key: "Escape" });
    await expectMenuClosed(rowHandle);
    await wait(400);
    await hoverCell(editor, "a1");
    const trigger = cellHandles()[0]!;
    await openMenu(trigger);
    const cellMenu = menuOf(trigger)!;
    expect(cellMenu).toHaveTextContent(/^Colors$/);
    expect(cellMenu.classList.contains("bn-table-handle-menu")).toBe(true);
    expect(cellMenu.classList.contains("bn-menu-dropdown")).toBe(true);
  });

  it("TM3 儲存格選單 Colors → Background 的 red → 該格底色是 red、其他格不變", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    const trigger = cellHandles()[0]!;
    await openMenu(trigger);
    await openColorsSub();
    fireEvent.click(item("background-color-red")!);
    expect(cellAt(editor, 0, 0).props.backgroundColor).toBe("red");
    expect(cellAt(editor, 0, 1).props.backgroundColor).toBe("default");
    await expectMenuClosed(() => cellHandles()[0]);
  });

  it("TM4 列兩格字色不同 → 列的 Colors 子選單「自動」打勾、「Custom…」不打勾", async () => {
    const editor = mount([{ textColor: "#ff6600" }, { textColor: "red" }]);
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    expect(isChecked(item("text-color-default")!)).toBe(true);
    expect(isChecked(item("text-color-custom")!)).toBe(false);
    expect(isChecked(item("text-color-red")!)).toBe(false);
    expect(isChecked(item("background-color-default")!)).toBe(true);
  });

  it("TM4 列兩格字色都是 #ff6600 → 列的 Colors 子選單「Custom…」打勾、「自動」不打勾", async () => {
    const editor = mount([{ textColor: "#ff6600" }, { textColor: "#ff6600" }]);
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    expect(isChecked(item("text-color-custom")!)).toBe(true);
    expect(isChecked(item("text-color-default")!)).toBe(false);
  });

  it("TM4 儲存格底色是 #ff6600 → 儲存格的 Colors 子選單底色段「Custom…」打勾、「自動」不打勾", async () => {
    const editor = mount([{ backgroundColor: "#ff6600" }, {}]);
    await hoverCell(editor, "a1");
    await openMenu(cellHandles()[0]!);
    await openColorsSub();
    expect(isChecked(item("background-color-custom")!)).toBe(true);
    expect(isChecked(item("background-color-default")!)).toBe(false);
  });

  it("TM5 儲存格 Custom… → 根選單仍開、焦點在面板；Back 回到項目列表、焦點在 Colors；再 Custom… 套用 #ff6600 → 該格有色、選單關", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    const trigger = cellHandles()[0]!;
    await openMenu(trigger);
    await openColorsSub();
    await clickCustom("background");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel()!.contains(document.activeElement)).toBe(true);
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(colorsItem()));
    expect(panel()).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await openColorsSub();
    await clickCustom("background");
    fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
    fireEvent.click(button("Apply"));
    expect(cellAt(editor, 0, 0).props.backgroundColor).toBe("#ff6600");
    expect(cellAt(editor, 1, 1).props.backgroundColor).toBe("default");
    await expectMenuClosed(() => cellHandles()[0]);
  });

  it("TM6 編輯器選項的 tables 就是 NOTE_TABLE_SETTINGS：只開儲存格字色與底色，沒有 splitCells、headers", () => {
    const base = buildCollabEditorBase({ doc: new Y.Doc(), awareness: undefined, language: "en", user: { name: "alice", color: "#888888" } });
    expect(base.tables).toBe(NOTE_TABLE_SETTINGS);
    expect(base.tables).toEqual({ cellTextColor: true, cellBackgroundColor: true });
    expect(Object.keys(base.tables).sort()).toEqual(["cellBackgroundColor", "cellTextColor"]);
  });

  it("TM7 儲存格面板開著時別人改了 (0,0) 的字 → Apply #ff6600：(0,0) 是新字、該格有色", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    const trigger = cellHandles()[0]!;
    await openMenu(trigger);
    await openColorsSub();
    await clickCustom("background");
    remoteSetCellText(editor, 0, 0, "remote");
    expect(cellText(editor, 0, 0)).toBe("remote");
    await wait(50);
    expect(panel()).not.toBeNull();
    fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
    fireEvent.click(button("Apply"));
    expect(cellText(editor, 0, 0)).toBe("remote");
    expect(cellAt(editor, 0, 0).props.backgroundColor).toBe("#ff6600");
    await expectMenuClosed(() => cellHandles()[0]);
  });

  it("TM7 列把手面板開著時別人改了 (0,0) 的字 → Apply #ff6600：(0,0) 是新字、整列字色都是 #ff6600", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    await clickCustom("text");
    remoteSetCellText(editor, 0, 0, "remote");
    expect(cellText(editor, 0, 0)).toBe("remote");
    await wait(50);
    expect(panel()).not.toBeNull();
    fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
    fireEvent.click(button("Apply"));
    expect(cellText(editor, 0, 0)).toBe("remote");
    expect(cellAt(editor, 0, 0).props.textColor).toBe("#ff6600");
    expect(cellAt(editor, 0, 1).props.textColor).toBe("#ff6600");
    expect(cellAt(editor, 1, 0).props.textColor).toBe("default");
    await expectMenuClosed(rowHandle);
  });

  it("TM8 列把手 Custom… → 根選單仍開、焦點在面板；Back 焦點在 Colors；關掉再開是項目列表；Custom… 套用 #0000ff → 整列字色、選單關", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    await clickCustom("text");
    expect(rowHandle()).toHaveAttribute("aria-expanded", "true");
    expect(panel()!.contains(document.activeElement)).toBe(true);
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(colorsItem()));
    expect(panel()).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await expectMenuClosed(rowHandle);
    await wait(400);
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    expect(panel()).toBeNull();
    expect(colorsItem()).not.toBeNull();
    expect(screen.getByText("Delete row")).toBeInTheDocument();
    await openColorsSub();
    await clickCustom("text");
    fireEvent.change(hexInput(), { target: { value: "#0000ff" } });
    fireEvent.click(button("Apply"));
    expect(cellAt(editor, 0, 0).props.textColor).toBe("#0000ff");
    expect(cellAt(editor, 0, 1).props.textColor).toBe("#0000ff");
    expect(cellAt(editor, 1, 1).props.textColor).toBe("default");
    await expectMenuClosed(rowHandle);
  });

  // 表格把手的選單在 Mantine Menu 自己的 focus trap 裡，但那個 trap 的 ref 經 useMergedRef 記住、重繪時不換，
  // 所以不會重新聚焦。格式工具列不同：它每次 render 都重建合併後的 ref，trap 跟著重掛、把焦點搶走。
  // 這兩案釘住：面板開著時文件變動（把手跟著重繪）不會把焦點從色碼框搶走。
  it("TM9 儲存格面板開著時文件在表格之前多了一段：焦點留在色碼框、面板不關、已輸入的字還在", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(cellHandles()[0]!);
    await openColorsSub();
    await clickCustom("background");
    const hex = hexInput();
    hex.focus();
    fireEvent.change(hex, { target: { value: "#ff6" } });
    await wait(20);
    expect(document.activeElement).toBe(hex);
    act(() => {
      editor.insertBlocks([{ type: "paragraph", content: "x" }], "p0", "before");
    });
    await wait(50);
    expect(document.activeElement).toBe(hex);
    expect(panel()).not.toBeNull();
    expect(hex.value).toBe("#ff6");
  });

  it("TM9 列把手面板開著時別的格子的字變了：焦點留在色碼框、面板不關、已輸入的字還在", async () => {
    const editor = mount();
    await hoverCell(editor, "a1");
    await openMenu(rowHandle()!);
    await openColorsSub();
    await clickCustom("text");
    const hex = hexInput();
    hex.focus();
    fireEvent.change(hex, { target: { value: "#ff6" } });
    await wait(20);
    expect(document.activeElement).toBe(hex);
    remoteSetCellText(editor, 1, 1, "changed");
    await wait(50);
    expect(document.activeElement).toBe(hex);
    expect(panel()).not.toBeNull();
    expect(hex.value).toBe("#ff6");
  });
});
