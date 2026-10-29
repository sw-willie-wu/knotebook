import { memo, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TrashItemDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { usePurgeTrash, useRestoreTrash, useTrash } from "@/api/trash";
import { useSession } from "@/auth/useSession";
import { selectionKey } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { selectedTrashIds, splitTrashSections, trashDetailLine, trashItemTitle } from "@/lib/trash-display";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EllipsisVertical, RotateCcw, SquareCheck, Trash } from "@/components/ui/icons";
import { hoverReveal } from "@/components/ui/reveal";
import { cn } from "@/lib/utils";
import { tabSpec, type HeaderActionId } from "@/components/sidebar/tab-specs";
import { EmptyTrashDialog, PurgeConfirmDialog, toastTrashFailure, toastTrashResult } from "@/components/sidebar/trash-dialogs";

/**
 * 垃圾桶 tab 的面板（spec 2026-10-21 §6.10.1、§6.10.3）：`AppShell` 在 tab 為 `trash` 時放進 tabpanel，取代 `NoteList`。
 * - 列**不是連結**：垃圾桶裡的筆記不能開（非目標「預覽」，§2.2）；只有 hover 浮出的「還原」與 ⋮（還原／永久刪除）。
 * - 兩區「個人」「工作坊」（某區 0 篇整區不渲染），區內照 server 的順序（`deleted_at DESC`）。
 * - 標題列動作照 `tabSpec("trash").actions` 渲染（spec §9-3）。
 * - 清空＝把**清單上**的 id 全部送 purge（spec §6.3.4-5）：之後才移入的不受影響；超過 200 由 `purgeTrashIds` 分批。
 * - 確認框成敗都關，結果走 toast（`trash-dialogs.tsx`）。動作完成後焦點回清單容器（被處理的列會卸載）。
 * - 選取模式（spec §6.10.2）：狀態在 `SidebarTabProvider`（靜態卡與抽屜兩份共用）；標題列換成「已選 N 篇」＋全選＋完成，
 *   列換成整列 `<label>`＋勾選框、不渲染「還原」與 ⋮。還原／永久刪除的動作列在 `TrashFooter.tsx` 的 `TrashActionBar`。
 *   焦點只由發起的那一份實例移動（`focusAfterRef`）。
 */

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

const MESSAGE_CLASS = "p-2 text-sm text-muted-foreground";

interface RowActions {
  onRestore: (id: string) => void;
  onPurge: (id: string, trigger: HTMLElement | null) => void;
}

function TrashRow({ item, now, actions }: { item: TrashItemDto; now: number; actions: RowActions }) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const locale = i18n.language;
  return (
    <li
      data-node-kind="note"
      data-node-id={item.id}
      title={trashItemTitle(item, { t, locale })}
      className="group/noterow flex items-center gap-0.5 rounded-md py-1.5 pl-2 pr-1 text-[13px] hover:bg-brand-soft hover:text-brand-on-soft"
    >
      {/* 兩行一律 <div>（同 NoteList 最近 tab 的兩行列）。 */}
      <div className="min-w-0 flex-1">
        <div className="truncate">{item.title}</div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{trashDetailLine(item, { now, t, locale })}</div>
      </div>
      {/* 側欄 24px 例外（button.tsx 檔頭）；與筆記列 ⋮ 共用 hoverReveal("noterow")。 */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("trash.restoreFor", { title: item.title })}
        title={t("trash.restore")}
        onClick={() => actions.onRestore(item.id)}
        className={cn("h-6 w-6 shrink-0", hoverReveal("noterow"))}
      >
        <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
      {/* controlled＋三步（preventDefault → 關選單 → 動作）：同 NoteMenu 檔頭的 focus trap 規矩。 */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.menuFor", { title: item.title })}
            className={cn("h-6 w-6 shrink-0", hoverReveal("noterow"))}
          >
            <EllipsisVertical aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              actions.onRestore(item.id);
            }}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("trash.restore")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              actions.onPurge(item.id, triggerRef.current);
            }}
          >
            <Trash className="mr-2 h-4 w-4" />
            {t("trash.purge")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * 選取模式的列：整列是 `<label>`，點文字或勾選框都切換（spec §6.10.2）。
 * memo：勾一列時其他列不重繪、不重算日期（final review M-1）——`now`／`onToggle` 由 `TrashPanel` 保持穩定。
 */
const SelectableTrashRow = memo(function SelectableTrashRow({
  item,
  now,
  checked,
  onToggle,
}: {
  item: TrashItemDto;
  now: number;
  checked: boolean;
  onToggle: (key: string, shiftKey: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  return (
    <li data-node-kind="note" data-node-id={item.id} title={trashItemTitle(item, { t, locale })}>
      {/* select-none：Shift＋點文字時不順帶選取頁面文字。label 內只能放 phrasing content，兩行用 block span。 */}
      <label
        className={cn(
          "flex cursor-pointer select-none items-start gap-2 rounded-md py-1.5 pl-2 pr-1 text-[13px]",
          checked ? "bg-brand-soft font-medium text-brand-on-soft" : "hover:bg-brand-soft hover:text-brand-on-soft",
        )}
        // Firefox 有修飾鍵時不把 label 的 click 轉給勾選框（留給文字選取），Shift／Ctrl＋點列文字會沒反應：有修飾鍵且點的不是
        // 勾選框本身時，取消轉送、自己切換（三引擎一致；Chromium／WebKit 不會因此切兩次）。
        onClick={(event) => {
          if (!(event.shiftKey || event.ctrlKey || event.metaKey) || event.target instanceof HTMLInputElement) return;
          event.preventDefault();
          onToggle(selectionKey({ kind: "note", id: item.id }), event.shiftKey);
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          // Shift＝範圍；Ctrl／⌘＋點與一般點選相同（單列切換）。macOS 的 Ctrl＋點是右鍵、不產生 click，用 ⌘。
          onChange={(event) => onToggle(selectionKey({ kind: "note", id: item.id }), (event.nativeEvent as MouseEvent).shiftKey)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.title}</span>
          <span className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground">{trashDetailLine(item, { now, t, locale })}</span>
        </span>
      </label>
    </li>
  );
});

function TrashSection({ label, items, renderItem }: { label: string; items: TrashItemDto[]; renderItem: (item: TrashItemDto) => ReactNode }) {
  const headingId = useId();
  return (
    <>
      <h3 id={headingId} className="flex h-6 items-center px-2 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ul aria-labelledby={headingId} className="space-y-0.5">
        {items.map(renderItem)}
      </ul>
    </>
  );
}

export function TrashPanel() {
  const { t } = useTranslation();
  const trash = useTrash();
  const { user } = useSession();
  const restore = useRestoreTrash();
  const purge = usePurgeTrash();
  const { selection } = useSidebarTabState();
  const { updateSelection, endSelectionIfActive } = useSidebarTabActions();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const emptyButtonRef = useRef<HTMLButtonElement>(null);
  const selectButtonRef = useRef<HTMLButtonElement>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  /** 進出選取模式後要聚焦的鈕：只有發起的這一份實例會設（靜態卡與抽屜同時在 DOM，另一份不搶焦點）。 */
  const focusAfterRef = useRef<"done" | "select" | null>(null);
  /** 單篇永久刪除的對象（確認框開著）。 */
  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  /** 每開一次清空框 +1：送出後回來時只關「同一次」開的框（期間取消又重開的不關）。 */
  const emptyRoundRef = useRef(0);
  /** 開框的鈕（該列 ⋮／「清空」）：取消時焦點還給它（沒有 DialogTrigger，Radix 預設會掉到 body）。關框那次 render 的
   * state 已清掉，所以存 ref。 */
  const openerRef = useRef<HTMLElement | null>(null);
  /** 確認後是否已送出（成敗不論）：送出過的關框焦點回清單（被處理的列會卸載），取消的回開框的鈕。 */
  const submittedRef = useRef(false);
  /** 連點不重送：mutation 的 isPending 要等下一個 macrotask 才反映到 disabled。 */
  const busyRef = useRef(false);

  const items = trash.data?.items ?? [];
  const actionsDisabled = !trash.isSuccess || items.length === 0;
  const selectedIds = selectedTrashIds(items, selection.keys);
  const allSelected = items.length > 0 && selectedIds.length === items.length;

  useEffect(() => {
    const target = focusAfterRef.current;
    if (target === null) return;
    focusAfterRef.current = null;
    (target === "done" ? doneButtonRef : selectButtonRef).current?.focus();
  }, [selection.active]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // 靜態卡的 Esc。抽屜裡的 Esc 由 AppShell 的 onEscapeKeyDown（document capture）結束選取並交焦點；真瀏覽器在那之後、
    // React 的 onKeyDown 之前就 commit，勾選框已卸載，這裡收不到。
    if (event.key !== "Escape" || !selection.active) return;
    focusAfterRef.current = "select";
    endSelectionIfActive();
  }

  // 穩定（清單重抓才換）：選取列 memo 靠它（final review M-1）。
  const toggleRow = useCallback(
    (key: string, shiftKey: boolean): void => {
      const { order } = splitTrashSections(trash.data?.items ?? []);
      updateSelection(shiftKey ? { type: "range", key, order } : { type: "toggle", key });
    },
    [trash.data, updateSelection],
  );

  async function exclusive(run: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await run();
    } finally {
      busyRef.current = false;
    }
  }

  const rowActions: RowActions = {
    onRestore: (id) =>
      void exclusive(async () => {
        try {
          toastTrashResult("restore", await restore.mutateAsync([id]), t);
        } catch (err) {
          toastTrashFailure("restore", err, t);
        }
        // 被還原的列會卸載：焦點原本在面板內（或已落 body）才拉回清單；等回應期間使用者已移到別處（例如編輯器）就不搶。
        const active = document.activeElement;
        if (active === null || active === document.body || rootRef.current?.contains(active)) listRef.current?.focus();
      }),
    onPurge: (id, trigger) => {
      openerRef.current = trigger;
      submittedRef.current = false;
      setPurgeId(id);
    },
  };

  async function purgeIds(ids: readonly string[], close: () => void): Promise<void> {
    await exclusive(async () => {
      submittedRef.current = true;
      try {
        toastTrashResult("purge", await purge.mutateAsync(ids), t);
      } catch (err) {
        toastTrashFailure("purge", err, t);
      } finally {
        close();
      }
    });
  }

  function focusAfterClose(event: Event): void {
    event.preventDefault();
    const opener = openerRef.current;
    if (!submittedRef.current && opener?.isConnected) opener.focus();
    else listRef.current?.focus();
  }

  function renderAction(action: HeaderActionId): ReactNode {
    switch (action) {
      case "selectMode":
        return (
          <Button
            key={action}
            ref={selectButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.select")}
            title={t("trash.select")}
            disabled={actionsDisabled}
            // 握把：底部動作列離開選取模式後，經 `[data-sidebar-instance]` 找回同一份的這顆鈕聚焦。
            data-sidebar-select=""
            // 已在選取模式時不重送 `start`（reducer 的 start 會清空已勾的；標題列換字樣前那一幀連點兩下也一樣）。
            onClick={() => {
              if (selection.active) return;
              focusAfterRef.current = "done";
              updateSelection({ type: "start" });
            }}
            className="h-6 w-6 shrink-0"
          >
            <SquareCheck aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        );
      case "emptyTrash":
        return (
          <Button
            key={action}
            ref={emptyButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            disabled={actionsDisabled}
            onClick={() => {
              openerRef.current = emptyButtonRef.current;
              submittedRef.current = false;
              emptyRoundRef.current += 1;
              setEmptyOpen(true);
            }}
            className="h-6 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
          >
            {t("trash.emptyTrash")}
          </Button>
        );
      // 一般 tab 的動作由 NoteList 渲染，垃圾桶 tab 不宣告。
      case "newPersonalNote":
      case "newGroup":
      case "newFolder":
        return null;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  function renderBody(): ReactNode {
    if (trash.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
    if (trash.isError) {
      return (
        <p role="alert" className="p-2 text-sm text-destructive">
          {errorMessage(t, trash.error)}
        </p>
      );
    }
    if (items.length === 0) return <p className={MESSAGE_CLASS}>{t("trash.empty")}</p>;
    const { personal, workspace } = splitTrashSections(items);
    // 「剩 N 天」以清單抓到的時間計（每次重抓更新）：勾選等重繪不換值，選取列的 memo 才有效。
    const now = trash.dataUpdatedAt;
    const renderItem = (item: TrashItemDto) =>
      selection.active ? (
        <SelectableTrashRow
          key={item.id}
          item={item}
          now={now}
          checked={selection.keys.has(selectionKey({ kind: "note", id: item.id }))}
          onToggle={toggleRow}
        />
      ) : (
        <TrashRow key={item.id} item={item} now={now} actions={rowActions} />
      );
    return (
      <>
        {personal.length > 0 && <TrashSection label={t("sidebar.myNotes")} items={personal} renderItem={renderItem} />}
        {workspace.length > 0 && <TrashSection label={t("trash.sectionWorkspace")} items={workspace} renderItem={renderItem} />}
        {trash.data.truncated && <p className="p-2 text-[11px] text-muted-foreground">{t("trash.truncated")}</p>}
      </>
    );
  }

  function renderHeader(): ReactNode {
    if (!selection.active) {
      return (
        <>
          <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
            <span className="truncate">{trash.isSuccess ? t("trash.header", { count: items.length }) : t("sidebar.trash")}</span>
          </span>
          {tabSpec("trash").actions.map(renderAction)}
        </>
      );
    }
    return (
      <>
        <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-brand-on-soft">
          <span className="truncate">{t("trash.selected", { count: selectedIds.length })}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // 選取中清單被重抓成 0 篇（別處清掉）：沒有可選的。
          disabled={items.length === 0}
          onClick={() => updateSelection(allSelected ? { type: "clear" } : { type: "setAll", keys: splitTrashSections(items).order })}
          className="h-6 px-2 text-xs"
        >
          {allSelected ? t("trash.deselectAll") : t("trash.selectAll")}
        </Button>
        <Button
          ref={doneButtonRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            focusAfterRef.current = "select";
            updateSelection({ type: "end" });
          }}
          className="h-6 px-2 text-xs"
        >
          {t("trash.done")}
        </Button>
      </>
    );
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
      <div data-sidebar-header="" className="flex items-center gap-0.5 px-2 pt-3 pb-1">
        {renderHeader()}
      </div>
      <div data-sidebar-list="" tabIndex={-1} ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 focus-visible:outline-none">
        {renderBody()}
      </div>
      <PurgeConfirmDialog
        count={1}
        open={purgeId !== null}
        // 列的還原送出中也 disabled：`exclusive` 會吞掉這一下（final review N-4）。
        pending={purge.isPending || restore.isPending}
        onConfirm={() => {
          if (purgeId === null) return;
          const target = purgeId;
          // 回應前取消又對別列開框：第一發回來時不關第二個框。
          void purgeIds([target], () => setPurgeId((current) => (current === target ? null : current)));
        }}
        onOpenChange={(open) => {
          if (!open) setPurgeId(null);
        }}
        onCloseAutoFocus={focusAfterClose}
      />
      <EmptyTrashDialog
        items={items}
        meHandle={user?.handle ?? null}
        open={emptyOpen}
        pending={purge.isPending || restore.isPending}
        onConfirm={() => {
          // 開框後清單被重抓成 0 篇（別處已清掉）：不送空請求、不報「已永久刪除 0 篇」，直接關框。
          if (items.length === 0) {
            setEmptyOpen(false);
            return;
          }
          const round = emptyRoundRef.current;
          void purgeIds(
            items.map((item) => item.id),
            () => {
              if (emptyRoundRef.current === round) setEmptyOpen(false);
            },
          );
        }}
        onOpenChange={setEmptyOpen}
        onCloseAutoFocus={focusAfterClose}
      />
    </div>
  );
}
