import { useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { TAG_COLORS, isTagColor, type SpaceTagDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import "@/i18n/tags-strings";
import { useDeleteTag, useMergeTag, useSpaceTags, useUpdateTag, type TagSpaceRef } from "@/api/tags";
import { useGroupOutlet } from "@/components/groups/group-outlet";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { RenameTagDialog } from "@/components/tags/RenameTagDialog";
import { TagDot } from "@/components/tags/TagDot";
import { isTagGone, refreshAfterTagGone } from "@/components/tags/tag-gone";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown, CornerDownRight, Pencil, Trash } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

const RADIO_ROW =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm outline-none " +
  "transition-colors focus:bg-accent focus:text-accent-foreground";

function ColorMenu({ tag, space }: { tag: SpaceTagDto; space: TagSpaceRef }) {
  const { t } = useTranslation();
  const update = useUpdateTag(space);
  const queryClient = useQueryClient();
  const colorName = t(`tags.colors.${tag.color}`);
  return (
    <DropdownMenu phoneSheet>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={t("tags.manage.colorCurrent", { name: tag.name, color: colorName })} className="gap-2 font-normal">
          <TagDot color={tag.color} />
          {colorName}
          <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sheetTitle={t("tags.manage.colorLabel", { name: tag.name })}>
        <DropdownMenuRadioGroup
          value={tag.color}
          onValueChange={(value) => {
            if (!isTagColor(value) || value === tag.color) return;
            update.mutate(
              { tagId: tag.id, color: value },
              {
                onError: (err) => {
                  if (isTagGone(err)) refreshAfterTagGone(queryClient, space);
                  toast({ title: errorMessage(t, err), variant: "destructive" });
                },
              },
            );
          }}
        >
          {TAG_COLORS.map((color) => (
            <DropdownMenuRadioItem key={color} value={color} className={RADIO_ROW} sheetRow>
              <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                <DropdownMenuItemIndicator>
                  <Check className="h-4 w-4" />
                </DropdownMenuItemIndicator>
              </span>
              <TagDot color={color} />
              {t(`tags.colors.${color}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function returnFocus(ref: RefObject<HTMLElement | null>) {
  return (event: Event) => {
    const target = ref.current;
    if (!target) return;
    event.preventDefault();
    target.focus();
  };
}

function MergeDialog({ tag, others, space, open, onOpenChange, returnFocusRef }: { tag: SpaceTagDto; others: SpaceTagDto[]; space: TagSpaceRef; open: boolean; onOpenChange: (open: boolean) => void; returnFocusRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const merge = useMergeTag(space);
  const queryClient = useQueryClient();
  const [into, setInto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const labelId = `merge-tag-label-${tag.id}`;

  async function handleConfirm(): Promise<void> {
    setError(null);
    try {
      await merge.mutateAsync({ tagId: tag.id, into });
      onOpenChange(false);
    } catch (err) {
      if (isTagGone(err)) {
        refreshAfterTagGone(queryClient, space);
        toast({ title: errorMessage(t, err), variant: "destructive" });
        return onOpenChange(false);
      }
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dismissOnOutside={false} onCloseAutoFocus={returnFocus(returnFocusRef)}>
        <DialogHeader>
          <DialogTitle>{t("tags.manage.mergeTitle", { name: tag.name })}</DialogTitle>
          <DialogDescription>{t("tags.manage.mergeDescription", { name: tag.name })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <p id={labelId} className="text-sm font-medium">
            {t("tags.manage.mergeInto")}
          </p>
          <Select
            variant="field"
            aria-labelledby={labelId}
            className="w-full"
            value={into}
            placeholder={t("tags.manage.mergePlaceholder")}
            onValueChange={setInto}
            options={others.map((other) => ({ value: other.id, label: other.name }))}
          />
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="brandDeep" disabled={into === "" || merge.isPending} onClick={() => void handleConfirm()}>
            {t("tags.manage.mergeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ tag, space, open, onOpenChange, returnFocusRef }: { tag: SpaceTagDto; space: TagSpaceRef; open: boolean; onOpenChange: (open: boolean) => void; returnFocusRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const del = useDeleteTag(space);
  const queryClient = useQueryClient();

  async function handleConfirm(): Promise<void> {
    try {
      await del.mutateAsync({ tagId: tag.id });
    } catch (err) {
      if (isTagGone(err)) refreshAfterTagGone(queryClient, space);
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={returnFocus(returnFocusRef)}>
        <DialogHeader>
          <DialogTitle>{t("tags.manage.deleteTitle", { name: tag.name })}</DialogTitle>
          <DialogDescription>{t("tags.manage.deleteDescription", { count: tag.noteCount })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" disabled={del.isPending} onClick={() => void handleConfirm()}>
            {t("tags.manage.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type OpenDialog = { kind: "rename" | "merge" | "delete"; tagId: string };

function TagManager({ space, canManage }: { space: TagSpaceRef; canManage: boolean }) {
  const { t } = useTranslation();
  const tags = useSpaceTags(space, { enabled: canManage });
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const openDialog = (kind: OpenDialog["kind"], tagId: string) => (event: { currentTarget: HTMLElement }) => {
    triggerRef.current = event.currentTarget;
    setDialog({ kind, tagId });
  };

  if (!canManage) return <p className="text-sm text-muted-foreground">{t("tags.manage.forbidden")}</p>;
  if (tags.isPending) return <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  if (tags.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(t, tags.error)}
      </p>
    );
  }
  if (tags.data.length === 0) return <p className="text-sm text-muted-foreground">{t("tags.manage.empty")}</p>;

  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("tags.manage.name"), kind: "primary" },
    { id: "notes", header: t("tags.manage.notes"), kind: "fixed" },
    { id: "color", header: t("tags.manage.color"), kind: "control" },
    { id: "actions", header: t("tags.manage.actions"), kind: "actions", buttons: 3 },
  ];
  const rows: SettingsTableRow[] = tags.data.map((tag) => {
    const canMerge = tags.data.length > 1;
    return {
      id: tag.id,
      primary: { name: tag.name, icon: <TagDot color={tag.color} /> },
      cells: { color: <ColorMenu tag={tag} space={space} />, notes: t("tags.manage.noteCount", { count: tag.noteCount }) },
      actions: (
        <>
          <RowIconButton
            label={t("tags.manage.renameLabel", { name: tag.name })}
            icon={<Pencil className="h-4 w-4" />}
            onClick={openDialog("rename", tag.id)}
          />
          <RowIconButton
            label={t("tags.manage.mergeLabel", { name: tag.name })}
            icon={<CornerDownRight className="h-4 w-4" />}
            softDisabled={!canMerge}
            softDisabledReason={t("tags.manage.mergeUnavailable")}
            onClick={openDialog("merge", tag.id)}
          />
          <RowIconButton
            label={t("tags.manage.deleteLabel", { name: tag.name })}
            tone="destructive"
            icon={<Trash className="h-4 w-4" />}
            onClick={openDialog("delete", tag.id)}
          />
        </>
      ),
    };
  });

  const target = dialog === null ? undefined : tags.data.find((tag) => tag.id === dialog.tagId);
  const close = (open: boolean): void => {
    if (!open) setDialog(null);
  };
  return (
    <>
      <SettingsTable label={t("tags.manage.nav")} columns={columns} rows={rows} />
      {target !== undefined && dialog?.kind === "rename" && <RenameTagDialog tag={target} space={space} open onOpenChange={close} returnFocusRef={triggerRef} />}
      {target !== undefined && dialog?.kind === "merge" && (
        <MergeDialog tag={target} others={tags.data.filter((tag) => tag.id !== target.id)} space={space} open onOpenChange={close} returnFocusRef={triggerRef} />
      )}
      {target !== undefined && dialog?.kind === "delete" && <DeleteDialog tag={target} space={space} open onOpenChange={close} returnFocusRef={triggerRef} />}
    </>
  );
}

const PERSONAL_SPACE: TagSpaceRef = { kind: "personal" };

export function PersonalTagsSection() {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t("tags.manage.nav")} description={t("tags.manage.personalDescription")}>
      <SettingsGroup>
        <TagManager space={PERSONAL_SPACE} canManage />
      </SettingsGroup>
    </SettingsPage>
  );
}

/** The nav item is hidden without `canManageGroup`, but the URL can still be typed, so this explains instead of fetching a list the server would refuse. */
export function GroupTagsSection() {
  const { t } = useTranslation();
  const group = useGroupOutlet();
  return (
    <SettingsPage title={t("tags.manage.nav")} description={group.canManageGroup ? t("tags.manage.groupDescription") : undefined}>
      <SettingsGroup>
        <TagManager space={{ kind: "group", groupId: group.id }} canManage={group.canManageGroup} />
      </SettingsGroup>
    </SettingsPage>
  );
}
