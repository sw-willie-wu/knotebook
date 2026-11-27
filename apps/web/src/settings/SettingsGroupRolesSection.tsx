import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/groups-admin-strings";
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

/** The role endpoint's 400 `invalid_name` is about the role name length (1–40), not the group-name text of `errors.invalid_name`. */
function roleErrorMessage(t: TFn, err: unknown): string {
  if (err instanceof ApiFail) {
    if (err.code === "invalid_name") return t("groups.roles.invalidName");
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * The DTO's seven keys (incl. the always-true `read`) to the role endpoint's six. Every sent `permissions` must come from
 * here: the server is `.strict()` and answers 400 to `read`.
 */
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
 * Contract: flags are independent; `onChange` may only change this row's key.
 * `softDisabled` (disabled while pending) uses `aria-disabled` rather than native `disabled`: if the pressed switch became
 * disabled, keyboard focus would drop to body. Whether `onChange` is ignored is up to the caller.
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
 * Switches take effect on click. The PATCH body always carries all six keys from the current cache (the `role` prop, from
 * `useGroupRoles`) with only the target key flipped.
 * One PATCH in flight per card: while this card's `useUpdateRole` is pending, all switches are `aria-disabled` and clicks
 * return; `checked` shows that request's `variables.permissions` (the pressed one shows its new value at once), or the
 * cache when absent (a rename). Pending covers the `onSettled` refetch (see `useUpdateRole`), so once it ends the cache
 * holds the server value.
 * Failure: no rollback (no optimistic write); the refetch snaps the switch back and the card's `role="alert"` stays until
 * the next press. The builtin admin card is locked (native disabled + explanation); without `canManageGroup` all is
 * read-only. Builtin member roles can't be renamed or deleted.
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
  const shown = sent ?? role.permissions;
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
            {/* Screen-reader-only h3 so heading navigation includes a role being renamed. */}
            <h3 className="sr-only">{label}</h3>
            <Input
              autoFocus
              aria-label={t("groups.roles.nameFor", { role: label })}
              // Same limit as the server (40 code points); `maxLength` counts UTF-16 and would block emoji early.
              maxLength={GROUP_ROLE_NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-48"
            />
            {/* No Esc to cancel: Radix Dialog eats Escape in the capture phase and would close the whole panel (same as the ApiTokensSection inline edit). */}
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
      {/* Delete without edit means notes you delete can't be recovered by you (#181). Hint only, never blocks; while pending it uses the sent value. Also shown in the read-only view on purpose, since members holding the role are affected. */}
      {!isAdmin && shown.delete && !shown.edit && (
        <p className="mt-2 text-xs text-muted-foreground">{t("groups.roles.deleteWithoutEditHint")}</p>
      )}
      {/* `title` doesn't show on disabled elements, so use visible text (same reason as the members page's `lastAdminHint`). */}
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

/** Flags start off (read only) and are independent. The dialog's submit stays `brandDeep`: the no-solid-button rule covers only the panel card. */
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
          {flags.delete && !flags.edit && <p className="text-xs text-muted-foreground">{t("groups.roles.deleteWithoutEditHint")}</p>}
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

/** Panel-level action: `outline`, since the panel card has no solid button. */
function NewRoleButton({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t("groups.roles.newRole")}
      </Button>
      {/* Remounted per open so name and flags start blank. */}
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
        {/* Render data while present: a failed refetch must not replace the cards with an error. */}
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
              // Keyed by role.id only, so a refetch doesn't remount cards and lose the mutation instance and the in-card alert.
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

export function SettingsGroupRolesSection() {
  const group = useGroupOutlet();
  return <RolesPage group={group} />;
}
