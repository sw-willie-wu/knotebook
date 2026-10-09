import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, type Location } from "react-router";
import type { GroupDto, GroupMemberDto, GroupRoleDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroupStorageUsage } from "@/api/storage";
import {
  useAddMember,
  useGroupMembers,
  useGroupRoles,
  useRemoveMember,
  useRenameGroup,
  useSetMemberRole,
} from "@/api/groups";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import { Trash } from "@/components/ui/icons";
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
import { DeleteGroupDialog } from "@/components/groups/DeleteGroupDialog";
import { GROUP_NAME_MAX_LENGTH } from "@/components/groups/GroupNameDialog";
import { roleLabel } from "@/lib/group-role";
import { GroupDetailShell } from "./GroupDetailShell";
import { SettingsGroup } from "./SettingsLayout";
import { StorageUsageGroup } from "./StorageUsageGroup";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 成員表的欄寬規則（#183）。jsdom 不排版、量不到「溢出」，所以
 * `SettingsGroupDetailSection.test.tsx` 逐格對**字面 token** 斷言（不 import 這個常數，
 * 免得常數被改錯時測試跟著一起錯）。
 * - `text`：名字、email 兩格可在任意處斷行。`wrap-anywhere`（`overflow-wrap: anywhere`）
 *   會把斷點算進 min-content，auto 表格才肯把這欄壓窄；`break-words` 不算，照樣撐爆。
 * - `fixed`：角色欄不換行（下拉本身已是 shrink-0）。
 * - `actions`：操作欄 `w-px` ＋ 不換行 ⇒ 收到內容寬（一顆 32px 圖示鈕），永遠不被擠壓。
 */
const MEMBERS_TABLE_LAYOUT = {
  text: "wrap-anywhere",
  fixed: "whitespace-nowrap",
  actions: "w-px whitespace-nowrap",
} as const;

/** 名單裡掛內建管理員角色的人數（spec §8.5「看 `builtin === "admin"` 計數」）。 */
function countAdmins(members: GroupMemberDto[]): number {
  return members.filter((member) => member.builtin === "admin").length;
}

/** 成員目前角色的顯示名：優先用 `GET …/roles` 的那一列（自訂角色要它的 `name`）；roles 還沒到時退回 `builtin`。 */
function memberRoleLabel(t: (key: string) => string, roles: GroupRoleDto[], member: GroupMemberDto): string {
  return roleLabel(t, roles.find((role) => role.id === member.roleId) ?? { builtin: member.builtin, name: null });
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
 * 成員表：`canManageMembers` 有角色下拉與移除鈕（最後一位管理員的列兩者 disabled＋title），否則唯讀。
 * 角色下拉的選項與送出的值都是 `GET …/roles` 的**角色 id**（spec §8.5；gate r2 M-7：兩位管理員、沒有
 * 一般成員的群組，一般成員角色的 id 只拿得到那裡）。下拉列全部角色、含內建管理員（不防升權，Q9）。
 */
function MembersSection({ group, canManageMembers }: { group: GroupDto; canManageMembers: boolean }) {
  const { t } = useTranslation();
  const membersQuery = useGroupMembers(group.id);
  const rolesQuery = useGroupRoles(group.id);
  const setRole = useSetMemberRole(group.id);
  const removeMember = useRemoveMember(group.id);
  const addMember = useAddMember(group.id);
  const [email, setEmail] = useState("");
  // null＝還沒選過：用內建一般成員那一個的 id；roles 還沒到時不送 roleId（server 預設內建一般成員）
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const members = membersQuery.data ?? [];
  const roles = rolesQuery.data ?? [];
  const adminCount = countAdmins(members);
  const isLastAdmin = (member: GroupMemberDto) => member.builtin === "admin" && adminCount === 1;
  const newRoleId = pickedRoleId ?? roles.find((role) => role.builtin === "member")?.id;

  async function handleRole(member: GroupMemberDto, roleId: string): Promise<void> {
    try {
      await setRole.mutateAsync({ userId: member.userId, roleId });
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
      await addMember.mutateAsync(newRoleId === undefined ? { email: trimmed } : { email: trimmed, roleId: newRoleId });
      setEmail("");
      setPickedRoleId(null);
    } catch (err) {
      setAddError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup
      title={t("groups.detail.membersTitle")}
      description={canManageMembers ? t("groups.detail.membersDescriptionAdmin") : t("groups.detail.membersDescriptionMember")}
    >
      {membersQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : membersQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, membersQuery.error)}
        </p>
      ) : (
        // #183：很長的 email（例如 e2e 的 uuid 帳號）曾把整張表撐出 modal、移除鈕被裁掉。
        // 版面規則（`MEMBERS_TABLE_LAYOUT`，有守衛）：名字／email 兩格可在任意處斷行
        // （`wrap-anywhere` 會一併縮小 auto 表格算欄寬用的 min-content，`break-words` 不會）；
        // 角色與操作兩欄不換行、操作欄 `w-px` 收到內容寬——移除鈕是固定 32px 的圖示鈕，
        // 不參與擠壓。可見文字不再帶 email（email 留在 aria-label，與分享面板同一套）。
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {/* 表頭不掛 wrap-anywhere：短字，掛了反而會在極窄時被逐字拆開。 */}
              <th className="py-2 pr-3 font-medium">{t("groups.detail.tableName")}</th>
              <th className="py-2 pr-3 font-medium">{t("groups.detail.tableEmail")}</th>
              <th className={`py-2 font-medium ${MEMBERS_TABLE_LAYOUT.fixed}`}>{t("groups.detail.tableRole")}</th>
              {canManageMembers && (
                <th className={`py-2 pl-2 text-right font-medium ${MEMBERS_TABLE_LAYOUT.actions}`}>
                  {t("groups.detail.tableActions")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const locked = isLastAdmin(member);
              return (
                <tr key={member.userId} className="border-b border-border">
                  <td className={`py-2 pr-3 ${MEMBERS_TABLE_LAYOUT.text}`}>{member.displayName}</td>
                  {/* A8：成員彼此看得到 email——要收回就刪這一格與表頭 */}
                  <td className={`py-2 pr-3 text-muted-foreground ${MEMBERS_TABLE_LAYOUT.text}`}>{member.email}</td>
                  <td className={`py-2 ${MEMBERS_TABLE_LAYOUT.fixed}`}>
                    {canManageMembers ? (
                      <select
                        aria-label={t("groups.detail.roleLabel", { email: member.email })}
                        value={member.roleId}
                        // roles 還沒到：只有目前角色那一個選項可顯示，先鎖住
                        disabled={locked || setRole.isPending || roles.length === 0}
                        title={locked ? t("groups.detail.lastAdminHint") : undefined}
                        onChange={(event) => void handleRole(member, event.target.value)}
                        className={SELECT_CLASS}
                      >
                        {roles.length === 0 ? (
                          <option value={member.roleId}>{memberRoleLabel(t, roles, member)}</option>
                        ) : (
                          roles.map((role) => (
                            <option key={role.id} value={role.id}>
                              {roleLabel(t, role)}
                            </option>
                          ))
                        )}
                      </select>
                    ) : (
                      memberRoleLabel(t, roles, member)
                    )}
                  </td>
                  {canManageMembers && (
                    <td className={`py-2 pl-2 ${MEMBERS_TABLE_LAYOUT.actions}`}>
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          aria-label={t("groups.detail.remove", { email: member.email })}
                          disabled={locked || removeMember.isPending}
                          title={locked ? t("groups.detail.lastAdminHint") : undefined}
                          onClick={() => void handleRemove(member)}
                        >
                          <Trash className="h-4 w-4" />
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
      {canManageMembers && adminCount === 1 && !membersQuery.isPending && (
        <p className="mt-2 text-xs text-muted-foreground">{t("groups.detail.lastAdminHint")}</p>
      )}

      {canManageMembers && (
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
              value={newRoleId ?? ""}
              disabled={roles.length === 0}
              onChange={(event) => setPickedRoleId(event.target.value)}
              className={SELECT_CLASS}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {roleLabel(t, role)}
                </option>
              ))}
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

/**
 * 底部兩個區塊，成功都導回列表頁：
 * - `canManageGroup` → 刪除群組（兩模式對話框 `DeleteGroupDialog`：轉移給管理員或全部刪除，#175 PR4）；
 * - 不是最後一位管理員 → 退出群組（spec §8.2）。最後一位管理員看**成員名單**的 `builtin === "admin"`
 *   計數（與成員表同一個 queryKey，共用快取、不多打一發）。名單 pending 時不渲染退出區；
 *   名單 error 時照常渲染（算不出管理員人數就當不是最後一位），由 server 409 `last_admin` 兜底。
 */
function DangerSection({
  group,
  canManageGroup,
  backgroundLocation,
}: {
  group: GroupDto;
  canManageGroup: boolean;
  backgroundLocation: Location | undefined;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useSession();
  const membersQuery = useGroupMembers(group.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const removeMember = useRemoveMember(group.id);

  const isLastAdmin = group.myRole?.builtin === "admin" && countAdmins(membersQuery.data ?? []) === 1;
  const showLeave = group.myRole !== null && !membersQuery.isPending && !isLastAdmin;

  function backToList(): void {
    navigate("/settings/groups", { state: backgroundLocation ? { backgroundLocation } : undefined });
  }

  return (
    <>
      {canManageGroup && (
        <SettingsGroup title={t("groups.detail.dangerTitle")} description={t("groups.detail.dangerDescription")}>
          <Button type="button" variant="outline" onClick={() => setDeleteOpen(true)}>
            {t("groups.delete.confirm")}
          </Button>
          {deleteOpen && <DeleteGroupDialog group={group} onOpenChange={setDeleteOpen} onDeleted={backToList} />}
        </SettingsGroup>
      )}
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
            backToList();
          }}
        />
      )}
    </>
  );
}

/** 群組用量（spec §9.2）：只在 `canManageGroup` 時**掛載**——不掛載就不發請求（非管理者打會 403）。 */
function GroupStorageSection({ group }: { group: GroupDto }) {
  const { t } = useTranslation();
  const query = useGroupStorageUsage(group.id);
  return <StorageUsageGroup title={t("groups.detail.storage")} query={query} />;
}

/**
 * `/settings/groups/:id` 的「成員」分頁（#103 spec §8.4；#175 spec §8.5；外框、not_found 三形見 `GroupDetailShell`）：
 * **只看 `GroupDto` 的兩個管理旗標**——`canManageGroup`＝名稱行內可改＋刪除群組；`canManageMembers`＝成員表的
 * 角色下拉與移除、加人；兩者都沒有＝名稱與成員表唯讀。不是最後一位管理員＝退出群組。`canManageGroup` 另顯示群組儲存用量。
 */
export function SettingsGroupDetailSection() {
  return (
    <GroupDetailShell>
      {(group, backgroundLocation) => (
        <>
          {group.canManageGroup ? <NameSection key={group.name} group={group} /> : null}
          <MembersSection group={group} canManageMembers={group.canManageMembers} />
          {group.canManageGroup ? <GroupStorageSection group={group} /> : null}
          <DangerSection group={group} canManageGroup={group.canManageGroup} backgroundLocation={backgroundLocation} />
        </>
      )}
    </GroupDetailShell>
  );
}
