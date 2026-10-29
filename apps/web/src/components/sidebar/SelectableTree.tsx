import "@/i18n/select-strings";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { RoleBadge } from "@/components/NoteList";
import { selectionKey } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { cn } from "@/lib/utils";
import { isCollapsed, useCollapsed } from "./collapse";
import { FolderRowButton } from "./FolderRowButton";
import { GroupRowButton } from "./GroupRowButton";
import { visibleNoteKeys, type SelectableTab } from "./select-model";
import { noteLocationLabel, type LocationContext, type SidebarNode } from "./tree";

/**
 * 一般 tab 選取模式的勾選樹（#181 PR-2c，spec §6.11、§6.10.2）：取代 NoteList 的清單內容（捲動容器不換）。
 * 筆記列整列是 `<label>`＋勾選框，不是連結、沒有 ⋮；工作坊的群組列與資料夾列只有折疊主鈕（與 NoteList 共用 `collapse.ts` 的同一把鍵），
 * 不可勾、沒有「＋」與 ⋮（資料夾列在 PR-3b-2 換成可勾）。只准經 `SelectLazy` 引用。
 */

type RowVariant = "plain" | "group" | "recent";
type ToggleRow = (key: string, shiftKey: boolean) => void;

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
        // Firefox 有修飾鍵時不把 label 的 click 轉給勾選框（留給文字選取），Shift／Ctrl＋點列文字會沒反應：有修飾鍵且點的不是
        // 勾選框本身時，取消轉送、自己切換（三引擎一致；Chromium／WebKit 不會因此切兩次）。
        onClick={(event) => {
          if (!(event.shiftKey || event.ctrlKey || event.metaKey) || event.target instanceof HTMLInputElement) return;
          event.preventDefault();
          onToggle(key, event.shiftKey);
        }}
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

/** 資料夾列：與群組列同形，只有折疊主鈕（同一把 `folder:` 鍵），不可勾（PR-3b-2 換成可勾）。 */
function SelectableFolderNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "folder" }>; ctx: TreeContext }) {
  const { t } = useTranslation();
  const [open, toggle] = useCollapsed(`folder:${node.folder.id}`);
  return (
    <li data-node-kind="folder" data-node-id={node.folder.id} className="flex flex-col gap-0.5">
      <div className="group/folderrow flex h-11 items-center gap-0.5 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong md:h-7">
        <FolderRowButton name={node.folder.name} open={open} onToggle={toggle} />
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
  // 穩定（`nodes` 由 NoteList memo，清單重抓才換）：選取列的 memo 靠它。Shift 範圍以按下當下的可見序計（收合子樹跳過）。
  const onToggle = useCallback<ToggleRow>(
    (key, shiftKey) => updateSelection(shiftKey ? { type: "range", key, order: visibleNoteKeys(nodes, isCollapsed) } : { type: "toggle", key }),
    [nodes, updateSelection],
  );
  return <SelectableNodeList nodes={nodes} ctx={{ tab, keys: selection.keys, onToggle, location }} />;
}
