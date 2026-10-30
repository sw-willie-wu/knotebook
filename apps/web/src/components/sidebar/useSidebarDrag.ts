import { useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { placeNoteWithUndo } from "@/lib/note-place";
import { useSidebarTabState, type SidebarTab } from "@/lib/sidebar-tab";
import { isCollapsed, setCollapsed } from "./collapse";
import { destinationShortLabel } from "./destination-level";
import { applyDragOver, beginDrag, endDrag, getDragSource, takeDropZone, useDragView, type DragView } from "./drag-session";
import {
  buildDropLookup,
  DRAG_NOTE_MIME,
  DRAG_POINTER_QUERY,
  evaluateDragOver,
  isDragEnabled,
  readDragTarget,
  type DragSource,
  type DragTab,
  type HoldAction,
} from "./drag-zone";
import type { FolderIndex } from "./folder-index";
import type { SidebarNode } from "./tree";

/**
 * 側欄拖曳的接線（資料夾 spec §6.13；PR-3c T4）：掛在 `[data-sidebar-list]` 容器上的事件委派。
 * 「啟用」＝容器的 dragstart 是否接手（寫自訂型別、開拖曳狀態）；不接手時原生連結拖曳照現行（讀碼發現 6）。
 * 首包模組：不 import 字串包。
 */

/** 落點範圍提示：比 `bg-brand-soft` 更淡的主色底＋主色外框（spec §6.13、§6.14；T4 Step 6 量過六色 × 淺深）。 */
export const DROP_SCOPE_CLASS = "bg-brand/8 ring-1 ring-inset ring-brand";

/** `(hover: hover) and (pointer: fine)`；訂閱 change（比照 GroupTransfer 的 useInlineGroupList）。 */
export function useFinePointer(): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DRAG_POINTER_QUERY).matches;
  const [fine, setFine] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(DRAG_POINTER_QUERY);
    const onChange = () => setFine(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return fine;
}

function dragTabOf(tab: SidebarTab): DragTab | null {
  return tab === "myNotes" || tab === "workspace" || tab === "shared" ? tab : null;
}

/** 計時到點：彈簧＝展開（寫折疊鍵，§6.8；拖曳結束不收回）；疊資料夾在 T5。模組層函式：計時起算時被捕捉，不依賴 render 的值。 */
function onHold(hold: HoldAction): void {
  if (hold.kind === "spring") setCollapsed(`folder:${hold.folderId}`, false);
}

/** 進行中的拖曳是這一份發起的才清（另一份實例卸載不影響）。 */
function endIfOwner(ownSource: { readonly current: DragSource | null }): void {
  if (ownSource.current !== null && ownSource.current === getDragSource()) endDrag();
}

export function useSidebarDrag(args: {
  tab: SidebarTab;
  nodes: readonly SidebarNode[] | null;
  groupIds: ReadonlySet<string>;
  folderIndex: FolderIndex;
}): {
  enabled: boolean;
  /** 掛在 [data-sidebar-list] 容器上。 */
  containerProps: Pick<HTMLAttributes<HTMLDivElement>, "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd">;
  view: DragView;
} {
  const { tab, nodes, groupIds, folderIndex } = args;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selection } = useSidebarTabState();
  const finePointer = useFinePointer();
  const view = useDragView();
  /** 這一份實例發起的拖曳來源：與 getDragSource() 是同一個物件才驅動 dragover（靜態卡與抽屜的另一份不動）。 */
  const ownSourceRef = useRef<DragSource | null>(null);
  const dragTab = dragTabOf(tab);
  // groupIds 與建樹的 groups 同源（NoteList 的 groupsQuery.data）。
  const lookup = useMemo(() => (nodes === null || dragTab === null ? null : buildDropLookup(nodes, dragTab, groupIds)), [nodes, dragTab, groupIds]);
  const enabled = isDragEnabled({ finePointer, tab, selectionActive: selection.active, creating: view.creating !== null, nodesReady: nodes !== null });

  // 發起拖曳的這一份在拖曳中卸載（例如抽屜被關）：dragend 送不到 React，卸載時收尾。
  useEffect(() => () => endIfOwner(ownSourceRef), []);

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (!enabled || lookup === null) return;
    const container = event.currentTarget;
    const row = event.target instanceof Element ? event.target.closest('[data-node-kind="note"]') : null;
    if (row === null || !container.contains(row)) return;
    const noteId = row.getAttribute("data-node-id");
    const entry = noteId === null ? undefined : lookup.notes.get(noteId);
    // placeable＝canDragNote（buildDropLookup 依樹上的空間算）。
    if (noteId === null || entry === undefined || !entry.placeable) return;
    // 只加自訂型別、不清原生資料；effectAllowed 保留 copy／link 再加 move（總管裁定 2026-10-30 Q4）。
    event.dataTransfer.setData(DRAG_NOTE_MIME, noteId);
    event.dataTransfer.effectAllowed = "all";
    const source: DragSource = { noteId, space: entry.space, folderId: entry.folderId, title: entry.title };
    ownSourceRef.current = source;
    beginDrag(source, container);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    const source = getDragSource();
    if (source === null || source !== ownSourceRef.current || lookup === null || dragTab === null) return;
    if (!Array.from(event.dataTransfer.types).includes(DRAG_NOTE_MIME)) return;
    const result = evaluateDragOver({
      source,
      target: readDragTarget(event.target, event.currentTarget),
      lookup,
      tab: dragTab,
      isCollapsed: (folderId) => isCollapsed(`folder:${folderId}`),
      previewAnchor: view.preview?.anchorNoteId ?? null,
    });
    if (!applyDragOver(result, onHold)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  // drop 一律 preventDefault（列是 <a>，Firefox 不取消會導航）；狀態與標示在這裡就清（樂觀更新會讓來源列卸載，之後的 dragend 不保證收得到）。
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const source = getDragSource();
    ownSourceRef.current = null;
    const zone = takeDropZone();
    if (source === null || zone === null || zone.kind !== "place") return;
    // 落點來自同一份索引建的樹；索引在拖曳中被重抓掉的話，server 會回 404（回滾＋錯誤 toast），名稱用不到。
    const folder = zone.folderId === null ? null : (folderIndex.byId.get(zone.folderId) ?? null);
    void placeNoteWithUndo({
      noteId: source.noteId,
      from: source.folderId,
      to: { folderId: zone.folderId, name: destinationShortLabel(folder, t) },
      index: folderIndex,
      queryClient,
      t,
      optimistic: true,
    });
  };

  const onDragEnd = () => {
    ownSourceRef.current = null;
    endDrag();
  };

  return { enabled, containerProps: { onDragStart, onDragOver, onDrop, onDragEnd }, view };
}
