import "@/i18n/select-strings";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { isTerminal } from "@/collab/connection";
import { useNotePageControls } from "@/lib/note-page-controls";
import { copyNotesInOrder, moveNotesInOrder, trashNotesInOrder, type BatchOutcome } from "@/lib/select-batch";
import { selectionKey, SIDEBAR_SELECT_BUTTON } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { showTrashedToast } from "@/lib/trash-undo";
import { Button } from "@/components/ui/button";
import { Copy, FolderInput, Trash } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { buildDestinationLevel, type DestSpace, type DestTarget } from "./destination-level";
import { DestinationPickerDialog } from "./DestinationPickerDialog";
import { CopyConfirmDialog, MoveConfirmDialog } from "./select-dialogs";
import {
  buildDestinationTree,
  destinationLabel,
  partitionEligible,
  SELECT_ACTIONS,
  selectedTabNotes,
  selectionResultTitle,
  type Destination,
  type SelectableTab,
  type SelectActionId,
} from "./select-model";
import { beginSelectRun, endSelectRun, updateSelectRun, useSelectRun } from "./select-run";
import { EMPTY_FOLDER_INDEX, indexFolders } from "./folder-index";
import { useFolderSortOf } from "./folder-sort";
import { buildTabNodes } from "./tree";

/**
 * 一般 tab 選取模式的動作列（#181 PR-2c，spec §6.11）。只准經 `SelectLazy` 引用。
 * - 動作表（§6.11）：我的筆記「移動到／複製到／刪除」、最近與工作坊「複製到／刪除」、與我共享「複製到」（`SELECT_ACTIONS`）。
 * - 預先排除與 disabled：刪除看 `permissions.delete`、移動看「自己的個人筆記」（`partitionEligible`）；排除的篇不送、算進「略過」。
 *   一篇都做不了就 disabled（移動另看有沒有可移入的群組）、複製 0 篇 disabled；不出「0 篇」toast。
 * - 執行：依序呼叫單篇端點（`lib/select-batch.ts`）；403／404 `not_found` 略過、其餘停下。停下後留在選取、只留下還沒處理的
 *   （Willie 裁定 Q4）；成功離開選取。結果一則 toast。
 * - 快照（讀碼發現 19）：目的地選定那一刻記下要送的篇與篇數，確認框與執行都用它（送出中清單重抓，篇數不會倒數）。
 * - 焦點交接（讀碼發現 18）：選了目的地，目的地框不還焦點、交給確認框自己的自動聚焦；取消才還給開框鈕。確認框送出後開到批次
 *   結束（進行中忽略所有關閉要求）；收尾的焦點只在焦點仍在本實例、確認框內或 body 時才搬（同 `TrashFooter.finish`）。
 * - 進行中：執行狀態在 provider 層的 `select-run` store，所有動作列（含重開抽屜、Done→Select 後新掛的）都顯示進度、三顆鈕 disabled。
 *   選取結果只在 session 沒換時套用（抽屜關掉、動作列卸載也照套；使用者中途結束又重開就不覆蓋新的選取）。
 * - 開著的那篇（讀碼發現 11）：排到刪除批次最後，送它前設 NotePage 的 `leavingRef`；成功導回首頁、「復原」導回它；失敗非終態撥回、
 *   終態導回首頁（不補單篇路徑的 `note.deleted` toast：批次只出一則，那篇已算進略過）。
 * - §6.10.7：整批都能自己還原才帶「復原」（`showTrashedToast`），否則帶說明句。
 * - PR-3b：刪資料夾的彙總確認框插在「刪除」流程開頭（選取含資料夾時）；資料夾的放置與移動接在同一套 run／收尾。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** ApiFail → errors.<code>；其餘 → errors.fallback（各檔各自一份，是既有慣例；同 `trash-undo.ts`）。 */
function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 「移動到」「複製到」：側欄最窄 200px（卡片內約 182px）也要和 36px 的刪除鈕排進同一列——`min-w-0` 讓 flex 子項能縮到比內容窄、
 * `px-1.5 gap-1.5` 省寬、字 `truncate`（DOM 裡仍是全文，可及名稱不受影響；`title` 給看得到截字的人）。不加的話刪除鈕會被擠出卡片、
 * 落到側欄寬度把手底下（T5 review r1 I1，真 Chromium 量測）。按鈕列是 `@container`：列寬不到 14.5rem（字級 16 時側欄約 250px 以下）時拿掉
 * 兩顆的圖示，把位置讓給字（實測帶圖示時 en 要列寬 ≥ 14rem 才不截字，字級 16、20 皆同；多留 0.5rem）。
 */
const ACTION_TEXT_BUTTON = "min-w-0 flex-1 gap-1.5 px-1.5";
const ACTION_ICON = "hidden h-4 w-4 shrink-0 @min-[14.5rem]:block";

/** PR-2c 的根層目的地 → T2 的 DestSpace（T6b 換成逐層目的地後刪）。 */
function destinationSpace(destination: Destination): DestSpace {
  return destination.kind === "group" ? { kind: "group", groupId: destination.groupId, name: destination.name } : { kind: "personal" };
}

/** PR-2c 的根層目的地 → T5 的 DestTarget（我的筆記根層／群組根層；T6b 換成逐層目的地後刪）。 */
function rootTarget(destination: Destination): DestTarget {
  return { kind: "place", space: destinationSpace(destination), folder: null };
}

/** 過渡接法（T6a→T6b，T6b 刪）：目的地框回的根層 DestTarget → PR-2c 的 Destination；過渡層只有個人／群組根層，其餘回 null。 */
function pickedDestination(target: DestTarget): Destination | null {
  if (target.kind !== "place" || target.folder !== null) return null;
  const { space } = target;
  if (space.kind === "personal") return { kind: "personal" };
  return space.kind === "group" ? { kind: "group", groupId: space.groupId, name: space.name } : null;
}

interface Snapshot {
  action: "move" | "copy";
  destination: Destination;
  eligible: NoteDto[];
  preSkipped: number;
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

  const [pickerMode, setPickerMode] = useState<"move" | "copy" | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /** 目的地框關閉時：選了（交給確認框）還是取消（還給開框鈕）。 */
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

  const nodes = useMemo(
    () =>
      notesQuery.isSuccess && (tab !== "workspace" || groupsQuery.data !== undefined)
        ? buildTabNodes(tab, notesQuery.data, groupsQuery.data ?? [], folderIndex, sortOf)
        : null,
    [tab, notesQuery.isSuccess, notesQuery.data, groupsQuery.data, folderIndex, sortOf],
  );
  const selected = nodes === null ? [] : selectedTabNotes(nodes, selection.keys);
  const moveEligible = partitionEligible("move", selected);
  const deletable = partitionEligible("delete", selected);
  const groups = groupsQuery.data;
  const destinations = (mode: "move" | "copy") => (groups === undefined ? null : buildDestinationTree({ mode, groups, t }));
  /**
   * 過渡接法（T6a→T6b，T6b 刪）：PR-2c 的平清單轉成目的地框的第一層——沒有上半部、沒有資料夾，所以不會有分隔線與 drill，
   * 項目與 PR-2c 同名同序（move＝候選群組；copy＝我的筆記＋候選群組）。
   */
  const pickerLevel = (mode: "move" | "copy") => {
    const nodes = destinations(mode);
    if (nodes === null) return null;
    const others = nodes.map((node) => destinationSpace(node.destination));
    return buildDestinationLevel({
      source: { mode, current: null, makeCopy: false, others, locations: [], movingFolders: [] },
      path: [],
      index: EMPTY_FOLDER_INDEX,
      t,
    });
  };
  const busy = run !== null;
  const available = SELECT_ACTIONS[tab];

  /** 焦點仍在本實例、確認框內或 body（被按的鈕已 disabled／確認框已卸載）才搬；等待期間使用者已移到別處就不搶。 */
  function mayReclaimFocus(shell: Element | null, confirmEl: Element | null): boolean {
    if (!mountedRef.current) return false;
    const active = document.activeElement;
    return active === null || active === document.body || shell?.contains(active) === true || confirmEl?.contains(active) === true;
  }

  async function runBatch(input: {
    action: SelectActionId;
    items: NoteDto[];
    preSkipped: number;
    destination: Destination | null;
    opener: HTMLElement | null;
  }): Promise<void> {
    const { action, items, preSkipped, destination, opener } = input;
    if (!beginSelectRun(actions, items.length)) return;
    submittedRef.current = action !== "delete";
    const session = getSelectionSession();
    const shell = opener?.closest("[data-sidebar-instance]") ?? null;
    const onProgress = (processed: number) => updateSelectRun(actions, processed);
    let focusTo: "select" | "opener" | null = null;
    try {
      let outcome: BatchOutcome<NoteDto>;
      let leaveHome = false;
      const openId = action === "delete" ? (controlsRef.current?.noteId ?? null) : null;
      if (action === "delete") {
        outcome = await trashNotesInOrder(items, {
          queryClient,
          onProgress,
          beforeEach: (note) => {
            const page = controlsRef.current;
            // 中途在同一個 NotePage 換到別篇：leavingRef 已屬於那一篇，不能設（T5 review r1 M1）。
            if (note.id === openId && page?.noteId === openId) page.leavingRef.current = true;
          },
          afterFailure: (note) => {
            const page = controlsRef.current;
            if (note.id !== openId || page?.noteId !== openId) return;
            if (isTerminal(page.state)) leaveHome = true;
            else page.leavingRef.current = false;
          },
        });
      } else if (action === "move" && destination?.kind === "group") {
        outcome = await moveNotesInOrder(items, { groupId: destination.groupId }, { queryClient, onProgress });
      } else if (action === "copy" && destination !== null) {
        outcome = await copyNotesInOrder(items, rootTarget(destination), { queryClient, onProgress });
      } else {
        return;
      }

      const { stopped } = outcome;
      const done = outcome.done.length;
      const title = selectionResultTitle(
        {
          action,
          tab,
          notesDone: done,
          foldersDone: 0,
          trashedViaFolders: 0,
          notesSkipped: preSkipped + outcome.skipped,
          foldersSkipped: 0,
          foldersBlocked: 0,
          foldersGone: 0,
          destinationName: destination === null ? null : destinationLabel(destination, t),
          sameSpace: false,
          destination: destination === null ? null : rootTarget(destination),
          copySource: null,
        },
        t,
      );
      const stoppedTitle = stopped ? errorMessage(t, stopped.cause) : null;
      const stoppedDescription = stopped ? t("select.stoppedAfter", { count: done }) : undefined;
      if (action === "delete") {
        const reopened = openId !== null && outcome.done.some((note) => note.id === openId);
        if (reopened) leaveHome = true;
        if (done > 0) {
          showTrashedToast({
            notes: outcome.done,
            queryClient,
            navigate,
            t,
            reopen: false,
            reopenId: reopened ? openId : null,
            title: stoppedTitle ?? title,
            description: stoppedDescription,
            variant: stopped ? "destructive" : "default",
          });
        } else {
          toast({ title: stoppedTitle ?? title, description: stoppedDescription, variant: "destructive" });
        }
      } else {
        toast({ title: stoppedTitle ?? title, description: stoppedDescription, variant: stopped || done === 0 ? "destructive" : "default" });
      }

      // 守衛在選取結果套用前判斷（成功會結束選取、本元件隨之卸載）；搬焦點在收尾之後（確認框已關、開框鈕已恢復可用）。
      if (mayReclaimFocus(shell, confirmContentRef.current)) focusTo = stopped ? "opener" : "select";
      // 選取結果只看 session、不看掛載（抽屜關掉照套；中途結束又重開就不覆蓋新的那輪）。
      if (getSelectionSession() === session) {
        flushSync(() => updateSelection(stopped ? { type: "setAll", keys: stopped.remaining.map(selectionKey) } : { type: "end" }));
      }
      // 中途已換到別篇就不導回首頁（換頁導致 AppShell 重掛時 controlsRef 停在舊值，這一形抓不到，屬已接受的邊界）。
      if (leaveHome && controlsRef.current?.noteId === openId) void navigate("/", { replace: true });
    } finally {
      flushSync(() => {
        setConfirmOpen(false);
        endSelectRun(actions);
      });
    }
    if (focusTo === "select") shell?.querySelector<HTMLButtonElement>(SIDEBAR_SELECT_BUTTON)?.focus();
    else if (focusTo === "opener" && opener?.isConnected) opener.focus();
  }

  function openPicker(mode: "move" | "copy", event: MouseEvent<HTMLButtonElement>): void {
    openerRef.current = event.currentTarget;
    pickedRef.current = false;
    setPickerMode(mode);
  }

  function startDelete(event: MouseEvent<HTMLButtonElement>): void {
    const { eligible, skipped } = deletable;
    const openId = controlsRef.current?.noteId ?? null;
    // 開著的那篇排最後：送它前才設 leavingRef，前面的篇失敗也不會先把頁面閘住。
    const items = [...eligible.filter((note) => note.id !== openId), ...eligible.filter((note) => note.id === openId)];
    void runBatch({ action: "delete", items, preSkipped: skipped, destination: null, opener: event.currentTarget });
  }

  /** 確認框沒有 DialogTrigger（Radix 會把焦點丟到 body）：取消時還給開框鈕；送出過的由收尾處理。 */
  function onConfirmCloseAutoFocus(event: Event): void {
    event.preventDefault();
    if (!submittedRef.current && openerRef.current?.isConnected) openerRef.current.focus();
  }

  const moveDisabled = busy || moveEligible.eligible.length === 0 || (groups !== undefined && destinations("move")?.length === 0);

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
              title={t("select.moveTo")}
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
              title={t("select.copyTo")}
              disabled={busy || selected.length === 0}
              onClick={(event) => openPicker("copy", event)}
            >
              <Copy aria-hidden="true" className={ACTION_ICON} />
              <span className="truncate">{t("select.copyTo")}</span>
            </Button>
          )}
          {available.includes("delete") && (
            // 不用 outline：它的 hover 填 brand-deep，紅字壓深色底不對（同 TrashFooter 的永久刪除）。
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="w-9 shrink-0 border border-input text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={t("select.deleteSelected", { count: selected.length })}
              title={t("select.deleteSelected", { count: selected.length })}
              disabled={busy || deletable.eligible.length === 0}
              onClick={startDelete}
            >
              <Trash aria-hidden="true" className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {/* 對話框放在動作列的 div 外（只是版面；Esc 由 SelectHeader 的 document 監聽處理，對話框開著時它不動作）。 */}
      <DestinationPickerDialog
        mode={pickerMode ?? "copy"}
        count={pickerMode === "move" ? moveEligible.eligible.length : selected.length}
        hasFolders={false}
        level={pickerMode === null ? null : pickerLevel(pickerMode)}
        levelKey="[]"
        error={groupsQuery.isError && groups === undefined ? groupsQuery.error : null}
        open={pickerMode !== null}
        // 過渡層沒有 drill 與「‹ 返回」：這兩支不會被呼叫（T6b 接上逐層 path）。
        onDrill={() => {}}
        onBack={() => {}}
        onPick={(target) => {
          const destination = pickedDestination(target);
          if (pickerMode === null || destination === null) return;
          pickedRef.current = true;
          submittedRef.current = false;
          setSnapshot(
            pickerMode === "move"
              ? { action: "move", destination, eligible: moveEligible.eligible, preSkipped: moveEligible.skipped }
              : { action: "copy", destination, eligible: selected, preSkipped: 0 },
          );
          setPickerMode(null);
          setConfirmOpen(true);
        }}
        onOpenChange={(open) => {
          if (!open) setPickerMode(null);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!pickedRef.current && openerRef.current?.isConnected) openerRef.current.focus();
        }}
      />
      {snapshot !== null && snapshot.action === "move" && snapshot.destination.kind === "group" && (
        <MoveConfirmDialog
          count={snapshot.eligible.length}
          groupName={snapshot.destination.name}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() =>
            void runBatch({ action: "move", items: snapshot.eligible, preSkipped: snapshot.preSkipped, destination: snapshot.destination, opener: openerRef.current })
          }
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
      {snapshot !== null && snapshot.action === "copy" && (
        <CopyConfirmDialog
          count={snapshot.eligible.length}
          destination={snapshot.destination}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() =>
            void runBatch({ action: "copy", items: snapshot.eligible, preSkipped: 0, destination: snapshot.destination, opener: openerRef.current })
          }
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
    </>
  );
}
