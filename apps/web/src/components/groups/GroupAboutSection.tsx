import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/groups-admin-strings";
import { useLocation, useNavigate, type Location } from "react-router";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroupMembers, useRemoveMember, useRenameGroup } from "@/api/groups";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { SettingsGroup, SettingsPage } from "@/settings/SettingsLayout";
import { DeleteGroupDialog } from "./DeleteGroupDialog";
import { GROUP_NAME_MAX_LENGTH } from "./GroupNameDialog";
import { useGroupOutlet } from "./group-outlet";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

function NameSection({ group }: { group: GroupDto }) {
  const { t } = useTranslation();
  const renameGroup = useRenameGroup();
  const [name, setName] = useState(group.name);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || trimmed === group.name) return;
    setError(null);
    try {
      await renameGroup.mutateAsync({ id: group.id, name: trimmed });
      toast({ title: t("groups.detail.nameSaved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup title={t("groups.detail.nameTitle")}>
      <form onSubmit={(event) => void handleSubmit(event)} className="flex items-center gap-2">
        <Input
          aria-label={t("groups.dialog.nameLabel")}
          maxLength={GROUP_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="max-w-md"
        />
        <Button type="submit" variant="outline" disabled={trimmed.length === 0 || trimmed === group.name || renameGroup.isPending}>
          {t("groups.detail.nameSave")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

/**
 * Only leaving uses this (deleting uses `DeleteGroupDialog`, which stays open on failure). A failed leave (409 `last_admin`,
 * the race fallback) toasts and closes the dialog.
 */
function ConfirmSection({
  title,
  dialogTitle,
  description,
  confirm,
  pending,
  onConfirm,
}: {
  title: string;
  dialogTitle: string;
  description: string;
  confirm: string;
  pending: boolean;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      setOpen(false);
    }
  }

  return (
    <SettingsGroup title={title} description={description}>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          {confirm}
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={pending}>
              {confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

function countAdmins(members: GroupMemberDto[]): number {
  return members.filter((member) => member.builtin === "admin").length;
}

/**
 * After leaving or deleting, go back to the background page, unless it is a note of this group (`/g/<id>/…`, case-insensitive;
 * access lost or the group gone) → `/`. No background page (deep link) → `/` too.
 * Not `/settings/groups`: that would jump from the group modal into the settings modal.
 */
export function afterLeaveTarget(groupId: string, backgroundLocation: Location | undefined): Location | "/" {
  if (!backgroundLocation) return "/";
  return backgroundLocation.pathname.toLowerCase().startsWith(`/g/${groupId.toLowerCase()}/`) ? "/" : backgroundLocation;
}

function ReadOnlyName({ group }: { group: GroupDto }) {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("groups.detail.nameTitle")}>
      <p className="text-base font-semibold">{group.name}</p>
    </SettingsGroup>
  );
}

/** Member count comes from the member list: `myRole.memberCount` is that role's headcount. */
function InfoGroup({ group }: { group: GroupDto }) {
  const { t, i18n } = useTranslation();
  const membersQuery = useGroupMembers(group.id);
  return (
    <SettingsGroup title={t("groups.about.infoTitle")}>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("groups.about.createdAt")}</dt>
        <dd>{new Date(group.createdAt).toLocaleDateString(i18n.language)}</dd>
        <dt className="text-muted-foreground">{t("groups.about.members")}</dt>
        <dd>{membersQuery.data ? t("groups.about.memberCount", { count: membersQuery.data.length }) : "—"}</dd>
      </dl>
    </SettingsGroup>
  );
}

/**
 * The last admin is counted from the member list; the leave section is hidden while it is pending, and on error
 * the server's 409 is the backstop. The delete button is `outline`: red is reserved for the dialog's submit.
 */
function LeaveAndDelete({ group, backgroundLocation }: { group: GroupDto; backgroundLocation: Location | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useSession();
  const membersQuery = useGroupMembers(group.id);
  const removeMember = useRemoveMember(group.id);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isLastAdmin = group.myRole?.builtin === "admin" && countAdmins(membersQuery.data ?? []) === 1;
  const showLeave = group.myRole !== null && !membersQuery.isPending && !isLastAdmin;

  function leaveTo(): void {
    navigate(afterLeaveTarget(group.id, backgroundLocation));
  }

  return (
    <>
      {showLeave && (
        <ConfirmSection
          title={t("groups.detail.leaveTitle")}
          dialogTitle={t("groups.leave.title")}
          description={t("groups.leave.description", { name: group.name })}
          confirm={t("groups.leave.confirm")}
          pending={removeMember.isPending || !user}
          onConfirm={async () => {
            if (!user) return;
            await removeMember.mutateAsync(user.id);
            leaveTo();
          }}
        />
      )}
      {group.canManageGroup && (
        <SettingsGroup title={t("groups.detail.dangerTitle")} description={t("groups.detail.dangerDescription")}>
          <Button type="button" variant="outline" onClick={() => setDeleteOpen(true)}>
            {t("groups.delete.confirm")}
          </Button>
          {deleteOpen && <DeleteGroupDialog group={group} onOpenChange={setDeleteOpen} onDeleted={leaveTo} />}
        </SettingsGroup>
      )}
    </>
  );
}

export function GroupAboutSection() {
  const { t } = useTranslation();
  const group = useGroupOutlet();
  const location = useLocation();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  return (
    <SettingsPage title={t("groups.nav.about")}>
      {group.canManageGroup ? <NameSection key={group.name} group={group} /> : <ReadOnlyName group={group} />}
      <InfoGroup group={group} />
      <LeaveAndDelete group={group} backgroundLocation={backgroundLocation} />
    </SettingsPage>
  );
}
