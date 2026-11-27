import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, type StoragePlanDto, type StoragePlansResponse } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import {
  useAdminStoragePlans,
  useCreateStoragePlan,
  useDeleteStoragePlan,
  useUpdateStorageDefaults,
  useUpdateStoragePlan,
} from "@/api/adminStorage";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Pencil, Trash } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { quotaBytesFromInput, quotaInputFromBytes, validPlanName, type QuotaUnit } from "@/lib/storage-plan-form";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { SiteNotificationsGroup } from "./SettingsNotificationsSection";
import { SiteTrashGroup } from "./SettingsTrashSection";
import { SiteVersionsGroups } from "./SettingsVersionsSection";
import "@/i18n/management-strings";

/** errors.<code>; plan endpoints use plan-specific text for invalid_name (errors.invalid_name is the group's "1–80"). */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    if (err.code === "invalid_name") return t("admin.storage.nameInvalid");
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * The limit is a number (MB/GB, 1024-based) or unlimited. Edit sends only changed fields: `name` only if it differs
 * after trim; `quotaBytes` only when a limit input (number, unit or unlimited) was touched and the converted value
 * differs, because bytes → "MB + decimal" → bytes rounds and a rename must not send the converted value back.
 * Lowering the limit only shows a hint, with no extra confirmation.
 */
function PlanDialog({ plan, trigger }: { plan?: StoragePlanDto; trigger: ReactNode }) {
  const { t } = useTranslation();
  const create = useCreateStoragePlan();
  const update = useUpdateStoragePlan();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [unit, setUnit] = useState<QuotaUnit>("GB");
  const [unlimited, setUnlimited] = useState(false);
  const [quotaTouched, setQuotaTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  function reset(): void {
    const initial = plan?.quotaBytes != null ? quotaInputFromBytes(plan.quotaBytes) : { value: "", unit: "GB" as QuotaUnit };
    setName(plan?.name ?? "");
    setQuota(initial.value);
    setUnit(initial.unit);
    setUnlimited(plan !== undefined && plan.quotaBytes === null);
    setQuotaTouched(false);
    setError(null);
  }

  const parsed = quotaBytesFromInput(quota, unit);
  const lowering =
    plan !== undefined && quotaTouched && !unlimited && parsed !== null && (plan.quotaBytes === null || parsed < plan.quotaBytes);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const validName = validPlanName(name);
    if (validName === null) return setError(t("admin.storage.nameInvalid"));
    if (!unlimited && parsed === null) return setError(t("admin.storage.quotaInvalid"));
    const quotaBytes = unlimited ? null : parsed;
    try {
      if (plan === undefined) {
        await create.mutateAsync({ name: validName, quotaBytes });
      } else {
        const body: { name?: string; quotaBytes?: number | null } = {};
        if (validName !== plan.name) body.name = validName;
        if (quotaTouched && quotaBytes !== plan.quotaBytes) body.quotaBytes = quotaBytes;
        if (Object.keys(body).length > 0) await update.mutateAsync({ id: plan.id, body });
      }
      setOpen(false);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  const ids = plan ? `plan-${plan.id}` : "plan-new";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{plan ? t("admin.storage.editTitle") : t("admin.storage.createTitle")}</DialogTitle>
          <DialogDescription>{t("admin.storage.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`${ids}-name`} className="text-sm font-medium">
              {t("admin.storage.nameLabel")}
            </label>
            <Input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-quota`} className="text-sm font-medium">
              {t("admin.storage.quotaLabel")}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={`${ids}-quota`}
                inputMode="decimal"
                className="max-w-40"
                value={quota}
                disabled={unlimited}
                onChange={(e) => {
                  setQuota(e.target.value);
                  setQuotaTouched(true);
                }}
              />
              <Select
                variant="field"
                aria-label={t("admin.storage.unitLabel")}
                className="shrink-0"
                value={unit}
                disabled={unlimited}
                onValueChange={(v) => {
                  setUnit(v as QuotaUnit);
                  setQuotaTouched(true);
                }}
                options={[
                  { value: "MB", label: "MB" },
                  { value: "GB", label: "GB" },
                ]}
              />
              <Checkbox
                id={`${ids}-unlimited`}
                checked={unlimited}
                onCheckedChange={(c) => {
                  setUnlimited(c === true);
                  setQuotaTouched(true);
                }}
              />
              <label htmlFor={`${ids}-unlimited`} className="text-sm">
                {t("admin.storage.unlimited")}
              </label>
            </div>
            {lowering && <p className="text-xs text-muted-foreground">{t("admin.storage.lowerNotice")}</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={pending}>
              {plan
                ? pending
                  ? t("admin.storage.saving")
                  : t("admin.storage.save")
                : pending
                  ? t("admin.storage.creating")
                  : t("admin.storage.createSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** `disabled` is a courtesy (the reason is visible below the table); the server decides, and a racing 409 `storage_plan_in_use` shows as a toast. */
function DeletePlanButton({ plan, disabled }: { plan: StoragePlanDto; disabled: boolean }) {
  const { t } = useTranslation();
  const del = useDeleteStoragePlan();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await del.mutateAsync(plan.id);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <RowIconButton
          label={t("admin.storage.deleteLabel", { name: plan.name })}
          tone="destructive"
          icon={<Trash className="h-4 w-4" />}
          softDisabled={disabled}
          softDisabledReason={t("admin.storage.deleteBlockedHint")}
        />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.storage.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("admin.storage.deleteDescription", { name: plan.name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={del.isPending}>
            {t("admin.storage.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Both defaults affect only what is created later. `null` = untouched (shows the server value); submit sends only changed keys. */
function DefaultsGroup({ data }: { data: StoragePlansResponse }) {
  const { t } = useTranslation();
  const updateDefaults = useUpdateStorageDefaults();
  const [userPlanId, setUserPlanId] = useState<string | null>(null);
  const [groupPlanId, setGroupPlanId] = useState<string | null>(null);
  const shownUser = userPlanId ?? data.defaults.userPlanId;
  const shownGroup = groupPlanId ?? data.defaults.groupPlanId;
  const userChanged = shownUser !== data.defaults.userPlanId;
  const groupChanged = shownGroup !== data.defaults.groupPlanId;

  async function handleSave(): Promise<void> {
    const body: { userPlanId?: string; groupPlanId?: string } = {};
    if (userChanged) body.userPlanId = shownUser;
    if (groupChanged) body.groupPlanId = shownGroup;
    try {
      await updateDefaults.mutateAsync(body);
      setUserPlanId(null);
      setGroupPlanId(null);
      toast({ title: t("admin.storage.defaultsSaved") });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <SettingsGroup title={t("admin.storage.defaultsTitle")} description={t("admin.storage.defaultsDescription")}>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="storage-default-user" className="text-sm">
          {t("admin.storage.defaultUserLabel")}
        </label>
        <Select
          variant="field"
          id="storage-default-user"
          className="shrink-0"
          value={shownUser}
          onValueChange={setUserPlanId}
          options={data.plans.map((p) => ({ value: p.id, label: p.name }))}
        />
        <label htmlFor="storage-default-group" className="text-sm">
          {t("admin.storage.defaultGroupLabel")}
        </label>
        <Select
          variant="field"
          id="storage-default-group"
          className="shrink-0"
          value={shownGroup}
          onValueChange={setGroupPlanId}
          options={data.plans.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Button
          type="button"
          variant="outline"
          disabled={(!userChanged && !groupChanged) || updateDefaults.isPending}
          onClick={() => void handleSave()}
        >
          {t("admin.storage.defaultsSave")}
        </Button>
      </div>
    </SettingsGroup>
  );
}

const BADGE_CLASS = "whitespace-nowrap rounded border border-border px-1 text-xs text-muted-foreground";

function PlanTable({ plans }: { plans: StoragePlanDto[] }) {
  const { t } = useTranslation();
  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("admin.storage.tableName"), kind: "primary" },
    { id: "quota", header: t("admin.storage.tableQuota"), kind: "fixed" },
    { id: "users", header: t("admin.storage.tableUsers"), kind: "fixed" },
    { id: "groups", header: t("admin.storage.tableGroups"), kind: "fixed" },
    { id: "overQuota", header: t("admin.storage.tableOverQuota"), kind: "fixed" },
    { id: "actions", header: t("admin.storage.tableActions"), kind: "actions", buttons: 2 },
  ];
  const rows: SettingsTableRow[] = plans.map((p) => ({
    id: p.id,
    primary: {
      name: p.name,
      badges: (
        <>
          {p.isDefaultForUsers && <span className={BADGE_CLASS}>{t("admin.storage.defaultForUsers")}</span>}
          {p.isDefaultForGroups && <span className={BADGE_CLASS}>{t("admin.storage.defaultForGroups")}</span>}
        </>
      ),
    },
    cells: {
      quota: p.quotaBytes === null ? t("admin.storage.unlimited") : formatBytes(p.quotaBytes),
      users: p.userCount,
      groups: p.groupCount,
      overQuota: { content: p.overQuotaCount, tone: p.overQuotaCount > 0 ? "danger" : "default" },
    },
    actions: (
      <>
        <PlanDialog
          plan={p}
          trigger={<RowIconButton label={t("admin.storage.editLabel", { name: p.name })} icon={<Pencil className="h-4 w-4" />} />}
        />
        <DeletePlanButton plan={p} disabled={p.userCount + p.groupCount > 0 || p.isDefaultForUsers || p.isDefaultForGroups} />
      </>
    ),
  }));
  return (
    <>
      <SettingsTable label={t("admin.storage.title")} columns={columns} rows={rows} />
      <p className="mt-2 text-xs text-muted-foreground">{t("admin.storage.deleteBlockedHint")}</p>
    </>
  );
}

/** Statically imported only by the site-admin lazy module, so everything shares one chunk; don't lazy-load per section. */
export function SettingsStorageSection() {
  const { t } = useTranslation();
  const plansQuery = useAdminStoragePlans();

  return (
    <SettingsPage
      title={t("admin.storage.title")}
      description={t("admin.storage.description")}
      action={
        <PlanDialog
          trigger={
            <Button type="button" variant="outline">
              {t("admin.storage.create")}
            </Button>
          }
        />
      }
    >
      <SettingsGroup>
        {plansQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : plansQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, plansQuery.error)}
          </p>
        ) : (
          <PlanTable plans={plansQuery.data.plans} />
        )}
      </SettingsGroup>
      {plansQuery.data && <DefaultsGroup data={plansQuery.data} />}
      <SiteVersionsGroups />
      <SiteTrashGroup />
      <SiteNotificationsGroup />
    </SettingsPage>
  );
}
