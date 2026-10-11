import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { GroupDto, GroupMemberDto, GroupRoleDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAddMember, useGroupMembers, useGroupRoles, useRemoveMember, useSetMemberRole } from "@/api/groups";
import { Button } from "@/components/ui/button";
import { Trash } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { toast } from "@/components/ui/toast";
import { roleLabel } from "@/lib/group-role";
import { SettingsGroup, SettingsPage } from "@/settings/SettingsLayout";
import { useGroupOutlet } from "./group-outlet";

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
 * `GroupMembersSection.test.tsx` 逐格對**字面 token** 斷言（不 import 這個常數，
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

/**
 * 成員表：`canManageMembers` 有角色下拉與移除鈕（最後一位管理員的列兩者鎖住＋title），否則唯讀。
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
    <SettingsGroup>
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
                        <RowIconButton
                          label={t("groups.detail.remove", { email: member.email })}
                          tone="destructive"
                          icon={<Trash className="h-4 w-4" />}
                          softDisabled={locked}
                          softDisabledReason={t("groups.detail.lastAdminHint")}
                          disabled={removeMember.isPending}
                          onClick={() => void handleRemove(member)}
                        />
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* 最後一位管理員的提示：移除鈕是 `aria-disabled`（`title` 浮得出來），但角色下拉仍是原生 disabled、
          `title` 浮不出來——所以照留看得見的文字。 */}
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
 * 群組 modal「成員」（`/groups/:id`，#247 §6.2）：成員表（`canManageMembers` 有角色下拉、紅垃圾桶移除、加人；否則唯讀）。
 * 最後一位管理員那列：角色下拉 disabled、移除鈕 `aria-disabled`＋`opacity-40`＋`title`（§4.9）。名稱、用量、危險區不在這頁。
 */
export function GroupMembersSection() {
  const { t } = useTranslation();
  const group = useGroupOutlet();
  return (
    <SettingsPage
      title={t("groups.nav.members")}
      description={group.canManageMembers ? t("groups.detail.membersDescriptionAdmin") : t("groups.detail.membersDescriptionMember")}
    >
      <MembersSection group={group} canManageMembers={group.canManageMembers} />
    </SettingsPage>
  );
}
