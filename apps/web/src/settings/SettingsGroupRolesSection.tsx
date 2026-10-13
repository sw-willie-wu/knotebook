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
import { useGroupOutlet } from "@/components/groups/group-outlet";
import { Button } from "@/components/ui/button";
import { Check, Pencil, Trash, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { roleLabel } from "@/lib/group-role";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** 角色端點的 400 `invalid_name` 要講角色名稱的長度（1–40），不是 `errors.invalid_name` 那句群組名稱（主檔 spec 疑點 1）。 */
function roleErrorMessage(t: TFn, err: unknown): string {
  if (err instanceof ApiFail) {
    if (err.code === "invalid_name") return t("groups.roles.invalidName");
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/** DTO 的七鍵（含恆真的 `read`）→ 角色端點收的六鍵。送出的 `permissions` 一律是它的輸出（server `.strict()`，收到 `read` 會 400）。 */
function toFlags(p: GroupRolePermissions): GroupRoleFlags {
  return Object.fromEntries(GROUP_ROLE_FLAGS.map((f) => [f, p[f]])) as GroupRoleFlags;
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
 * 一列「旗標名＋switch」。**契約：旗標彼此不連動**（Willie 裁決；spec 疑點 11）——`onChange` 只准改這一列自己的那一鍵。
 * `softDisabled`＝pending 期間的停用：`aria-disabled`＋視覺停用，**不用原生 `disabled`**（按下那顆若變 disabled，
 * 鍵盤焦點會掉到 body，#247 §6.3）；`onChange` 是否忽略由呼叫端決定。
 */
function FlagSwitchRow({
  flag,
  accessibleName,
  checked,
  disabled,
  softDisabled,
  describedBy,
  onChange,
}: {
  flag: GroupRoleFlag;
  accessibleName: string;
  checked: boolean;
  disabled?: boolean;
  softDisabled?: boolean;
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
        aria-disabled={softDisabled || undefined}
        className={softDisabled ? "cursor-not-allowed opacity-50" : undefined}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </label>
  );
}

/** 刪自訂角色：紅垃圾桶（§4.9）→ 確認對話框（destructive）。失敗 toast 並關閉。 */
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
      <DialogTrigger asChild>
        <RowIconButton label={t("groups.roles.deleteFor", { role: label })} tone="destructive" icon={<Trash className="h-4 w-4" />} />
      </DialogTrigger>
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
 * 一張角色卡（#247 §6.3，W28：按下即生效）。
 * - 六個 switch 按下就送 `PATCH …/roles/:roleId`，body 一律六鍵：取**當下快取**（`role` prop＝`useGroupRoles` 的資料）的六鍵、只翻目標鍵。
 * - **一張卡同時只有一發**：本卡自己的 `useUpdateRole` 實例 `isPending` 期間，六個 switch 全 `aria-disabled`、按了直接 return；
 *   `checked` 取這一發的 `variables.permissions`（被按的那顆立刻顯示新值）；`variables.permissions` 缺席（改名那一發）時取快取值。
 *   pending 涵蓋 `onSettled` 的 refetch（見 `useUpdateRole`），所以不再 pending 時快取必為真值。
 * - 失敗：不回滾（沒有樂觀寫入）；refetch 讓 switch 彈回 server 值，卡內 `role="alert"` 直到下一次按下。
 * - 內建管理員卡鎖定（原生 disabled＋說明，S8）；沒有 `canManageGroup` 時全部唯讀。
 * - 自訂角色卡右上：鉛筆（行內改名，送 `{ name }`）＋紅垃圾桶（刪除，確認框）。內建一般成員不能改名、不能刪（Q10）。
 */
function RoleCard({ groupId, role, canManage }: { groupId: string; role: GroupRoleDto; canManage: boolean }) {
  const { t } = useTranslation();
  const lockedHintId = useId();
  const update = useUpdateRole(groupId);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  const label = roleLabel(t, role);
  const isAdmin = role.builtin === "admin";
  const isCustom = role.builtin === null;
  const locked = isAdmin || !canManage;
  const pending = update.isPending;
  const sent = pending ? update.variables?.permissions : undefined;
  const trimmed = name.trim();

  function handleToggle(flag: GroupRoleFlag, value: boolean): void {
    if (locked || update.isPending) return;
    const permissions: GroupRoleFlags = { ...toFlags(role.permissions), [flag]: value };
    setError(null);
    update.mutate({ roleId: role.id, permissions }, { onError: (err) => setError(roleErrorMessage(t, err)) });
  }

  function startRename(): void {
    setName(role.name ?? "");
    setError(null);
    setRenaming(true);
  }

  async function handleRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || update.isPending) return;
    setError(null);
    try {
      await update.mutateAsync({ roleId: role.id, name: trimmed });
      setRenaming(false);
    } catch (err) {
      setError(roleErrorMessage(t, err));
    }
  }

  return (
    <section aria-label={label} className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        {renaming ? (
          <form onSubmit={(event) => void handleRename(event)} className="flex min-w-0 flex-1 items-center gap-2">
            {/* 標題跳讀不要漏掉改名中的角色：輸入框之外補一個只給輔助科技的 h3。 */}
            <h3 className="sr-only">{label}</h3>
            <Input
              autoFocus
              aria-label={t("groups.roles.nameFor", { role: label })}
              // 與 server 同上限（40 個 code point）；`maxLength` 數 UTF-16 單元，對 emoji 會提早擋——server 才是裁決者。
              maxLength={GROUP_ROLE_NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-48"
            />
            {/* 存檔／取消是表單最右的 icon 鈕（spec 2026-10-13 settings-table §2.6、§3 角色卡：勾＝存檔、叉＝取消）。
                沒有 Esc 取消：Radix Dialog 在 capture 階段吃 Escape 會關整個面板（同 ApiTokensSection 的行內編輯）。 */}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <RowIconButton
                type="submit"
                label={t("groups.roles.save")}
                icon={<Check className="h-4 w-4" aria-hidden="true" />}
                disabled={trimmed.length === 0 || pending}
              />
              <RowIconButton label={t("groups.roles.cancel")} icon={<X className="h-4 w-4" aria-hidden="true" />} onClick={() => setRenaming(false)} />
            </div>
          </form>
        ) : (
          <h3 className="text-sm font-medium">{label}</h3>
        )}
        {canManage && isCustom && !renaming && (
          <div className="flex shrink-0 items-center">
            <RowIconButton label={t("groups.roles.renameFor", { role: label })} icon={<Pencil className="h-4 w-4" />} onClick={startRename} />
            <DeleteRoleButton groupId={groupId} role={role} label={label} />
          </div>
        )}
      </div>
      <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {GROUP_ROLE_FLAGS.map((flag) => (
          <FlagSwitchRow
            key={flag}
            flag={flag}
            accessibleName={t("groups.roles.flagFor", { flag: t(`groups.roles.flags.${flag}.label`), role: label })}
            checked={sent ? sent[flag] : role.permissions[flag]}
            disabled={locked}
            softDisabled={!locked && pending}
            describedBy={isAdmin && canManage ? lockedHintId : undefined}
            onChange={(value) => handleToggle(flag, value)}
          />
        ))}
      </div>
      {/* disabled 的元件 `title` 浮不出來——用看得見的文字（成員頁 `lastAdminHint` 同一個理由）。 */}
      {isAdmin && canManage && (
        <p id={lockedHintId} className="mt-2 text-xs text-muted-foreground">
          {t("groups.roles.adminLocked")}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** 新增角色（`canManageGroup`）：名稱＋六個 switch（初值全關＝只能閱讀；不連動）。成功關閉、失敗留著顯示 alert。對話框內的送出鈕照舊 `brandDeep`（§4.8 的例外只管右卡）。 */
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

/** 頁首「新增角色」：面板層級動作，`outline`（#247 §4.8，W16——面板右卡不放實心鈕）。 */
function NewRoleButton({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t("groups.roles.newRole")}
      </Button>
      {/* 每次開啟重新掛載：名稱與旗標從空白開始 */}
      {open && <NewRoleDialog groupId={groupId} open onOpenChange={setOpen} />}
    </>
  );
}

function RolesPage({ group }: { group: GroupDto }) {
  const { t } = useTranslation();
  const rolesQuery = useGroupRoles(group.id);
  const canManage = group.canManageGroup;
  const roles = rolesQuery.data;

  return (
    <SettingsPage
      title={t("groups.nav.roles")}
      description={canManage ? t("groups.roles.descriptionManage") : t("groups.roles.descriptionView")}
      action={canManage ? <NewRoleButton groupId={group.id} /> : undefined}
    >
      <SettingsGroup>
        <p className="text-sm text-muted-foreground">{t("groups.roles.readAlways")}</p>
        {/* 有資料就畫資料：refetch 失敗（isError 但 data 仍在）時不把整片卡換成錯誤字（Review Focus 1）。 */}
        {roles === undefined ? (
          rolesQuery.isPending ? (
            <p className="mt-3 text-sm text-muted-foreground">{t("app.loading")}</p>
          ) : (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {roleErrorMessage(t, rolesQuery.error)}
            </p>
          )
        ) : (
          <ul className="mt-3 space-y-3">
            {roles.map((role) => (
              // key 只用 role.id：refetch 回來卡不重掛，mutation 實例與卡內 alert 才不會一起消失（§6.3）。
              <li key={role.id}>
                <RoleCard groupId={group.id} role={role} canManage={canManage} />
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
    </SettingsPage>
  );
}

/**
 * 群組 modal「角色」（`/groups/:id/roles`，#247 §6.3；前身 #175 spec §8.5）。群組由 `GroupModal` 經 Outlet context 給。
 * 每個角色都能閱讀（沒有閱讀開關）；六個旗標彼此不連動；沒有 `canManageGroup` 的成員看唯讀視角（Q18）。
 */
export function SettingsGroupRolesSection() {
  const group = useGroupOutlet();
  return <RolesPage group={group} />;
}
