import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MIN_PASSWORD_LENGTH, ONLINE_WINDOW_MS, type StoragePlanDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { useSession } from "@/auth/useSession";
import {
  useAdminUsers,
  useCreateAdminUser,
  useDemoteAdminUser,
  useDisableAdminUser,
  useEnableAdminUser,
  usePromoteAdminUser,
  useAssignUserPlan,
  type AdminUserDto,
} from "@/api/admin";
import { useAdminStoragePlans } from "@/api/adminStorage";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { PlanSelect, StorageCell } from "./StorageAdminCells";

/** ApiFail → errors.<code>；其餘 → errors.fallback。與 NoteList/ShareDialog 同一套對映
 * （各檔各自一份，是既有慣例——見那兩處的說明）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 建立使用者 dialog。密碼長度在送出前先做客戶端 pre-validation
 * （`MIN_PASSWORD_LENGTH`，鏡射 server 端同名常數，與 `ChangePasswordForm` 同一套模式）——
 * 只是體驗優化，server 一樣會再驗一次（`password_too_short`），不能省。
 *
 * `isAdmin` 一律以明確布林值送出（勾選 true／未勾選 false），不因「false 是預設值」
 * 就省略欄位——讓送出的 body 對呼叫端（測試、未來的除錯）永遠可預期。
 */
function CreateUserDialog() {
  const { t } = useTranslation();
  const createUser = useCreateAdminUser();
  const authConfig = useAuthConfig();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm(): void {
    setEmail("");
    setPassword("");
    setDisplayName("");
    setIsAdmin(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("errors.password_too_short"));
      return;
    }

    try {
      await createUser.mutateAsync({ email, password, displayName, isAdmin });
      resetForm();
      setOpen(false);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">{t("admin.createUser")}</Button>
      </DialogTrigger>
      <DialogContent dismissOnOutside={false}>
        <DialogHeader>
          <DialogTitle>{t("admin.createUser")}</DialogTitle>
          <DialogDescription>{t("admin.createUserDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="admin-create-email" className="text-sm font-medium">
              {t("admin.email")}
            </label>
            <Input
              id="admin-create-email"
              type="email"
              autoComplete="off"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="admin-create-password" className="text-sm font-medium">
              {t("admin.password")}
            </label>
            <Input
              id="admin-create-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("admin.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
          </div>

          <div className="space-y-1">
            <label htmlFor="admin-create-display-name" className="text-sm font-medium">
              {t("admin.displayName")}
            </label>
            <Input
              id="admin-create-display-name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="admin-create-is-admin"
              checked={isAdmin}
              onCheckedChange={(checked) => setIsAdmin(checked === true)}
            />
            <label htmlFor="admin-create-is-admin" className="text-sm font-medium">
              {t("admin.isAdmin")}
            </label>
          </div>

          <p className="text-xs text-muted-foreground">{t("admin.mustChangePasswordNotice")}</p>
          {authConfig.data?.passwordLogin.enabled === false && (
            // §9.5 表末列：關閉期間代建照常（仍要臨時密碼），但它只用於對方首次 SSO 登入時在連結頁證明本人。
            <p className="text-xs text-muted-foreground">{t("admin.passwordLoginOffNotice")}</p>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" variant="brandDeep" disabled={createUser.isPending}>
              {createUser.isPending ? t("admin.creating") : t("admin.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 使用者表的欄寬規則（比照群組成員表 #183）。jsdom 不排版，測試對字面 token 斷言。
 * - `text`：email／username／顯示名稱可在任意處斷行；`wrap-anywhere` 會把斷點算進 min-content，
 *   auto 表格才肯壓窄這欄（`break-words` 不會，照樣撐爆）。`min-w-[14ch]` 是下限：沒有它，窄螢幕（768px 卡片約 474px）
 *   會把三欄壓到一個字元寬、字一個一個直排；有它，表格寬於卡片時改由卡片層的橫向捲動吸收。
 * - `fixed`：角色、用量、最後活動三欄不換行。
 * - `actions`：啟用欄收到內容寬、不換行，按鈕永遠不被擠壓。
 */
const USERS_TABLE_LAYOUT = {
  text: "min-w-[14ch] wrap-anywhere",
  fixed: "whitespace-nowrap",
  actions: "w-px whitespace-nowrap",
} as const;

/**
 * #267「最後活動」欄：`now - lastActiveAt` 小於 `ONLINE_WINDOW_MS` →「上線中」（server 至多每 `LAST_ACTIVE_WRITE_INTERVAL_MS` 記一次，
 * 遠短於視窗，持續有活動的人不會掉出來）；更早 → 日期＋時間（與版本面板 `formatVersionTime` 同格式：dateStyle／timeStyle short）；
 * null（從無紀錄）→「尚無紀錄」。`now` 取瀏覽器時鐘、在 render 當下算；沒有計時器重算，停在畫面上的「上線中」要等下次 render（例如列表重新取得）才會變。
 */
function lastActiveLabel(lastActiveAt: string | null, t: (key: string) => string, language: string): string {
  if (lastActiveAt === null) return t("admin.users.lastActiveNone");
  const at = new Date(lastActiveAt);
  if (Date.now() - at.getTime() < ONLINE_WINDOW_MS) return t("admin.users.online");
  return at.toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
}

const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 一列使用者（#247 §7.0，W27）：角色**下拉**（管理員／一般：升級送 `promote`、降級送 `demote`）、方案下拉、用量、最後活動、
 * 列尾**啟用 toggle**。
 * - 角色：自己那列 disabled＋`title`（server 另以 400 `cannot_demote_self` 把關）；pending 時 disabled 並顯示剛選的值；失敗（含 409
 *   `last_site_admin`）下拉自然留在原值（受控於列資料）、列內紅字。
 * - 啟用：關 → 先開確認框（停用會踢掉線上 session）、確認才送 `disable`；開 → 直接送 `enable`。自己那列照常渲染、恆為開，但
 *   `aria-disabled`＋`title`、不送請求（現行是整顆停用鈕不渲染；改成 toggle 欄後每列都要有一格）。server 的 `cannot_disable_self`
 *   照舊是最後防線。失敗：toggle 受控於列資料、自然彈回，列內紅字。
 */
function UserRow({ row, currentUserId, plans, onAssignPlan, enabledHeaderId }: {
  row: AdminUserDto;
  currentUserId: string;
  plans: StoragePlanDto[] | undefined;
  onAssignPlan: (planId: string) => Promise<unknown>;
  /** 「Enabled」欄頭的 id：switch 的可及名稱＝欄頭＋該列 email（`aria-labelledby`）。 */
  enabledHeaderId: string;
}) {
  const { t, i18n } = useTranslation();
  const emailCellId = useId();
  const promote = usePromoteAdminUser();
  const demote = useDemoteAdminUser();
  const disableUser = useDisableAdminUser();
  const enableUser = useEnableAdminUser();
  const [pickedRole, setPickedRole] = useState<"admin" | "user" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSelf = row.id === currentUserId;
  const rolePending = promote.isPending || demote.isPending;
  const roleValue = rolePending && pickedRole !== null ? pickedRole : row.isAdmin ? "admin" : "user";
  const enabled = row.disabledAt === null;

  async function handleRole(next: "admin" | "user"): Promise<void> {
    if (isSelf || rolePending || next === (row.isAdmin ? "admin" : "user")) return;
    setError(null);
    setPickedRole(next);
    try {
      await (next === "admin" ? promote : demote).mutateAsync(row.id);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setPickedRole(null);
    }
  }

  async function handleEnabled(next: boolean): Promise<void> {
    if (isSelf) return;
    setError(null);
    if (!next) {
      setConfirmOpen(true);
      return;
    }
    try {
      await enableUser.mutateAsync(row.id);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  async function handleDisableConfirm(): Promise<void> {
    try {
      await disableUser.mutateAsync(row.id);
      setConfirmOpen(false);
    } catch (err) {
      setConfirmOpen(false);
      setError(errorMessage(t, err));
    }
  }

  return (
    <tr className="border-b border-border align-top">
      <td className={`py-2 pr-3 ${USERS_TABLE_LAYOUT.text}`}>
        <p>{row.displayName}</p>
        <p className="text-xs text-muted-foreground">@{row.handle}</p>
      </td>
      <td id={emailCellId} className={`py-2 pr-3 ${USERS_TABLE_LAYOUT.text}`}>{row.email}</td>
      <td className={`py-2 pr-3 ${USERS_TABLE_LAYOUT.fixed}`}>
        <select
          aria-label={t("admin.users.roleFor", { email: row.email })}
          value={roleValue}
          disabled={isSelf || rolePending}
          title={isSelf ? t("errors.cannot_demote_self") : undefined}
          onChange={(event) => void handleRole(event.target.value as "admin" | "user")}
          className={SELECT_CLASS}
        >
          <option value="admin">{t("admin.roleAdmin")}</option>
          <option value="user">{t("admin.roleUser")}</option>
        </select>
        {error && (
          <p role="alert" className="mt-1 whitespace-normal text-xs text-destructive">
            {error}
          </p>
        )}
      </td>
      <td className="py-2 pr-3">
        <PlanSelect
          label={t("admin.planFor", { email: row.email })}
          planId={row.storage.planId}
          planName={row.storage.planName}
          plans={plans}
          onAssign={onAssignPlan}
        />
      </td>
      <td className={`py-2 pr-3 ${USERS_TABLE_LAYOUT.fixed}`}>
        <StorageCell storage={row.storage} />
      </td>
      <td className={`py-2 pr-3 ${USERS_TABLE_LAYOUT.fixed}`}>
        {lastActiveLabel(row.lastActiveAt, t, i18n.language)}
      </td>
      <td className={`py-2 ${USERS_TABLE_LAYOUT.actions}`}>
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Switch
            aria-labelledby={`${enabledHeaderId} ${emailCellId}`}
            checked={isSelf ? true : enabled}
            aria-disabled={isSelf || undefined}
            title={isSelf ? t("errors.cannot_disable_self") : undefined}
            className={isSelf ? "cursor-not-allowed opacity-50" : undefined}
            disabled={!isSelf && (enableUser.isPending || disableUser.isPending)}
            onCheckedChange={(next) => void handleEnabled(next)}
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("admin.disableTitle")}</DialogTitle>
              <DialogDescription>{t("admin.disableDescription", { email: row.email })}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("home.cancel")}
                </Button>
              </DialogClose>
              <Button type="button" variant="destructive" onClick={() => void handleDisableConfirm()} disabled={disableUser.isPending}>
                {t("admin.disable")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}

/**
 * 站台管理 modal 的使用者區（`/admin/users`，#247 §7.0）。歷程：Task 15 獨立頁 → Plan 4 併進設定 modal →
 * 2026-09-30 獨立頁 `/admin/*` → #247 起是站台管理 modal 的第一項（`AdminSections` 聚合 chunk）。
 * 頁首的「建立使用者」是面板層級動作，`outline`（§4.8）；它開出的對話框內送出鈕照舊 `brandDeep`。
 *
 * - 方案下拉即存、失敗 toast（spec §9.3，`PlanSelect`）；停權者照樣可改（S13）。
 * - 標題列的建立鈕走 `SettingsPage` 的 `action` 插槽（見 `SettingsLayout.tsx`）。
 */
export function SettingsUsersSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const usersQuery = useAdminUsers();
  const plansQuery = useAdminStoragePlans();
  const assignPlan = useAssignUserPlan();
  const enabledHeaderId = useId();
  const currentUserId = user?.id ?? "";

  return (
    <SettingsPage
      title={t("admin.title")}
      description={t("admin.description")}
      // 建立鈕改掛在頁首標題列。原本它自己一行右對齊浮在表格上方，既沒有跟標題
      // 成組、也沒有跟表格成組，是「項次都黏在一起」感覺的來源之一。
      action={<CreateUserDialog />}
    >
      <SettingsGroup>
      {usersQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : usersQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, usersQuery.error)}
        </p>
      ) : usersQuery.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-2 pr-3 font-medium">{t("admin.users.user")}</th>
              <th className="py-2 pr-3 font-medium">{t("admin.tableEmail")}</th>
              <th className={`py-2 pr-3 font-medium ${USERS_TABLE_LAYOUT.fixed}`}>{t("admin.tableRole")}</th>
              <th className="py-2 pr-3 font-medium">{t("admin.tablePlan")}</th>
              <th className={`py-2 pr-3 font-medium ${USERS_TABLE_LAYOUT.fixed}`}>{t("admin.tableStorage")}</th>
              <th className={`py-2 pr-3 font-medium ${USERS_TABLE_LAYOUT.fixed}`}>{t("admin.users.lastActive")}</th>
              <th id={enabledHeaderId} className={`py-2 font-medium ${USERS_TABLE_LAYOUT.actions}`}>{t("admin.users.enabled")}</th>
            </tr>
          </thead>
          <tbody>
            {usersQuery.data.map((row) => (
              <UserRow
                key={row.id}
                row={row}
                currentUserId={currentUserId}
                plans={plansQuery.data?.plans}
                onAssignPlan={(planId) => assignPlan.mutateAsync({ userId: row.id, planId })}
                enabledHeaderId={enabledHeaderId}
              />
            ))}
          </tbody>
        </table>
      )}
      </SettingsGroup>
    </SettingsPage>
  );
}
