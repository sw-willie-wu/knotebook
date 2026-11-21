import "@/i18n/select-strings";
import { memo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { FolderDto, NoteDto } from "@knotebook/shared";
import { RoleBadge } from "@/components/NoteList";
import { ChevronRight, Folder } from "@/components/ui/icons";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { selectionKey } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { cn } from "@/lib/utils";
import { isCollapsed } from "./collapse";
import { GroupRowButton } from "./GroupRowButton";
import { filteredSelectionKeys, visibleSelectionKeys, type SelectableTab } from "./select-model";
import { isFilterCollapsed, useSectionOpen } from "./tag-filter";
import { noteLocationLabel, type LocationContext, type SidebarNode } from "./tree";

/** Import only through the SelectLazy chain and tests. Note rows are `<label>`s; a folder row is a chevron `<button>` plus a `<label>`, since a `<button>` can't live inside a `<label>` (invalid HTML). Collapse shares keys with NoteList via `collapse.ts`. */

type RowVariant = "plain" | "group" | "recent";
type ToggleRow = (key: string, shiftKey: boolean) => void;

/**
 * Firefox doesn't forward a label's click to the checkbox when a modifier is held (left for text selection), so Shift/Ctrl+click on the row text did nothing:
 * with a modifier and a target other than the checkbox, cancel the forward and toggle ourselves (same in all three engines; Chromium/WebKit don't toggle twice).
 */
function onLabelClick(event: ReactMouseEvent<HTMLLabelElement>, key: string, onToggle: ToggleRow): void {
  if (!(event.shiftKey || event.ctrlKey || event.metaKey) || event.target instanceof HTMLInputElement) return;
  event.preventDefault();
  onToggle(key, event.shiftKey);
}

/** memo: ticking a row doesn't re-render others (`note` from query data, `location`/`onToggle` stable); the recents tab computes its location line inside the row so it isn't recomputed per tick. */
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
      {/* select-none: Shift+click on text must not select page text; a label holds only phrasing content, so the two lines are block spans */}
      <label
        className={cn(
          "flex cursor-pointer select-none gap-2 rounded-md px-2 text-[13px]",
          variant === "recent" ? "items-start py-1.5" : "h-11 items-center pointer-fine:h-7",
          checked ? "bg-brand-soft font-medium text-brand-on-soft" : "hover:bg-brand-soft hover:text-brand-on-soft",
        )}
        onClick={(event) => onLabelClick(event, key, onToggle)}
      >
        <SelectionCheckbox
          checked={checked}
          data-selection-key={key}
          // Shift = range; Ctrl/⌘+click is a plain toggle. Ctrl+click on macOS is a right-click and fires no click, hence ⌘.
          onChange={(event) => onToggle(key, (event.nativeEvent as MouseEvent).shiftKey)}
          className={variant === "recent" ? "mt-0.5" : undefined}
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
  /** Tag filtering is on: folders show no checkbox (only notes can be ticked) and open/closed follows the filter, not the saved collapse state. */
  filtered: boolean;
}

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
      <SelectionCheckbox
        checked={checked}
        data-selection-key={key}
        onChange={(event) => onToggle(key, (event.nativeEvent as MouseEvent).shiftKey)}
      />
      <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover/folderrow:text-brand-on-soft" />
      <span className="truncate" title={folder.name}>
        {folder.name}
      </span>
    </label>
  );
});

function SelectableFolderNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "folder" }>; ctx: TreeContext }) {
  const { t } = useTranslation();
  const [open, toggle] = useSectionOpen(`folder:${node.folder.id}`, ctx.filtered, node.children.length > 0);
  return (
    <li data-node-kind="folder" data-node-id={node.folder.id} className="flex flex-col gap-0.5">
      <div className="group/folderrow flex h-11 items-center gap-0.5 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong pointer-fine:h-7">
        <button
          type="button"
          aria-expanded={open}
          aria-label={node.folder.name}
          onClick={toggle}
          className="flex h-full w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground group-hover/folderrow:text-brand-on-soft"
        >
          <ChevronRight aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </button>
        {ctx.filtered ? (
          <span className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1 pr-2 text-[13px] font-medium text-foreground">
            <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate" title={node.folder.name}>
              {node.folder.name}
            </span>
          </span>
        ) : (
          <SelectableFolderLabel folder={node.folder} checked={ctx.keys.has(selectionKey({ kind: "folder", id: node.id }))} onToggle={ctx.onToggle} />
        )}
      </div>
      {open && (
        <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
          {node.children.length === 0 ? (
            <p className="flex h-11 items-center pl-3 text-[11px] text-muted-foreground pointer-fine:h-7">{t("sidebar.folderEmpty")}</p>
          ) : (
            <SelectableNodeList nodes={node.children} ctx={ctx} inGroup />
          )}
        </div>
      )}
    </li>
  );
}

function SelectableGroupNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "group" }>; ctx: TreeContext }) {
  const [open, toggle] = useSectionOpen(`group:${node.group.id}`, ctx.filtered, node.children.length > 0);
  return (
    <li data-node-kind="group" data-node-id={node.group.id} className="flex flex-col gap-0.5">
      <div className="group/grouprow flex h-11 items-center gap-0.5 pointer-fine:h-7 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong">
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
            variant={inGroup ? "group" : ctx.tab === "recent" || ctx.tab === "favorites" ? "recent" : "plain"}
            checked={ctx.keys.has(selectionKey({ kind: "note", id: node.id }))}
            onToggle={ctx.onToggle}
            location={ctx.location}
          />
        ),
      )}
    </ul>
  );
}

export function SelectableTree({
  nodes,
  tab,
  location,
  filtered = false,
}: {
  nodes: readonly SidebarNode[];
  tab: SelectableTab;
  location: LocationContext;
  filtered?: boolean;
}) {
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  // Stable (`nodes` is memoised by NoteList and changes only on refetch): the select rows' memo relies on it. Shift ranges use the visible order at press time (folder rows count, collapsed subtrees skipped).
  const onToggle = useCallback<ToggleRow>(
    (key, shiftKey) => {
      if (!shiftKey) return updateSelection({ type: "toggle", key });
      const order = filtered ? filteredSelectionKeys(nodes, isFilterCollapsed) : visibleSelectionKeys(nodes, isCollapsed);
      updateSelection({ type: "range", key, order });
    },
    [nodes, filtered, updateSelection],
  );
  return <SelectableNodeList nodes={nodes} ctx={{ tab, keys: selection.keys, onToggle, location, filtered }} />;
}
