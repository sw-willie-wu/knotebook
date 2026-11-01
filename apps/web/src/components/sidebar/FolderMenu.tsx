import { useId, useRef, useState, type ReactElement, type SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { FOLDER_DEPTH_MAX, type FolderDto } from "@knotebook/shared";
import type { FolderDialogRequest } from "@/components/NoteList";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, EllipsisVertical, FilePlus, FolderPlus, Pencil, Trash } from "@/components/ui/icons";
import { hoverReveal } from "@/components/ui/reveal";
import { cn } from "@/lib/utils";
import { setFolderSort, useFolderSort, type FolderSort } from "./folder-sort";

/** 排序列樣式照 `NoteWidthMenu`（RadioItem 是不帶樣式的最小包裝）。 */
const RADIO_ROW =
  "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none " +
  "transition-colors focus:bg-accent focus:text-accent-foreground";
const SORTS: readonly { value: FolderSort; key: "sortName" | "sortRecent" | "sortSize" }[] = [
  { value: "name", key: "sortName" },
  { value: "recent", key: "sortRecent" },
  { value: "size", key: "sortSize" },
];

function isFolderSort(value: string): value is FolderSort {
  return value === "name" || value === "recent" || value === "size";
}

/**
 * 一個選單項：可執行時是一般項；不可執行（`blockedReason` 有值）時**不用** Radix 的 `disabled`（disabled 項不在方向鍵焦點序裡，
 * 鍵盤與讀屏使用者聽不到說明）——改 `aria-disabled`、`onSelect` 只 `preventDefault`（不關選單、不開框），名稱只有項目名
 * （`aria-labelledby`），說明只在描述裡唸一次（`aria-describedby`）。plan Rev 2 M-7。
 */
function MenuAction({
  icon: Icon,
  label,
  blockedReason,
  destructive = false,
  disabled = false,
  onRun,
}: {
  icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
  label: string;
  blockedReason: string | null;
  destructive?: boolean;
  /** 暫時不能按（例如建立中），沒有說明：用 Radix 的 disabled（同列上的「＋」）。 */
  disabled?: boolean;
  onRun: () => void;
}) {
  const nameId = useId();
  const descId = useId();
  const blocked = blockedReason !== null;
  return (
    <DropdownMenuItem
      disabled={disabled}
      // 明確傳 aria-disabled 會蓋掉 Radix 在 disabled 時自己設的值，所以兩種情形都要帶。
      aria-disabled={blocked || disabled ? "true" : undefined}
      aria-labelledby={blocked ? nameId : undefined}
      aria-describedby={blocked ? descId : undefined}
      className={cn("aria-disabled:opacity-50", destructive && "text-destructive focus:text-destructive")}
      onSelect={(event) => {
        event.preventDefault();
        if (blocked) return;
        onRun();
      }}
    >
      <Icon aria-hidden="true" className="mr-2 h-4 w-4 shrink-0 self-start mt-0.5" />
      <span className="flex min-w-0 flex-col">
        <span id={blocked ? nameId : undefined}>{label}</span>
        {blocked && (
          <span id={descId} className="text-xs text-muted-foreground">
            {blockedReason}
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * 刪除／移除項：當作 `DropdownMenuContent` 的子元件，`hasLiveNotes()` 在這裡才呼叫——Radix 只在選單打開與退場動畫期間掛載 content，
 * 所以選單關著時不掃筆記；打開期間快取變了照樣重算。不能在 FolderMenu 本體算成 prop（每次渲染都會跑），也不能用 `open &&` 擋
 * （退場動畫期間會閃回可執行）。
 */
function DeleteAction({ folder, hasLiveNotes, onRun }: { folder: FolderDto; hasLiveNotes: () => boolean; onRun: () => void }) {
  const { t } = useTranslation();
  const blocked = !folder.permissions.deleteNotes && hasLiveNotes();
  return (
    <MenuAction
      icon={Trash}
      label={folder.space.kind === "shared" ? t("folders.menu.remove") : t("folders.menu.delete")}
      blockedReason={blocked ? t("folders.menu.deleteBlocked") : null}
      destructive
      onRun={onRun}
    />
  );
}

/**
 * 資料夾列 ⋮（資料夾 spec §6.5；稿 `FolderMenu`）。24px、hover 浮出（`hoverReveal("folderrow")`）；controlled DropdownMenu，
 * 選單項三步形（`preventDefault` → 關選單 → 動作；GroupMenu／NoteMenu 檔頭的 focus trap 規矩）。對話框由 NoteList 的 host 開
 * （`onRequest` 帶 ⋮ 當還焦點的對象）；排序選了不關選單（radio 可連續看效果）。首包模組：不 import 字串包。
 */
export function FolderMenu({
  folder,
  depth,
  hasLiveNotes,
  onCreateNote,
  createNotePending = false,
  onRequest,
}: {
  folder: FolderDto;
  /** 節點的 depth（根層＝1）；≥ FOLDER_DEPTH_MAX → 新增子資料夾不可執行。 */
  depth: number;
  /** 只在選單內容掛載時（打開與退場動畫期間）由 `DeleteAction` 呼叫，避免每列每次渲染都掃一遍筆記。 */
  hasLiveNotes: () => boolean;
  onCreateNote: () => void;
  /** 建立中：「新增筆記」暫時不能按（比照列上的「＋」）。 */
  createNotePending?: boolean;
  onRequest: (request: FolderDialogRequest, opener: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sort = useFolderSort(folder.id);
  const sortLabelId = useId();
  const { permissions } = folder;
  const shared = folder.space.kind === "shared";
  const showNewNote = permissions.createNote && !shared;
  const showManage = permissions.manage;

  function run(action: () => void): void {
    setOpen(false);
    action();
  }

  /**
   * 開對話框的項目：選單關閉時不把焦點還給 ⋮。對話框（chunk 已快取時）會在選單卸載前就掛上並把焦點給輸入框，
   * Radix 選單卸載時的還焦點再把它搶回 ⋮（真 Chromium 重現：第二次開框起輸入框都失焦）。關框後焦點回 ⋮ 由 host 的 `returnFocusRef` 負責。
   */
  const openingDialogRef = useRef(false);
  function openDialog(request: FolderDialogRequest): void {
    openingDialogRef.current = true;
    run(() => onRequest(request, triggerRef.current));
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("folders.menu.label", { name: folder.name })}
          className={cn("h-6 w-6 shrink-0", hoverReveal("folderrow"))}
        >
          <EllipsisVertical aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (!openingDialogRef.current) return;
          openingDialogRef.current = false;
          event.preventDefault();
        }}
      >
        {showNewNote && (
          <MenuAction icon={FilePlus} label={t("folders.menu.newNote")} blockedReason={null} disabled={createNotePending} onRun={() => run(onCreateNote)} />
        )}
        {showManage && (
          <MenuAction
            icon={FolderPlus}
            label={t("folders.menu.newSubfolder")}
            blockedReason={depth >= FOLDER_DEPTH_MAX ? t("folders.menu.depthLimit", { max: FOLDER_DEPTH_MAX }) : null}
            onRun={() => openDialog({ kind: "create", parent: { folderId: folder.id } })}
          />
        )}
        {showManage && (
          <MenuAction
            icon={Pencil}
            label={t("folders.menu.rename")}
            blockedReason={null}
            onRun={() => openDialog({ kind: "rename", folder })}
          />
        )}
        {(showNewNote || showManage) && <DropdownMenuSeparator />}
        <DropdownMenuLabel id={sortLabelId} className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
          {t("folders.menu.sortBy")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value) => {
            if (isFolderSort(value)) setFolderSort(folder.id, value);
          }}
          aria-labelledby={sortLabelId}
        >
          {SORTS.map(({ value, key }) => (
            <DropdownMenuRadioItem key={value} value={value} className={RADIO_ROW} onSelect={(event) => event.preventDefault()}>
              <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                <DropdownMenuItemIndicator>
                  <Check className="h-4 w-4" />
                </DropdownMenuItemIndicator>
              </span>
              {t(`folders.menu.${key}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {showManage && <DropdownMenuSeparator />}
        {showManage && (
          <DeleteAction folder={folder} hasLiveNotes={hasLiveNotes} onRun={() => openDialog({ kind: "delete", folder })} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
