import { useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { FOLDER_DEPTH_MAX, type FolderDto, type FolderSpaceDto } from "@knotebook/shared";
import { FOLDERS_QUERY_KEY } from "@/api/folders";
import type { FolderDialogRequest } from "@/components/NoteList";
import { toast } from "@/components/ui/toast";
import { placeNoteWithUndo } from "@/lib/note-place";
import { useSidebarTabState, type SidebarTab } from "@/lib/sidebar-tab";
import { isCollapsed, setCollapsed } from "./collapse";
import { destinationShortLabel } from "./destination-level";
import {
  applyDragOver,
  beginDrag,
  endDrag,
  getDragSource,
  setCreating,
  setPreview,
  takeDropZone,
  useDragView,
  type DragView,
  type StackPreviewState,
} from "./drag-session";
import {
  buildDropLookup,
  DRAG_NOTE_MIME,
  DRAG_POINTER_QUERY,
  evaluateDragOver,
  isDragEnabled,
  readDragTarget,
  stackFolderName,
  type DragSource,
  type DragTab,
  type DropLookup,
  type HoldAction,
} from "./drag-zone";
import { expandFolderChain, indexFolders, type FolderIndex, type FolderSpaceKey } from "./folder-index";
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

/** 進行中的拖曳是這一份發起的才清（另一份實例卸載不影響）。 */
function endIfOwner(ownSource: { readonly current: DragSource | null }): void {
  if (ownSource.current !== null && ownSource.current === getDragSource()) endDrag();
}

function spaceDtoOf(space: FolderSpaceKey): FolderSpaceDto {
  if (space === "personal" || space === "shared") return { kind: space };
  return { kind: "group", groupId: space.slice("group:".length) };
}

/** 同層（B 所在那一層）的既有資料夾名：預覽取名與 ① 的撞名重送共用。 */
function siblingNames(index: FolderIndex, space: FolderSpaceKey, parentFolderId: string | null): string[] {
  return index.children(space, parentFolderId).map((folder) => folder.name);
}

export function useSidebarDrag(args: {
  tab: SidebarTab;
  nodes: readonly SidebarNode[] | null;
  groupIds: ReadonlySet<string>;
  folderIndex: FolderIndex;
  /** 疊資料夾建好後開改名框（NoteList 傳現有的那支；opener 為 null，焦點由 stack.focusTarget 決定）。 */
  openFolderDialog: (request: FolderDialogRequest, opener: HTMLElement | null) => void;
}): {
  enabled: boolean;
  /** 掛在 [data-sidebar-list] 容器上。 */
  containerProps: Pick<HTMLAttributes<HTMLDivElement>, "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd">;
  view: DragView;
} {
  const { tab, nodes, groupIds, folderIndex, openFolderDialog } = args;
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
  /** 計時到點時讀的最新 lookup／索引／t：計時起算時捕捉的是舊的 onHold（T3），疊資料夾要以當下的樹重判。 */
  const latestRef = useRef<{ lookup: DropLookup | null; folderIndex: FolderIndex; t: typeof t }>({ lookup, folderIndex, t });
  useEffect(() => {
    latestRef.current = { lookup, folderIndex, t };
  });

  /** 這一份是否還掛著：疊資料夾三發期間抽屜被關，就開不了它的改名框（stackInto）。 */
  const mountedRef = useRef(true);
  // 發起拖曳的這一份在拖曳中卸載（例如抽屜被關）：dragend 送不到 React，卸載時收尾。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      endIfOwner(ownSourceRef);
    };
  }, []);

  /**
   * 計時到點：彈簧＝展開（寫折疊鍵，§6.8；拖曳結束不收回）；疊資料夾＝出預覽（§6.13 第 2 步）。
   * 同一列的 hold 從非 null 變 null 時舊計時照跑（T3）：出預覽前以當下的 lookup 重判 B 仍可疊（可放置、同空間、同一層、深度 < 5）。
   */
  const onHold = (hold: HoldAction) => {
    if (hold.kind === "spring") {
      setCollapsed(`folder:${hold.folderId}`, false);
      return;
    }
    const source = getDragSource();
    const latest = latestRef.current;
    const anchor = latest.lookup?.notes.get(hold.anchorNoteId);
    if (source === null || source !== ownSourceRef.current || anchor === undefined) return;
    if (!anchor.placeable || anchor.space !== source.space || anchor.folderId !== hold.parentFolderId || anchor.folderDepth >= FOLDER_DEPTH_MAX) return;
    setPreview({
      anchorNoteId: hold.anchorNoteId,
      parentFolderId: hold.parentFolderId,
      name: stackFolderName(siblingNames(latest.folderIndex, source.space, hold.parentFolderId), latest.t),
      sourceTitle: source.title,
    });
  };

  /**
   * 第 5–6 步：「建立中」→ 載入流程模組 → 三發（含補償）→ 成功時展開父層、開改名框；改名框關閉後才出成功 toast（stack.onClosed）。
   * instance：發起拖曳的那一份 `[data-sidebar-instance]`，關框時焦點回它裡面的新資料夾列。
   */
  const stackInto = async (source: DragSource, preview: StackPreviewState, instance: Element | null) => {
    setCreating(preview);
    const flow = await import("@/lib/stack-folder").catch(() => null);
    if (flow === null) {
      toast({ title: t("errors.fallback"), variant: "destructive" });
      setCreating(null);
      return;
    }
    const a = { noteId: source.noteId, from: source.folderId };
    const b = { noteId: preview.anchorNoteId, from: preview.parentFolderId };
    let folder: FolderDto | null = null;
    try {
      folder = await flow.runStackFolder({
        a,
        b,
        parent: preview.parentFolderId !== null ? { folderId: preview.parentFolderId } : { space: spaceDtoOf(source.space) },
        firstName: preview.name,
        takenNames: siblingNames(folderIndex, source.space, preview.parentFolderId),
        queryClient,
        t,
      });
    } finally {
      setCreating(null);
    }
    if (folder === null) return;
    const created = folder;
    if (preview.parentFolderId !== null) {
      expandFolderChain(indexFolders(queryClient.getQueryData<FolderDto[]>(FOLDERS_QUERY_KEY) ?? []), preview.parentFolderId);
    }
    // 發起的這一份已卸載（三發期間抽屜被 Esc／外點／跨斷點關掉）：開不了改名框，直接出成功 toast（名稱＝建立時的名字）與「復原」。
    if (!mountedRef.current) {
      flow.showStackCreatedToast({ folderId: created.id, name: created.name, a, b, queryClient, t });
      return;
    }
    openFolderDialog(
      {
        kind: "rename",
        folder: created,
        stack: {
          onClosed: (name) => flow.showStackCreatedToast({ folderId: created.id, name, a, b, queryClient, t }),
          focusTarget: () => instance?.querySelector<HTMLElement>(`[data-node-kind="folder"][data-node-id="${created.id}"] button[aria-expanded]`) ?? null,
        },
      },
      null,
    );
  };

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
    // 預載疊資料夾的流程模組（drop 時才 await）；失敗不處理。
    void import("@/lib/stack-folder").catch(() => undefined);
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
    // 當下的預覽取自這一份 render 的 view，在 takeDropZone 清掉之前讀。
    const preview = view.preview;
    const instance = event.currentTarget.closest("[data-sidebar-instance]");
    ownSourceRef.current = null;
    const zone = takeDropZone();
    if (source === null || zone === null) return;
    if (zone.kind === "stack") {
      if (preview !== null) void stackInto(source, preview, instance);
      return;
    }
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
