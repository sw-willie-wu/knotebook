import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams, type Location } from "react-router";
import type { GroupDto, GroupMemberDto, GroupMemberRole } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAddMember, useDeleteGroup, useGroupMembers, useGroups, useRemoveMember, useRenameGroup, useSetMemberRole } from "@/api/groups";
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
import { GROUP_NAME_MAX_LENGTH } from "@/components/groups/GroupNameDialog";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

interface SettingsLocationState {
  backgroundLocation?: Location;
}

/** 名稱行內編輯（admin）：outline「儲存名稱」，成功 toast、失敗行內 alert。 */
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

/** 成員表：admin 有角色下拉與移除鈕（最後一位 admin 的列兩者 disabled＋title），member 唯讀。 */
function MembersSection({ group, isAdmin }: { group: GroupDto; isAdmin: boolean }) {
  const { t } = useTranslation();
  const membersQuery = useGroupMembers(group.id);
  const setRole = useSetMemberRole(group.id);
  const removeMember = useRemoveMember(group.id);
  const addMember = useAddMember(group.id);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<GroupMemberRole>("member");
  const [addError, setAddError] = useState<string | null>(null);

  const members = membersQuery.data ?? [];
  const adminCount = members.filter((member) => member.role === "admin").length;
  const isLastAdmin = (member: GroupMemberDto) => member.role === "admin" && adminCount === 1;

  async function handleRole(member: GroupMemberDto, role: GroupMemberRole): Promise<void> {
    try {
      await setRole.mutateAsync({ userId: member.userId, role });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleRemove(member: GroupMemberDto): Promise<void> {
    try {
      await removeMember.mutateAsync(member.userId);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAddError(null);
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    try {
      await addMember.mutateAsync({ email: trimmed, role: newRole });
      setEmail("");
      setNewRole("member");
    } catch (err) {
      setAddError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup
      title={t("groups.detail.membersTitle")}
      description={isAdmin ? t("groups.detail.membersDescriptionAdmin") : t("groups.detail.membersDescriptionMember")}
    >
      {membersQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : membersQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, membersQuery.error)}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-2 font-medium">{t("groups.detail.tableName")}</th>
              <th className="py-2 font-medium">{t("groups.detail.tableEmail")}</th>
              <th className="py-2 font-medium">{t("groups.detail.tableRole")}</th>
              {isAdmin && <th className="py-2 text-right font-medium">{t("groups.detail.tableActions")}</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const locked = isLastAdmin(member);
              return (
                <tr key={member.userId} className="border-b border-border">
                  <td className="py-2">{member.displayName}</td>
                  {/* A8：成員彼此看得到 email——要收回就刪這一格與表頭 */}
                  <td className="py-2 text-muted-foreground">{member.email}</td>
                  <td className="py-2">
                    {isAdmin ? (
                      <select
                        aria-label={t("groups.detail.roleLabel", { email: member.email })}
                        value={member.role}
                        disabled={locked || setRole.isPending}
                        title={locked ? t("groups.detail.lastAdminHint") : undefined}
                        onChange={(event) => void handleRole(member, event.target.value as GroupMemberRole)}
                        className={SELECT_CLASS}
                      >
                        <option value="admin">{t("groups.role.admin")}</option>
                        <option value="member">{t("groups.role.member")}</option>
                      </select>
                    ) : (
                      t(`groups.role.${member.role}`)
                    )}
                  </td>
                  {isAdmin && (
                    <td className="py-2">
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t("groups.detail.remove", { email: member.email })}
                          disabled={locked || removeMember.isPending}
                          title={locked ? t("groups.detail.lastAdminHint") : undefined}
                          onClick={() => void handleRemove(member)}
                        >
                          {t("groups.detail.remove", { email: member.email })}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* disabled 的 Button 有 `disabled:pointer-events-none`，`title` 永遠浮不出來——提示要
          用看得見的文字（`title` 仍保留給 AT）。 */}
      {isAdmin && adminCount === 1 && !membersQuery.isPending && (
        <p className="mt-2 text-xs text-muted-foreground">{t("groups.detail.lastAdminHint")}</p>
      )}

      {isAdmin && (
        <>
          <form onSubmit={(event) => void handleAdd(event)} className="mt-4 flex items-center gap-2">
            <Input
              type="email"
              required
              placeholder={t("groups.detail.addEmailLabel")}
              aria-label={t("groups.detail.addEmailLabel")}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-w-0 max-w-md flex-1"
            />
            <select
              aria-label={t("groups.detail.addRoleLabel")}
              value={newRole}
              onChange={(event) => setNewRole(event.target.value as GroupMemberRole)}
              className={SELECT_CLASS}
            >
              <option value="member">{t("groups.role.member")}</option>
              <option value="admin">{t("groups.role.admin")}</option>
            </select>
            <Button type="submit" variant="outline" disabled={addMember.isPending}>
              {t("groups.detail.add")}
            </Button>
          </form>
          {addError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {addError}
            </p>
          )}
        </>
      )}
    </SettingsGroup>
  );
}

/** 底部危險區：admin＝刪除群組、member＝退出群組；都二次確認，成功導回列表頁。 */
function DangerSection({ group, isAdmin, backgroundLocation }: { group: GroupDto; isAdmin: boolean; backgroundLocation: Location | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useSession();
  const deleteGroup = useDeleteGroup();
  const removeMember = useRemoveMember(group.id);
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      if (isAdmin) await deleteGroup.mutateAsync(group.id);
      else if (user) await removeMember.mutateAsync(user.id);
      setOpen(false);
      navigate("/settings/groups", { state: backgroundLocation ? { backgroundLocation } : undefined });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      setOpen(false);
    }
  }

  const title = isAdmin ? t("groups.delete.title") : t("groups.leave.title");
  const description = isAdmin ? t("groups.delete.description", { name: group.name }) : t("groups.leave.description", { name: group.name });
  const confirm = isAdmin ? t("groups.delete.confirm") : t("groups.leave.confirm");

  return (
    <SettingsGroup title={isAdmin ? t("groups.detail.dangerTitle") : t("groups.detail.leaveTitle")} description={description}>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          {confirm}
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={deleteGroup.isPending || removeMember.isPending}>
              {confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

/**
 * `/settings/groups/:id`（spec §8.4）：admin 視角＝名稱行內可改、成員表（角色下拉、移除）、
 * 加人、底部刪除群組；member 視角＝名稱唯讀、成員表唯讀、退出群組。非成員／不存在／id
 * 不合法一律 `errors.not_found`（S4：三者同形，UI 不分辨）。`useGroups()` 決定我在這個
 * 群組的角色（`myRole`）——與側欄同一份快取。
 */
export function SettingsGroupDetailSection() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const location = useLocation();
  const backgroundLocation = (location.state as SettingsLocationState | null)?.backgroundLocation;
  const groupsQuery = useGroups();

  if (groupsQuery.isPending) {
    return <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  }
  if (groupsQuery.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(t, groupsQuery.error)}
      </p>
    );
  }
  const group = groupsQuery.data.find((candidate) => candidate.id === id);
  if (!group) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("errors.not_found")}
      </p>
    );
  }
  const isAdmin = group.myRole === "admin";

  return (
    <div className="space-y-4">
      <Link
        to="/settings/groups"
        state={backgroundLocation ? { backgroundLocation } : undefined}
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← {t("groups.detail.back")}
      </Link>
      <SettingsPage title={group.name}>
        {isAdmin ? <NameSection key={group.name} group={group} /> : null}
        <MembersSection group={group} isAdmin={isAdmin} />
        <DangerSection group={group} isAdmin={isAdmin} backgroundLocation={backgroundLocation} />
      </SettingsPage>
    </div>
  );
}
