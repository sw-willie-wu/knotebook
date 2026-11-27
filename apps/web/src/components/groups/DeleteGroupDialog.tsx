import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/groups-admin-strings";
import { useQueryClient } from "@tanstack/react-query";
import type { GroupDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useFolders } from "@/api/folders";
import { groupMembersKey, useDeleteGroup, useGroupMembers } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { useTrash } from "@/api/trash";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";

type Mode = "transfer" | "delete";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * Callers mount it as `open && <DeleteGroupDialog />` so state is fresh on every open. Transfer is the default because it
 * loses no data; the admin select keeps the server's order (`GET …/members` lists admins first) and may include yourself.
 * The delete-all checkbox is cleared on mode switch so it can't carry into a later delete-all. Empty groups still show both
 * modes (same effect there) so the UI doesn't branch and the user needn't guess.
 *
 * Note count = live notes + the group's trash, since both modes also handle trashed notes (#181); live notes come from the
 * `['notes']` cache because the sidebar has it loaded anyway. The trash count is unreliable when the user lacks the group's
 * trash rights (edit + delete; a custom role that can manage the group may not have them), the list is `truncated`
 * (`TRASH_LIST_LIMIT` undercounts), or it hasn't loaded or failed; then the number-free copy is used rather than claiming 0.
 * In transfer mode trashed group notes go to the recipient's personal trash.
 *
 * Failures (409 `not_admin`, 409 `server_busy`, 404…) keep the dialog open; `not_admin` also refetches members so the select shows current admins.
 */
export function DeleteGroupDialog({
  group,
  onOpenChange,
  onDeleted,
  returnFocusRef,
}: {
  group: GroupDto;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const deleteGroup = useDeleteGroup();
  const membersQuery = useGroupMembers(group.id);
  const notesQuery = useNotes();
  const trashQuery = useTrash();
  const foldersQuery = useFolders();
  const [mode, setMode] = useState<Mode>("transfer");
  const [pickedAdmin, setPickedAdmin] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const admins = (membersQuery.data ?? []).filter((m) => m.builtin === "admin");
  // Fall back to the first admin if the selection vanished after a refetch: a stale value would always 409.
  const selected = admins.find((m) => m.userId === pickedAdmin) ?? admins[0] ?? null;
  const adminsFailed = membersQuery.isError;

  const liveCount = notesQuery.data ? notesQuery.data.filter((n) => n.groupId === group.id).length : null;
  const canSeeGroupTrash = group.myRole?.permissions.edit === true && group.myRole.permissions.delete === true;
  const trashCount =
    trashQuery.isSuccess && !trashQuery.data.truncated && canSeeGroupTrash
      ? trashQuery.data.items.filter((item) => item.group?.id === group.id).length
      : null;
  const total = liveCount !== null && trashCount !== null ? liveCount + trashCount : null;
  const name = selected?.displayName ?? "";
  const hasGroupFolders =
    foldersQuery.isSuccess && foldersQuery.data.some((folder) => folder.space.kind === "group" && folder.space.groupId === group.id);

  function describe(kind: "transfer" | "delete"): string {
    if (liveCount === 0 && trashCount === 0) return t("groups.delete.emptyDescription");
    if (kind === "transfer") {
      return total === null
        ? t("groups.delete.transferDescriptionNoCount", { name })
        : t("groups.delete.transferDescription", { count: total, name });
    }
    if (total === null) return t("groups.delete.deleteDescriptionNoCount");
    return trashCount === 0
      ? t("groups.delete.deleteDescription", { count: total })
      : t("groups.delete.deleteDescriptionWithTrash", { count: total, trash: trashCount });
  }

  function switchMode(next: Mode): void {
    setMode(next);
    setAcknowledged(false);
  }

  const blocked =
    deleteGroup.isPending || (mode === "transfer" && selected === null) || (mode === "delete" && !acknowledged);

  async function handleConfirm(): Promise<void> {
    if (blocked) return;
    try {
      await deleteGroup.mutateAsync({
        id: group.id,
        body: mode === "transfer" && selected ? { mode, transferTo: selected.userId } : { mode: "delete" },
      });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      if (err instanceof ApiFail && err.code === "not_admin") {
        void queryClient.invalidateQueries({ queryKey: groupMembersKey(group.id) });
      }
      return;
    }
    onOpenChange(false);
    onDeleted?.();
  }

  function returnFocus(event: Event): void {
    const target = returnFocusRef?.current;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  }

  const modes: Array<{ value: Mode; label: string }> = [
    { value: "transfer", label: t("groups.delete.transferLabel") },
    { value: "delete", label: t("groups.delete.deleteLabel") },
  ];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent dismissOnOutside={false} onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{t("groups.delete.title")}</DialogTitle>
        </DialogHeader>

        <div role="radiogroup" aria-label={t("groups.delete.modeLabel")} className="space-y-1">
          {modes.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
            >
              <input
                type="radio"
                name="delete-group-mode"
                checked={mode === option.value}
                onChange={() => switchMode(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>

        {mode === "transfer" ? (
          <div className="space-y-2">
            <Select
              variant="field"
              aria-label={t("groups.delete.transferToLabel")}
              className="w-full"
              disabled={membersQuery.isPending || deleteGroup.isPending}
              value={selected?.userId ?? ""}
              onValueChange={setPickedAdmin}
              options={admins.map((m) => ({ value: m.userId, label: `${m.displayName} (${m.email})` }))}
            />
            {adminsFailed && (
              <p role="alert" className="text-sm text-destructive">
                {t("groups.delete.adminsUnavailable")}
              </p>
            )}
            <DialogDescription>{describe("transfer")}</DialogDescription>
            {trashCount !== 0 && <p className="text-sm text-muted-foreground">{t("groups.delete.transferTrashNote", { name })}</p>}
            {hasGroupFolders && <p className="text-sm text-muted-foreground">{t("groups.delete.transferFoldersNote", { name })}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <DialogDescription>{describe("delete")}</DialogDescription>
            <div className="flex items-center gap-2">
              <Checkbox
                id="delete-group-acknowledge"
                checked={acknowledged}
                onCheckedChange={(value) => setAcknowledged(value === true)}
              />
              <label htmlFor="delete-group-acknowledge" className="cursor-pointer text-sm">
                {t("groups.delete.acknowledge")}
              </label>
            </div>
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={blocked}>
            {t("groups.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
