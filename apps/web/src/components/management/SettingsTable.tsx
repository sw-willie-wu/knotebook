import { Fragment, isValidElement, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 設定與管理面板的「項目清單」共用表格（spec：docs/superpowers/specs/2026-10-13-settings-table-design.md，下稱 spec）。
 *
 * - 欄位順序由元件強制（spec §2.2）：主欄 → 資訊欄（text／url／fixed，彼此保留宣告順序）→ 可編輯欄（control）→ 操作鈕欄 → 啟用欄。
 *   宣告違反時開發模式 console.error，並照強制順序排。
 * - 版面（§2.3）：`role="table"` 是 grid，軌道由各欄 kind 算出、以 inline style 寫進 `--kb-table-cols`（Tailwind v4 只產生原始碼裡
 *   出現的 class，不能在執行期拼 arbitrary class）。表頭列與資料列是 `grid-column: 1 / -1` 的 subgrid：`max-content` 軌道在整張表
 *   取同一寬度，各欄左緣對齊表頭。列不得設 gap、水平內距或行內方向的框線（subgrid 會把它們加到邊緣項目上）；內距只在儲存格上。
 *   cell 撐滿列的內容高（grid 預設 stretch），內容一律包成單一個 `flex-1 min-w-0` 子元素，欄的水平對齊設在這個子元素上。
 * - 窄螢幕（§2.4）：不重排。頂層表外包 `role="region"` 的橫向捲動框，主欄 sticky 在左（不透明底、z-index 1：開關圓鈕用 translate，
 *   會建立堆疊環境）。捲動框只在內容實際溢出時可聚焦；`scroll-padding-inline-start` 取表頭主欄格的實際寬，Tab 帶捲時焦點目標
 *   落在 sticky 欄右側（WCAG 2.4.11）；目標已在框內、只是壓在 sticky 欄底下時瀏覽器不捲，由捲動框的 focus 處理補捲。
 * - 明細列與錯誤列（§2.5）是緊接在資料列後的獨立 row（不是 subgrid）。子表以 `nested` 宣告：沒有捲動框、主欄不 sticky（sticky 盒
 *   不能離開所屬列，子表主欄軌很寬，黏住會蓋掉同列的操作鈕與開關）、表頭列 sr-only（供開關的 aria-labelledby 引用）。
 * - 編輯中（§2.6）：主欄 cell 保留，其餘欄合併成一格放呼叫端的表單。
 *
 * ⚠ 版面 class／inline style 的斷言只准寫在本元件的測試（spec §5.1）；各頁測試一律語意查詢。
 */

export type SettingsTableColumnKind = "primary" | "text" | "url" | "fixed" | "control" | "actions" | "enabled";

export interface SettingsTableColumn {
  /** 欄 id：資料列以它對應 `cells`，也用來組表頭的 DOM id。 */
  id: string;
  /** 表頭文字（`actions` 欄渲染成 sr-only）。 */
  header: string;
  kind: SettingsTableColumnKind;
  /** 只給 `actions`：該表一列最多幾顆鈕（spec §2.1，決定固定軌寬）。 */
  buttons?: number;
}

export type SettingsTableTone = "default" | "muted" | "danger";

/** 一格的內容＋語氣（`muted` 灰字、`danger` 紅字）；`url` 欄的 `title`（全文）在內容是字串時可省。 */
export interface SettingsTableCellSpec {
  content: ReactNode;
  tone?: SettingsTableTone;
  title?: string;
}

export type SettingsTableCellValue = ReactNode | SettingsTableCellSpec;

/**
 * 主欄：一行名稱（前可接圖示、後可接標籤）＋任意行數的灰色副標。名稱一律 bidi 隔離（spec §2.1，沿用 token 名稱的
 * `dir="ltr"`＋`unicode-bidi:isolate`）——這幾張表的名稱全是使用者、管理員或 OAuth client 自填的。
 * `icon` 直接渲染在名稱元素的前一個兄弟位置（測試以「名稱元素的 previousElementSibling」找圖示）。
 * `weight`：名稱字重，沿用各表現行的樣式（spec §2.1 沒有規定字重，元件不替任何表加粗）；預設一般字重。
 */
export interface SettingsTablePrimary {
  name: string;
  weight?: "normal" | "medium" | "semibold";
  icon?: ReactNode;
  badges?: ReactNode;
  subtitles?: ReactNode[];
}

export interface SettingsTableRow {
  /** 穩定 id（資料庫 id）：列名、明細列等 DOM id 都以它組，不以名稱（名稱可重複，spec §2.1）。 */
  id: string;
  primary: SettingsTablePrimary;
  /** 資訊欄與可編輯欄（`text`／`url`／`fixed`／`control`）的內容，以欄 id 為鍵。 */
  cells?: Record<string, SettingsTableCellValue>;
  /** 操作鈕欄（一律 `RowIconButton`，spec §2.7）；不提供的動作就不渲染該鈕。 */
  actions?: ReactNode;
  /** 啟用欄：收到 `aria-labelledby`（＝啟用欄表頭 id＋名稱文字 id），交給 `Switch`（spec §2.8）。 */
  enabled?: (labelledBy: string) => ReactNode;
  /** 緊接在後的明細列（spec §2.5）。 */
  detail?: ReactNode;
  /** 有值＝編輯中：主欄 cell 保留，其餘欄合併成一格放這個表單（spec §2.6）。 */
  editing?: ReactNode;
  /** 列層級錯誤：渲染成資料列之後的錯誤列，內容 `role="alert"`；有明細列時在它之前（spec §2.5 末）。 */
  error?: ReactNode;
}

export interface SettingsTableProps {
  /** 表格可及名稱（必填，spec §3 逐表列出）；頂層表的捲動框也用它。 */
  label: string;
  columns: SettingsTableColumn[];
  rows: SettingsTableRow[];
  /** 哪一欄的文字當列名與開關名稱（預設＝主欄；使用者表、成員表＝email 欄）。該欄內容必須是純文字。 */
  nameColumn?: string;
  /** 零列時的提示；零列時不渲染 table 與捲動框（載入與錯誤由呼叫端在元件外處理）。 */
  empty?: ReactNode;
  /** 表格上方的標題列（不論有無資料列都渲染）；頂層表通常由 `SettingsGroup` 給標題，不用這個。 */
  title?: ReactNode;
  titleAction?: ReactNode;
  /** 子表（放在父表的明細列裡）：沒有捲動框、主欄不 sticky、表頭 sr-only、主欄內容左縮（spec §2.5）。 */
  nested?: boolean;
}

const KIND_RANK: Record<SettingsTableColumnKind, number> = { primary: 0, text: 1, url: 1, fixed: 1, control: 2, actions: 3, enabled: 4 };

/** spec §2.2：照「主欄→資訊欄→可編輯欄→操作鈕欄→啟用欄」排（同級保留宣告順序）；宣告違反時開發模式 console.error。 */
export function orderSettingsTableColumns(columns: SettingsTableColumn[]): SettingsTableColumn[] {
  const ordered = columns
    .map((column, index) => ({ column, index }))
    .sort((a, b) => KIND_RANK[a.column.kind] - KIND_RANK[b.column.kind] || a.index - b.index)
    .map(({ column }) => column);
  if (import.meta.env.DEV) {
    if (ordered.some((column, index) => column !== columns[index])) {
      console.error(
        `SettingsTable：欄位宣告順序違反 spec §2.2，已改照「主欄→資訊欄→可編輯欄→操作鈕欄→啟用欄」排：${ordered.map((column) => column.id).join(", ")}`,
      );
    }
    const count = (kind: SettingsTableColumnKind): number => columns.filter((column) => column.kind === kind).length;
    if (count("primary") !== 1) console.error(`SettingsTable：一張表恰有一個 primary 欄（spec §2.2），實際 ${count("primary")} 個`);
    if (count("actions") > 1) console.error(`SettingsTable：一張表至多一個 actions 欄（spec §2.2），實際 ${count("actions")} 個`);
    if (count("enabled") > 1) console.error(`SettingsTable：一張表至多一個 enabled 欄（spec §2.2），實際 ${count("enabled")} 個`);
    for (const column of columns) {
      if (column.kind === "actions" && (column.buttons === undefined || column.buttons < 1)) {
        console.error(`SettingsTable：actions 欄「${column.id}」要給 buttons（該表一列最多的按鈕數，spec §2.1）`);
      }
    }
  }
  return ordered;
}

/** 啟用欄固定 56px（spec §2.1）：子表與父表都是這個寬、都在最右，開關中心才會上下對齊。 */
const ENABLED_TRACK = "3.5rem";

/** 一欄的 grid 軌道（spec §2.1）。 */
function settingsTableTrack(column: SettingsTableColumn, isLast: boolean): string {
  switch (column.kind) {
    case "primary":
      return "minmax(14ch,2fr)";
    case "text":
      return "minmax(14ch,1fr)";
    case "url":
      return "minmax(14ch,1.5fr)";
    case "fixed":
    case "control":
      return "max-content";
    case "actions": {
      const buttons = column.buttons ?? 1;
      // 32px 鈕 ×n＋gap-1 ×(n−1)；是最後一欄時要帶 pr-3，preflight 是 border-box、內距吃在軌寬裡，所以再加 0.75rem。
      return `${buttons * 2 + (buttons - 1) * 0.25 + (isLast ? 0.75 : 0)}rem`;
    }
    case "enabled":
      return ENABLED_TRACK;
  }
}

/** 整張表的 `grid-template-columns`（傳入已排序的欄）。 */
export function settingsTableTracks(ordered: SettingsTableColumn[]): string {
  return ordered.map((column, index) => settingsTableTrack(column, index === ordered.length - 1)).join(" ");
}

/** 表頭列與資料列：同一張表內這一層的 subgrid（spec §2.3）。列不得加 gap、水平內距或 items-*。 */
const ROW_GRID = "col-span-full grid grid-cols-subgrid";
/** 列間分隔：畫在列上（欄距處不斷線）。 */
const ROW_BORDER = "border-b border-border";
/** 儲存格：撐滿列的內容高、內容垂直置中。 */
const CELL = "flex items-center";
/** 頂層表主欄（表頭格與每列主欄格）：sticky、z-index 1、不透明底、右緣分隔線（spec §2.4）。 */
const STICKY_CELL = "sticky left-0 z-[1] border-r border-border bg-card";
/** 編輯中列的 sticky 主欄：淡色疊在卡片色上（`--brand-soft` 是半透明；用 inline style，不用 `bg-[…]` arbitrary 值，spec §2.4）。 */
const EDITING_STICKY_BACKGROUND = "linear-gradient(var(--brand-soft), var(--brand-soft)), var(--card)";
/** 頂層表的橫向捲動框（spec §2.4）。 */
const SCROLL_BOX = "overflow-x-auto scroll-ps-(--kb-sticky-w) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** 明細 cell：不加水平內距（子表要與父表同寬；非表格內容自己帶 px-3，spec §2.5）。 */
const DETAIL_CELL = "pb-3";
/** cell 內容子元素依欄種的文字行為與水平對齊（spec §2.1、§2.3）。 */
const INNER: Record<SettingsTableColumnKind, string> = {
  primary: "wrap-anywhere",
  text: "wrap-anywhere",
  url: "truncate",
  fixed: "whitespace-nowrap",
  control: "whitespace-nowrap",
  actions: "flex justify-end gap-1",
  enabled: "flex justify-center",
};
/** 表頭文字與該欄內容同側（spec §2.3）：啟用置中、操作靠右、其餘靠左。 */
const HEADER_INNER: Partial<Record<SettingsTableColumnKind, string>> = { actions: "text-right", enabled: "text-center" };

/** 內距只在儲存格（spec §2.3）：第一格 pl-3；最後一格 pr-3，但最後一格是 enabled 時不加（56px 軌道已含留白）。 */
function cellPadding(kind: SettingsTableColumnKind, index: number, count: number, header: boolean): string {
  return cn(header ? "py-2" : "py-2.5", index === 0 && "pl-3", index === count - 1 && kind !== "enabled" && "pr-3");
}

function isCellSpec(value: SettingsTableCellValue): value is SettingsTableCellSpec {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isValidElement(value) && "content" in value;
}

function present(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

function PrimaryContent({ primary, nameId }: { primary: SettingsTablePrimary; nameId: string | undefined }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {primary.icon}
        <span
          id={nameId}
          dir="ltr"
          className={cn(
            "min-w-0 [unicode-bidi:isolate]",
            primary.weight === "medium" && "font-medium",
            primary.weight === "semibold" && "font-semibold",
          )}
        >
          {primary.name}
        </span>
        {primary.badges}
      </div>
      {primary.subtitles?.map((subtitle, index) => (
        <p key={index} className="text-xs text-muted-foreground">
          {subtitle}
        </p>
      ))}
    </>
  );
}

/**
 * 頂層表的橫向捲動框：量內容是否溢出、表頭主欄格的實際寬（spec §2.4）。
 * `stickyKey`＝主欄的欄 id：表頭格以欄 id 為 key，id 一換就是新的 DOM 節點，effect 要重新訂閱，不能繼續觀察已脫離的舊節點。
 */
function useScrollBox(active: boolean, stickyKey: string | undefined) {
  const boxRef = useRef<HTMLDivElement>(null);
  const headerRowRef = useRef<HTMLDivElement>(null);
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const headerRow = headerRowRef.current;
    if (!active || box === null || headerRow === null) return;
    const scroller: HTMLDivElement = box;
    const sticky = stickyKey === undefined ? null : stickyHeaderRef.current;
    function measure(entries: readonly ResizeObserverEntry[]): void {
      // 寬度只取 sticky 格自己那筆 entry 的 borderBoxSize。不以 getBoundingClientRect 補：它受 transform 影響
      // （管理面板 Dialog 開啟時的 zoom-in-95），只有捲動框或表頭列變動的回呼會把正確值蓋成縮放後的寬。
      // observe 之後 ResizeObserver 一定會送 sticky 格的初始 entry，所以不需要後備值。
      const width = entries.find((entry) => entry.target === sticky)?.borderBoxSize?.[0]?.inlineSize;
      if (width !== undefined) scroller.style.setProperty("--kb-sticky-w", `${width}px`);
      setOverflowing(scroller.scrollWidth > scroller.clientWidth);
    }
    measure([]);
    // 軌道溢出不會改變 table 盒的大小——要看表頭列（它跨全部軌道）；表頭主欄格給 sticky 寬。
    const observer = new ResizeObserver((entries) => measure(entries));
    observer.observe(scroller);
    observer.observe(headerRow);
    if (sticky !== null) observer.observe(sticky);
    return () => observer.disconnect();
  }, [active, stickyKey]);

  /**
   * 聚焦帶捲的補捲：瀏覽器只在焦點目標落在捲動框可視範圍外時才捲（捲的時候才套用 scroll-padding）；目標整顆在框內、
   * 只是左半壓在 sticky 主欄底下時不會捲（Chromium 實測），這裡把 scrollLeft 往左補到目標露出。只補頂層資料列
   * （捲動框 > table > row、帶 aria-labelledby）的非主欄格：明細列、錯誤列、子表列沒有 sticky 格，控制項完全可見，
   * 補捲反而讓滑鼠按下（先 focus）時按鈕移離游標、click 被吃掉；主欄格（sticky 格本身）裡也不補。
   */
  function revealPastSticky(target: Element): void {
    const scroller = boxRef.current;
    const sticky = stickyHeaderRef.current;
    // React 的 onFocus 會穿過 portal 冒泡：列上開的對話框（DOM 在 body）裡的焦點不是表內控制項，不補。
    if (scroller === null || sticky === null || !scroller.contains(target)) return;
    const row = target.closest('[role="row"]');
    if (row === null || !row.hasAttribute("aria-labelledby") || row.parentElement?.parentElement !== scroller) return;
    if (row.firstElementChild?.contains(target)) return;
    const covered = sticky.getBoundingClientRect().right - target.getBoundingClientRect().left;
    // 進位成整數：scrollLeft 可能被取整，補不足會留下小於 1px 的遮擋。
    if (covered > 0) scroller.scrollLeft -= Math.ceil(covered);
  }

  // 只在溢出時可聚焦；捲動框正有焦點時不移除 tabIndex，等它失焦後再依溢出狀態更新。
  return { boxRef, headerRowRef, stickyHeaderRef, tabbable: overflowing || focused, setFocused, revealPastSticky };
}

export function SettingsTable({ label, columns, rows, nameColumn, empty, title, titleAction, nested = false }: SettingsTableProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const ordered = orderSettingsTableColumns(columns);
  const tracks = settingsTableTracks(ordered);
  const primaryId = ordered.find((column) => column.kind === "primary")?.id;
  const box = useScrollBox(!nested && rows.length > 0, primaryId);
  const nameColumnId = nameColumn ?? primaryId;
  const enabledColumn = ordered.find((column) => column.kind === "enabled");
  const headerId = (column: SettingsTableColumn): string => `${baseId}-col-${column.id}`;
  const nameId = (row: SettingsTableRow): string => `${baseId}-row-${row.id}-name`;
  const isSticky = (kind: SettingsTableColumnKind): boolean => kind === "primary" && !nested;

  const titleRow =
    title !== undefined || titleAction !== undefined ? (
      <div className={cn("flex items-center justify-between gap-2 py-2 pr-3", nested ? "pl-7" : "pl-3")}>
        <div className="min-w-0 text-xs font-semibold text-muted-foreground">{title}</div>
        {titleAction !== undefined && <div className="shrink-0">{titleAction}</div>}
      </div>
    ) : null;

  if (rows.length === 0) {
    return (
      <div>
        {titleRow}
        {empty !== undefined && <p className={cn("text-sm text-muted-foreground", nested && "pb-2 pl-7 text-xs")}>{empty}</p>}
      </div>
    );
  }

  function rowName(row: SettingsTableRow): string {
    if (nameColumnId === undefined || nameColumnId === primaryId) return row.primary.name;
    const value = row.cells?.[nameColumnId];
    const content = isCellSpec(value) ? value.content : value;
    if (typeof content === "string") return content;
    if (import.meta.env.DEV) console.error(`SettingsTable：nameColumn「${nameColumnId}」那一格要是純文字（列 ${row.id}）`);
    return row.primary.name;
  }

  function renderCell(row: SettingsTableRow, column: SettingsTableColumn, index: number, editing: boolean): ReactNode {
    const isName = column.id === nameColumnId;
    let content: ReactNode;
    let tone: SettingsTableTone = "default";
    let cellTitle: string | undefined;
    if (column.kind === "primary") {
      content = <PrimaryContent primary={row.primary} nameId={isName ? nameId(row) : undefined} />;
    } else if (column.kind === "actions") {
      content = row.actions;
    } else if (column.kind === "enabled") {
      content = enabledColumn !== undefined ? row.enabled?.(`${headerId(enabledColumn)} ${nameId(row)}`) : null;
    } else {
      const value = row.cells?.[column.id];
      if (isCellSpec(value)) {
        content = value.content;
        tone = value.tone ?? "default";
        cellTitle = value.title;
      } else {
        content = value;
      }
      if (column.kind === "url" && cellTitle === undefined && typeof content === "string") cellTitle = content;
    }
    const sticky = isSticky(column.kind);
    return (
      <div
        key={column.id}
        role="cell"
        className={cn(CELL, cellPadding(column.kind, index, ordered.length, false), sticky && STICKY_CELL)}
        style={sticky && editing ? { background: EDITING_STICKY_BACKGROUND } : undefined}
      >
        <div
          id={isName && column.kind !== "primary" ? nameId(row) : undefined}
          title={cellTitle}
          className={cn(
            "min-w-0 flex-1",
            INNER[column.kind],
            column.kind === "primary" && nested && "pl-4",
            tone === "muted" && "text-muted-foreground",
            tone === "danger" && "text-destructive",
          )}
        >
          {content}
        </div>
      </div>
    );
  }

  const body = rows.map((row, rowIndex) => {
    const editing = present(row.editing);
    const hasError = present(row.error);
    const hasDetail = present(row.detail);
    // 一組＝資料列（＋錯誤列）（＋明細列）：下框線只畫在這一組的最後一列；子表的最後一組不畫（由外層明細列畫，spec §2.3）。
    const groupBorder = nested && rowIndex === rows.length - 1 ? undefined : ROW_BORDER;
    const name = rowName(row);
    return (
      <Fragment key={row.id}>
        <div
          role="row"
          aria-labelledby={nameId(row)}
          className={cn(ROW_GRID, editing && "bg-brand-soft", !hasError && !hasDetail && groupBorder)}
        >
          {editing ? (
            <>
              {renderCell(row, ordered[0]!, 0, true)}
              <div role="cell" aria-colspan={ordered.length - 1} className={cn(CELL, "col-[2/-1] py-2.5 pr-3")}>
                <div className="min-w-0 flex-1">{row.editing}</div>
              </div>
            </>
          ) : (
            ordered.map((column, index) => renderCell(row, column, index, false))
          )}
        </div>
        {hasError && (
          <div role="row" aria-label={t("settings.table.rowError", { name })} className={cn("col-span-full", !hasDetail && groupBorder)}>
            <div role="cell" aria-colspan={ordered.length}>
              <div role="alert" className="px-3 pb-2.5 text-xs text-destructive">
                {row.error}
              </div>
            </div>
          </div>
        )}
        {hasDetail && (
          <div role="row" aria-label={t("settings.table.rowDetails", { name })} className={cn("col-span-full", groupBorder)}>
            <div role="cell" aria-colspan={ordered.length} className={DETAIL_CELL}>
              {row.detail}
            </div>
          </div>
        )}
      </Fragment>
    );
  });

  const table = (
    <div
      role="table"
      aria-label={label}
      className="grid grid-cols-(--kb-table-cols) gap-x-3 text-sm"
      style={{ "--kb-table-cols": tracks } as CSSProperties}
    >
      <div role="row" ref={box.headerRowRef} className={cn(ROW_GRID, ROW_BORDER, nested && "sr-only")}>
        {ordered.map((column, index) => (
          <div
            key={column.id}
            id={headerId(column)}
            role="columnheader"
            ref={column.kind === "primary" ? box.stickyHeaderRef : undefined}
            className={cn(
              CELL,
              cellPadding(column.kind, index, ordered.length, true),
              "text-xs text-muted-foreground",
              isSticky(column.kind) && STICKY_CELL,
            )}
          >
            <div className={cn("min-w-0 flex-1 whitespace-nowrap", HEADER_INNER[column.kind])}>
              {column.kind === "actions" ? <span className="sr-only">{column.header}</span> : column.header}
            </div>
          </div>
        ))}
      </div>
      {body}
    </div>
  );

  if (nested) {
    return (
      <div>
        {titleRow}
        {table}
      </div>
    );
  }
  return (
    <div>
      {titleRow}
      <div
        ref={box.boxRef}
        role="region"
        aria-label={label}
        tabIndex={box.tabbable ? 0 : undefined}
        onFocus={(event) => {
          if (event.target === event.currentTarget) box.setFocused(true);
          else box.revealPastSticky(event.target);
        }}
        onBlur={(event) => {
          if (event.target === event.currentTarget) box.setFocused(false);
        }}
        className={SCROLL_BOX}
      >
        {table}
      </div>
    </div>
  );
}
