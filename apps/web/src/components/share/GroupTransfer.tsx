import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { useConfirmNoteStillPersonal, useCopyNote, useMoveNoteToGroup } from "@/api/note-move";
import { usePublicLink } from "@/api/public-link";
import { useShares } from "@/api/shares";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronDown } from "@/components/ui/icons";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";

/** ApiFail → errors.<code>；其餘 → errors.fallback（逐檔各寫一份是 repo 慣例，見 ShareDialog.tsx）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

export type GroupTransferKind = "move" | "copy";

/** 目標：某個群組（移動／複製進去）、個人空間（複製到我的筆記）、或就地建立副本（群組筆記複製進它自己的群組）。 */
export type TransferTarget =
  | { type: "group"; group: GroupDto }
  | { type: "inPlace"; group: GroupDto }
  | { type: "personal" };

export interface GroupTransferPick {
  kind: GroupTransferKind;
  target: TransferTarget;
}

export interface TransferOption {
  key: string;
  label: string;
  target: TransferTarget;
}

type Translate = (key: string) => string;

/** 與側欄群組「＋」同一條規則（`NoteList`）：角色同時有新建與編輯。 */
function canCreateAndEdit(group: GroupDto): boolean {
  return group.myRole?.permissions.create === true && group.myRole.permissions.edit === true;
}

/**
 * #216（Willie 2026-10-08 定案）：⋮ 選單的「移動到…」「複製到…」第二層清單。**純函式**，目標清單＝個人空間＋群組，
 * 之後要加目標只改這裡。群組候選一律要 create 且 edit（與側欄「＋」同規則）：
 * - 自己的個人筆記：移動＝候選群組；複製＝「建立副本」（個人空間）＋候選群組。
 * - 群組筆記：不能移動；複製＝「建立副本」（原群組，我在該群組需 create＋edit）、「個人空間」、其餘候選群組。
 *   只讀成員（無 create／edit）看不到「建立副本」，仍有「個人空間」。
 * - 別人分享給我的個人筆記（viewer 或 editor，「看得到就能複製」）：複製到「個人空間」＋候選群組；不能移動。
 * 空清單 → 該項整個不渲染。server 對每個目標都收（`POST /copy` 無 groupId＝個人、群組要成員＋can_create；
 * 移動只收個人筆記 owner），UI 只比 server 更嚴。
 */
export function buildTransferOptions(
  note: NoteDto,
  groups: GroupDto[],
  t: Translate,
): { move: TransferOption[]; copy: TransferOption[] } {
  const usable = groups.filter(canCreateAndEdit);
  const asGroup = (group: GroupDto): TransferOption => ({
    key: `g:${group.id}`,
    label: group.name,
    target: { type: "group", group },
  });
  const isGroupNote = note.groupId !== null;
  const isOwnPersonal = !isGroupNote && note.permissions.moveToGroup;
  if (isOwnPersonal) {
    return {
      move: usable.map(asGroup),
      copy: [{ key: "personal", label: t("note.menu.makeCopy"), target: { type: "personal" } }, ...usable.map(asGroup)],
    };
  }
  if (isGroupNote) {
    const current = usable.find((group) => group.id === note.groupId);
    return {
      move: [],
      copy: [
        ...(current ? [{ key: "inPlace", label: t("note.menu.makeCopy"), target: { type: "inPlace" as const, group: current } }] : []),
        { key: "personal", label: t("note.menu.personalSpace"), target: { type: "personal" as const } },
        ...usable.filter((group) => group.id !== note.groupId).map(asGroup),
      ],
    };
  }
  // 別人分享給我的個人筆記（viewer 或 editor）：看得到就能複製——個人空間，再加我 create＋edit 的群組；不能移動。
  return {
    move: [],
    copy: [{ key: "personal", label: t("note.menu.personalSpace"), target: { type: "personal" } }, ...usable.map(asGroup)],
  };
}

/**
 * #216：⋮ 選單的「移動到…」「複製到…」（原分享面板「搬入群組」列 `MoveToGroupSection` 的搬家，邏輯沿用；選項規則見
 * `buildTransferOptions`）。群組清單來自 `useGroups()`（載入中／失敗時只剩不需要群組的選項）。
 * 子選單用 Radix `Sub`：滑鼠 hover、觸控／點擊、方向鍵右進左出、Esc 例外，見 `GroupSub`；`SubContent` 走 Portal
 * （見 `ui/dropdown-menu.tsx`），不被父層 `overflow-hidden` 裁掉，貼近視窗邊緣時 Radix 自動翻邊。
 */
export function useTransferOptions(note: NoteDto): { move: TransferOption[]; copy: TransferOption[] } {
  const { t } = useTranslation();
  const groupsQuery = useGroups();
  return buildTransferOptions(note, groupsQuery.data ?? [], t);
}

/**
 * 群組清單的展開形（Willie 2026-10-08）：**窄視窗或觸控** -> 就地向下展開（手風琴，項目縮排在觸發項下方，同一個選單內，
 * 不會被抽屜／視窗邊緣裁切）；**寬且可 hover** -> 右側 flyout（Radix Sub）。
 * 判準沿用 repo 既有的兩個界線：窄＝`(width < 48rem)`（`AppShell.NARROW_QUERY`、`max-md:`）；觸控＝`(hover: none)`
 * （`ui/reveal.ts`、`NoteList` 的觸控常駐判準）。兩者任一成立即就地展開。jsdom 預設 matchMedia 恆 false -> flyout 形。
 */
export const INLINE_GROUP_LIST_QUERY = "(width < 48rem), (hover: none)";

export function useInlineGroupList(): boolean {
  const read = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(INLINE_GROUP_LIST_QUERY).matches;
  const [inline, setInline] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(INLINE_GROUP_LIST_QUERY);
    const onChange = () => setInline(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return inline;
}

/** 就地展開形的一組：觸發項（Enter／Space／右鍵展開或收合，左鍵收合）＋縮排的群組項（同一個 menu 的一般項，上下鍵照常漫遊）。
 * Esc 的收合由 `NoteMenu` 的 `onEscapeKeyDown` 接（見 `GroupTransferMenuItems` 的 `expanded` 說明）。 */
function GroupInline({
  label,
  options,
  open,
  onOpenChange,
  onPick,
  testId,
  triggerRef,
}: {
  label: string;
  options: TransferOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (target: TransferTarget) => void;
  testId: string;
  triggerRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <>
      <DropdownMenuItem
        ref={triggerRef}
        data-testid={testId}
        aria-expanded={open}
        onSelect={(event) => {
          event.preventDefault(); // 選單保持開著，只切換展開
          onOpenChange(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !open) {
            event.preventDefault();
            onOpenChange(true);
          } else if (event.key === "ArrowLeft" && open) {
            event.preventDefault();
            onOpenChange(false);
          }
        }}
      >
        {label}
        <ChevronDown className={"ml-auto h-4 w-4 transition-transform" + (open ? " rotate-180" : "")} />
      </DropdownMenuItem>
      {open && (
        <DropdownMenuGroup aria-label={label}>
          {options.map((option) => (
            <DropdownMenuItem
              key={option.key}
              className="pl-6"
              onSelect={() => onPick(option.target)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  onOpenChange(false);
                }
              }}
            >
              <span className="truncate">{option.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      )}
    </>
  );
}

function GroupSub({
  label,
  options,
  onPick,
  testId,
}: {
  label: string;
  options: TransferOption[];
  onPick: (target: TransferTarget) => void;
  testId: string;
}) {
  // 受控：Radix 的 SubContent 對 Esc 呼叫的是 root 的 onClose（整個選單關掉，實測），不是「返回上一層」。
  // 所以自己接 Esc——只關第二層、焦點回子選單觸發項；方向鍵左與 hover 離開仍走 Radix 原生。
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger ref={triggerRef} data-testid={testId}>
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }}
        className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] max-w-[min(18rem,calc(100vw-2rem))] overflow-y-auto"
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.key}
            onSelect={() => {
              onPick(option.target);
            }}
          >
            <span className="truncate">{option.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** 放進 `DropdownMenuContent` 的兩個子選單項；選定群組只回報（`onPick`），確認框由呼叫端掛 `GroupTransferDialog`。 */
export function GroupTransferMenuItems({
  note,
  onPick,
  expanded,
  onExpandedChange,
}: {
  note: NoteDto;
  onPick: (pick: GroupTransferPick) => void;
  /** 就地展開形（窄／觸控）目前展開的是哪一組；狀態由 `NoteMenu` 持有，因為 Esc 要在 `DropdownMenuContent` 的
   * `onEscapeKeyDown` 裡先收合、不關整個選單（Radix 的 Esc 監聽在 document，從項目的 onKeyDown 擋不住）。flyout 形不用它。 */
  expanded: GroupTransferKind | null;
  onExpandedChange: (kind: GroupTransferKind | null) => void;
}) {
  const { t } = useTranslation();
  const options = useTransferOptions(note);
  const inline = useInlineGroupList();
  const triggers = useRef<Partial<Record<GroupTransferKind, HTMLDivElement | null>>>({});
  const prevExpanded = useRef<GroupTransferKind | null>(null);
  // 收合（尤其 Esc）後焦點原本在被卸載的群組項上 -> 還給觸發項，鍵盤不掉出選單。
  useEffect(() => {
    const prev = prevExpanded.current;
    prevExpanded.current = expanded;
    if (prev !== null && expanded === null) {
      const el = triggers.current[prev];
      const active = document.activeElement;
      if (el && !(active && active.closest('[role="menuitem"]'))) el.focus();
    }
  }, [expanded]);
  const kinds: Array<{ kind: GroupTransferKind; label: string; testId: string; options: TransferOption[] }> = [
    { kind: "move" as const, label: t("note.menu.moveTo"), testId: "note-menu-move-to", options: options.move },
    { kind: "copy" as const, label: t("note.menu.copyTo"), testId: "note-menu-copy-to", options: options.copy },
  ].filter((entry) => entry.options.length > 0);
  return (
    <>
      {kinds.map(({ kind, label, testId, options: kindOptions }) =>
        inline ? (
          <GroupInline
            key={kind}
            label={label}
            testId={testId}
            options={kindOptions}
            open={expanded === kind}
            onOpenChange={(open) => onExpandedChange(open ? kind : null)}
            onPick={(target) => onPick({ kind, target })}
            triggerRef={(el) => {
              triggers.current[kind] = el;
            }}
          />
        ) : (
          <GroupSub
            key={kind}
            label={label}
            testId={testId}
            options={kindOptions}
            onPick={(target) => onPick({ kind, target })}
          />
        ),
      )}
    </>
  );
}

/**
 * 選定群組後的確認框（原行內確認的 Dialog 版，文案與規則不變）。PR1 交接的不變量：
 * - **移動**（`MoveDialog`）確認列出會失去存取的逐人分享對象、有 token 時說公開連結會關、恆說網址會變與擁有權移交；提交鈕
 *   `destructive`。**shares 與 public-link 兩支都成功之前提交鈕停用**（資料不明時文案會低報被移除的人）。
 *   shares／public-link 的查詢**只由 `MoveDialog` 發**（複製不需要，且在群組筆記／別人分享給我的筆記上會 403 重試）。
 * - 送出前檢查（`useConfirmNoteStillPersonal`）：重讀到已不是我能移動的個人筆記 -> 不送、發 `changedElsewhere` toast。
 *   ⚠ 那支 hook 每次 render 回傳新函式——只在送出 handler 裡直接呼叫，**不得**放進任何 effect 的 deps。
 * - 移動成功：hook 先寫 shares／public-link 再寫 `['note', id]`（順序契約在 `api/note-move.ts`），之後的頁面只讀回應的
 *   `role`／`permissions`，不假設搬完能編輯。
 * - **複製**（`CopyDialog`）確認「原筆記不變」，提交鈕 `outline`；成功 toast 附「前往副本」（altText 鍵 `share.move.openCopyAlt`）。
 * - 失敗一律 toast（`errors.<code>`）並關框——選單已關，沒有別處可放行內訊息。送出中（含送出前檢查）鈕停用、框不可關閉，
 *   避免重送出第二份副本。
 * - 關框後焦點回 `returnFocusRef`（呼叫端的 ⋮ 觸發鈕）：Radix 的還焦點靠 `DialogTrigger`，這裡沒有，會掉到 body。
 */
interface DialogShellProps {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  footer: ReactNode;
}

function DialogShell({ title, description, busy, onClose, returnFocusRef, children, footer }: DialogShellProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        dismissOnOutside={false}
        data-testid="group-transfer-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef?.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TransferDialogProps {
  note: NoteDto;
  target: TransferTarget;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function MoveDialog({ note, target, onClose, returnFocusRef }: TransferDialogProps) {
  const group = target.type === "personal" ? null : target.group;
  const { t, i18n } = useTranslation();
  const sharesQuery = useShares(note.id);
  const linkQuery = usePublicLink(note.id);
  const move = useMoveNoteToGroup(note.id);
  const confirmStillPersonal = useConfirmNoteStillPersonal(note.id);
  const [submitting, setSubmitting] = useState(false);

  const busy = submitting || move.isPending;
  const dataKnown = sharesQuery.isSuccess && linkQuery.isSuccess;
  const shares = sharesQuery.data ?? [];
  const token = linkQuery.data?.token ?? null;
  const names = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(
    shares.map((share) => share.displayName),
  );

  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      if (!(await confirmStillPersonal())) {
        toast({ title: t("share.move.changedElsewhere") });
        return;
      }
      if (group === null) return;
      await move.mutateAsync(group.id);
      toast({ title: t("share.move.movedToGroup", { group: group.name }) });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <DialogShell
      title={t("share.move.moveSubmit")}
      description={t("share.move.moveLead", { group: group?.name ?? "" })}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={busy || !dataKnown} onClick={() => void submit()}>
            {t("share.move.moveSubmit")}
          </Button>
        </>
      }
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {shares.length > 0 && <li>{t("share.move.moveRemovesPeople", { count: shares.length, names })}</li>}
        {token && <li>{t("share.move.moveClosesPublicLink")}</li>}
        <li>{t("share.move.moveUrlChange")}</li>
        <li>{t("share.move.moveOwnership")}</li>
      </ul>
    </DialogShell>
  );
}

function CopyDialog({ note, target, onClose, returnFocusRef }: TransferDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const copy = useCopyNote(note.id);
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || copy.isPending;
  // 自己的個人筆記複製到個人空間＝選單上的「建立副本」，確認框標題／按鈕同字；其餘來源是「複製到我的筆記」。
  const duplicate = note.groupId === null && note.permissions.moveToGroup;
  const submitLabel =
    target.type === "group"
      ? t("share.move.copySubmit")
      : target.type === "inPlace" || duplicate
        ? t("share.move.copyHereSubmit")
        : t("share.move.copyPersonalSubmit");
  const lead =
    target.type === "group"
      ? t("share.move.copyLead", { group: target.group.name })
      : target.type === "inPlace"
        ? t("share.move.copyLeadInPlace", { group: target.group.name })
        : t("share.move.copyLeadPersonal");

  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      const created = await copy.mutateAsync(target.type === "personal" ? undefined : target.group.id);
      toast({
        title: target.type === "personal" ? t("share.move.copiedToPersonal") : t("share.move.copiedToGroup", { group: target.group.name }),
        action: {
          label: t("share.move.openCopy"),
          altText: t("share.move.openCopyAlt"),
          onClick: () => void navigate(canonicalNotePath(created)),
        },
      });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <DialogShell
      title={submitLabel}
      description={lead}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    />
  );
}

export function GroupTransferDialog({
  note,
  pick,
  onClose,
  returnFocusRef,
}: {
  note: NoteDto;
  pick: GroupTransferPick;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const Body = pick.kind === "move" ? MoveDialog : CopyDialog;
  return <Body note={note} target={pick.target} onClose={onClose} returnFocusRef={returnFocusRef} />;
}
