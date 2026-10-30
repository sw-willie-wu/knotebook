import "@/i18n/select-strings";
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { folderErrorMessage, invalidateFolderRelated, isFolderNotFound, useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { isTerminal } from "@/collab/connection";
import { useNotePageControls } from "@/lib/note-page-controls";
import {
  copyNotesInOrder,
  deleteTargetsInOrder,
  moveNotesInOrder,
  placeTargetsInOrder,
  undoPlacements,
  type BatchOutcome,
  type PlacedItem,
} from "@/lib/select-batch";
import { selectionKey, SIDEBAR_SELECT_BUTTON } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { showTrashedToast } from "@/lib/trash-undo";
import { Button } from "@/components/ui/button";
import { Copy, FolderInput, Trash } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import {
  buildDestinationLevel,
  destinationPathLabel,
  destinationShortLabel,
  isEmptyDestination,
  livePath,
  type DestMode,
  type DestPathStep,
  type DestSpace,
  type DestTarget,
} from "./destination-level";
import { DestinationPickerDialog } from "./DestinationPickerDialog";
import { CopyConfirmDialog, DeleteFoldersConfirmDialog, MoveConfirmDialog } from "./select-dialogs";
import {
  batchDestSource,
  dedupeByAncestor,
  isSameSpace,
  partitionTargets,
  SELECT_ACTIONS,
  selectedTargets,
  selectionResultTitle,
  type Eligibility,
  type SelectableTab,
  type SelectionTarget,
} from "./select-model";
import { beginSelectRun, endSelectRun, updateSelectRun, useSelectRun } from "./select-run";
import { expandFolderChain, indexFolders, liveNotesUnder, type FolderIndex } from "./folder-index";
import { useFolderSortOf } from "./folder-sort";
import { buildTabNodes, noteSpaceKey } from "./tree";

/**
 * 一般 tab 選取模式的動作列（#181 PR-2c，spec §6.11；資料夾 spec §6.10）。只准經 `SelectLazy` 引用。
 * - 動作表（`SELECT_ACTIONS`）：我的筆記、工作坊、與我共享「移動到／複製到／刪除」，最近「複製到／刪除」；與我共享的刪除鈕＝「移除選取的資料夾」，
 *   只在選取（去重後）非空且全是資料夾時才渲染。
 * - 選取（資料夾與筆記同列）：`selectedTargets` → `dedupeByAncestor`（祖先也被選的不送、不算略過）→ 依動作 `partitionTargets` 預先排除
 *   （排除的不送、算進結果句的略過）。一項都做不了就 disabled；不出「0 項」toast。
 * - 移動到：目的地框一次一層（`buildDestinationLevel`；path 本元件持有、開框重設；換層一律從 `livePath` 接，不看 path.length）。
 *   工作坊選取分屬多個群組、或第一層為空（`isEmptyDestination`）→ disabled。選定後：同空間（`isSameSpace`）不確認、`placeTargetsInOrder`、
 *   結果 toast 帶「復原」（`undoPlacements`，依序送回原處；停下報已移回幾項）、目標資料夾展開；跨空間（只會是我的筆記 → 群組）先
 *   `MoveConfirmDialog`（完整路徑）→ `moveNotesInOrder`，沒有復原。
 * - 複製到：選了資料夾 → disabled（D14）；選定後一律先 `CopyConfirmDialog` → `copyNotesInOrder`。
 * - 刪除：含資料夾 → 先開彙總確認框（開框那一刻快照篇數）→ `deleteTargetsInOrder`（資料夾先、筆記後）；只有筆記 → 不確認（D-W7）。
 *   與我共享 tab 是「移除」：一般 toast、沒有復原。
 * - 執行：依序呼叫單篇端點（`lib/select-batch.ts`）；403／404 `not_found` 略過、其餘停下。停下後留在選取、只留下還沒處理的
 *   （Willie 裁定 Q4）；成功離開選取。結果一則 toast；停在 404 `folder_not_found` 另失效資料夾快取。
 * - 快照（讀碼發現 19）：目的地選定那一刻記下要送的項與篇數，確認框與執行都用它（送出中清單重抓，篇數不會倒數）。
 * - 焦點交接（讀碼發現 18）：選了目的地，目的地框不還焦點、交給確認框自己的自動聚焦（同空間沒有確認框，由收尾處理）；取消才還給開框鈕。
 *   確認框送出後開到批次結束（進行中忽略所有關閉要求）；收尾的焦點只在焦點仍在本實例、確認框內或 body 時才搬（同 `TrashFooter.finish`）。
 * - 進行中：執行狀態在 provider 層的 `select-run` store，所有動作列（含重開抽屜、Done→Select 後新掛的）都顯示進度、三顆鈕 disabled。
 *   選取結果只在 session 沒換時套用（抽屜關掉、動作列卸載也照套；使用者中途結束又重開就不覆蓋新的選取）。
 * - 開著的那篇（讀碼發現 11）：直接選的排到筆記段最後；在某個要刪的**個人／群組**資料夾子樹裡 → 那個資料夾排到資料夾段最後。送它前設
 *   NotePage 的 `leavingRef`；成功導回首頁、「復原」導回它；失敗非終態撥回、終態導回首頁（不補單篇路徑的 `note.deleted` toast：批次只出一則）。
 *   與我共享的移除不設、不離場（讀碼發現 10：筆記只是回最上層）。
 * - §6.10.7：整批都能自己還原才帶「復原」（`showTrashedToast`；資料夾帶走的篇併進 `undoIds`），否則帶說明句。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;
type PlaceTarget = Extract<DestTarget, { kind: "place" }>;
type Stopped = BatchOutcome<unknown>["stopped"];

/**
 * 「移動到」「複製到」：側欄最窄 200px（卡片內約 182px）也要和 36px 的刪除鈕排進同一列——`min-w-0` 讓 flex 子項能縮到比內容窄、
 * `px-1.5 gap-1.5` 省寬、字 `truncate`（DOM 裡仍是全文，可及名稱不受影響；`title` 給看得到截字的人）。不加的話刪除鈕會被擠出卡片、
 * 落到側欄寬度把手底下（T5 review r1 I1，真 Chromium 量測）。按鈕列是 `@container`：列寬不到 14.5rem（字級 16 時側欄約 250px 以下）時拿掉
 * 兩顆的圖示，把位置讓給字（實測帶圖示時 en 要列寬 ≥ 14rem 才不截字，字級 16、20 皆同；多留 0.5rem）。
 */
const ACTION_TEXT_BUTTON = "min-w-0 flex-1 gap-1.5 px-1.5";
const ACTION_ICON = "hidden h-4 w-4 shrink-0 @min-[14.5rem]:block";

const NO_SKIPS: Eligibility = { eligible: [], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 };

const isFolder = (target: SelectionTarget): boolean => target.kind === "folder";
const notesOf = (targets: readonly SelectionTarget[]): NoteDto[] => targets.flatMap((target) => (target.kind === "note" ? [target.note] : []));

/** 預先排除＋server 略過 → 結果句的略過數；資料夾依錯誤碼分：`folder_delete_blocked`→擋下、`folder_not_found`→已不在、其他→略過。 */
function skippedCounts(pre: Eligibility, skippedDetail: BatchOutcome<unknown>["skippedDetail"]) {
  const out = { notesSkipped: pre.notesSkipped, foldersSkipped: pre.foldersSkipped, foldersBlocked: pre.foldersBlocked, foldersGone: 0 };
  for (const { node, err } of skippedDetail) {
    if (node.kind === "note") out.notesSkipped += 1;
    else if (err instanceof ApiFail && err.code === "folder_delete_blocked") out.foldersBlocked += 1;
    else if (isFolderNotFound(err)) out.foldersGone += 1;
    else out.foldersSkipped += 1;
  }
  return out;
}

/** 停下的 toast：標題＝錯誤句、描述＝已完成幾項（`items`：同空間放置、或刪除含資料夾時「項」；否則「篇」）。 */
function stoppedCopy(t: Translate, stopped: Stopped, done: number, items: boolean): { title: string; description: string } | null {
  if (stopped === null) return null;
  return { title: folderErrorMessage(t, stopped.cause), description: t(items ? "select.stoppedAfterItems" : "select.stoppedAfter", { count: done }) };
}

/**
 * 同空間批次的「復原」（D18 ③）：依序送回原處；全部成功不另出 toast（清單即時歸位），停下 → 錯誤 toast＋已移回幾項。
 * toast 的 handler 只用參數捕捉的值：按「復原」時動作列常已卸載（同 `lib/trash-undo.ts`）。
 */
async function undoBatchPlacement(done: readonly PlacedItem[], queryClient: QueryClient, t: Translate): Promise<void> {
  const outcome = await undoPlacements(done, { queryClient });
  if (outcome.stopped === null) return;
  toast({
    title: folderErrorMessage(t, outcome.stopped.cause),
    description: t("select.undoStopped", { count: outcome.done.length }),
    variant: "destructive",
  });
}

/** 確認框的快照（目的地選定、或按下刪除那一刻）。 */
type Confirm =
  | { kind: "move"; target: PlaceTarget; groupId: string; pathLabel: string; notes: NoteDto[]; pre: Eligibility }
  | { kind: "copy"; target: DestTarget; pathLabel: string; notes: NoteDto[]; copySource: DestSpace | null }
  | { kind: "delete"; items: SelectionTarget[]; pre: Eligibility; folderCount: number; noteCount: number; alsoNotes: number; shared: boolean };

interface RunResult {
  stopped: Stopped;
  /** 選取結果套用之後才跑（導回首頁）。 */
  afterSelection?: () => void;
}

export function SelectActionBar() {
  const { t } = useTranslation();
  const { tab: currentTab, selection } = useSidebarTabState();
  const actions = useSidebarTabActions();
  const { updateSelection, getSelectionSession } = actions;
  const notesQuery = useNotes();
  const groupsQuery = useGroups();
  const foldersQuery = useFolders();
  const sortOf = useFolderSortOf();
  // 與畫面上的樹同序（讀碼發現 7：批次依樹序送出）。
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const controls = useNotePageControls();
  // 批次的 hook 在卸載、換頁後才可能跑到：一律讀最新那份（`?.`，hook 不得丟例外）。
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const run = useSelectRun(actions);
  // SidebarFooter 只在一般 tab 掛本元件。
  const tab = currentTab as SelectableTab;
  const acrossGroupsId = useId();
  const cantCopyId = useId();

  const [pickerMode, setPickerMode] = useState<DestMode | null>(null);
  /** 目的地框目前這一層的路徑（開框重設）。 */
  const [path, setPath] = useState<readonly DestPathStep[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /** 目的地框關閉時：選了（交給確認框或收尾）還是取消（還給開框鈕）。 */
  const pickedRef = useRef(false);
  /** 確認框關閉時：送出過（焦點由收尾處理）還是取消。 */
  const submittedRef = useRef(false);
  const confirmContentRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const groups = groupsQuery.data;
  const nodes = useMemo(
    () =>
      notesQuery.isSuccess && (tab !== "workspace" || groups !== undefined)
        ? buildTabNodes(tab, notesQuery.data, groups ?? [], folderIndex, sortOf)
        : null,
    [tab, notesQuery.isSuccess, notesQuery.data, groups, folderIndex, sortOf],
  );
  const groupIds = useMemo<ReadonlySet<string>>(() => new Set((groups ?? []).map((group) => group.id)), [groups]);
  const notes = notesQuery.data ?? [];
  const spaceOf = (note: NoteDto) => noteSpaceKey(note, groupIds);
  const targets = nodes === null ? [] : selectedTargets(nodes, selection.keys);
  const deduped = dedupeByAncestor(targets, folderIndex);
  const ctx = { tab, index: folderIndex, notes, groupIds };
  const moveElig = partitionTargets("move", deduped, ctx);
  const copyElig = partitionTargets("copy", deduped, ctx);
  const deleteElig = partitionTargets("delete", deduped, ctx);
  const sourceFor = (mode: DestMode) =>
    batchDestSource({ tab, mode, eligible: (mode === "move" ? moveElig : copyElig).eligible, groups: groups ?? [], groupIds });
  const moveSource = sourceFor("move");
  /** 第一層要的群組清單到了沒（與我共享的「移動到」只有共享私人資料夾，不等群組）。 */
  const levelReady = (mode: DestMode) => groups !== undefined || (mode === "move" && tab === "shared");
  const busy = run !== null;
  const available = SELECT_ACTIONS[tab];

  /** 焦點仍在本實例、確認框內或 body（被按的鈕已 disabled／確認框已卸載）才搬；等待期間使用者已移到別處就不搶。 */
  function mayReclaimFocus(shell: Element | null, confirmEl: Element | null): boolean {
    if (!mountedRef.current) return false;
    const active = document.activeElement;
    return active === null || active === document.body || shell?.contains(active) === true || confirmEl?.contains(active) === true;
  }

  /** 一輪批次的共用收尾：鎖、選取結果（只看 session）、確認框、焦點。`execute` 跑批次並出結果 toast。 */
  async function runBatch(input: {
    total: number;
    opener: HTMLElement | null;
    fromConfirm: boolean;
    execute: (onProgress: (processed: number) => void) => Promise<RunResult>;
  }): Promise<void> {
    const { total, opener, fromConfirm, execute } = input;
    if (!beginSelectRun(actions, total)) return;
    submittedRef.current = fromConfirm;
    const session = getSelectionSession();
    const shell = opener?.closest("[data-sidebar-instance]") ?? null;
    let focusTo: "select" | "opener" | null = null;
    try {
      const { stopped, afterSelection } = await execute((processed) => updateSelectRun(actions, processed));
      // 明選的資料夾（或要搬的資料夾）已不在：樹要重抓（spec §6.15）。
      if (stopped !== null && isFolderNotFound(stopped.cause)) invalidateFolderRelated(queryClient);
      // 守衛在選取結果套用前判斷（成功會結束選取、本元件隨之卸載）；搬焦點在收尾之後（確認框已關、開框鈕已恢復可用）。
      if (mayReclaimFocus(shell, confirmContentRef.current)) focusTo = stopped ? "opener" : "select";
      // 選取結果只看 session、不看掛載（抽屜關掉照套；中途結束又重開就不覆蓋新的那輪）。
      if (getSelectionSession() === session) {
        flushSync(() => updateSelection(stopped ? { type: "setAll", keys: stopped.remaining.map(selectionKey) } : { type: "end" }));
      }
      afterSelection?.();
    } finally {
      flushSync(() => {
        setConfirmOpen(false);
        endSelectRun(actions);
      });
    }
    if (focusTo === "select") shell?.querySelector<HTMLButtonElement>(SIDEBAR_SELECT_BUTTON)?.focus();
    else if (focusTo === "opener" && opener?.isConnected) opener.focus();
  }

  /** 同空間（進資料夾、回根目錄）：不確認；結果 toast 帶「復原」；正向移動成功後展開目標資料夾（比照 ⋮，M9）。 */
  function runPlace(target: PlaceTarget, items: SelectionTarget[], pre: Eligibility, index: FolderIndex, opener: HTMLElement | null): void {
    const folderId = target.folder?.id ?? null;
    void runBatch({
      total: items.length,
      opener,
      fromConfirm: false,
      execute: async (onProgress) => {
        const outcome = await placeTargetsInOrder(items, folderId, { queryClient, onProgress });
        const { done, stopped } = outcome;
        if (done.length > 0 && folderId !== null) expandFolderChain(index, folderId);
        const title = selectionResultTitle(
          {
            action: "move",
            tab,
            notesDone: done.filter((item) => item.kind === "note").length,
            foldersDone: done.filter((item) => item.kind === "folder").length,
            trashedViaFolders: 0,
            ...skippedCounts(pre, outcome.skippedDetail),
            destinationName: destinationShortLabel(target.folder, t),
            sameSpace: true,
            destination: target,
            copySource: null,
          },
          t,
        );
        // 同空間的結果句一律以「項」計（movedItems）：停下的描述也用「項」，只有筆記也一樣。
        const halted = stoppedCopy(t, stopped, done.length, true);
        toast({
          title: halted?.title ?? title,
          description: halted?.description,
          variant: stopped || done.length === 0 ? "destructive" : "default",
          action: done.length === 0 ? undefined : { label: t("trash.undo"), onClick: () => void undoBatchPlacement(done, queryClient, t) },
        });
        return { stopped };
      },
    });
  }

  /** 我的筆記 → 群組（根層或資料夾）：確認後逐篇 `POST /move`；沒有復原（現行）。 */
  function runMove(snapshot: Extract<Confirm, { kind: "move" }>): void {
    const { target, groupId, pathLabel, notes: items, pre } = snapshot;
    void runBatch({
      total: items.length,
      opener: openerRef.current,
      fromConfirm: true,
      execute: async (onProgress) => {
        const body = target.folder === null ? { groupId } : { groupId, folderId: target.folder.id };
        const outcome = await moveNotesInOrder(items, body, { queryClient, onProgress });
        const { done, stopped } = outcome;
        const title = selectionResultTitle(
          {
            action: "move",
            tab,
            notesDone: done.length,
            foldersDone: 0,
            trashedViaFolders: 0,
            ...skippedCounts(pre, outcome.skippedDetail),
            destinationName: pathLabel,
            sameSpace: false,
            destination: target,
            copySource: null,
          },
          t,
        );
        const halted = stoppedCopy(t, stopped, done.length, false);
        toast({ title: halted?.title ?? title, description: halted?.description, variant: stopped || done.length === 0 ? "destructive" : "default" });
        return { stopped };
      },
    });
  }

  function runCopy(snapshot: Extract<Confirm, { kind: "copy" }>): void {
    const { target, pathLabel, notes: items, copySource } = snapshot;
    void runBatch({
      total: items.length,
      opener: openerRef.current,
      fromConfirm: true,
      execute: async (onProgress) => {
        const outcome = await copyNotesInOrder(items, target, { queryClient, onProgress });
        const { done, stopped } = outcome;
        const title = selectionResultTitle(
          {
            action: "copy",
            tab,
            notesDone: done.length,
            foldersDone: 0,
            trashedViaFolders: 0,
            ...skippedCounts(NO_SKIPS, outcome.skippedDetail),
            destinationName: pathLabel,
            sameSpace: false,
            destination: target,
            copySource,
          },
          t,
        );
        const halted = stoppedCopy(t, stopped, done.length, false);
        toast({ title: halted?.title ?? title, description: halted?.description, variant: stopped || done.length === 0 ? "destructive" : "default" });
        return { stopped };
      },
    });
  }

  /**
   * 刪除（資料夾先、筆記後，`deleteTargetsInOrder`）。開著的那篇：直接選的、或所在的個人／群組資料夾（與我共享的移除不算）排到各段最後，
   * 送它前設 `leavingRef`。
   */
  function runDelete(items: readonly SelectionTarget[], pre: Eligibility, opener: HTMLElement | null, fromConfirm: boolean): void {
    const openId = controlsRef.current?.noteId ?? null;
    const leavingFolder =
      openId === null
        ? null
        : (items.find(
            (target) =>
              target.kind === "folder" &&
              target.folder.space.kind !== "shared" &&
              liveNotesUnder(folderIndex, target.folder.id, notes, spaceOf).some((note) => note.id === openId),
          ) ?? null);
    const isLeaving = (target: SelectionTarget): boolean =>
      target.kind === "folder" ? target === leavingFolder : openId !== null && target.note.id === openId;
    // 開著的那篇排最後：送它前才設 leavingRef，前面的項目失敗也不會先把頁面閘住（deleteTargetsInOrder 再分成資料夾段、筆記段，各自保序）。
    const ordered = [...items.filter((target) => !isLeaving(target)), ...items.filter(isLeaving)];
    const hasFolders = items.some(isFolder);
    void runBatch({
      total: ordered.length,
      opener,
      fromConfirm,
      execute: async (onProgress) => {
        let leaveHome = false;
        const outcome = await deleteTargetsInOrder(ordered, {
          queryClient,
          onProgress,
          beforeEach: (target) => {
            const page = controlsRef.current;
            // 中途在同一個 NotePage 換到別篇：leavingRef 已屬於那一篇，不能設（T5 review r1 M1）。
            if (isLeaving(target) && page?.noteId === openId) page.leavingRef.current = true;
          },
          afterFailure: (target) => {
            const page = controlsRef.current;
            if (!isLeaving(target) || page?.noteId !== openId) return;
            if (isTerminal(page.state)) leaveHome = true;
            else page.leavingRef.current = false;
          },
        });
        const { done, stopped } = outcome;
        const doneNotes = done.flatMap((item) => (item.target.kind === "note" ? [item.target.note] : []));
        // 資料夾帶走的篇（筆記項的 trashedNoteIds 只是自己，已算在 notesDone）。
        const undoIds = done.flatMap((item) => (item.target.kind === "folder" ? item.trashedNoteIds : []));
        const reopened = done.some((item) => isLeaving(item.target));
        if (reopened) leaveHome = true;
        const title = selectionResultTitle(
          {
            action: "delete",
            tab,
            notesDone: doneNotes.length,
            foldersDone: done.length - doneNotes.length,
            trashedViaFolders: undoIds.length,
            ...skippedCounts(pre, outcome.skippedDetail),
            destinationName: null,
            sameSpace: false,
            destination: null,
            copySource: null,
          },
          t,
        );
        const halted = stoppedCopy(t, stopped, done.length, hasFolders);
        if (tab !== "shared" && (undoIds.length > 0 || doneNotes.length > 0)) {
          showTrashedToast({
            notes: doneNotes,
            undoIds,
            queryClient,
            navigate,
            t,
            reopen: false,
            reopenId: reopened ? openId : null,
            title: halted?.title ?? title,
            description: halted?.description,
            variant: stopped ? "destructive" : "default",
          });
        } else {
          // 與我共享的移除（筆記回最上層、不進垃圾桶）、只刪了空資料夾、或一項都沒做：沒有可復原的。
          toast({ title: halted?.title ?? title, description: halted?.description, variant: stopped || done.length === 0 ? "destructive" : "default" });
        }
        return {
          stopped,
          // 中途已換到別篇就不導回首頁（換頁導致 AppShell 重掛時 controlsRef 停在舊值，這一形抓不到，屬已接受的邊界）。
          afterSelection: () => {
            if (leaveHome && controlsRef.current?.noteId === openId) void navigate("/", { replace: true });
          },
        };
      },
    });
  }

  function openPicker(mode: DestMode, event: MouseEvent<HTMLButtonElement>): void {
    openerRef.current = event.currentTarget;
    pickedRef.current = false;
    setPath([]);
    setPickerMode(mode);
  }

  function startDelete(event: MouseEvent<HTMLButtonElement>): void {
    const opener = event.currentTarget;
    openerRef.current = opener;
    const { eligible } = deleteElig;
    const folders = eligible.flatMap((target) => (target.kind === "folder" ? [target.folder] : []));
    if (folders.length === 0) {
      runDelete(eligible, deleteElig, opener, false);
      return;
    }
    // 彙總確認框的數字在開框那一刻快照：各資料夾子樹活筆記的聯集、另選的筆記數。
    const trashed = new Set(folders.flatMap((folder) => liveNotesUnder(folderIndex, folder.id, notes, spaceOf).map((note) => note.id)));
    submittedRef.current = false;
    setConfirm({
      kind: "delete",
      items: eligible,
      pre: deleteElig,
      folderCount: folders.length,
      noteCount: trashed.size,
      alsoNotes: eligible.length - folders.length,
      shared: tab === "shared",
    });
    setConfirmOpen(true);
  }

  /** 確認框沒有 DialogTrigger（Radix 會把焦點丟到 body）：取消時還給開框鈕；送出過的由收尾處理。 */
  function onConfirmCloseAutoFocus(event: Event): void {
    event.preventDefault();
    if (!submittedRef.current && openerRef.current?.isConnected) openerRef.current.focus();
  }

  // ── 目的地框 ──
  const pickerSource = pickerMode === null ? null : pickerMode === "move" ? moveSource : sourceFor("copy");
  const source = pickerSource === null || pickerSource === "mixedGroups" ? null : pickerSource;
  const level = source !== null && pickerMode !== null && levelReady(pickerMode) ? buildDestinationLevel({ source, path, index: folderIndex, t }) : null;

  function pick(target: DestTarget): void {
    if (pickerMode === null || source === null) return;
    const opener = openerRef.current;
    if (pickerMode === "move") {
      if (target.kind !== "place") return;
      if (isSameSpace(target, source)) {
        pickedRef.current = true;
        setPickerMode(null);
        runPlace(target, moveElig.eligible, moveElig, folderIndex, opener);
        return;
      }
      if (target.space.kind !== "group") return;
      setConfirm({
        kind: "move",
        target,
        groupId: target.space.groupId,
        pathLabel: destinationPathLabel(target.space, target.folder, folderIndex, t),
        notes: notesOf(moveElig.eligible),
        pre: moveElig,
      });
    } else {
      setConfirm({
        kind: "copy",
        target,
        pathLabel: target.kind === "place" ? destinationPathLabel(target.space, target.folder, folderIndex, t) : "",
        notes: notesOf(copyElig.eligible),
        copySource: source.current,
      });
    }
    pickedRef.current = true;
    submittedRef.current = false;
    setPickerMode(null);
    setConfirmOpen(true);
  }

  // ── 鈕 ──
  const acrossGroups = moveSource === "mixedGroups";
  const moveDisabled =
    busy ||
    moveElig.eligible.length === 0 ||
    moveSource === "mixedGroups" ||
    (levelReady("move") && isEmptyDestination(moveSource, folderIndex, t));
  const anyFolder = targets.some(isFolder);
  const copyDisabled = busy || anyFolder || copyElig.eligible.length === 0;
  // 與我共享：只有「移除選取的資料夾」，選取（去重後）非空且全是資料夾才渲染（D-M3）。
  const showDelete = available.includes("delete") && (tab !== "shared" || (deduped.length > 0 && deduped.every(isFolder)));
  const deleteLabel =
    tab === "shared"
      ? t("select.removeSelectedFolders", { count: targets.filter(isFolder).length })
      : t("select.deleteSelected", { count: targets.length });

  return (
    <>
      <div className="m-2 flex flex-col gap-1" data-select-action-bar="" aria-busy={busy}>
        {run !== null && (
          <p role="status" className="px-1 text-center text-[11px] text-muted-foreground">
            {t("select.progress", run.progress)}
          </p>
        )}
        <div className="@container flex gap-1">
          {available.includes("move") && (
            <Button
              type="button"
              variant="brand"
              className={ACTION_TEXT_BUTTON}
              title={acrossGroups ? t("select.acrossGroups") : t("select.moveTo")}
              aria-describedby={acrossGroups ? acrossGroupsId : undefined}
              disabled={moveDisabled}
              onClick={(event) => openPicker("move", event)}
            >
              <FolderInput aria-hidden="true" className={ACTION_ICON} />
              <span className="truncate">{t("select.moveTo")}</span>
            </Button>
          )}
          {available.includes("copy") && (
            <Button
              type="button"
              variant="outline"
              className={ACTION_TEXT_BUTTON}
              title={anyFolder ? t("select.foldersCantCopy") : t("select.copyTo")}
              aria-describedby={anyFolder ? cantCopyId : undefined}
              disabled={copyDisabled}
              onClick={(event) => openPicker("copy", event)}
            >
              <Copy aria-hidden="true" className={ACTION_ICON} />
              <span className="truncate">{t("select.copyTo")}</span>
            </Button>
          )}
          {showDelete && (
            // 不用 outline：它的 hover 填 brand-deep，紅字壓深色底不對（同 TrashFooter 的永久刪除）。
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="w-9 shrink-0 border border-input text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={deleteLabel}
              title={deleteLabel}
              disabled={busy || deleteElig.eligible.length === 0}
              onClick={startDelete}
            >
              <Trash aria-hidden="true" className="h-4 w-4" />
            </Button>
          )}
        </div>
        {/* disabled 鈕的 title 螢幕閱讀器讀不到：原因另放一份 sr-only 同字，經 aria-describedby 唸。 */}
        {acrossGroups && available.includes("move") && (
          <span id={acrossGroupsId} className="sr-only">
            {t("select.acrossGroups")}
          </span>
        )}
        {anyFolder && available.includes("copy") && (
          <span id={cantCopyId} className="sr-only">
            {t("select.foldersCantCopy")}
          </span>
        )}
      </div>
      {/* 對話框放在動作列的 div 外（只是版面；Esc 由 SelectHeader 的 document 監聽處理，對話框開著時它不動作）。 */}
      <DestinationPickerDialog
        mode={pickerMode ?? "copy"}
        count={pickerMode === "move" ? moveElig.eligible.length : copyElig.eligible.length}
        hasFolders={pickerMode === "move" && moveElig.eligible.some(isFolder)}
        level={level}
        levelKey={JSON.stringify(path)}
        error={pickerMode !== null && !levelReady(pickerMode) && groupsQuery.isError ? groupsQuery.error : null}
        open={pickerMode !== null}
        // 換層一律從 livePath 接（path 裡有已失效的步時 buildDestinationLevel 會靜默截斷，不能看 path.length）。
        onDrill={(step) => {
          if (source !== null) setPath([...livePath(source, path, folderIndex, t), step]);
        }}
        onBack={() => {
          if (source !== null) setPath(livePath(source, path, folderIndex, t).slice(0, -1));
        }}
        onPick={pick}
        onOpenChange={(open) => {
          if (!open) setPickerMode(null);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!pickedRef.current && openerRef.current?.isConnected) openerRef.current.focus();
        }}
      />
      {confirm?.kind === "move" && (
        <MoveConfirmDialog
          count={confirm.notes.length}
          groupName={confirm.pathLabel}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() => runMove(confirm)}
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
      {confirm?.kind === "copy" && (
        <CopyConfirmDialog
          count={confirm.notes.length}
          target={confirm.target}
          pathLabel={confirm.pathLabel}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() => runCopy(confirm)}
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
      {confirm?.kind === "delete" && (
        <DeleteFoldersConfirmDialog
          folderCount={confirm.folderCount}
          noteCount={confirm.noteCount}
          alsoNotes={confirm.alsoNotes}
          shared={confirm.shared}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() => runDelete(confirm.items, confirm.pre, openerRef.current, true)}
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
    </>
  );
}
