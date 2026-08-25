import { useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteNote } from "@/api/notes";
import { isTerminal, type CollabState } from "@/collab/connection";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EllipsisVertical, Link as LinkIcon, Trash } from "@/components/ui/icons";
import { ManualCopyField } from "@/components/ManualCopyField";
import { toast } from "@/components/ui/toast";

/** ApiFail → errors.<code>；其餘 → errors.fallback。與 NoteList/ShareDialog 同一套對映
 * （各檔各自一份，是既有慣例）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

export interface NoteMenuProps {
  note: NoteDto;
  /** 目前的共編連線狀態——刪除失敗時用來判斷是否已進終態（見下方 handler 的說明）。 */
  state: CollabState;
  /** `NotePage` 既有的離場閘門（`useRef<boolean>`）：共編 `deleted` 終態與「自己按
   * ⋮ 刪除」是兩條可能同時成立的離場路徑，共用同一道閘門才不會噴兩次 toast、
   * 導兩次頁。⋮ 由 `NotePage` 組裝，直接拿同一個 ref 用，不新建一份。 */
  leavingRef: RefObject<boolean>;
}

/**
 * 內文卡頁頭的 ⋮ 選單（spec D.4）：複製連結（任何角色）＋刪除筆記（owner-only）。
 *
 * **focus trap 雷（rev5 定案，⚠ 改動前必讀）**：Radix `DropdownMenu` 預設是 modal，
 * 跟 `Dialog` 共用同一套 `FocusScope` 搶焦點；`lib/clipboard.ts` 的 `execCommand`
 * 退路只認 `[role="dialog"],[role="menu"]` 這兩種 host（該檔已同步擴充）。若複製項
 * 的 `onSelect` 讓選單照 Radix 預設行為關閉，`document.activeElement` 會落在別處，
 * `execCommand` 大概率在沒有焦點的 textarea 上跑而靜默失敗。因此：
 * 1. 複製項 `onSelect` 帶 `event.preventDefault()`——選單保持開啟；
 * 2. handler 內同步 `await copyText(...)`（此時選單仍是目前的焦點所在，
 *    `closest('[role="menu"]')` 找得到它）；
 * 3. 複製完（不論成敗）才手動關選單（`setMenuOpen(false)`）。
 * `DropdownMenu` 本體因此改 controlled（`open`/`onOpenChange`），不能用 Radix 的
 * 非受控預設行為。
 *
 * **與共編 `deleted` 終態的互動（M11，⚠ review 修正——舊版方向反了，見下）**：
 * server 的 `beforeNoteDeleted` 會先關掉發起者自己的連線，`close(NOTE_DELETED)`
 * 可能**早於** DELETE 的 HTTP 回應抵達。刪除 handler：
 * - 確認後**先** `leavingRef.current = true`，**再** `await deleteNote.mutateAsync`；
 * - 成功：不另發成功 toast（跟改版前側欄刪除一致，導頁即回饋）→ 無條件
 *   `navigate("/",{replace:true})`；
 * - **失敗且已進終態**：`NotePage` 的終態 effect 是被 `leavingRef.current` 閘住的
 *   （`if (!isTerminal(state) || leavingRef.current) return;`）——這支 handler
 *   在函式開頭就已經把它設成 `true`，那個 effect **永遠不會再觸發**。「終態 effect
 *   會接手」是假話：不自己補一套出口就是死頁（無 toast、無導頁、卡在刪除中）。
 *   因此這裡必須**就地**複製 `NotePage` 終態出口的同一套文案／終點：
 *   `kicked`→`note.accessRevoked`、其餘→`note.deleted`，destructive toast，
 *   `navigate("/",{replace:true})`；`leavingRef` 維持 `true`（本來就該離開）。
 * - **失敗且非終態**：把 `leavingRef` 撥回 `false`（不然既有的錯誤 toast 映射會被
 *   閘門吃掉，變成死頁）再顯示錯誤 toast，**不導頁**。
 * - 判斷終態用的是 `stateRef.current`（每次 render 同步寫入的 ref），不是
 *   `state` 這個 closure 參數本身：`close(NOTE_DELETED)` 常常早於 DELETE 回應
 *   抵達，`handleConfirmDelete` 這個 closure 建立當下捕捉到的 `state` 大概率還
 *   是呼叫當時的 `connected`，直接讀它會誤判成「非終態」而走錯分支。
 */
export function NoteMenu({ note, state, leavingRef }: NoteMenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const deleteNote = useDeleteNote();

  // 每次 render 同步寫入——`handleConfirmDelete` 的 catch 分支讀最新值，避開
  // stale closure（見上方檔頭「判斷終態用的是 stateRef.current」的說明）。
  const stateRef = useRef(state);
  stateRef.current = state;

  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);

  async function handleCopyLink(): Promise<void> {
    const url = `${window.location.origin}${canonicalNotePath(note)}`;
    const copied = await copyText(url);
    setMenuOpen(false);
    if (copied) {
      toast({ title: t("share.linkCopied") });
      return;
    }
    setManualCopyUrl(url);
  }

  async function handleConfirmDelete(): Promise<void> {
    leavingRef.current = true;
    try {
      await deleteNote.mutateAsync(note.id);
      setDeleteOpen(false);
      void navigate("/", { replace: true });
    } catch (err) {
      setDeleteOpen(false);
      const currentState = stateRef.current;
      if (isTerminal(currentState)) {
        // `NotePage` 的終態 effect 被 `leavingRef.current` 閘住——上面已經把它設成
        // true，那個 effect 不會再觸發，這裡必須自己補同一套出口（同文案同終點），
        // 否則就是死頁。`leavingRef` 維持 true：這個分支本來就該離開。
        toast({
          title: currentState.phase === "kicked" ? t("note.accessRevoked") : t("note.deleted"),
          variant: "destructive",
        });
        void navigate("/", { replace: true });
        return;
      }
      leavingRef.current = false;
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={t("note.menu.label")}>
            <EllipsisVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void handleCopyLink();
            }}
          >
            <LinkIcon className="mr-2 h-4 w-4" />
            {t("share.copyLink")}
          </DropdownMenuItem>
          {note.role === "owner" && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
            >
              <Trash className="mr-2 h-4 w-4" />
              {t("note.menu.delete")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 複製失敗的手動退路——DialogTitle 用 share.copyLink（Radix 必填，沿用選單項
          同一把文案，避免無意義的新 key）。 */}
      <Dialog open={manualCopyUrl !== null} onOpenChange={(open) => !open && setManualCopyUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("share.copyLink")}</DialogTitle>
          </DialogHeader>
          {manualCopyUrl !== null && <ManualCopyField value={manualCopyUrl} />}
        </DialogContent>
      </Dialog>

      {/* 刪除確認——文案沿用既有 home.* key（跟改版前的側欄刪除鈕同一套）。 */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("home.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("home.deleteDescription", { title: note.title })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleConfirmDelete()}
              disabled={deleteNote.isPending}
            >
              {t("home.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
