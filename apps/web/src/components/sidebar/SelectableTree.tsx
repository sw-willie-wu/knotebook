import "@/i18n/select-strings";
import { memo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { FolderDto, NoteDto } from "@knotebook/shared";
import { RoleBadge } from "@/components/NoteList";
import { ChevronRight, Folder } from "@/components/ui/icons";
import { selectionKey } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { cn } from "@/lib/utils";
import { isCollapsed, useCollapsed } from "./collapse";
import { GroupRowButton } from "./GroupRowButton";
import { visibleSelectionKeys, type SelectableTab } from "./select-model";
import { noteLocationLabel, type LocationContext, type SidebarNode } from "./tree";

/**
 * 一般 tab 選取模式的勾選樹（#181 PR-2c，spec §6.11、§6.10.2；資料夾 spec §6.10）：取代 NoteList 的清單內容（捲動容器不換）。
 * 筆記列整列是 `<label>`＋勾選框，不是連結、沒有 ⋮。資料夾列＝折疊 chevron 鈕＋`<label>`（勾選框、資料夾圖示、名稱）：
 * `<button>` 不放進 `<label>`（無效 HTML，spec 缺陷 S2），沒有「＋」與 ⋮。群組 tab 的群組列只有折疊主鈕、不可勾。
 * 折疊與 NoteList 共用 `collapse.ts` 的同一把鍵。只准經 `SelectLazy` 引用。
 */

type RowVariant = "plain" | "group" | "recent";
type ToggleRow = (key: string, shiftKey: boolean) => void;

/**
 * Firefox 有修飾鍵時不把 label 的 click 轉給勾選框（留給文字選取），Shift／Ctrl＋點列文字會沒反應：有修飾鍵且點的不是
 * 勾選框本身時，取消轉送、自己切換（三引擎一致；Chromium／WebKit 不會因此切兩次）。筆記列與資料夾列共用。
 */
function onLabelClick(event: ReactMouseEvent<HTMLLabelElement>, key: string, onToggle: ToggleRow): void {
  if (!(event.shiftKey || event.ctrlKey || event.metaKey) || event.target instanceof HTMLInputElement) return;
  event.preventDefault();
  onToggle(key, event.shiftKey);
}

/**
 * memo：勾一列時其他列不重繪（plan gate r1 I2）——`note` 來自查詢資料、`location`／`onToggle` 由上層穩定；
 * 最近 tab 的位置行在列內算，才不會每次勾選都替每一列重算。
 */
const SelectableNoteRow = memo(function SelectableNoteRow({
  note,
  variant,
  checked,
  onToggle,
  location,
}: {
  note: NoteDto;
  variant: RowVariant;
  checked: boolean;
  onToggle: ToggleRow;
  location: LocationContext;
}) {
  const { t } = useTranslation();
  const key = selectionKey({ kind: "note", id: note.id });
  const label = variant === "recent" ? noteLocationLabel(note, location, t) : "";
  return (
    <li data-node-kind="note" data-node-id={note.id}>
      {/* select-none：Shift＋點文字時不順帶選取頁面文字。label 內只能放 phrasing content，兩行用 block span。 */}
      <label
        className={cn(
          "flex cursor-pointer select-none gap-2 rounded-md px-2 text-[13px]",
          variant === "recent" ? "items-start py-1.5" : "h-11 items-center md:h-7",
          checked ? "bg-brand-soft font-medium text-brand-on-soft" : "hover:bg-brand-soft hover:text-brand-on-soft",
        )}
        onClick={(event) => onLabelClick(event, key, onToggle)}
      >
        <input
          type="checkbox"
          checked={checked}
          data-selection-key={key}
          // Shift＝範圍；Ctrl／⌘＋點與一般點選相同（單列切換）。macOS 的 Ctrl＋點是右鍵、不產生 click，用 ⌘。
          onChange={(event) => onToggle(key, (event.nativeEvent as MouseEvent).shiftKey)}
          className={cn("h-4 w-4 shrink-0 accent-brand", variant === "recent" && "mt-0.5")}
        />
        {variant === "recent" ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate">{note.title}</span>
            <span className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground" title={label}>
              {label}
            </span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{note.title}</span>
        )}
        {variant !== "recent" && <RoleBadge role={note.role} group={note.group} />}
      </label>
    </li>
  );
});

interface TreeContext {
  tab: SelectableTab;
  keys: ReadonlySet<string>;
  onToggle: ToggleRow;
  location: LocationContext;
}

/**
 * 資料夾列的勾選部分（勾選框＋資料夾圖示＋名稱）。memo 同筆記列：勾一列時其他列不重繪——`folder` 來自查詢資料、`onToggle` 由上層穩定。
 */
const SelectableFolderLabel = memo(function SelectableFolderLabel({
  folder,
  checked,
  onToggle,
}: {
  folder: FolderDto;
  checked: boolean;
  onToggle: ToggleRow;
}) {
  const key = selectionKey({ kind: "folder", id: folder.id });
  return (
    <label
      className={cn(
        "flex h-full min-w-0 flex-1 cursor-pointer select-none items-center gap-1.5 rounded-md pr-2 pl-1 text-[13px] font-medium",
        checked ? "bg-brand-soft text-brand-on-soft" : "text-foreground group-hover/folderrow:text-brand-on-soft",
      )}
      onClick={(event) => onLabelClick(event, key, onToggle)}
    >
      <input
        type="checkbox"
        checked={checked}
        data-selection-key={key}
        onChange={(event) => onToggle(key, (event.nativeEvent as MouseEvent).shiftKey)}
        className="h-4 w-4 shrink-0 accent-brand"
      />
      <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover/folderrow:text-brand-on-soft" />
      <span className="truncate" title={folder.name}>
        {folder.name}
      </span>
    </label>
  );
});

/**
 * 資料夾列：［折疊 chevron 鈕］［label：勾選框＋圖示＋名稱］。chevron 鈕的可及名稱＝資料夾名（§6.14；圖示 `aria-hidden`），
 * 點它只收合／展開、不勾；點 label 才勾（勾資料夾不連帶勾子項，§6.10）。
 */
function SelectableFolderNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "folder" }>; ctx: TreeContext }) {
  const { t } = useTranslation();
  const [open, toggle] = useCollapsed(`folder:${node.folder.id}`);
  return (
    <li data-node-kind="folder" data-node-id={node.folder.id} className="flex flex-col gap-0.5">
      <div className="group/folderrow flex h-11 items-center gap-0.5 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong md:h-7">
        <button
          type="button"
          aria-expanded={open}
          aria-label={node.folder.name}
          onClick={toggle}
          className="flex h-full w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground group-hover/folderrow:text-brand-on-soft"
        >
          <ChevronRight aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <SelectableFolderLabel folder={node.folder} checked={ctx.keys.has(selectionKey({ kind: "folder", id: node.id }))} onToggle={ctx.onToggle} />
      </div>
      {open && (
        <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
          {node.children.length === 0 ? (
            <p className="flex h-11 items-center pl-3 text-[11px] text-muted-foreground md:h-7">{t("sidebar.folderEmpty")}</p>
          ) : (
            <SelectableNodeList nodes={node.children} ctx={ctx} inGroup />
          )}
        </div>
      )}
    </li>
  );
}

function SelectableGroupNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "group" }>; ctx: TreeContext }) {
  const [open, toggle] = useCollapsed(`group:${node.group.id}`);
  return (
    <li data-node-kind="group" data-node-id={node.group.id} className="flex flex-col gap-0.5">
      <div className="group/grouprow flex h-7 items-center gap-0.5 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong">
        <GroupRowButton name={node.group.name} open={open} onToggle={toggle} />
      </div>
      {open && (
        <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
          <SelectableNodeList nodes={node.children} ctx={ctx} inGroup />
        </div>
      )}
    </li>
  );
}

function SelectableNodeList({ nodes, ctx, inGroup = false }: { nodes: readonly SidebarNode[]; ctx: TreeContext; inGroup?: boolean }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) =>
        node.kind === "group" ? (
          <SelectableGroupNode key={node.id} node={node} ctx={ctx} />
        ) : node.kind === "folder" ? (
          <SelectableFolderNode key={node.id} node={node} ctx={ctx} />
        ) : (
          <SelectableNoteRow
            key={node.id}
            note={node.note}
            variant={inGroup ? "group" : ctx.tab === "recent" ? "recent" : "plain"}
            checked={ctx.keys.has(selectionKey({ kind: "note", id: node.id }))}
            onToggle={ctx.onToggle}
            location={ctx.location}
          />
        ),
      )}
    </ul>
  );
}

export function SelectableTree({ nodes, tab, location }: { nodes: readonly SidebarNode[]; tab: SelectableTab; location: LocationContext }) {
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  // 穩定（`nodes` 由 NoteList memo，清單重抓才換）：選取列的 memo 靠它。Shift 範圍以按下當下的可見序計（資料夾列算、收合子樹跳過）。
  const onToggle = useCallback<ToggleRow>(
    (key, shiftKey) => updateSelection(shiftKey ? { type: "range", key, order: visibleSelectionKeys(nodes, isCollapsed) } : { type: "toggle", key }),
    [nodes, updateSelection],
  );
  return <SelectableNodeList nodes={nodes} ctx={{ tab, keys: selection.keys, onToggle, location }} />;
}
