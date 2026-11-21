import { useId, useRef, useState, type ReactElement, type SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { FOLDER_DEPTH_MAX, type FolderDto } from "@knotebook/shared";
import type { FolderDialogRequest } from "@/components/NoteList";
import { Button } from "@/components/ui/button";
import { ROW_ICON_HIT } from "@/components/ui/hit-area";
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
import { Check, EllipsisVertical, FilePlus, FolderPlus, Library, Pencil, Trash } from "@/components/ui/icons";
import { hoverReveal } from "@/components/ui/reveal";
import { cn } from "@/lib/utils";
import { setFolderSort, useFolderSort, type FolderSort } from "./folder-sort";

/** Sort row styling follows `DropdownMenuCheckboxItem` (RadioItem is an unstyled minimal wrapper). */
const RADIO_ROW =
  "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm outline-none " +
  "transition-colors focus:bg-accent focus:text-accent-foreground";
const SORTS: readonly { value: FolderSort; key: "sortName" | "sortRecent" | "sortSize" }[] = [
  { value: "name", key: "sortName" },
  { value: "recent", key: "sortRecent" },
  { value: "size", key: "sortSize" },
];

function isFolderSort(value: string): value is FolderSort {
  return value === "name" || value === "recent" || value === "size";
}

/** Blocked items use `aria-disabled` and a `preventDefault`-only `onSelect`, not Radix `disabled`: disabled items are outside the arrow-key focus order, so keyboard and screen-reader users would never hear the reason. */
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
  disabled?: boolean;
  onRun: () => void;
}) {
  const nameId = useId();
  const descId = useId();
  const blocked = blockedReason !== null;
  return (
    <DropdownMenuItem
      disabled={disabled}
      // An explicit aria-disabled overrides the value Radix sets itself when disabled, so both cases must pass it.
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

/** Child of `DropdownMenuContent` so `hasLiveNotes()` runs only while Radix has the content mounted (open and exit animation): not in FolderMenu itself (every render), not `open &&` (flashes enabled during the exit animation). */
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

/** First-bundle module: no string-bundle import. Controlled menu; items follow the three-step pattern (`preventDefault` → close menu → action) of the GroupMenu/NoteMenu focus-trap rule. The dialogs are opened by NoteList's host (`onRequest` carries ⋮ as the focus-return target). Sort radio items `preventDefault` on select so the menu stays open to compare sorts. */
export function FolderMenu({
  folder,
  indexPath,
  depth,
  hasLiveNotes,
  onCreateNote,
  createNotePending = false,
  onRequest,
}: {
  folder: FolderDto;
  /** Set only when the folder's subtree has knowledge. */
  indexPath?: string;
  /** Folder depth (root level = 1); at or above FOLDER_DEPTH_MAX "new subfolder" is unavailable. */
  depth: number;
  hasLiveNotes: () => boolean;
  onCreateNote: () => void;
  createNotePending?: boolean;
  onRequest: (request: FolderDialogRequest, opener: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
   * Dialog-opening items don't return focus to ⋮ on close: the dialog (chunk cached) mounts and focuses its input before the menu unmounts,
   * and Radix's focus return would steal it back (reproduced in Chromium). The host's `returnFocusRef` restores focus after the dialog closes.
   */
  const openingDialogRef = useRef(false);
  function openDialog(request: FolderDialogRequest): void {
    openingDialogRef.current = true;
    run(() => onRequest(request, triggerRef.current));
  }

  return (
    <DropdownMenu phoneSheet open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("folders.menu.label", { name: folder.name })}
          className={cn("h-6 w-6 shrink-0", ROW_ICON_HIT, hoverReveal("folderrow"))}
        >
          <EllipsisVertical aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sheetTitle={folder.name}
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
        {indexPath !== undefined && (
          <MenuAction icon={Library} label={t("folders.menu.openIndex")} blockedReason={null} onRun={() => run(() => navigate(indexPath))} />
        )}
        {(showNewNote || showManage || indexPath !== undefined) && <DropdownMenuSeparator />}
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
            <DropdownMenuRadioItem key={value} value={value} className={RADIO_ROW} sheetRow onSelect={(event) => event.preventDefault()}>
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
