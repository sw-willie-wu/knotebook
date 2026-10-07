import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  GROUP_ROLE_FLAGS,
  GROUP_ROLE_NAME_MAX,
  type GroupDto,
  type GroupRoleDto,
  type GroupRoleFlag,
  type GroupRoleFlags,
  type GroupRolePermissions,
} from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useCreateRole, useDeleteRole, useGroupRoles, useUpdateRole } from "@/api/groups";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { roleLabel } from "@/lib/group-role";
import { GroupDetailShell } from "./GroupDetailShell";
import { SettingsGroup } from "./SettingsLayout";

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** 角色端點的 400 `invalid_name` 要講角色名稱的長度（1–40），不是 `errors.invalid_name` 那句群組名稱（主檔 spec 疑點 1）。 */
function roleErrorMessage(t: TFn, err: unknown): string {
  if (err instanceof ApiFail) {
    if (err.code === "invalid_name") return t("groups.roles.invalidName");
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * DTO 的七鍵（含恆真的 `read`）→ 角色端點收的六鍵。**送出的 `permissions` 一律是它的輸出**：server `.strict()`，
 * 收到 `read` 會 400；`useUpdateRole`／`useCreateRole` 的型別擋不住多出來的鍵（結構型別），靠這裡收。
 */
function toFlags(p: GroupRolePermissions): GroupRoleFlags {
  return Object.fromEntries(GROUP_ROLE_FLAGS.map((f) => [f, p[f]])) as GroupRoleFlags;
}

/** 區塊 React key 的一部分：server 端旗標一變，區塊重掛、草稿回到新值（`canManage` 翻轉時也要重掛，見 RolesSection 的 key）。 */
function flagKey(f: GroupRoleFlags): string {
  return GROUP_ROLE_FLAGS.map((x) => (f[x] ? "1" : "0")).join("");
}

const NO_FLAGS: GroupRoleFlags = {
  create: false,
  edit: false,
  delete: false,
  managePublicLink: false,
  manageMembers: false,
  manageGroup: false,
};

/**
 * 一列「旗標名＋switch」。`accessibleName` 給可及名稱（角色頁要帶角色名，例如「Create for Reader」；
 * 新增對話框只有一組，就用旗標名本身）。`describedBy` 掛到 switch 的 `aria-describedby`（鎖定說明用）。
 * **契約：旗標彼此不連動**（Willie 裁決；spec 疑點 11）——`onChange` 只准改這一列自己的那一鍵，
 * 呼叫端不得在裡面順手改別的旗標（例如「開 Edit 順帶開 Create」）；案 2／3／7a／7b 守著。
 */
function FlagSwitchRow({
  flag,
  accessibleName,
  checked,
  disabled,
  describedBy,
  onChange,
}: {
  flag: GroupRoleFlag;
  accessibleName: string;
  checked: boolean;
  disabled?: boolean;
  describedBy?: string;
  onChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      {t(`groups.roles.flags.${flag}.label`)}
      <Switch
        aria-label={accessibleName}
        aria-describedby={describedBy}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </label>
  );
}

/** 刪自訂角色：ghost 觸發鈕 → 確認對話框（destructive）。失敗 toast 並關閉。 */
function DeleteRoleButton({ groupId, role, label }: { groupId: string; role: GroupRoleDto; label: string }) {
  const { t } = useTranslation();
  const deleteRole = useDeleteRole(groupId);
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteRole.mutateAsync(role.id);
    } catch (err) {
      toast({ title: roleErrorMessage(t, err), variant: "destructive" });
    }
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t("groups.roles.deleteFor", { role: label })}
        onClick={() => setOpen(true)}
      >
        {t("groups.roles.deleteShort")}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("groups.roles.delete.title")}</DialogTitle>
          <DialogDescription>
            {role.memberCount === 0
              ? t("groups.roles.delete.descriptionEmpty")
              : t("groups.roles.delete.description", { count: role.memberCount })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={deleteRole.isPending}>
            {t("groups.roles.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 一個角色的區塊。`locked`＝內建管理員（S8：DB `group_roles_admin_all_chk`、路由 409 `builtin_role`）或沒有
 * `canManageGroup`。switch 只改本地草稿；「套用」只送改了的鍵（名稱、六鍵 permissions 各自可省）。
 * **無變動時套用鈕 disabled**＝「有沒有未套用的變動」的可見訊號（Willie 裁決）。
 */
function RoleCard({ groupId, role, canManage }: { groupId: string; role: GroupRoleDto; canManage: boolean }) {
  const { t } = useTranslation();
  const lockedHintId = useId();
  const update = useUpdateRole(groupId);
  const [name, setName] = useState(role.name ?? "");
  const [flags, setFlags] = useState<GroupRoleFlags>(() => toFlags(role.permissions));
  const [error, setError] = useState<string | null>(null);

  const label = roleLabel(t, role);
  const isAdmin = role.builtin === "admin";
  const isCustom = role.builtin === null;
  const locked = isAdmin || !canManage;
  const nameChanged = isCustom && name.trim() !== (role.name ?? "");
  const flagsChanged = GROUP_ROLE_FLAGS.some((f) => flags[f] !== role.permissions[f]);
  const nameBlank = isCustom && name.trim() === "";

  async function handleApply(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!(nameChanged || flagsChanged) || nameBlank || update.isPending) return;
    setError(null);
    try {
      await update.mutateAsync({
        roleId: role.id,
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(flagsChanged ? { permissions: flags } : {}),
      });
      toast({ title: t("groups.roles.applied") });
    } catch (err) {
      setError(roleErrorMessage(t, err));
    }
  }

  return (
    <section aria-label={label} className="rounded-md border border-border p-3">
      <form onSubmit={(event) => void handleApply(event)}>
        {canManage && isCustom ? (
          <>
            {/* 標題跳讀不要漏掉自訂角色：內建角色有看得見的 h3，自訂角色那一格是輸入框，補一個只給輔助科技的 h3。 */}
            <h3 className="sr-only">{label}</h3>
            <Input
              aria-label={t("groups.roles.nameFor", { role: label })}
              // 與 server 同上限（40 個 code point）；`maxLength` 數 UTF-16 單元，對 emoji 會提早擋——體驗優化，
              // server 才是裁決者（400 `invalid_name` 走下面的 alert）。同 `GroupNameDialog` 的 `GROUP_NAME_MAX_LENGTH`。
              maxLength={GROUP_ROLE_NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-48"
            />
          </>
        ) : (
          <h3 className="text-sm font-medium">{label}</h3>
        )}
        <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {GROUP_ROLE_FLAGS.map((flag) => (
            <FlagSwitchRow
              key={flag}
              flag={flag}
              accessibleName={t("groups.roles.flagFor", { flag: t(`groups.roles.flags.${flag}.label`), role: label })}
              checked={flags[flag]}
              disabled={locked || update.isPending}
              describedBy={isAdmin && canManage ? lockedHintId : undefined}
              onChange={(value) => setFlags((current) => ({ ...current, [flag]: value }))}
            />
          ))}
        </div>
        {/* disabled 的元件 `title` 浮不出來（成員頁 `lastAdminHint` 同一個理由）——用看得見的文字。 */}
        {isAdmin && canManage && (
          <p id={lockedHintId} className="mt-2 text-xs text-muted-foreground">
            {t("groups.roles.adminLocked")}
          </p>
        )}
        {canManage && !isAdmin && (
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              aria-label={t("groups.roles.applyFor", { role: label })}
              disabled={!(nameChanged || flagsChanged) || nameBlank || update.isPending}
            >
              {t("groups.roles.apply")}
            </Button>
            {isCustom && <DeleteRoleButton groupId={groupId} role={role} label={label} />}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function RolesSection({ group }: { group: GroupDto }) {
  const { t } = useTranslation();
  const rolesQuery = useGroupRoles(group.id);
  const canManage = group.canManageGroup;

  return (
    <>
      <SettingsGroup
        title={t("groups.roles.title")}
        description={canManage ? t("groups.roles.descriptionManage") : t("groups.roles.descriptionView")}
      >
        <p className="text-sm text-muted-foreground">{t("groups.roles.readAlways")}</p>
        {rolesQuery.isPending ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : rolesQuery.isError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {roleErrorMessage(t, rolesQuery.error)}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {rolesQuery.data.map((role) => (
              <li key={role.id}>
                <RoleCard
                  key={`${role.id}:${canManage ? 1 : 0}:${role.name ?? ""}:${flagKey(toFlags(role.permissions))}`}
                  groupId={group.id}
                  role={role}
                  canManage={canManage}
                />
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>
      <SettingsGroup title={t("groups.roles.legendTitle")}>
        <dl className="space-y-3 text-sm">
          {GROUP_ROLE_FLAGS.map((flag) => (
            <div key={flag}>
              <dt className="font-medium">{t(`groups.roles.flags.${flag}.label`)}</dt>
              <dd className="text-muted-foreground">{t(`groups.roles.flags.${flag}.description`)}</dd>
            </div>
          ))}
        </dl>
      </SettingsGroup>
    </>
  );
}

/** 新增角色（`canManageGroup`）：名稱＋六個 switch（初值全關＝只能閱讀；不連動）。成功關閉、失敗留著顯示 alert。 */
function NewRoleDialog({ groupId, open, onOpenChange }: { groupId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const createRole = useCreateRole(groupId);
  const [name, setName] = useState("");
  const [flags, setFlags] = useState<GroupRoleFlags>(NO_FLAGS);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || createRole.isPending) return;
    setError(null);
    try {
      await createRole.mutateAsync({ name: trimmed, permissions: flags });
      onOpenChange(false);
    } catch (err) {
      setError(roleErrorMessage(t, err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{t("groups.roles.dialog.title")}</DialogTitle>
          <DialogDescription>{t("groups.roles.dialog.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <Input
            autoFocus
            aria-label={t("groups.roles.dialog.nameLabel")}
            placeholder={t("groups.roles.dialog.nameLabel")}
            maxLength={GROUP_ROLE_NAME_MAX}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={error !== null || undefined}
          />
          <div className="space-y-2">
            {GROUP_ROLE_FLAGS.map((flag) => (
              <FlagSwitchRow
                key={flag}
                flag={flag}
                accessibleName={t(`groups.roles.flags.${flag}.label`)}
                checked={flags[flag]}
                onChange={(value) => setFlags((current) => ({ ...current, [flag]: value }))}
              />
            ))}
          </div>
          {error && (
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
            <Button type="submit" variant="brandDeep" disabled={trimmed.length === 0 || createRole.isPending}>
              {t("groups.roles.dialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 頁首「新增角色」：本畫面唯一實心鈕（`brandDeep`，modal 內那一階；比照 `SettingsGroupsSection` 的「新增群組」）。 */
function NewRoleButton({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="brandDeep" onClick={() => setOpen(true)}>
        {t("groups.roles.newRole")}
      </Button>
      {/* 每次開啟重新掛載：名稱與旗標從空白開始 */}
      {open && <NewRoleDialog groupId={groupId} open onOpenChange={setOpen} />}
    </>
  );
}

/**
 * `/settings/groups/:id/roles`（#175 spec §8.5）：每個角色一個區塊，六個可設旗標各一個 switch。
 * - 每個角色都能閱讀（Willie 裁決；沒有閱讀開關，區塊上方一句 `readAlways` 交代）。
 * - switch 外觀、但**只改本地狀態**，按區塊底部的「套用」才 PATCH（Willie 裁決，刻意偏離 `ui/switch.tsx`「switch＝立即生效」）。
 * - 六個旗標彼此不連動（Willie 裁決；spec 疑點 11）。
 * - 內建管理員：六個全開、disabled、沒有套用鈕（S8：DB `group_roles_admin_all_chk`；路由回 409 `builtin_role`）。
 * - 內建一般成員：名稱唯讀（i18n）、旗標可改（Q10）、不能刪。
 * - 自訂角色：名稱輸入框、旗標、套用（outline sm）、刪除（ghost sm → 確認對話框，destructive）。
 * - 頁首「新增角色」是本畫面唯一實心鈕（`brandDeep`，modal 那一階）。
 * - 沒有 `canManageGroup` 的成員看唯讀視角（Q18：角色清單所有成員可見）。
 * 每個區塊以「server 值」當 React key：套用或別人改過之後 `['groups', id, 'roles']` 重抓，草稿自動回到新值（比照 `NameSection key={group.name}`）。
 * key 也含 `canManage`：權限被拿掉（或又被給回來）時區塊重掛，唯讀視角不會殘留未套用的草稿假值。
 * **設計取捨**：別人改了「同一個角色」、重抓之後，本地未套用的草稿會無提示丟掉（別的角色的草稿不受影響）；不加 UI 提示。
 */
export function SettingsGroupRolesSection() {
  return (
    <GroupDetailShell action={(group) => (group.canManageGroup ? <NewRoleButton groupId={group.id} /> : undefined)}>
      {(group) => <RolesSection group={group} />}
    </GroupDetailShell>
  );
}
