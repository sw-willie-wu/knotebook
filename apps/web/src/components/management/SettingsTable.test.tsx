import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortal } from "react-dom";
import { act, render, screen, within } from "@testing-library/react";
import i18n from "@/i18n";
import { Switch } from "@/components/ui/switch";
import {
  SettingsTable,
  orderSettingsTableColumns,
  settingsTableTracks,
  type SettingsTableColumn,
  type SettingsTableRow,
} from "./SettingsTable";

// spec 2026-10-13 settings-table §5.1。jsdom 不排版：版面一律以 class／inline style 斷言（只有本檔准這樣寫，§5.1 末），
// 真實幾何由 e2e 26-settings-tables 量。ResizeObserver 在 test/setup.ts 是什麼都不做的假建構子——要驗溢出的案自己換成 FakeResizeObserver。

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  targets: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.targets = [];
  }
  fire(entries: Array<{ target: Element; borderBoxSize?: Array<{ inlineSize: number; blockSize: number }> }>): void {
    this.callback(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

function setOverflow(el: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => clientWidth });
}

const NAME: SettingsTableColumn = { id: "name", header: "Name", kind: "primary" };
const EMAIL: SettingsTableColumn = { id: "email", header: "Email", kind: "text" };
const LINK: SettingsTableColumn = { id: "url", header: "URL", kind: "url" };
const SIZE: SettingsTableColumn = { id: "size", header: "Size", kind: "fixed" };
const ROLE: SettingsTableColumn = { id: "role", header: "Role", kind: "control" };
const ACTIONS: SettingsTableColumn = { id: "actions", header: "Actions", kind: "actions", buttons: 3 };
const ENABLED: SettingsTableColumn = { id: "enabled", header: "Enabled", kind: "enabled" };
const ALL: SettingsTableColumn[] = [NAME, EMAIL, LINK, SIZE, ROLE, ACTIONS, ENABLED];

function row(id: string, name: string, extra: Partial<SettingsTableRow> = {}): SettingsTableRow {
  return {
    id,
    primary: { name },
    cells: {
      email: `${id}@example.com`,
      url: `https://example.com/${id}`,
      size: "1 MB",
      role: (
        <select aria-label={`Role for ${name}`} defaultValue="admin">
          <option value="admin">Admin</option>
        </select>
      ),
    },
    actions: (
      <button type="button" aria-label={`Edit ${name}`}>
        e
      </button>
    ),
    enabled: (labelledBy) => <Switch aria-labelledby={labelledBy} checked />,
    ...extra,
  };
}

const tableNamed = (name = "Things") => screen.getByRole("table", { name });
/** 只取這張表自己的表頭（巢狀子表的表頭也在子樹裡）。 */
const headersOf = (table: HTMLElement) =>
  within(table).getAllByRole("columnheader").filter((cell) => cell.closest('[role="table"]') === table);

describe("SettingsTable（spec §2、§5.1）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("§2.2 欄位強制順序：亂序宣告 → 照「主欄→資訊欄（保留宣告順序）→可編輯欄→操作→啟用」排，並 console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SettingsTable label="Things" columns={[ENABLED, ROLE, SIZE, ACTIONS, EMAIL, NAME]} rows={[row("a", "Alpha")]} />);
    expect(headersOf(tableNamed()).map((cell) => cell.textContent)).toEqual(["Name", "Size", "Email", "Role", "Actions", "Enabled"]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("§2.2"));
    expect(within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "Alpha",
      "1 MB",
      "a@example.com",
      "Admin",
      "e",
      "",
    ]);
    expect(tableNamed().style.getPropertyValue("--kb-table-cols")).toBe("minmax(14ch,2fr) max-content minmax(14ch,1fr) max-content 6.5rem 3.5rem");
  });

  it("§2.2 照規則宣告 → 不 console.error；orderSettingsTableColumns 原樣回傳", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    expect(spy).not.toHaveBeenCalled();
    expect(orderSettingsTableColumns(ALL)).toEqual(ALL);
  });

  it.each([
    ["全部 kind", ALL, "minmax(14ch,2fr) minmax(14ch,1fr) minmax(14ch,1.5fr) max-content max-content 6.5rem 3.5rem"],
    ["actions 是最後一欄（2 鈕）→ 再加 0.75rem", [NAME, SIZE, { ...ACTIONS, buttons: 2 }], "minmax(14ch,2fr) max-content 5rem"],
    ["actions 是最後一欄（1 鈕）", [NAME, EMAIL, { ...ACTIONS, buttons: 1 }], "minmax(14ch,2fr) minmax(14ch,1fr) 2.75rem"],
    ["4 鈕、後面還有 enabled → 不加", [NAME, { ...ACTIONS, buttons: 4 }, ENABLED], "minmax(14ch,2fr) 8.75rem 3.5rem"],
    ["沒有 actions／enabled", [NAME, SIZE, ROLE], "minmax(14ch,2fr) max-content max-content"],
  ] as const)("§2.1 --kb-table-cols：%s", (_case, columns, expected) => {
    render(<SettingsTable label="Things" columns={[...columns]} rows={[row("a", "Alpha")]} />);
    expect(tableNamed().style.getPropertyValue("--kb-table-cols")).toBe(expected);
    expect(settingsTableTracks(orderSettingsTableColumns([...columns]))).toBe(expected);
    expect(tableNamed()).toHaveClass("grid", "grid-cols-(--kb-table-cols)", "gap-x-3", "text-sm");
  });

  it("§2.8／§2.9 列名＝主欄名稱；開關名稱＝「Enabled ＜列名＞」，aria-labelledby 指向表頭 columnheader 與名稱文字", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha"), row("b", "Beta")]} />);
    expect(screen.getByRole("row", { name: "Alpha" })).toBeInTheDocument();
    const toggle = within(screen.getByRole("row", { name: "Beta" })).getByRole("switch", { name: "Enabled Beta" });
    const [headerRef, nameRef] = toggle.getAttribute("aria-labelledby")!.split(" ");
    expect(document.getElementById(headerRef!)).toHaveAttribute("role", "columnheader");
    expect(document.getElementById(nameRef!)).toHaveTextContent(/^Beta$/);
  });

  it("§2.1 nameColumn＝非主欄（email）：列名、開關名稱、明細列名稱都用該欄文字", () => {
    render(<SettingsTable label="Things" nameColumn="email" columns={ALL} rows={[row("a", "Alpha", { detail: "notes" })]} />);
    const dataRow = screen.getByRole("row", { name: "a@example.com" });
    expect(within(dataRow).getByRole("switch", { name: "Enabled a@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "a@example.com details" })).toBeInTheDocument();
  });

  it("§2.1 nameColumn 那一格不是純文字 → 開發模式 console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <SettingsTable label="Things" nameColumn="email" columns={ALL} rows={[row("a", "Alpha", { cells: { email: <b>a@example.com</b> } })]} />,
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nameColumn"));
  });

  it("§2.1 rows=[] → 只有 empty 文字，沒有 table、沒有捲動框；title／titleAction 仍在", () => {
    render(
      <SettingsTable
        label="Things"
        columns={ALL}
        rows={[]}
        empty="Nothing yet."
        title="Models"
        titleAction={<button type="button">Add model</button>}
      />,
    );
    expect(screen.getByText("Nothing yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add model" })).toBeInTheDocument();
  });

  it("§2.1 有資料列時 title／titleAction 也渲染", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} title="Models" titleAction={<button type="button">Add model</button>} />);
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add model" })).toBeInTheDocument();
  });

  it("§2.5 明細列與錯誤列：獨立 row（不是 subgrid）、名稱「＜列名＞ details／error」、cell aria-colspan＝欄數；錯誤列在明細列之前、內容 role=alert；下框線只畫在一組的最後一列", () => {
    render(
      <SettingsTable
        label="Things"
        columns={ALL}
        rows={[row("a", "Alpha", { detail: <p>Alpha notes</p>, error: "Role change failed" }), row("b", "Beta")]}
      />,
    );
    const dataRow = screen.getByRole("row", { name: "Alpha" });
    const errorRow = screen.getByRole("row", { name: "Alpha error" });
    const detailRow = screen.getByRole("row", { name: "Alpha details" });
    expect(dataRow.contains(detailRow)).toBe(false);
    expect(dataRow.compareDocumentPosition(errorRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(errorRow.compareDocumentPosition(detailRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(detailRow).getByRole("cell")).toHaveAttribute("aria-colspan", "7");
    expect(within(detailRow).getByText("Alpha notes")).toBeInTheDocument();
    expect(within(errorRow).getByRole("cell")).toHaveAttribute("aria-colspan", "7");
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("Role change failed");
    expect(detailRow).toHaveClass("col-span-full");
    expect(detailRow).not.toHaveClass("grid-cols-subgrid");
    expect(within(detailRow).getByRole("cell").className).not.toMatch(/(^|\s)(px|pl|pr)-/);
    expect(dataRow).not.toHaveClass("border-b");
    expect(errorRow).not.toHaveClass("border-b");
    expect(detailRow).toHaveClass("border-b", "border-border");
    expect(screen.getByRole("row", { name: "Beta" })).toHaveClass("border-b", "border-border");
  });

  it("§2.5 明細／錯誤列的名稱後綴走 i18n（zh-TW：明細／錯誤）", async () => {
    await i18n.changeLanguage("zh-TW");
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha", { detail: "notes", error: "x" })]} />);
    expect(screen.getByRole("row", { name: "Alpha 明細" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Alpha 錯誤" })).toBeInTheDocument();
  });

  it("§2.6 editing：主欄 cell 保留、其餘欄合併成一格（aria-colspan＝欄數−1、grid-column 2/-1）放呼叫端的表單、整列 bg-brand-soft、sticky 主欄是不透明疊色、其他欄（含開關）不顯示", () => {
    // autoFocus 與 Enter 送出是呼叫端表單自己的行為（spec §2.6「保留現有鍵盤行為」），元件不轉手也不攔——
    // 這兩條由 token 頁的測試守（Task 6「鉛筆 → 編輯態…」的 toHaveFocus、「清空 label…Enter＝儲存」），這裡只驗結構。
    render(
      <SettingsTable
        label="Things"
        columns={ALL}
        rows={[row("a", "Alpha", { editing: <input aria-label="Label" defaultValue="draft" /> }), row("b", "Beta")]}
      />,
    );
    const editingRow = screen.getByRole("row", { name: "Alpha" });
    const cells = within(editingRow).getAllByRole("cell");
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent(/^Alpha$/);
    expect(cells[1]).toHaveAttribute("aria-colspan", "6");
    expect(cells[1]).toHaveClass("col-[2/-1]");
    expect(within(cells[1]!).getByRole("textbox", { name: "Label" })).toBeInTheDocument();
    expect(editingRow).toHaveClass("bg-brand-soft");
    expect(cells[0]!.style.background).toBe("linear-gradient(var(--brand-soft), var(--brand-soft)), var(--card)");
    expect(within(editingRow).queryByRole("switch")).toBeNull();
  });

  it("§2.1 主欄名稱字重由呼叫端決定（weight），元件預設一般字重、不替任何表加粗", () => {
    render(
      <SettingsTable
        label="Things"
        columns={[NAME, SIZE]}
        rows={[
          { id: "n", primary: { name: "Plain" }, cells: { size: "1" } },
          { id: "m", primary: { name: "Medium", weight: "medium" }, cells: { size: "2" } },
          { id: "s", primary: { name: "Semi", weight: "semibold" }, cells: { size: "3" } },
        ]}
      />,
    );
    const nameOf = (rowName: string) => document.getElementById(screen.getByRole("row", { name: rowName }).getAttribute("aria-labelledby")!)!;
    expect(nameOf("Plain").className).not.toMatch(/(^|\s)font-/);
    expect(nameOf("Medium")).toHaveClass("font-medium");
    expect(nameOf("Semi")).toHaveClass("font-semibold");
  });

  it("§2.4 頂層表：捲動框 role=region（名＝label）、overflow-x-auto＋scroll-ps；只在溢出時 tabIndex=0、有焦點時不移除；--kb-sticky-w 取表頭主欄的 borderBoxSize（保留小數）", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const box = screen.getByRole("region", { name: "Things" });
    expect(box).toHaveClass("overflow-x-auto", "scroll-ps-(--kb-sticky-w)");
    expect(box).not.toHaveAttribute("tabindex");
    const observer = FakeResizeObserver.instances.at(-1)!;
    const stickyHeader = headersOf(tableNamed())[0]!;
    expect(observer.targets).toEqual(expect.arrayContaining([box, stickyHeader.parentElement!, stickyHeader]));

    setOverflow(box, 900, 400);
    act(() => observer.fire([{ target: stickyHeader, borderBoxSize: [{ inlineSize: 123.25, blockSize: 30 }] }]));
    expect(box).toHaveAttribute("tabindex", "0");
    expect(box.style.getPropertyValue("--kb-sticky-w")).toBe("123.25px");

    act(() => box.focus());
    setOverflow(box, 400, 400);
    act(() => observer.fire([{ target: box }]));
    expect(box).toHaveAttribute("tabindex", "0");
    act(() => box.blur());
    expect(box).not.toHaveAttribute("tabindex");
  });

  it("§2.4 --kb-sticky-w 只取 sticky 格那筆 entry 的 borderBoxSize：掛載時與只有捲動框／表頭列變動的回呼，都不以 getBoundingClientRect（受 transform 縮放）寫入或覆蓋", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    // 模擬 Dialog 開啟動畫 zoom-in-95 期間：getBoundingClientRect 量到的是縮放後的 95% 寬。
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 117.0875, 28.5));
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const box = screen.getByRole("region", { name: "Things" });
    expect(box.style.getPropertyValue("--kb-sticky-w")).toBe("");
    const observer = FakeResizeObserver.instances.at(-1)!;
    const stickyHeader = headersOf(tableNamed())[0]!;
    act(() => observer.fire([{ target: stickyHeader, borderBoxSize: [{ inlineSize: 123.25, blockSize: 30 }] }]));
    act(() => observer.fire([{ target: box }, { target: stickyHeader.parentElement! }]));
    expect(box.style.getPropertyValue("--kb-sticky-w")).toBe("123.25px");
  });

  it("§2.4 主欄的欄 id 換掉（表頭主欄格換成新節點）→ ResizeObserver 重新訂閱新節點、斷開舊的", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    const { rerender } = render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const first = FakeResizeObserver.instances.at(-1)!;
    rerender(<SettingsTable label="Things" columns={[{ ...NAME, id: "title" }, ...ALL.slice(1)]} rows={[row("a", "Alpha")]} />);
    const stickyHeader = headersOf(tableNamed())[0]!;
    expect(FakeResizeObserver.instances.at(-1)!.targets).toContain(stickyHeader);
    expect(first.targets).toHaveLength(0);
  });

  it("§2.4 聚焦補捲：焦點目標左緣壓在 sticky 主欄右緣之下 → scrollLeft 往左補（進位成整數）；沒壓到、或焦點在主欄格裡 → 不動", () => {
    const badgeRow = row("a", "Alpha", { primary: { name: "Alpha", badges: <button type="button">Badge</button> } });
    render(<SettingsTable label="Things" columns={ALL} rows={[badgeRow]} />);
    const box = screen.getByRole("region", { name: "Things" });
    let scrollLeft = 241;
    Object.defineProperty(box, "scrollLeft", { configurable: true, get: () => scrollLeft, set: (value: number) => (scrollLeft = value) });
    const stickyHeader = headersOf(tableNamed())[0]!;
    const edit = screen.getByRole("button", { name: "Edit Alpha" });
    const role = screen.getByRole("combobox", { name: "Role for Alpha" });
    const badge = screen.getByRole("button", { name: "Badge" });
    const lefts = new Map<Element, number>([
      [stickyHeader, 0],
      [edit, 116.1], // 壓在 sticky 右緣（124.6875）下 8.5875px
      [role, 200], // 在 sticky 右側
      [badge, 20], // 在主欄格裡
    ]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this === stickyHeader ? new DOMRect(0, 0, 124.6875, 30) : new DOMRect(lefts.get(this) ?? 0, 0, 32, 32);
    });

    act(() => edit.focus());
    expect(scrollLeft).toBe(232);

    scrollLeft = 241;
    act(() => role.focus());
    expect(scrollLeft).toBe(241);
    act(() => badge.focus());
    expect(scrollLeft).toBe(241);
  });

  it("§2.4 聚焦補捲只管捲動框內的焦點：列上 portal 到 body 的控制項（對話框）取得焦點時，React onFocus 冒泡上來也不動 scrollLeft", () => {
    const portalRow = row("a", "Alpha", {
      actions: createPortal(
        <button type="button" aria-label="Dialog field">
          d
        </button>,
        document.body,
      ),
    });
    render(<SettingsTable label="Things" columns={ALL} rows={[portalRow]} />);
    const box = screen.getByRole("region", { name: "Things" });
    let scrollLeft = 241;
    Object.defineProperty(box, "scrollLeft", { configurable: true, get: () => scrollLeft, set: (value: number) => (scrollLeft = value) });
    const stickyHeader = headersOf(tableNamed())[0]!;
    const dialogField = screen.getByRole("button", { name: "Dialog field" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this === stickyHeader ? new DOMRect(0, 0, 124.6875, 30) : new DOMRect(20, 0, 32, 32); // 對話框欄位左緣在 sticky 右緣左邊
    });

    act(() => dialogField.focus());
    expect(scrollLeft).toBe(241);
    expect(box.contains(dialogField)).toBe(false);
  });

  it("§2.4／§2.5 主欄 sticky（表頭格與資料列主欄格：left-0、z-[1]、不透明 bg-card、右緣框線）；nested 子表不 sticky、沒有捲動框、表頭列 sr-only、主欄內容 pl-4、標題列 pl-7", () => {
    render(
      <>
        <SettingsTable label="Top" columns={ALL} rows={[row("a", "Alpha")]} />
        <SettingsTable nested label="Sub" title="Models" columns={[NAME, { ...ACTIONS, buttons: 2 }, ENABLED]} rows={[row("m", "Model one")]} />
      </>,
    );
    const topHeader = headersOf(screen.getByRole("table", { name: "Top" }))[0]!;
    const topCell = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell")[0]!;
    for (const el of [topHeader, topCell]) expect(el).toHaveClass("sticky", "left-0", "z-[1]", "bg-card", "border-r", "border-border");
    const sub = screen.getByRole("table", { name: "Sub" });
    expect(screen.queryByRole("region", { name: "Sub" })).toBeNull();
    const subHeader = headersOf(sub)[0]!;
    const subCell = within(screen.getByRole("row", { name: "Model one" })).getAllByRole("cell")[0]!;
    expect(subHeader).not.toHaveClass("sticky");
    expect(subCell).not.toHaveClass("sticky");
    expect(subHeader.parentElement).toHaveClass("sr-only");
    expect(subCell.firstElementChild).toHaveClass("pl-4");
    expect(screen.getByText("Models").parentElement).toHaveClass("pl-7");
    // 子表最後一列不畫下框線（由外層明細列畫，spec §2.3）。
    expect(screen.getByRole("row", { name: "Model one" })).not.toHaveClass("border-b");
  });

  it("§2.3 列是 subgrid、不設 items-center／gap／水平內距；cell 撐滿（flex items-center），內容包成單一 flex-1 min-w-0 子元素；操作欄靠右（justify-end gap-1）、啟用欄置中設在子元素上", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />);
    const dataRow = screen.getByRole("row", { name: "Alpha" });
    expect(dataRow).toHaveClass("col-span-full", "grid", "grid-cols-subgrid");
    expect(dataRow.className).not.toMatch(/(^|\s)(items-center|gap-\S+|px-\S+|pl-\S+|pr-\S+)(\s|$)/);
    const cells = within(dataRow).getAllByRole("cell");
    for (const cell of cells) {
      expect(cell).toHaveClass("flex", "items-center");
      expect(cell.children).toHaveLength(1);
      expect(cell.firstElementChild).toHaveClass("min-w-0", "flex-1");
    }
    expect(cells[5]!.firstElementChild).toHaveClass("flex", "justify-end", "gap-1");
    expect(cells[6]!.firstElementChild).toHaveClass("flex", "justify-center");
    expect(cells[1]!.firstElementChild).toHaveClass("wrap-anywhere");
    expect(cells[0]!.firstElementChild).toHaveClass("wrap-anywhere");
    expect(cells[2]!.firstElementChild).toHaveClass("truncate");
    expect(cells[2]!.firstElementChild).toHaveAttribute("title", "https://example.com/a");
    expect(cells[3]!.firstElementChild).toHaveClass("whitespace-nowrap");
  });

  it("§2.3 內距只在儲存格：第一格 pl-3、資料列 py-2.5、表頭 py-2；最後一格 pr-3，但最後一格是 enabled 時不加；表頭 text-xs 灰、啟用置中、操作靠右且 sr-only", () => {
    render(
      <>
        <SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha")]} />
        <SettingsTable label="Plans" columns={[NAME, { ...ACTIONS, buttons: 2 }]} rows={[row("p", "Plan one")]} />
      </>,
    );
    const cells = within(screen.getByRole("row", { name: "Alpha" })).getAllByRole("cell");
    expect(cells[0]).toHaveClass("pl-3", "py-2.5");
    expect(cells[6]!.className).not.toMatch(/(^|\s)(px|pl|pr)-/);
    expect(cells[5]!.className).not.toMatch(/(^|\s)pr-/);
    const planCells = within(screen.getByRole("row", { name: "Plan one" })).getAllByRole("cell");
    expect(planCells[1]).toHaveClass("pr-3");
    const headers = headersOf(tableNamed());
    expect(headers[0]).toHaveClass("py-2", "pl-3", "text-xs", "text-muted-foreground");
    expect(headers[6]!.firstElementChild).toHaveClass("text-center");
    expect(headers[5]!.firstElementChild).toHaveClass("text-right");
    expect(within(headers[5]!).getByText("Actions")).toHaveClass("sr-only");
  });

  it("§2.1 cell 的 tone：muted 灰、danger 紅（設在內容子元素上）", () => {
    render(
      <SettingsTable
        label="Things"
        columns={[NAME, SIZE, EMAIL]}
        rows={[row("a", "Alpha", { cells: { size: { content: "Expired", tone: "danger" }, email: { content: "a@example.com", tone: "muted" } } })]}
      />,
    );
    expect(screen.getByText("Expired")).toHaveClass("text-destructive");
    expect(screen.getByText("a@example.com")).toHaveClass("text-muted-foreground");
  });

  it("RF1 名稱含方向覆寫字元：名稱 dir=ltr＋unicode-bidi:isolate，標籤與副標是另外的元素；列名、明細列名稱與開關名稱是原字串", () => {
    const name = "\u202Etxt.exe";
    render(
      <SettingsTable
        label="Things"
        columns={[NAME, ENABLED]}
        rows={[
          {
            id: "x",
            primary: { name, badges: <span>Built-in</span>, subtitles: ["Created today"] },
            enabled: (labelledBy) => <Switch aria-labelledby={labelledBy} />,
            detail: "notes",
          },
        ]}
      />,
    );
    expect(screen.getByRole("row", { name: `${name} details` })).toBeInTheDocument();
    const dataRow = screen.getByRole("row", { name });
    const nameEl = document.getElementById(dataRow.getAttribute("aria-labelledby")!)!;
    expect(nameEl).toHaveAttribute("dir", "ltr");
    expect(nameEl).toHaveClass("[unicode-bidi:isolate]");
    expect(nameEl.textContent).toBe(name);
    expect(nameEl.nextElementSibling).toHaveTextContent("Built-in");
    expect(within(dataRow).getByText("Created today")).not.toBe(nameEl);
    expect(screen.getByRole("switch", { name: `Enabled ${name}` })).toBeInTheDocument();
  });

  it("RF2 同名的兩列：各自的列名 id、開關、明細列只指向自己那一列", () => {
    render(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Dup", { detail: "first" }), row("b", "Dup", { detail: "second" })]} />);
    const [first, second] = screen.getAllByRole("row", { name: "Dup" });
    expect(first!.getAttribute("aria-labelledby")).not.toBe(second!.getAttribute("aria-labelledby"));
    const toggles = screen.getAllByRole("switch", { name: "Enabled Dup" });
    expect(toggles).toHaveLength(2);
    expect(first).toContainElement(toggles[0]!);
    expect(second).toContainElement(toggles[1]!);
    for (const [index, toggle] of toggles.entries()) {
      const nameRef = toggle.getAttribute("aria-labelledby")!.split(" ")[1]!;
      expect([first, second][index]).toContainElement(document.getElementById(nameRef));
    }
    expect(screen.getAllByRole("row", { name: "Dup details" }).map((detail) => detail.textContent)).toEqual(["first", "second"]);
  });

  it("RF3 表格在載入完成後才出現：ResizeObserver 這時才掛上、溢出時捲動框可聚焦；歸零時換成 empty、不留明細列、ResizeObserver 斷開", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    FakeResizeObserver.instances = [];
    const { rerender } = render(<SettingsTable label="Things" columns={ALL} rows={[]} empty="Nothing" />);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    rerender(<SettingsTable label="Things" columns={ALL} rows={[row("a", "Alpha", { detail: "notes" })]} empty="Nothing" />);
    const box = screen.getByRole("region", { name: "Things" });
    const observer = FakeResizeObserver.instances.at(-1)!;
    expect(observer.targets).toContain(box);
    setOverflow(box, 900, 400);
    act(() => observer.fire([{ target: box }]));
    expect(box).toHaveAttribute("tabindex", "0");
    rerender(<SettingsTable label="Things" columns={ALL} rows={[]} empty="Nothing" />);
    expect(observer.targets).toHaveLength(0);
    expect(screen.queryByRole("row", { name: "Alpha details" })).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });
});
