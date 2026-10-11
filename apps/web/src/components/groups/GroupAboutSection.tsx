import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
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

/** 名稱行內編輯（`canManageGroup`）：outline「儲存名稱」，成功 toast、失敗行內 alert。 */
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
 * 危險動作的一個區塊：標題＋說明＋outline 觸發鈕＋二次確認對話框。目前只有退出群組在用（刪群組走
 * `DeleteGroupDialog`，失敗時對話框留著）；退出失敗（409 `last_admin`，競態後備）→ toast 並關閉對話框。
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

/** 名單裡掛內建管理員角色的人數（spec §8.5「看 `builtin === "admin"` 計數」）。 */
function countAdmins(members: GroupMemberDto[]): number {
  return members.filter((member) => member.builtin === "admin").length;
}

/**
 * 退出與刪除成功後的去處（#247 §6.5，兩者同一規則）：回背景頁；但背景頁若是**這個群組**的筆記（`/g/<id>/…`，不分大小寫）——
 * 剛失去存取權（退出）或已不存在（刪除）——改回 `/`。沒有背景頁（深連結）也回 `/`。
 * 不再導到 `/settings/groups`：那會從群組 modal 跳進個人設定 modal（違反 W11）。
 */
export function afterLeaveTarget(groupId: string, backgroundLocation: Location | undefined): Location | "/" {
  if (!backgroundLocation) return "/";
  return backgroundLocation.pathname.toLowerCase().startsWith(`/g/${groupId.toLowerCase()}/`) ? "/" : backgroundLocation;
}

/** 沒有 `canManageGroup` 時的名稱：唯讀文字。 */
function ReadOnlyName({ group }: { group: GroupDto }) {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("groups.detail.nameTitle")}>
      <p className="text-base font-semibold">{group.name}</p>
    </SettingsGroup>
  );
}

/** 資訊：建立時間（`GroupDto.createdAt`）與成員數（`useGroupMembers().data.length`——不是 `myRole.memberCount`，那是該角色的人數）。 */
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
 * 退出（不是最後一位管理員才顯示，#175 §8.2）與刪除（`canManageGroup`；兩模式 `DeleteGroupDialog` 不變）。
 * 最後一位管理員看成員名單的 `builtin === "admin"` 計數；名單 pending 時不渲染退出區；error 時照常渲染，由 server 409 兜底。
 * 「Delete group」是面板層級的 `outline` 鈕、不塗紅（§4.8）；紅色留給對話框的提交鈕。
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

/**
 * 群組 modal「關於」（`/groups/:id/about`，#247 §6.5）：名稱（`canManageGroup` 行內可改，否則唯讀）、資訊、退出、刪除。
 * 項次四個對所有成員相同，內容依兩個管理旗標降級（W13）。
 */
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
