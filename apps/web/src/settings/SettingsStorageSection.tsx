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
import { Input } from "@/components/ui/input";
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
import { quotaBytesFromInput, quotaInputFromBytes, validPlanName, type QuotaUnit } from "@/lib/storage-plan-form";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

/** 原生 select（repo 慣例：逐檔宣告，見 ApiTokensSection.tsx:35-41）。 */
const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** errors.<code>；方案端點的 invalid_name 改用方案版文案（errors.invalid_name 是群組的「1–80」）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    if (err.code === "invalid_name") return t("admin.storage.nameInvalid");
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 新增／編輯方案（spec §9.3）。上限＝數字（MB／GB，1024 進位）或「無上限」。編輯時只送改了的欄位（起草裁定 6）：
 * 名稱 trim 後不同才送 `name`；碰過上限欄（數字、單位、無上限任一）且換算後不同才送 `quotaBytes`——
 * bytes→「MB＋小數」→bytes 會四捨五入，只改名時不能把換算值送回去（RF2）。調低只顯示說明文字，不另確認（M1）。
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
              <select
                aria-label={t("admin.storage.unitLabel")}
                className={SELECT_CLASS}
                value={unit}
                disabled={unlimited}
                onChange={(e) => {
                  setUnit(e.target.value as QuotaUnit);
                  setQuotaTouched(true);
                }}
              >
                <option value="MB">MB</option>
                <option value="GB">GB</option>
              </select>
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

/** 刪除鈕＋確認框。disabled 只是體驗（說明在表下方，看得見）；server 仍是最終裁決，競態的 409 以 toast 顯示。 */
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("admin.storage.deleteLabel", { name: plan.name })}
          disabled={disabled}
          title={disabled ? t("admin.storage.deleteBlockedHint") : undefined}
        >
          {t("admin.storage.delete")}
        </Button>
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

/** 兩個預設（spec §7.1、D4b）：只影響之後建立的。`null`＝沒碰過、顯示 server 值；送出只帶改了的鍵。 */
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
        <select id="storage-default-user" className={SELECT_CLASS} value={shownUser} onChange={(e) => setUserPlanId(e.target.value)}>
          {data.plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label htmlFor="storage-default-group" className="text-sm">
          {t("admin.storage.defaultGroupLabel")}
        </label>
        <select id="storage-default-group" className={SELECT_CLASS} value={shownGroup} onChange={(e) => setGroupPlanId(e.target.value)}>
          {data.plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
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

/** 欄寬規則（比照使用者表 `USERS_TABLE_LAYOUT`）：文字欄可任意處斷行、數字欄不換行、操作欄收到內容寬。 */
const PLAN_TABLE_LAYOUT = {
  text: "min-w-[14ch] wrap-anywhere",
  fixed: "whitespace-nowrap",
  actions: "w-px whitespace-nowrap",
} as const;

const BADGE_CLASS = "ml-2 whitespace-nowrap rounded border border-border px-1 text-xs text-muted-foreground";

function PlanTable({ plans }: { plans: StoragePlanDto[] }) {
  const { t } = useTranslation();
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2 pr-3 font-medium">{t("admin.storage.tableName")}</th>
            <th className={`py-2 pr-3 font-medium ${PLAN_TABLE_LAYOUT.fixed}`}>{t("admin.storage.tableQuota")}</th>
            <th className={`py-2 pr-3 font-medium ${PLAN_TABLE_LAYOUT.fixed}`}>{t("admin.storage.tableUsers")}</th>
            <th className={`py-2 pr-3 font-medium ${PLAN_TABLE_LAYOUT.fixed}`}>{t("admin.storage.tableGroups")}</th>
            <th className={`py-2 pr-3 font-medium ${PLAN_TABLE_LAYOUT.fixed}`}>{t("admin.storage.tableOverQuota")}</th>
            <th className={`py-2 font-medium text-right ${PLAN_TABLE_LAYOUT.actions}`}>{t("admin.storage.tableActions")}</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id} className="border-b border-border">
              <td className={`py-2 pr-3 ${PLAN_TABLE_LAYOUT.text}`}>
                {p.name}
                {p.isDefaultForUsers && <span className={BADGE_CLASS}>{t("admin.storage.defaultForUsers")}</span>}
                {p.isDefaultForGroups && <span className={BADGE_CLASS}>{t("admin.storage.defaultForGroups")}</span>}
              </td>
              <td className={`py-2 pr-3 ${PLAN_TABLE_LAYOUT.fixed}`}>
                {p.quotaBytes === null ? t("admin.storage.unlimited") : formatBytes(p.quotaBytes)}
              </td>
              <td className={`py-2 pr-3 ${PLAN_TABLE_LAYOUT.fixed}`}>{p.userCount}</td>
              <td className={`py-2 pr-3 ${PLAN_TABLE_LAYOUT.fixed}`}>{p.groupCount}</td>
              <td className={`py-2 pr-3 ${PLAN_TABLE_LAYOUT.fixed} ${p.overQuotaCount > 0 ? "text-destructive" : ""}`}>
                {p.overQuotaCount}
              </td>
              <td className={`py-2 ${PLAN_TABLE_LAYOUT.actions}`}>
                <div className="flex justify-end gap-1">
                  <PlanDialog
                    plan={p}
                    trigger={
                      <Button type="button" variant="ghost" size="sm" aria-label={t("admin.storage.editLabel", { name: p.name })}>
                        {t("admin.storage.edit")}
                      </Button>
                    }
                  />
                  <DeletePlanButton
                    plan={p}
                    disabled={p.userCount + p.groupCount > 0 || p.isDefaultForUsers || p.isDefaultForGroups}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">{t("admin.storage.deleteBlockedHint")}</p>
    </>
  );
}

/**
 * 站台管理頁的儲存方案區（`/admin/storage`，admin only；spec §9.3）。版面外殼由 `pages/AdminPage.tsx` 提供，
 * 本元件只被它靜態 import（#201：同一個 lazy chunk，不得逐區 lazy）。刪除鈕的 disabled 只是體驗，
 * server 仍裁決（並發被指派 → 409 `storage_plan_in_use`，以 toast 顯示）。
 */
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
            <Button type="button" variant="brandDeep">
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
    </SettingsPage>
  );
}
