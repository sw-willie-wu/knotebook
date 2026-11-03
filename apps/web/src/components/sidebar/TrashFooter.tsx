import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { usePurgeTrash, useRestoreTrash, useTrash } from "@/api/trash";
import { SIDEBAR_SELECT_BUTTON } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { selectedTrashIds } from "@/lib/trash-display";
import { useWidePointer } from "@/lib/wide-pointer";
import { Button } from "@/components/ui/button";
import { RotateCcw, Trash } from "@/components/ui/icons";
import { PurgeConfirmDialog, toastTrashFailure, toastTrashResult } from "@/components/sidebar/trash-dialogs";

/**
 * 垃圾桶 tab 的側欄底部（`SidebarFooter` 經 `TrashLazy` 延遲載入）：保留天數說明（spec §6.10.1）；選取模式換成動作列（spec §6.10.2）。
 * 兩者在同一個 lazy 元件裡切換：各自一個 lazy 的話，第一次進選取時動作列還要再 suspend 一次、先閃一下佔位。
 * 寬螢幕（`useWidePointer`，PR-3b-3，spec §6.10.2 rev 4.3）選取中底部什麼都不顯示（保留天數說明也不出現，總管裁定 ⑧）：
 * 動作在 `TrashPanel` 標題列的 `TrashWideToolbar`。
 */
export function TrashFooter() {
  const { selection } = useSidebarTabState();
  const wide = useWidePointer();
  if (!selection.active) return <TrashFooterNote />;
  return wide ? null : <TrashActionBar />;
}

/** 保留天數說明；載入中／失敗時只留同高的空位，版面不跳。 */
function TrashFooterNote() {
  const { t } = useTranslation();
  const trash = useTrash();
  if (!trash.isSuccess) return <div className="h-7" />;
  const days = trash.data.retentionDays;
  return (
    <p data-testid="trash-footer" className="px-4 py-1.5 text-center text-[11px] text-muted-foreground">
      {days !== null ? t("trash.footer", { count: days }) : t("trash.footerNever")}
    </p>
  );
}

/**
 * 垃圾桶選取模式的動作（spec §6.10.2）：還原、開永久刪除確認、確認後送出、成功收尾。窄形 `TrashActionBar` 與寬形 `TrashWideToolbar` 共用。
 * 0 篇或送出中 `disabled`。成功後離開選取模式（結果走 toast），失敗留在選取模式讓使用者重試。送出的 id 照清單順序、只算清單上還在的（`selectedTrashIds`）。
 * ⚠ 兩個呼叫端都只在選取中掛載——`mountedRef` 守衛（回應晚到時不結束使用者重新開始的另一輪選取）靠這一點成立；
 * `purgeDialog` 由呼叫端渲染在自己裡面，跟著呼叫端一起卸載（plan gate r1 I2 ①）。
 */
export function useTrashSelectionActions(): {
  selectedIds: string[];
  disabled: boolean;
  /** 送出中（還原或永久刪除的請求在途）。 */
  busy: boolean;
  onRestore: (event: MouseEvent<HTMLButtonElement>) => void;
  onPurge: (event: MouseEvent<HTMLButtonElement>) => void;
  purgeDialog: ReactNode;
} {
  const { t } = useTranslation();
  const trash = useTrash();
  const restore = useRestoreTrash();
  const purge = usePurgeTrash();
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 連點不重送（同 TrashPanel：isPending 要等下一個 macrotask 才反映到 disabled）。 */
  const busyRef = useRef(false);
  /** 選取已結束（呼叫端卸載）就不再動選取與焦點：回應晚到時不結束使用者重新開始的另一輪選取。 */
  const mountedRef = useRef(true);
  /** 開確認框的鈕與它所在的那一份實例（確認鈕在 portal 裡，找不到外殼）。 */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const shellRef = useRef<Element | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectedIds = selectedTrashIds(trash.data?.items ?? [], selection.keys);
  const busy = restore.isPending || purge.isPending;
  const disabled = selectedIds.length === 0 || busy;
  const end = () => updateSelection({ type: "end" });

  async function exclusive(run: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await run();
    } finally {
      busyRef.current = false;
    }
  }

  /**
   * 動作成功：結束選取、焦點交給發起那一份的「選取」鈕。動作鈕一結束就卸載、「選取」鈕要等 `TrashPanel` 重繪才出現，
   * 所以 `flushSync` 讓它在同一個 task 內 commit 再找（rAF 要多等一幀，那一幀的按鍵會落到 body）。
   * 焦點原本在這份實例裡（或已落 body：被按的鈕、確認框已卸載）才拉回；等回應期間使用者已移到別處就不搶。
   */
  function finish(shell: Element | null): void {
    if (!mountedRef.current) return;
    flushSync(end);
    const active = document.activeElement;
    if (active === null || active === document.body || shell?.contains(active)) shell?.querySelector<HTMLButtonElement>(SIDEBAR_SELECT_BUTTON)?.focus();
  }

  function onRestore(event: MouseEvent<HTMLButtonElement>): void {
    const shell = event.currentTarget.closest("[data-sidebar-instance]");
    const ids = selectedIds;
    void exclusive(async () => {
      try {
        toastTrashResult("restore", await restore.mutateAsync(ids), t);
      } catch (err) {
        toastTrashFailure("restore", err, t);
        return;
      }
      finish(shell);
    });
  }

  function onPurge(event: MouseEvent<HTMLButtonElement>): void {
    openerRef.current = event.currentTarget;
    shellRef.current = event.currentTarget.closest("[data-sidebar-instance]");
    setConfirmOpen(true);
  }

  const purgeDialog = (
    <PurgeConfirmDialog
      count={selectedIds.length}
      open={confirmOpen}
      pending={purge.isPending}
      onConfirm={() => {
        const ids = selectedIds;
        // 開框後清單重抓、選的全不在了：不送空請求、不報「已永久刪除 0 篇」，直接關框。
        if (ids.length === 0) {
          setConfirmOpen(false);
          return;
        }
        const shell = shellRef.current;
        void exclusive(async () => {
          let ok = false;
          try {
            toastTrashResult("purge", await purge.mutateAsync(ids), t);
            ok = true;
          } catch (err) {
            toastTrashFailure("purge", err, t);
          }
          // 成敗都關（讀碼發現 23）。送出中取消了框也不會重開到別的對象：動作鈕在 pending 時 disabled。
          setConfirmOpen(false);
          if (ok) finish(shell);
        });
      }}
      onOpenChange={setConfirmOpen}
      // 沒有 DialogTrigger：Radix 關框時聚焦的 triggerRef 是空的，焦點會落 body。取消或失敗時開框鈕還在，焦點還給它；
      // 成功時 finish 已聚焦「選取」、開框鈕已卸載，這裡不動。
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (openerRef.current?.isConnected) openerRef.current.focus();
      }}
    />
  );

  return { selectedIds, disabled, busy, onRestore, onPurge, purgeDialog };
}

/** 窄形：底部動作列「還原」（主色，總管裁定 ⑩）「永久刪除」（紅字），各帶圖示。 */
function TrashActionBar() {
  const { t } = useTranslation();
  const { disabled, onRestore, onPurge, purgeDialog } = useTrashSelectionActions();
  const { endSelectionIfActive } = useSidebarTabActions();

  /**
   * 靜態卡底部的 Esc（動作列不在 TrashPanel 的根底下）。抽屜裡的 Esc 由 AppShell 的 `onEscapeKeyDown`（Radix 在 document
   * capture 先處理）結束選取並交焦點；真瀏覽器在那之後、React 的 onKeyDown 之前就 commit，動作列已卸載，這裡收不到。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    const shell = event.currentTarget.closest("[data-sidebar-instance]");
    let ended = false;
    flushSync(() => {
      ended = endSelectionIfActive();
    });
    if (ended) {
      event.preventDefault(); // 這一下 Esc 只結束選取（搜尋標記的 Esc 監聽看到 defaultPrevented 就讓路）
      shell?.querySelector<HTMLButtonElement>(SIDEBAR_SELECT_BUTTON)?.focus();
    }
  }

  return (
    <>
      <div className="m-2 flex gap-1" onKeyDown={handleKeyDown}>
        <Button type="button" variant="brand" className="flex-1" disabled={disabled} onClick={onRestore}>
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          {t("trash.restore")}
        </Button>
        {/* 不用 outline：它的 hover 填 brand-deep，紅字壓深色底不對；hover 同 row-actions.ts 的 ROW_ICON_DANGER。 */}
        <Button
          type="button"
          variant="ghost"
          className="flex-1 border border-input text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={disabled}
          onClick={onPurge}
        >
          <Trash aria-hidden="true" className="h-4 w-4" />
          {t("trash.purge")}
        </Button>
      </div>
      {/* 放在動作列的 div 外：確認框內的 Esc 只關框，不經 React 樹冒泡到上面的 onKeyDown 結束選取。 */}
      {purgeDialog}
    </>
  );
}

/**
 * 寬形（spec §6.10.2 rev 4.3）：`TrashPanel` 標題列裡的「還原」「永久刪除」兩顆 24px 純圖示鈕（可及名稱＝hover 提示＝原按鈕字；
 * 外觀同一般 tab 的 `SelectActionBar` toolbar 形）＋永久刪除確認框。`TrashPanel` 只在選取中渲染它（`mountedRef` 守衛靠這一點）。
 * 確認框內的 Esc 經 React 樹（portal）冒泡到 `TrashPanel` 根，由它的 `handleKeyDown` 開頭濾掉：只關框、不結束選取。
 */
export function TrashWideToolbar() {
  const { t } = useTranslation();
  const { disabled, busy, onRestore, onPurge, purgeDialog } = useTrashSelectionActions();
  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5" data-select-action-bar="" aria-busy={busy}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("trash.restore")}
          title={t("trash.restore")}
          disabled={disabled}
          onClick={onRestore}
          className="h-6 w-6 shrink-0"
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("trash.purge")}
          title={t("trash.purge")}
          disabled={disabled}
          onClick={onPurge}
          className="h-6 w-6 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
      {purgeDialog}
    </>
  );
}
